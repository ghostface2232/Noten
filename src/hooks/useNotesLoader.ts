import { useState, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import {
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { tauriFileSystem } from "../utils/fs";
import { normalizeSep } from "../utils/pathUtils";
import { reconcileFolder, createReconcileState, clearReconcileState, type ReconcileState } from "../utils/reconcileFolder";
import {
  createPersistState,
  clearPersistState,
  persistDecomposedState as persistDecomposedStateImpl,
  loadDecomposedState as loadDecomposedStateImpl,
  seedWriteSnapshots as seedWriteSnapshotsImpl,
  syncGroupsSnapshotFromDisk as syncGroupsSnapshotFromDiskImpl,
  readLocalCache as readLocalCacheImpl,
  writeLocalCache as writeLocalCacheImpl,
  buildGroupsFromShared,
  type LocalCache,
  type DecomposedState,
} from "../utils/decomposedState";
import { markOwnWrite } from "./ownWriteTracker";
import { isValidNoteId } from "../utils/noteId";
import { NotenError } from "../utils/notenError";
import { logNotenError } from "../utils/crashLog";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import type { NoteColorId } from "../utils/noteColors";
import type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
export type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
export { deriveTitle, getFileBaseName, stripInlineMarkdown, stripMarkdownContent } from "../utils/noteText";
import { migrateDataUrlImagesToAssets } from "../utils/migrateImageAssets";
import { removeNoteAssetDir } from "../utils/imageAssetUtils";
import {
  metaPathFor,
  metaDirFor,
  readAllMeta,
  writeMeta as writeMetaFile,
  removeMeta as removeMetaFile,
  invalidateReadAllMetaCache,
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
} from "../utils/conflictBackup";
import {
  getUiStateCached,
  loadUiState,
  setActiveNoteIdPersisted,
  setGroupCollapsedPersisted,
} from "./useUiState";

let notesDirCache: string | null = null;
let imageAssetMigrationV1CompletedAtCache: number | null = null;
let trashedNotesCache: TrashedNote[] = [];
export function getTrashedNotesCache(): TrashedNote[] { return trashedNotesCache; }
export function setTrashedNotesCache(notes: TrashedNote[]) { trashedNotesCache = notes; }

/** Blocks public persistence while the notes directory is moving or reloading. */
export let migrationInProgress = false;
export function setMigrationInProgress(v: boolean) { migrationInProgress = v; }

// Single bundle of diff caches and pending writes. External helpers below
// (markGroupAsDeleted etc.) mutate this bundle so callers in useFileSystem,
// useNoteGroups, and useWindowSync don't need to thread it explicitly.
const persistState = createPersistState();

// Monotonic logical clock for group deletions. `markGroupAsDeleted` stamps each
// tombstone with the next value; `saveManifest` captures the current value when
// a save is ENQUEUED. Comparing the two at drain time lets persist tell a
// genuine resurrection (save enqueued after the delete) from a slow in-flight
// save whose groups snapshot predates the delete, so the latter can no longer
// cancel the tombstone and revive the group (P0-4).
let groupMutationSeq = 0;

export function markGroupMembershipChanged(noteId: string, groupId: string | null, updatedAt = Date.now()): void {
  persistState.pendingGroupMembership.set(noteId, { groupId, updatedAt });
}

export function markGroupMembershipChanges(
  noteIds: string[],
  groupId: string | null,
  updatedAt = Date.now(),
): void {
  for (const noteId of noteIds) {
    persistState.pendingGroupMembership.set(noteId, { groupId, updatedAt });
  }
}

export function markGroupAsDeleted(id: string): void {
  persistState.pendingTombstones.set(id, ++groupMutationSeq);
}

export function unmarkGroupAsDeleted(id: string): void {
  persistState.pendingTombstones.delete(id);
}

function resetWriteSnapshots() {
  clearPersistState(persistState);
}

async function seedWriteSnapshots(dir: string): Promise<void> {
  await seedWriteSnapshotsImpl(tauriFileSystem, dir, persistState);
}

export async function syncGroupsSnapshotFromDisk(dir: string): Promise<void> {
  await syncGroupsSnapshotFromDiskImpl(tauriFileSystem, dir, persistState);
}

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

/** The app-data fallback directory, without touching the active-dir cache. */
export async function getDefaultNotesDir(): Promise<string> {
  const base = await appDataDir();
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  return `${base}${sep}notes`;
}

export async function getNotesDir(): Promise<string> {
  if (notesDirCache) return notesDirCache;
  notesDirCache = await getDefaultNotesDir();
  return notesDirCache;
}

/**
 * Cleared state mirrors the active notes directory; pass the ReconcileState
 * instance so its bodyMissing observations are reset alongside the snapshot
 * caches. Callers that omit it accept that the observations will carry over.
 */
export function setNotesDir(dir: string, reconcileState?: ReconcileState) {
  notesDirCache = dir;
  imageAssetMigrationV1CompletedAtCache = null;
  resetWriteSnapshots();
  resetKnownDiskContent();
  invalidateReadAllMetaCache(tauriFileSystem);
  if (reconcileState) clearReconcileState(reconcileState);
}

export function resetNotesDir(reconcileState?: ReconcileState) {
  notesDirCache = null;
  imageAssetMigrationV1CompletedAtCache = null;
  resetWriteSnapshots();
  resetKnownDiskContent();
  invalidateReadAllMetaCache(tauriFileSystem);
  if (reconcileState) clearReconcileState(reconcileState);
}

async function ensureNotesDir(): Promise<string> {
  const dir = await getNotesDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

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
  try {
    notesDir = await getNotesDir();
  } catch (err) {
    // Trash body removal below still works (absolute trashFilePath), but the
    // asset-dir and meta sidecar cleanups depend on notesDir and now get
    // skipped. Orphan files are recoverable on next launch's reconcile, but
    // the partial-cleanup state should be diagnosable.
    void logNotenError(new NotenError(
      "TRASH_PURGE_FAILED",
      "recoverable",
      "purgeExpiredTrash: getNotesDir failed; bodies removed but meta/assets stay orphaned",
      { cause: err },
    ));
  }

  for (const note of trashedNotes) {
    // Defense-in-depth: an unsafe id here drives recursive deletes
    // (removeNoteAssetDir). Upstream validation should prevent it, but never
    // purge such an entry — keep it visible/inert so the bad sidecar can be
    // diagnosed rather than acted on.
    if (!isValidNoteId(note.id)) {
      void logNotenError(new NotenError(
        "INVALID_NOTE_ID",
        "recoverable",
        "purgeExpiredTrash: skipping trashed note with unsafe id",
        { context: { noteId: note.id } },
      ));
      kept.push(note);
      continue;
    }
    if (now - note.trashedAt > TRASH_RETENTION_MS) {
      try { await tauriFileSystem.remove(note.trashFilePath); } catch { /* file may already be gone */ }
      if (notesDir) {
        await removeNoteAssetDir(notesDir, note.id);
        await removeMetaFile(tauriFileSystem, notesDir, note.id);
      }
    } else {
      kept.push(note);
    }
  }

  return kept;
}

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

async function readLocalCache(notesDir: string): Promise<LocalCache | null> {
  const path = await getLocalCachePath();
  const cache = await readLocalCacheImpl(tauriFileSystem, path, notesDir);
  if (cache) imageAssetMigrationV1CompletedAtCache = cache.imageAssetMigrationV1CompletedAt ?? null;
  return cache;
}

/**
 * Returns `null` on read failure rather than `""`, because a transient
 * cloud-sync read failure followed by an empty-string fallback would poison
 * the in-memory doc: the user sees a blank note, edits it, and autosave
 * overwrites the real on-disk body. Callers must skip the doc on `null` so
 * the next load (or watcher event) retries the read.
 */
async function readFileContent(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch (err) {
    void logNotenError(new NotenError(
      "BODY_READ_FAILED",
      "recoverable",
      "useNotesLoader: body read failed; deferring doc until next load",
      { context: { filePath: path }, cause: err },
    ));
    return null;
  }
}

/** Load groups from disk; membership is derived from per-note `groupId`. */
export async function loadGroupsFromDisk(dir: string): Promise<NoteGroup[]> {
  await loadUiState();
  const file = await readGroupsFile(tauriFileSystem, dir);
  const allMeta = await readAllMeta(tauriFileSystem, dir);
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

async function loadDecomposedState(dir: string): Promise<DecomposedState> {
  return loadDecomposedStateImpl(tauriFileSystem, dir, getUiStateCached());
}

async function attachDocContents(docs: NoteDoc[]): Promise<NoteDoc[]> {
  const results = await Promise.all(
    docs.map(async (d) => {
      const content = await readFileContent(d.filePath);
      if (content === null) return null;
      if (d.filePath) setKnownDiskContent(d.filePath, content);
      return { ...d, content } as NoteDoc;
    }),
  );
  return results.filter((d): d is NoteDoc => d !== null);
}

interface LegacyManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  color?: NoteColorId;
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
  color?: NoteColorId;
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
    await writeGroupsWithMerge(tauriFileSystem, dir, sharedGroups);
  }

  for (const n of manifest.notes ?? []) {
    if (!isValidNoteId(n.id)) continue;
    await writeMetaFile(tauriFileSystem, dir, {
      version: 2,
      id: n.id,
      fileName: n.fileName,
      customName: n.customName || undefined,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      pinned: n.pinned === true,
      color: n.color,
      groupId: noteIdToGroupId.get(n.id) ?? null,
      groupUpdatedAt: n.updatedAt,
      trashedAt: null,
    }, machineId);
  }

  for (const t of manifest.trashedNotes ?? []) {
    if (!isValidNoteId(t.id)) continue;
    await writeMetaFile(tauriFileSystem, dir, {
      version: 2,
      id: t.id,
      fileName: t.fileName,
      customName: undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      pinned: t.pinned === true,
      color: t.color,
      groupId: t.groupId ?? null,
      groupUpdatedAt: t.updatedAt,
      trashedAt: t.trashedAt,
      trashedFromPath: t.originalFilePath,
    }, machineId);
  }

  if (manifest.activeNoteId) {
    await setActiveNoteIdPersisted(manifest.activeNoteId);
  }
  for (const [gid, collapsed] of Object.entries(collapsedMap)) {
    if (collapsed) await setGroupCollapsedPersisted(gid, true);
  }

  if (manifest.imageAssetMigrationV1CompletedAt) {
    imageAssetMigrationV1CompletedAtCache = manifest.imageAssetMigrationV1CompletedAt;
  }
}


// Ungated writer used by the loader while it already owns `migrationInProgress`.
// External callers should use `saveManifest`.
async function persistDecomposedState(
  docs: NoteDoc[],
  activeId: string | null,
  groups?: NoteGroup[],
  source?: string,
  snapshotSeq?: number,
): Promise<void> {
  const dir = await getNotesDir();
  const cachePath = await getLocalCachePath();
  try {
    await persistDecomposedStateImpl(tauriFileSystem, dir, persistState, docs, activeId, groups, {
      trashedNotes: trashedNotesCache,
      machineId: getMachineIdCached(),
      cachePath,
      imageAssetMigrationCompletedAt: imageAssetMigrationV1CompletedAtCache,
      setActiveNoteId: setActiveNoteIdPersisted,
      // Fall back to the live counter for direct loader calls (which run while
      // pendingTombstones is empty, so the value is moot). Chained saves pass
      // the value captured at enqueue time.
      groupsSnapshotSeq: snapshotSeq ?? groupMutationSeq,
    });
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[PERSIST_FAILED]", err);
    void logNotenError(new NotenError(
      "PERSIST_FAILED",
      "fatal",
      err instanceof Error ? err.message : String(err),
      { context: { dir, docCount: docs.length, activeId, source }, cause: err },
    ));
    throw err;
  }
}

// Serializes ALL manifest writes within this window through a single chain.
// Without it, concurrent callers (autosave + watcher reconcile, sidebar action
// + autosave, etc.) raced: the later call's stale snapshot could finish first
// and the earlier one would overwrite disk on resolve. Chaining preserves
// call-time ordering on disk; .catch(() => undefined) keeps a failed entry
// from breaking subsequent writes. Multi-window races are a separate problem
// — this chain lives per-process, so each window has its own queue.
let persistChain: Promise<unknown> = Promise.resolve();

export async function saveManifest(
  docs: NoteDoc[],
  activeId: string | null,
  groups?: NoteGroup[],
  source?: string,
): Promise<void> {
  if (migrationInProgress) return;
  // Capture the deletion clock at ENQUEUE time. A tombstone recorded after this
  // point carries a higher sequence, so when this (now-stale) save finally
  // drains it can no longer cancel that tombstone. See P0-4.
  const snapshotSeq = groupMutationSeq;
  const job = persistChain
    .catch(() => undefined)
    .then(() => persistDecomposedState(docs, activeId, groups, source, snapshotSeq));
  persistChain = job;
  return job;
}

export function useNotesLoader(
  locale: Locale,
  notesSortOrder: NotesSortOrder,
  enabled = true,
  reloadKey = 0,
  reconcileState?: ReconcileState,
) {
  const reconcileStateRef = useRef<ReconcileState>(reconcileState ?? createReconcileState());
  if (reconcileState && reconcileStateRef.current !== reconcileState) {
    reconcileStateRef.current = reconcileState;
  }
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
      // bodyMissing counters belong to reconcileState (not PersistState),
      // so resetWriteSnapshots leaves them stale. Without clearing, a
      // sidecar that was bodyless on pass N-1 would be deleted on the
      // very next reload pass — bypassing the 2-pass cloud-sync grace.
      clearReconcileState(reconcileStateRef.current);
    }
  }, [reloadKey]);

  useEffect(() => {
    if (!enabled || initialized.current) return;
    initialized.current = true;

    (async () => {
      // Keep autosave out while load/reload paths touch multiple disk files.
      setMigrationInProgress(true);
      // Snapshot of the best valid state we've reached so far. If a later
      // step throws, the outer catch falls back to this instead of nuking
      // the user's visible notes down to a single blank stub. On reload,
      // seed from current hook state so an early throw (before any new
      // checkpoint is reached) still preserves what the user already sees.
      let safeDocs: NoteDoc[] | null = docs.length > 0 ? docs : null;
      let safeGroups: NoteGroup[] | null = docs.length > 0 ? groups : null;
      let safeActiveId: string | null = docs[activeIndex]?.id ?? null;
      try {
        await getMachineId();
        await loadUiState();

        const dir = await ensureNotesDir();
        await ensureSharedDirs(tauriFileSystem, dir);

        const cache = await readLocalCache(dir);
        if (cache && cache.notes.length > 0) {
          const cachedDocs: NoteDoc[] = cache.notes.map((n) => ({
            ...n,
            isDirty: false,
            content: "",
          } as NoteDoc));
          setDocs(sortNotes(cachedDocs, notesSortOrder, locale));
          if (cache.groups) setGroups(cache.groups);
          safeDocs = cachedDocs;
          safeGroups = cache.groups ?? [];
          safeActiveId = getUiStateCached().activeNoteId ?? null;
        }

        const legacy = await readLegacyManifestFile(dir);
        if (legacy && Array.isArray(legacy.notes)) {
          await decomposeLegacyManifest(dir, legacy);
          await retireLegacyManifest(tauriFileSystem, dir);
        }

        try {
          await scanAndAbsorbConflicts(tauriFileSystem, dir);
        } catch { /* best-effort */ }

        const state = await loadDecomposedState(dir);
        await seedWriteSnapshots(dir);
        let docsLoaded = await attachDocContents(state.docs);
        if (state.docs.length > 0 && docsLoaded.length === 0) {
          throw new NotenError(
            "BODY_READ_FAILED",
            "recoverable",
            "useNotesLoader: all persisted note bodies were unreadable; deferring blank-note creation",
            { context: { dir, docCount: state.docs.length } },
          );
        }
        if (docsLoaded.length > 0) {
          safeDocs = docsLoaded;
          safeGroups = state.groups;
          safeActiveId = state.activeNoteId ?? null;
        }

        if (!imageAssetMigrationV1CompletedAtCache) {
          const noteFilePaths = docsLoaded.map((d) => d.filePath).filter(Boolean);
          const imageMigration = await migrateDataUrlImagesToAssets(Array.from(new Set(noteFilePaths)));
          if (imageMigration.changedFiles > 0) {
            docsLoaded = await attachDocContents(docsLoaded);
            if (docsLoaded.length > 0) safeDocs = docsLoaded;
          }
          imageAssetMigrationV1CompletedAtCache = Date.now();
        }

        const purgedTrashed = await purgeExpiredTrash(state.trashedNotes);
        const trashChanged = purgedTrashed.length !== state.trashedNotes.length;
        setTrashedNotes(purgedTrashed);

        let reconciled: NoteDoc[];
        let reconciledGroups: NoteGroup[];
        let reconcileChanged: boolean;
        try {
          const result = await reconcileFolder(tauriFileSystem, reconcileStateRef.current, dir, docsLoaded, state.groups, locale);
          reconciled = result.docs;
          reconciledGroups = result.groups;
          reconcileChanged = result.changed;
        } catch (err) {
          if (import.meta.env.DEV) console.warn("[RECONCILE_FAILED:loader]", err);
          void logNotenError(new NotenError(
            "RECONCILE_FAILED",
            "fatal",
            err instanceof Error ? err.message : String(err),
            { context: { dir, docCount: docsLoaded.length, source: "loader" }, cause: err },
          ));
          throw err;
        }

        let finalDocs = reconcileChanged ? reconciled : docsLoaded;
        let finalGroups = reconcileChanged ? reconciledGroups : state.groups;

        if (finalDocs.length === 0) {
          const id = crypto.randomUUID();
          const filePath = `${dir}/${id}.md`;
          const timestamp = Date.now();
          markOwnWrite(filePath, "");
          await writeTextFile(filePath, "");
          await writeMetaFile(tauriFileSystem, dir, {
            version: 2,
            id,
            fileName: getDefaultDocumentTitle(locale),
            createdAt: timestamp,
            updatedAt: timestamp,
            groupId: null,
            groupUpdatedAt: timestamp,
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

        safeDocs = sorted;
        safeGroups = finalGroups;
        safeActiveId = activeId;

        // The loader owns the migration guard, so use the ungated writer here.
        if (reconcileChanged || trashChanged) {
          await persistDecomposedState(sorted, activeId, finalGroups).catch(() => {});
        } else {
          const cachePath = await getLocalCachePath();
          await writeLocalCacheImpl(tauriFileSystem, cachePath, {
            version: 2,
            notesDirectory: dir,
            notes: sorted.map(({ id, filePath, fileName, createdAt, updatedAt, customName, pinned, color }) => ({
              id, filePath, fileName, createdAt, updatedAt,
              ...(customName ? { customName } : {}),
              ...(pinned ? { pinned } : {}),
              ...(color ? { color } : {}),
            })),
            groups: finalGroups.length > 0 ? finalGroups : undefined,
            trashedNotes: purgedTrashed.length > 0 ? purgedTrashed : undefined,
            imageAssetMigrationV1CompletedAt: imageAssetMigrationV1CompletedAtCache ?? undefined,
          });
        }
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn("Notes loader failed:", err);
        }
        // Preserve whatever we'd already loaded. The stub is only a sane
        // fallback when we have nothing — wiping a populated list to a
        // single blank note loses the user's notes visually even though
        // they are still on disk.
        if (safeDocs && safeDocs.length > 0) {
          const sorted = sortNotes(safeDocs, notesSortOrder, locale);
          setDocs(sorted);
          setGroups(safeGroups ?? []);
          const idx = safeActiveId
            ? Math.max(sorted.findIndex((d) => d.id === safeActiveId), 0)
            : 0;
          setActiveIndex(idx);
        } else {
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
        }
      } finally {
        setMigrationInProgress(false);
        setIsLoading(false);
      }
    })();
  }, [enabled, locale, notesSortOrder, reloadKey]);

  return { docs, setDocs, activeIndex, setActiveIndex, groups, setGroups, trashedNotes, setTrashedNotes, isLoading };
}

export { metaPathFor, metaDirFor, groupsPathFor };
