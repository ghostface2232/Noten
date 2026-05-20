import { useState, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import {
  mkdir,
  readTextFile,
  writeTextFile,
  readDir,
  remove,
  copyFile,
  exists,
} from "@tauri-apps/plugin-fs";
import { markOwnWrite } from "./ownWriteTracker";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { getFileTimestamps } from "../utils/fileTimestamps";
import { migrateDataUrlImagesToAssets } from "../utils/migrateImageAssets";
import { removeNoteAssetDir } from "../utils/imageAssetUtils";
import {
  metaPathFor,
  metaDirFor,
  readAllMeta,
  writeMeta as writeMetaFile,
  removeMeta as removeMetaFile,
} from "../utils/metadataIO";
import {
  groupsPathFor,
  readGroupsFile,
  writeGroupsWithMerge,
  genOrderKeyAfter,
  type SharedGroupEntry,
} from "../utils/groupsIO";
import { getMachineId, getMachineIdCached } from "../utils/machineId";
import {
  ensureSharedDirs,
  retireLegacyManifest,
  scanAndAbsorbConflicts,
} from "../utils/conflictFileDetector";
import {
  setKnownDiskContent,
  resetKnownDiskContent,
  backupRemoteVersion,
} from "../utils/conflictBackup";
import {
  getUiStateCached,
  setActiveNoteIdPersisted,
  setGroupCollapsedPersisted,
} from "./useUiState";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface NoteDoc {
  id: string;
  filePath: string;
  fileName: string;
  isDirty: boolean;
  content: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  customName?: boolean;
}

export interface NoteGroup {
  id: string;
  name: string;
  noteIds: string[];
  collapsed: boolean;
  createdAt: number;
  /** Fractional index used to sort groups in the sidebar — synced across PCs. */
  orderKey?: string;
  /** updatedAt for orderKey alone (independent of name updates). */
  orderUpdatedAt?: number;
  /** updatedAt for name and other shared fields. */
  updatedAt?: number;
}

export interface TrashedNote {
  id: string;
  fileName: string;
  originalFilePath: string;
  trashFilePath: string;
  trashedAt: number;
  groupId: string | null;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

/**
 * Per-machine cache that lets us paint the sidebar quickly on next launch.
 * NOT a source of truth: it is rebuilt from `.meta/*.json` + `.groups.json`
 * + `ui-state.json` after the first scan.
 */
interface LocalCache {
  version: 2;
  notes: Omit<NoteDoc, "isDirty" | "content">[];
  groups?: NoteGroup[];
  trashedNotes?: TrashedNote[];
  imageAssetMigrationV1CompletedAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level caches
// ─────────────────────────────────────────────────────────────────────────────

let notesDirCache: string | null = null;
let imageAssetMigrationV1CompletedAtCache: number | null = null;
let trashedNotesCache: TrashedNote[] = [];
export function getTrashedNotesCache(): TrashedNote[] { return trashedNotesCache; }
export function setTrashedNotesCache(notes: TrashedNote[]) { trashedNotesCache = notes; }

/** Migration in progress — blocks saveManifest writes. */
export let migrationInProgress = false;
export function setMigrationInProgress(v: boolean) { migrationInProgress = v; }

/**
 * Last-written snapshot of per-note meta. Lets `saveManifest` write only the
 * meta files that actually changed instead of touching all of them.
 */
interface MetaSnapshot {
  fileName: string;
  customName: boolean;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  groupId: string | null;
  trashedAt: number | null;
}
const writtenMetaSnapshot = new Map<string, MetaSnapshot>();

interface SharedGroupSnapshot {
  name: string;
  orderKey: string;
  orderUpdatedAt: number;
  updatedAt: number;
}
const writtenGroupsSnapshot = new Map<string, SharedGroupSnapshot>();

/**
 * Explicit "delete this group" intents queued by user actions. saveManifest
 * emits a tombstone into `.groups.json` for each id present here that is also
 * absent from the current `groups` argument. Using an explicit set (instead
 * of inferring deletions from snapshot-vs-state diffs) prevents a remote
 * group create from being misread as a local delete: e.g. when the watcher
 * has just synced a remotely-created group into `writtenGroupsSnapshot` but
 * a saveManifest call from a stale closure runs before React state catches
 * up, the diff path would tombstone the new group; the explicit set won't.
 */
const pendingGroupTombstones = new Set<string>();

/** Mark a group as deleted. Called from `useNoteGroups.deleteGroup` and from
 *  the auto-prune paths in `useFileSystem` (empty-group cleanup). The tombstone
 *  is materialised in `.groups.json` on the next `saveManifest` call that sees
 *  the group missing from its `groups` argument. */
export function markGroupAsDeleted(id: string): void {
  pendingGroupTombstones.add(id);
}

/** Cancel a pending deletion (e.g. user undid the action before saveManifest
 *  ran, or a remote write resurrected the group). */
export function unmarkGroupAsDeleted(id: string): void {
  pendingGroupTombstones.delete(id);
}

function resetWriteSnapshots() {
  writtenMetaSnapshot.clear();
  writtenGroupsSnapshot.clear();
  pendingGroupTombstones.clear();
}

/**
 * Populate the diff snapshots from on-disk state so subsequent `saveManifest`
 * calls can:
 *   - skip rewriting unchanged meta files
 *   - detect group deletions and emit tombstones into `.groups.json`
 *
 * Without this seeding, deleting a group that existed before the session
 * starts would NOT produce a tombstone and the read-merge-write in
 * `writeGroupsWithMerge` would resurrect it.
 */
async function seedWriteSnapshots(dir: string): Promise<void> {
  resetWriteSnapshots();

  const allMeta = await readAllMeta(dir);
  for (const m of allMeta.values()) {
    writtenMetaSnapshot.set(m.id, {
      fileName: m.fileName,
      customName: !!m.customName,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      pinned: m.pinned === true,
      groupId: m.groupId ?? null,
      trashedAt: m.trashedAt ?? null,
    });
  }

  await syncGroupsSnapshotFromDisk(dir);
}

/**
 * Refresh `writtenGroupsSnapshot` from `.groups.json`. Called when the watcher
 * sees an external write so that subsequent local deletions of remotely-created
 * groups still emit tombstones (otherwise the deletion is silently lost in the
 * read-merge-write cycle).
 */
export async function syncGroupsSnapshotFromDisk(dir: string): Promise<void> {
  const groupsFile = await readGroupsFile(dir);
  // Forget entries that no longer exist on disk so we don't keep emitting
  // tombstones for already-tombstoned groups.
  const liveOnDisk = new Set<string>();
  for (const g of Object.values(groupsFile.groups)) {
    if (g.deletedAt != null) continue;
    liveOnDisk.add(g.id);
    writtenGroupsSnapshot.set(g.id, {
      name: g.name,
      orderKey: g.orderKey,
      orderUpdatedAt: g.orderUpdatedAt,
      updatedAt: g.updatedAt,
    });
  }
  for (const id of Array.from(writtenGroupsSnapshot.keys())) {
    if (!liveOnDisk.has(id)) writtenGroupsSnapshot.delete(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting & title helpers
// ─────────────────────────────────────────────────────────────────────────────

export function sortNotes(docs: NoteDoc[], order: NotesSortOrder, locale: Locale = "en"): NoteDoc[] {
  const sorted = [...docs];
  const desc = order.endsWith("-desc");
  const direction = desc ? -1 : 1;
  const byTitle = order.startsWith("title");
  const byCreated = order.startsWith("created");

  sorted.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;

    if (byTitle) {
      const cmp = a.fileName.localeCompare(b.fileName, locale);
      if (cmp !== 0) return cmp * direction;
      return b.updatedAt - a.updatedAt;
    }

    const primaryDiff = byCreated
      ? a.createdAt - b.createdAt
      : a.updatedAt - b.updatedAt;
    if (primaryDiff !== 0) return primaryDiff * direction;

    const secondaryDiff = byCreated
      ? a.updatedAt - b.updatedAt
      : a.createdAt - b.createdAt;
    if (secondaryDiff !== 0) return secondaryDiff * direction;

    return a.fileName.localeCompare(b.fileName, locale);
  });

  return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notes directory
// ─────────────────────────────────────────────────────────────────────────────

export async function getNotesDir(): Promise<string> {
  if (notesDirCache) return notesDirCache;
  const base = await appDataDir();
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  notesDirCache = `${base}${sep}notes`;
  return notesDirCache;
}

export function setNotesDir(dir: string) {
  notesDirCache = dir;
  // Path changed → previous diff snapshot and conflict baseline are meaningless.
  resetWriteSnapshots();
  resetKnownDiskContent();
}

export function resetNotesDir() {
  notesDirCache = null;
  resetWriteSnapshots();
  resetKnownDiskContent();
}

async function ensureNotesDir(): Promise<string> {
  const dir = await getNotesDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trash directory
// ─────────────────────────────────────────────────────────────────────────────

export async function getTrashDir(): Promise<string> {
  const notesDir = await getNotesDir();
  const sep = notesDir.endsWith("/") || notesDir.endsWith("\\") ? "" : "/";
  return `${notesDir}${sep}.trash`;
}

export async function ensureTrashDir(): Promise<string> {
  const dir = await getTrashDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

const TRASH_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export async function purgeExpiredTrash(trashedNotes: TrashedNote[]): Promise<TrashedNote[]> {
  const now = Date.now();
  const kept: TrashedNote[] = [];
  let notesDir: string | null = null;
  try { notesDir = await getNotesDir(); } catch { /* ignore */ }

  for (const note of trashedNotes) {
    if (now - note.trashedAt > TRASH_RETENTION_MS) {
      try { await remove(note.trashFilePath); } catch { /* file may already be gone */ }
      if (notesDir) {
        await removeNoteAssetDir(notesDir, note.id);
        await removeMetaFile(notesDir, note.id);
      }
    } else {
      kept.push(note);
    }
  }

  return kept;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local cache file (per-machine, fast-boot)
// ─────────────────────────────────────────────────────────────────────────────

let localCachePathPromise: Promise<string> | null = null;

async function getLocalCachePath(): Promise<string> {
  if (!localCachePathPromise) {
    localCachePathPromise = (async () => {
      const base = await appDataDir();
      await mkdir(base, { recursive: true }).catch(() => {});
      const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
      return `${base}${sep}manifest-cache.json`;
    })();
  }
  return localCachePathPromise;
}

async function readLocalCache(): Promise<LocalCache | null> {
  try {
    const path = await getLocalCachePath();
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw) as LocalCache;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 2) return null;
    if (!Array.isArray(parsed.notes)) return null;
    imageAssetMigrationV1CompletedAtCache = parsed.imageAssetMigrationV1CompletedAt ?? null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeLocalCache(cache: LocalCache): Promise<void> {
  try {
    const path = await getLocalCachePath();
    await writeTextFile(path, JSON.stringify(cache, null, 2));
  } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function readFileContent(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch {
    return "";
  }
}

export function getFileBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileNameToId(name: string): string {
  // Drop ".md" suffix; legacy notes may have non-UUID stems — preserve them.
  return name.replace(/\.md$/i, "");
}

function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decomposed-state I/O
//   (replaces the old monolithic manifest.json read/write)
// ─────────────────────────────────────────────────────────────────────────────

interface DecomposedState {
  docs: NoteDoc[];
  groups: NoteGroup[];
  trashedNotes: TrashedNote[];
  activeNoteId: string | null;
}

/**
 * Read both `.groups.json` and every `.meta/{id}.json` from disk and return
 * the resulting NoteGroup list. Membership (noteIds) is derived from each
 * meta's `groupId`, which is the only authoritative source. Use this from
 * the watcher / reconcile path so we don't accidentally compute membership
 * from a stale React state snapshot.
 */
export async function loadGroupsFromDisk(dir: string): Promise<NoteGroup[]> {
  const file = await readGroupsFile(dir);
  const allMeta = await readAllMeta(dir);
  const collapsedMap = getUiStateCached().groupCollapsed;
  const metaByGroup = new Map<string, string[]>();
  for (const m of allMeta.values()) {
    if (m.trashedAt != null) continue;
    if (m.groupId) {
      const arr = metaByGroup.get(m.groupId) ?? [];
      arr.push(m.id);
      metaByGroup.set(m.groupId, arr);
    }
  }
  return buildGroupsFromShared(file.groups, metaByGroup, collapsedMap);
}

/** Build the in-memory NoteGroup list from `.groups.json` + per-note groupId. */
function buildGroupsFromShared(
  shared: Record<string, SharedGroupEntry>,
  metaByGroup: Map<string, string[]>,
  collapsedMap: Record<string, boolean>,
): NoteGroup[] {
  const out: NoteGroup[] = [];
  for (const entry of Object.values(shared)) {
    if (entry.deletedAt != null) continue;
    out.push({
      id: entry.id,
      name: entry.name,
      noteIds: metaByGroup.get(entry.id) ?? [],
      collapsed: !!collapsedMap[entry.id],
      createdAt: entry.createdAt,
      orderKey: entry.orderKey,
      orderUpdatedAt: entry.orderUpdatedAt,
      updatedAt: entry.updatedAt,
    });
  }
  out.sort((a, b) => {
    const ak = a.orderKey ?? "";
    const bk = b.orderKey ?? "";
    if (ak === bk) return a.createdAt - b.createdAt;
    return ak < bk ? -1 : 1;
  });
  return out;
}

async function loadDecomposedState(dir: string): Promise<DecomposedState> {
  const base = normalizeSep(dir);
  const trashBase = `${base}.trash/`;

  const allMeta = await readAllMeta(dir);
  const sharedGroupsFile = await readGroupsFile(dir);
  const uiState = getUiStateCached();

  const metaByGroup = new Map<string, string[]>();
  for (const meta of allMeta.values()) {
    if (meta.trashedAt != null) continue;
    if (meta.groupId) {
      const arr = metaByGroup.get(meta.groupId) ?? [];
      arr.push(meta.id);
      metaByGroup.set(meta.groupId, arr);
    }
  }

  const groups = buildGroupsFromShared(
    sharedGroupsFile.groups,
    metaByGroup,
    uiState.groupCollapsed,
  );

  const docs: NoteDoc[] = [];
  const trashed: TrashedNote[] = [];

  for (const meta of allMeta.values()) {
    if (meta.trashedAt != null) {
      const fileName = getFileBaseName(meta.trashedFromPath ?? `${base}${meta.id}.md`);
      const trashFilePath = `${trashBase}${meta.id}.md`;
      trashed.push({
        id: meta.id,
        fileName: meta.fileName,
        originalFilePath: meta.trashedFromPath ?? `${base}${fileName}`,
        trashFilePath,
        trashedAt: meta.trashedAt,
        groupId: meta.groupId ?? null,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        pinned: meta.pinned === true,
      });
    } else {
      docs.push({
        id: meta.id,
        filePath: `${base}${meta.id}.md`,
        fileName: meta.fileName,
        isDirty: false,
        content: "",
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        pinned: meta.pinned === true,
        customName: meta.customName,
      });
    }
  }

  const docIds = new Set(docs.map((d) => d.id));
  let activeId: string | null = null;
  if (uiState.activeNoteId && docIds.has(uiState.activeNoteId)) {
    activeId = uiState.activeNoteId;
  } else if (uiState.lastOpenedNoteId && docIds.has(uiState.lastOpenedNoteId)) {
    activeId = uiState.lastOpenedNoteId;
  } else {
    activeId = docs[0]?.id ?? null;
  }

  return { docs, groups, trashedNotes: trashed, activeNoteId: activeId };
}

async function attachDocContents(docs: NoteDoc[]): Promise<NoteDoc[]> {
  return Promise.all(
    docs.map(async (d) => {
      const content = await readFileContent(d.filePath);
      // Seed the conflict-backup baseline so the first local autosave knows
      // what disk looked like at boot.
      if (d.filePath) setKnownDiskContent(d.filePath, content);
      return { ...d, content } as NoteDoc;
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy `manifest.json` migration (one-shot)
// ─────────────────────────────────────────────────────────────────────────────

interface LegacyManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

interface LegacyManifestGroup {
  id: string;
  name: string;
  noteIds: string[];
  collapsed?: boolean;
  createdAt?: number;
}

interface LegacyManifestTrashed {
  id: string;
  fileName: string;
  originalFilePath: string;
  trashFilePath: string;
  trashedAt: number;
  groupId: string | null;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

interface LegacyManifest {
  version?: number;
  notes?: LegacyManifestNote[];
  activeNoteId?: string | null;
  groups?: LegacyManifestGroup[];
  trashedNotes?: LegacyManifestTrashed[];
  imageAssetMigrationV1CompletedAt?: number;
}

async function readLegacyManifestFile(dir: string): Promise<LegacyManifest | null> {
  try {
    const raw = await readTextFile(`${normalizeSep(dir)}manifest.json`);
    return JSON.parse(raw) as LegacyManifest;
  } catch {
    return null;
  }
}

async function decomposeLegacyManifest(dir: string, manifest: LegacyManifest): Promise<void> {
  const machineId = await getMachineId();

  // 1. groups → .groups.json
  const sharedGroups: Record<string, SharedGroupEntry> = {};
  let lastKey: string | undefined = undefined;
  const collapsedMap: Record<string, boolean> = {};
  const noteIdToGroupId = new Map<string, string>();
  const now = Date.now();

  for (const g of manifest.groups ?? []) {
    if (!g.id) continue;
    const orderKey = genOrderKeyAfter(lastKey);
    lastKey = orderKey;
    sharedGroups[g.id] = {
      id: g.id,
      name: g.name ?? "",
      orderKey,
      orderUpdatedAt: now,
      updatedAt: now,
      createdAt: g.createdAt ?? now,
      deletedAt: null,
    };
    if (g.collapsed) collapsedMap[g.id] = true;
    for (const noteId of g.noteIds ?? []) {
      noteIdToGroupId.set(noteId, g.id);
    }
  }

  if (Object.keys(sharedGroups).length > 0) {
    await writeGroupsWithMerge(dir, sharedGroups);
  }

  // 2. live notes → .meta/{id}.json
  for (const n of manifest.notes ?? []) {
    if (!n.id) continue;
    await writeMetaFile(dir, {
      version: 2,
      id: n.id,
      fileName: n.fileName,
      customName: n.customName || undefined,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      pinned: n.pinned === true,
      groupId: noteIdToGroupId.get(n.id) ?? null,
      trashedAt: null,
    }, machineId);
  }

  // 3. trashed notes → .meta with trashedAt
  for (const t of manifest.trashedNotes ?? []) {
    if (!t.id) continue;
    await writeMetaFile(dir, {
      version: 2,
      id: t.id,
      fileName: t.fileName,
      customName: undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      pinned: t.pinned === true,
      groupId: t.groupId ?? null,
      trashedAt: t.trashedAt,
      trashedFromPath: t.originalFilePath,
    }, machineId);
  }

  // 4. activeNoteId + collapsed → ui-state.json (per-machine)
  if (manifest.activeNoteId) {
    await setActiveNoteIdPersisted(manifest.activeNoteId);
  }
  for (const [gid, collapsed] of Object.entries(collapsedMap)) {
    if (collapsed) await setGroupCollapsedPersisted(gid, true);
  }

  // 5. imageAssetMigrationV1CompletedAt → local cache
  if (manifest.imageAssetMigrationV1CompletedAt) {
    imageAssetMigrationV1CompletedAtCache = manifest.imageAssetMigrationV1CompletedAt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// reconcileFolder — pick up new files, drop missing ones, repair meta
// ─────────────────────────────────────────────────────────────────────────────

export async function reconcileFolder(
  dir: string,
  docs: NoteDoc[],
  groups: NoteGroup[],
  locale: Locale,
): Promise<{ docs: NoteDoc[]; groups: NoteGroup[]; changed: boolean }> {
  let entries: { name?: string; isFile?: boolean; isDirectory?: boolean }[];
  try {
    entries = await readDir(dir);
  } catch {
    return { docs, groups, changed: false };
  }

  const machineId = getMachineIdCached();
  const base = normalizeSep(dir);
  const trashBase = `${base}.trash/`;

  const mdEntries = entries.filter((e) => e.name?.endsWith(".md") && e.isFile);
  const folderFileNames = new Set(mdEntries.map((e) => e.name!));
  const allMeta = await readAllMeta(dir);
  const trashedIds = new Set(
    Array.from(allMeta.values()).filter((m) => m.trashedAt != null).map((m) => m.id),
  );

  let changed = false;
  let nextDocs = [...docs];
  const docById = new Map(nextDocs.map((d) => [d.id, d]));

  // ── Add files in folder but missing from in-memory docs ──
  for (const entry of mdEntries) {
    const name = entry.name!;
    const id = fileNameToId(name);
    if (docById.has(id)) continue;
    if (trashedIds.has(id)) continue; // handled in mismatch branch below

    const filePath = `${base}${name}`;
    const content = await readFileContent(filePath);

    let meta = allMeta.get(id);
    const fts = await getFileTimestamps(filePath);

    if (!meta) {
      meta = {
        version: 2,
        id,
        fileName: deriveTitle(content) || getDefaultDocumentTitle(locale),
        customName: !UUID_RE.test(id) ? true : undefined,
        createdAt: fts.createdAt,
        updatedAt: fts.updatedAt,
        pinned: false,
        groupId: null,
        trashedAt: null,
      };
      try { await writeMetaFile(dir, meta, machineId); } catch { /* ignore */ }
    }

    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: meta.fileName,
      isDirty: false,
      content,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      pinned: meta.pinned === true,
      customName: meta.customName,
    };
    nextDocs.push(newDoc);
    docById.set(id, newDoc);
    changed = true;
  }

  // ── Resolve state mismatches: meta says trashed but root .md exists ──
  // Three-way state when `.trash/{id}.md` *also* exists is the dangerous
  // case — the previous implementation copied root over trash unconditionally
  // and silently destroyed whichever body wasn't the survivor. We now read
  // both bodies and, if they differ, copy the loser into `.conflicts/`
  // before applying the resolution.
  for (const meta of allMeta.values()) {
    if (meta.trashedAt == null) continue;
    const rootName = `${meta.id}.md`;
    if (!folderFileNames.has(rootName)) continue;

    const rootPath = `${base}${rootName}`;
    const trashPath = `${trashBase}${rootName}`;
    let rootMtime = 0;
    try { rootMtime = (await getFileTimestamps(rootPath)).updatedAt; } catch { /* fall back */ }

    // Read the existing trash body (if any) and the root body so we can
    // detect content divergence before either is overwritten or removed.
    let trashBody: string | null = null;
    try {
      if (await exists(trashPath)) {
        trashBody = await readTextFile(trashPath);
      }
    } catch { /* trash unreadable; treat as absent */ }

    let rootBody = "";
    try { rootBody = await readTextFile(rootPath); } catch { /* unreadable root */ }

    if (rootMtime > meta.trashedAt) {
      // Restore branch: meta becomes non-trashed. The trash body is now
      // redundant. If it has content distinct from root, preserve it under
      // `.conflicts/{id}-{ts}.md` before deleting so the user can recover.
      if (trashBody !== null && trashBody !== rootBody && trashBody.length > 0) {
        try { await backupRemoteVersion(dir, meta.id, trashBody); } catch { /* best-effort */ }
      }
      if (trashBody !== null) {
        try { markOwnWrite(trashPath); await remove(trashPath); } catch { /* ignore */ }
      }
      try {
        await writeMetaFile(dir, { ...meta, trashedAt: null, trashedFromPath: null }, machineId);
      } catch { /* ignore */ }
      changed = true;
    } else {
      // Move-to-trash branch: root will be copied over trash. If a distinct
      // trash body already exists, back it up before we clobber it.
      if (trashBody !== null && trashBody !== rootBody && trashBody.length > 0) {
        try { await backupRemoteVersion(dir, meta.id, trashBody); } catch { /* best-effort */ }
      }
      try {
        await mkdir(`${base}.trash`, { recursive: true });
        markOwnWrite(rootPath);
        await copyFile(rootPath, trashPath);
        await remove(rootPath);
      } catch { /* ignore */ }
      const beforeLen = nextDocs.length;
      nextDocs = nextDocs.filter((d) => d.id !== meta.id);
      if (nextDocs.length !== beforeLen) changed = true;
    }
  }

  // ── Remove docs whose root .md no longer exists ──
  // Crucially, keep dirty docs even if disk is gone: the user may be actively
  // editing in the editor, and their next autosave will recreate the file.
  // Dropping them here would silently destroy unsaved work.
  const beforeRemoveLen = nextDocs.length;
  const removedIds = new Set<string>();
  nextDocs = nextDocs.filter((d) => {
    if (!d.filePath) return true;
    const name = getFileBaseName(d.filePath);
    if (folderFileNames.has(name)) return true;
    if (d.isDirty) return true;
    removedIds.add(d.id);
    return false;
  });
  if (nextDocs.length !== beforeRemoveLen) changed = true;

  const nextGroups = removedIds.size > 0
    ? groups.map((g) => ({
        ...g,
        noteIds: g.noteIds.filter((id) => !removedIds.has(id)),
      }))
    : groups;

  // Read the trash directory once up front so subsequent integrity checks
  // can reference it without re-stat'ing.
  let trashEntries: { name?: string; isFile?: boolean }[] = [];
  try { trashEntries = await readDir(`${base}.trash`); } catch { trashEntries = []; }
  const trashFileNames = new Set(
    trashEntries.filter((e) => e.name?.endsWith(".md") && e.isFile).map((e) => e.name!),
  );

  // ── Orphan meta cleanup: meta with trashedAt=null but no root .md ──
  // Special case: if a `.trash/{id}.md` body exists for this meta, we are
  // observing a `deleteNote` operation mid-flight (root removed, meta has
  // not yet been stamped with `trashedAt`). Treating it as an orphan here
  // would race against the upcoming `saveManifest` write and either delete
  // a meta we're about to re-create or temporarily drop the trashed entry
  // from the in-memory state until the next reconcile rediscovers it.
  // Leave it alone and let the trash-side update finish.
  for (const meta of allMeta.values()) {
    if (meta.trashedAt != null) continue;
    const rootName = `${meta.id}.md`;
    if (folderFileNames.has(rootName)) continue;
    if (trashFileNames.has(rootName)) continue;
    try { await removeMetaFile(dir, meta.id); } catch { /* ignore */ }
  }

  // ── Trashed body integrity: meta says trashed but .trash file missing ──
  for (const meta of allMeta.values()) {
    if (meta.trashedAt == null) continue;
    if (!trashFileNames.has(`${meta.id}.md`)) {
      try { await removeMetaFile(dir, meta.id); } catch { /* ignore */ }
    }
  }

  // locale used only by getDefaultDocumentTitle above; suppress unused warning otherwise
  void locale;

  return { docs: nextDocs, groups: nextGroups, changed };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveManifest — public API preserved, internals decomposed
// ─────────────────────────────────────────────────────────────────────────────

function metaSnapshotEqual(a: MetaSnapshot, b: MetaSnapshot): boolean {
  return a.fileName === b.fileName
    && a.customName === b.customName
    && a.createdAt === b.createdAt
    && a.updatedAt === b.updatedAt
    && a.pinned === b.pinned
    && a.groupId === b.groupId
    && a.trashedAt === b.trashedAt;
}

function groupSnapshotEqual(a: SharedGroupSnapshot, b: SharedGroupSnapshot): boolean {
  return a.name === b.name
    && a.orderKey === b.orderKey
    && a.orderUpdatedAt === b.orderUpdatedAt
    && a.updatedAt === b.updatedAt;
}

/**
 * Internal persistence: writes decomposed state to disk.
 *   - `.meta/{id}.json` for any doc/trashed entry whose snapshot changed
 *   - shared `.groups.json` (read-merge-write against on-disk content)
 *   - local `ui-state.json` (activeNoteId)
 *   - local `manifest-cache.json` for next-launch fast paint
 *
 * This function is intentionally ungated by `migrationInProgress`. Callers
 * that should respect the migration guard go through `saveManifest` instead;
 * `useNotesLoader`'s own load can call this directly because it already owns
 * the guard window and needs to persist reconciled state without releasing
 * it. Splitting the gate out lets us avoid the previous "release-then-
 * reacquire" workaround that opened a tiny input window inside the load.
 */
async function persistDecomposedState(
  docs: NoteDoc[],
  activeId: string | null,
  groups?: NoteGroup[],
): Promise<void> {
  const dir = await getNotesDir();
  const machineId = getMachineIdCached();
  const trashed = trashedNotesCache;

  // Build a noteId → groupId index from the in-memory groups array.
  const noteIdToGroupId = new Map<string, string>();
  for (const g of groups ?? []) {
    if (!g.id) continue;
    for (const nid of g.noteIds) noteIdToGroupId.set(nid, g.id);
  }

  // ── 1. Per-note meta diffs ──
  const metaWrites: Promise<unknown>[] = [];
  for (const doc of docs) {
    const snap: MetaSnapshot = {
      fileName: doc.fileName,
      customName: !!doc.customName,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      pinned: doc.pinned === true,
      groupId: noteIdToGroupId.get(doc.id) ?? null,
      trashedAt: null,
    };
    const prev = writtenMetaSnapshot.get(doc.id);
    if (prev && metaSnapshotEqual(prev, snap)) continue;

    metaWrites.push(
      writeMetaFile(dir, {
        version: 2,
        id: doc.id,
        fileName: snap.fileName,
        customName: snap.customName || undefined,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        pinned: snap.pinned,
        groupId: snap.groupId,
        trashedAt: null,
      }, machineId).catch(() => {}),
    );
    writtenMetaSnapshot.set(doc.id, snap);
  }

  for (const t of trashed) {
    const snap: MetaSnapshot = {
      fileName: t.fileName,
      customName: false,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      pinned: t.pinned === true,
      groupId: t.groupId ?? null,
      trashedAt: t.trashedAt,
    };
    const prev = writtenMetaSnapshot.get(t.id);
    if (prev && metaSnapshotEqual(prev, snap)) continue;

    metaWrites.push(
      writeMetaFile(dir, {
        version: 2,
        id: t.id,
        fileName: snap.fileName,
        customName: undefined,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        pinned: snap.pinned,
        groupId: snap.groupId,
        trashedAt: snap.trashedAt,
        trashedFromPath: t.originalFilePath,
      }, machineId).catch(() => {}),
    );
    writtenMetaSnapshot.set(t.id, snap);
  }

  // ── 2. Shared groups diff ──
  const localGroupsMap: Record<string, SharedGroupEntry> = {};
  let lastOrderKey: string | undefined = undefined;
  const orderedGroups = [...(groups ?? [])].sort((a, b) => {
    const ak = a.orderKey ?? "";
    const bk = b.orderKey ?? "";
    if (ak === bk) return a.createdAt - b.createdAt;
    return ak < bk ? -1 : 1;
  });
  const now = Date.now();
  let groupsChanged = false;
  for (const g of orderedGroups) {
    if (!g.id) continue;
    let orderKey = g.orderKey;
    let orderUpdatedAt = g.orderUpdatedAt ?? 0;
    if (!orderKey) {
      orderKey = genOrderKeyAfter(lastOrderKey);
      orderUpdatedAt = now;
    }
    lastOrderKey = orderKey;

    const updatedAt = g.updatedAt ?? now;
    const snap: SharedGroupSnapshot = {
      name: g.name,
      orderKey,
      orderUpdatedAt,
      updatedAt,
    };
    const prev = writtenGroupsSnapshot.get(g.id);
    if (!prev || !groupSnapshotEqual(prev, snap)) groupsChanged = true;
    writtenGroupsSnapshot.set(g.id, snap);

    localGroupsMap[g.id] = {
      id: g.id,
      name: g.name,
      orderKey,
      orderUpdatedAt,
      updatedAt,
      createdAt: g.createdAt,
      deletedAt: null,
    };
  }

  // Materialise tombstones for explicit delete intents only. Inferring
  // deletions from "in writtenGroupsSnapshot but not in currentIds" is unsafe:
  // when the watcher just synced a remotely-created group into the snapshot,
  // a saveManifest call from a stale closure (that never saw the new group in
  // its `groups` argument) would emit a tombstone and silently destroy the
  // remote create. Only ids that were explicitly added to
  // `pendingGroupTombstones` by the user-action path are tombstoned here.
  const currentIds = new Set(orderedGroups.map((g) => g.id));
  const tombstoneApplied: string[] = [];
  for (const id of Array.from(pendingGroupTombstones)) {
    if (currentIds.has(id)) continue; // user undid the deletion (or this is a stale call) — skip
    localGroupsMap[id] = {
      id,
      name: "",
      orderKey: "z",
      orderUpdatedAt: now,
      updatedAt: now,
      createdAt: now,
      deletedAt: now,
    };
    writtenGroupsSnapshot.delete(id);
    tombstoneApplied.push(id);
    groupsChanged = true;
  }

  const groupsPromise = groupsChanged
    ? writeGroupsWithMerge(dir, localGroupsMap).then(
        () => {
          // Successful write — drop the consumed intents. If the write fails
          // we keep them so the next saveManifest retries automatically.
          for (const id of tombstoneApplied) pendingGroupTombstones.delete(id);
        },
        () => { /* keep pending for retry */ },
      )
    : Promise.resolve();

  // ── 3. Active note id (per-machine) ──
  const activePromise = setActiveNoteIdPersisted(activeId).catch(() => {});

  // ── 4. Local cache for next-boot quick paint ──
  const localCache: LocalCache = {
    version: 2,
    notes: docs.map(({ id, filePath, fileName, createdAt, updatedAt, customName, pinned }) => ({
      id, filePath, fileName, createdAt, updatedAt,
      ...(customName ? { customName } : {}),
      ...(pinned ? { pinned } : {}),
    })),
    groups: groups && groups.length > 0 ? groups : undefined,
    trashedNotes: trashed.length > 0 ? trashed : undefined,
    imageAssetMigrationV1CompletedAt: imageAssetMigrationV1CompletedAtCache ?? undefined,
  };
  const cachePromise = writeLocalCache(localCache);

  await Promise.all([
    Promise.all(metaWrites),
    groupsPromise,
    activePromise,
    cachePromise,
  ]);
}

/**
 * Public persistence entry point. Skips writing while a notes-directory
 * migration / reload is in flight (autosave, useNoteGroups, useFileSystem
 * etc. all funnel through here). The internal `persistDecomposedState` is
 * the actual writer; callers inside the loader's own migration window
 * should invoke that directly.
 */
export async function saveManifest(
  docs: NoteDoc[],
  activeId: string | null,
  groups?: NoteGroup[],
): Promise<void> {
  if (migrationInProgress) return;
  return persistDecomposedState(docs, activeId, groups);
}

// ─────────────────────────────────────────────────────────────────────────────
// useNotesLoader hook
// ─────────────────────────────────────────────────────────────────────────────

export function useNotesLoader(
  locale: Locale,
  notesSortOrder: NotesSortOrder,
  enabled = true,
  reloadKey = 0,
) {
  const [docs, setDocs] = useState<NoteDoc[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [groups, setGroups] = useState<NoteGroup[]>([]);
  const [trashedNotes, setTrashedNotesState] = useState<TrashedNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);

  const setTrashedNotes = (
    updater: TrashedNote[] | ((prev: TrashedNote[]) => TrashedNote[]),
  ) => {
    const next = typeof updater === "function" ? updater(trashedNotesCache) : updater;
    setTrashedNotesCache(next);
    setTrashedNotesState(next);
  };

  useEffect(() => {
    if (reloadKey > 0) {
      initialized.current = false;
      setIsLoading(true);
      resetWriteSnapshots();
    }
  }, [reloadKey]);

  useEffect(() => {
    if (!enabled || initialized.current) return;
    initialized.current = true;

    (async () => {
      // Gate the entire load behind `migrationInProgress` so any autosave
      // timer that fires during the multi-await reload (e.g. the user typed
      // right before clicking Change Path) skips writing instead of stamping
      // the OLD `snapshot.filePath` into a now-cleared directory.
      // Inner legacy / image-asset migrations used to manage this flag
      // themselves; they no longer need to since the outer wrapper covers
      // every disk-touching step.
      setMigrationInProgress(true);
      try {
        await getMachineId();

        const dir = await ensureNotesDir();
        await ensureSharedDirs(dir);

        // ── Quick-paint from local cache while we scan disk ──
        const cache = await readLocalCache();
        if (cache && cache.notes.length > 0) {
          const cachedDocs: NoteDoc[] = cache.notes.map((n) => ({
            ...n,
            isDirty: false,
            content: "",
          } as NoteDoc));
          setDocs(sortNotes(cachedDocs, notesSortOrder, locale));
          if (cache.groups) setGroups(cache.groups);
        }

        // ── Migrate legacy `manifest.json` if present ──
        const legacy = await readLegacyManifestFile(dir);
        if (legacy && Array.isArray(legacy.notes)) {
          await decomposeLegacyManifest(dir, legacy);
          await retireLegacyManifest(dir);
        }

        // ── Absorb OneDrive/Dropbox conflict copies ──
        try {
          await scanAndAbsorbConflicts(dir);
        } catch { /* best-effort */ }

        // ── Load decomposed state from disk ──
        const state = await loadDecomposedState(dir);
        await seedWriteSnapshots(dir);
        let docsLoaded = await attachDocContents(state.docs);

        // ── Image asset URL → file migration (one-time, per-machine) ──
        if (!imageAssetMigrationV1CompletedAtCache) {
          const noteFilePaths = docsLoaded.map((d) => d.filePath).filter(Boolean);
          await migrateDataUrlImagesToAssets(Array.from(new Set(noteFilePaths)));
          imageAssetMigrationV1CompletedAtCache = Date.now();
        }

        // ── Auto-purge expired trash ──
        const purgedTrashed = await purgeExpiredTrash(state.trashedNotes);
        const trashChanged = purgedTrashed.length !== state.trashedNotes.length;
        setTrashedNotes(purgedTrashed);

        // ── Reconcile folder ↔ meta sidecars ──
        const { docs: reconciled, groups: reconciledGroups, changed: reconcileChanged } =
          await reconcileFolder(dir, docsLoaded, state.groups, locale);

        let finalDocs = reconcileChanged ? reconciled : docsLoaded;
        let finalGroups = reconcileChanged ? reconciledGroups : state.groups;

        // ── Bootstrap empty folder with a starter note ──
        if (finalDocs.length === 0) {
          const id = crypto.randomUUID();
          const filePath = `${dir}/${id}.md`;
          const timestamp = Date.now();
          markOwnWrite(filePath, "");
          await writeTextFile(filePath, "");
          await writeMetaFile(dir, {
            version: 2,
            id,
            fileName: getDefaultDocumentTitle(locale),
            createdAt: timestamp,
            updatedAt: timestamp,
            groupId: null,
            trashedAt: null,
          }, getMachineIdCached());
          finalDocs = [{
            id,
            filePath,
            fileName: getDefaultDocumentTitle(locale),
            isDirty: false,
            content: "",
            createdAt: timestamp,
            updatedAt: timestamp,
          }];
        }

        const sorted = sortNotes(finalDocs, notesSortOrder, locale);
        setDocs(sorted);
        setGroups(finalGroups);

        const activeId = state.activeNoteId && sorted.some((d) => d.id === state.activeNoteId)
          ? state.activeNoteId
          : sorted[0]?.id ?? null;
        const nextActiveIndex = activeId
          ? Math.max(sorted.findIndex((d) => d.id === activeId), 0)
          : 0;
        setActiveIndex(nextActiveIndex);

        // Inside the load we own the migration guard (set true at the top of
        // this effect). Call the ungated internal writer directly so we
        // don't have to flip the global flag — the previous "release ->
        // saveManifest -> reacquire" pattern opened a tiny input window in
        // which an autosave timer could schedule against the OLD path.
        if (reconcileChanged || trashChanged) {
          await persistDecomposedState(sorted, activeId, finalGroups).catch(() => {});
        } else {
          await writeLocalCache({
            version: 2,
            notes: sorted.map(({ id, filePath, fileName, createdAt, updatedAt, customName, pinned }) => ({
              id, filePath, fileName, createdAt, updatedAt,
              ...(customName ? { customName } : {}),
              ...(pinned ? { pinned } : {}),
            })),
            groups: finalGroups.length > 0 ? finalGroups : undefined,
            trashedNotes: purgedTrashed.length > 0 ? purgedTrashed : undefined,
            imageAssetMigrationV1CompletedAt: imageAssetMigrationV1CompletedAtCache ?? undefined,
          });
        }
      } catch (err) {
        console.warn("Notes loader failed:", err);
        const timestamp = Date.now();
        setDocs([{
          id: "local",
          filePath: "",
          fileName: getDefaultDocumentTitle(locale),
          isDirty: false,
          content: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        }]);
        setActiveIndex(0);
      } finally {
        setMigrationInProgress(false);
        setIsLoading(false);
      }
    })();
  }, [enabled, locale, notesSortOrder, reloadKey]);

  return { docs, setDocs, activeIndex, setActiveIndex, groups, setGroups, trashedNotes, setTrashedNotes, isLoading };
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown helpers
// ─────────────────────────────────────────────────────────────────────────────

export function stripInlineMarkdown(text: string): string {
  let s = text;
  s = s.replace(/\[\[([^\[\]\n]+)\]\]/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/\*{1,3}(.*?)\*{1,3}/g, "$1");
  s = s.replace(/_{1,3}(.*?)_{1,3}/g, "$1");
  s = s.replace(/~~(.*?)~~/g, "$1");
  s = s.replace(/&[a-zA-Z]+;|&#\d+;/g, " ");
  return s.trim();
}

function stripBlockMarkers(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^(?:>\s*)+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "");
}

export function deriveTitle(content: string): string {
  if (!content) return "";
  const lines = content.trimStart().split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("![") || line.startsWith("<img") || line.startsWith("```")) continue;
    const heading = stripInlineMarkdown(stripBlockMarkers(line));
    if (heading) return heading.slice(0, 20);
  }
  return "";
}

export function stripMarkdownContent(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  const result: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("![") || line.startsWith("<img")) continue;
    if (/^[-*_]{3,}\s*$/.test(line)) continue;

    const plain = stripInlineMarkdown(stripBlockMarkers(line));
    if (plain) result.push(plain);
  }

  return result.join(" ").replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for callers
// ─────────────────────────────────────────────────────────────────────────────

export { metaPathFor, metaDirFor, groupsPathFor };
