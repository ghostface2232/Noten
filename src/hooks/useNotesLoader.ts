import { useState, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile, readDir, remove, rename } from "@tauri-apps/plugin-fs";
import { markOwnWrite } from "./ownWriteTracker";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { getFileTimestamps } from "../utils/fileTimestamps";
import { migrateDataUrlImagesToAssets } from "../utils/migrateImageAssets";
import { removeNoteAssetDir } from "../utils/imageAssetUtils";
import { deriveNoteGroups, groupsToStored, readStoredGroups, writeStoredGroups } from "../utils/groupsIO";
import {
  ensureMetaDir,
  metaToNoteDoc,
  metaToTrashedNote,
  noteDocToMeta,
  readAllNoteMetas,
  readNoteMeta,
  removeNoteMeta,
  writeNoteMeta,
  type NoteMeta,
} from "../utils/metadataIO";
import { getMachineId } from "../utils/machineId";
import { readUiState, updateUiState } from "../utils/uiStateIO";
import { writeManifestCache } from "../utils/manifestCacheIO";
import { joinPath, noteFilePath } from "../utils/storagePaths";
import { detectConflictFile } from "../utils/conflictFileDetector";
import { decomposeLegacyManifest } from "../utils/legacyManifestMigration";

export interface NoteDoc {
  id: string;
  filePath: string;
  fileName: string;
  isDirty: boolean;
  content: string;
  createdAt: number;
  updatedAt: number;
  customName?: boolean;
}

export interface NoteGroup {
  id: string;
  name: string;
  noteIds: string[];
  collapsed: boolean;
  createdAt: number;
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
}

interface Manifest {
  version: 1;
  notes: Omit<NoteDoc, "isDirty" | "content">[];
  activeNoteId: string | null;
  groups?: NoteGroup[];
  trashedNotes?: TrashedNote[];
  imageAssetMigrationV1CompletedAt?: number;
}

const UI_STATE_STORAGE_KEY = "markdown-studio-ui-state";

let notesDirCache: string | null = null;

// --- Module-level trashedNotes cache (avoids disk I/O in saveManifest) ---

let trashedNotesCache: TrashedNote[] = [];
export function getTrashedNotesCache(): TrashedNote[] { return trashedNotesCache; }
export function setTrashedNotesCache(notes: TrashedNote[]) { trashedNotesCache = notes; }

/** Migration in progress — blocks metadata writes */
export let migrationInProgress = false;
export function setMigrationInProgress(v: boolean) { migrationInProgress = v; }

export function sortNotes(docs: NoteDoc[], order: NotesSortOrder, locale: Locale = "en"): NoteDoc[] {
  const sorted = [...docs];
  const desc = order.endsWith("-desc");
  const direction = desc ? -1 : 1;
  const byTitle = order.startsWith("title");
  const byCreated = order.startsWith("created");

  sorted.sort((a, b) => {
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

export async function getNotesDir(): Promise<string> {
  if (notesDirCache) return notesDirCache;
  const base = await appDataDir();
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  notesDirCache = `${base}${sep}notes`;
  return notesDirCache;
}

/** Set the notes directory to a custom path */
export function setNotesDir(dir: string) {
  notesDirCache = dir;
}

/** Reset notes directory cache so getNotesDir() recomputes the default */
export function resetNotesDir() {
  notesDirCache = null;
}

async function ensureNotesDir(): Promise<string> {
  const dir = await getNotesDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

// --- Trash directory ---

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
      if (notesDir) await removeNoteAssetDir(notesDir, note.id);
    } else {
      kept.push(note);
    }
  }

  return kept;
}

// --- Legacy manifest migration ---

async function readLegacyManifestFromFile(dir: string): Promise<Manifest | null> {
  try {
    const raw = await readTextFile(joinPath(dir, "manifest.json"));
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

// --- localStorage fallback (backup / migration source) ---

function readStoredManifest(): Manifest | null {
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

async function readFileContent(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch {
    return "";
  }
}

function groupIdByNote(groups: NoteGroup[] = []): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const group of groups) {
    for (const noteId of group.noteIds) map.set(noteId, group.id);
  }
  return map;
}

export async function persistDocMeta(doc: NoteDoc, groups: NoteGroup[] = []): Promise<void> {
  const dir = await getNotesDir();
  const machineId = await getMachineId();
  await writeNoteMeta(dir, noteDocToMeta(doc, groupIdByNote(groups).get(doc.id) ?? null, machineId));
}

export async function persistGroups(groups: NoteGroup[]): Promise<void> {
  const dir = await getNotesDir();
  const previous = await readStoredGroups(dir);
  await writeStoredGroups(dir, groupsToStored(groups, previous));
}

export async function persistActiveNote(activeId: string | null): Promise<void> {
  await updateUiState((state) => ({
    ...state,
    activeNoteId: activeId,
    lastOpenedNoteId: activeId ?? state.lastOpenedNoteId,
  }));
}

export async function persistGroupCollapsed(groups: NoteGroup[]): Promise<void> {
  await updateUiState((state) => {
    const groupCollapsed = { ...state.groupCollapsed };
    for (const group of groups) groupCollapsed[group.id] = group.collapsed;
    return { ...state, groupCollapsed };
  });
}

async function migrateLegacyManifestIfNeeded(dir: string): Promise<void> {
  const fileLegacy = await readLegacyManifestFromFile(dir);
  const legacy = fileLegacy ?? readStoredManifest();
  if (!legacy) return;

  const machineId = await getMachineId();
  const decomposed = decomposeLegacyManifest(legacy, machineId);
  if (decomposed.groups.length > 0) await writeStoredGroups(dir, decomposed.groups);
  await Promise.all(decomposed.metas.map((meta) => writeNoteMeta(dir, meta)));
  await updateUiState(() => decomposed.uiState);

  if (fileLegacy) {
    const legacyPath = joinPath(dir, "manifest.json");
    const renamedPath = joinPath(dir, "manifest.legacy.json");
    try {
      if (await exists(legacyPath)) {
        markOwnWrite(legacyPath, null);
        await rename(legacyPath, renamedPath);
      }
    } catch {
      // Leave the source in place; loader remains idempotent.
    }
  } else {
    // Consumed the localStorage fallback — clear it so the next launch doesn't
    // reapply this stale snapshot on top of newer per-file metadata.
    try { localStorage.removeItem(UI_STATE_STORAGE_KEY); } catch { /* ignore */ }
  }
}

async function ensureMetaForMarkdownFile(dir: string, entryName: string, locale: Locale): Promise<NoteMeta | null> {
  const id = entryName.replace(/\.md$/, "");
  const existing = await readNoteMeta(dir, id);
  if (existing) return existing;

  const filePath = noteFilePath(dir, id);
  let content = "";
  try { content = await readTextFile(filePath); } catch { return null; }
  const { createdAt, updatedAt } = await getFileTimestamps(filePath);
  const meta: NoteMeta = {
    version: 2,
    id,
    fileName: deriveTitle(content) || getDefaultDocumentTitle(locale),
    createdAt,
    updatedAt,
    groupId: null,
    lastWriterMachineId: await getMachineId(),
  };
  await writeNoteMeta(dir, meta);
  return meta;
}

async function absorbConflictFiles(dir: string, locale: Locale): Promise<void> {
  const entries = await readDir(dir).catch(() => []);
  for (const entry of entries) {
    if (!entry.name) continue;
    const detected = detectConflictFile(entry.name);
    if (!detected) continue;

    const sourcePath = joinPath(dir, entry.name);
    if (detected.kind === "note") {
      const content = await readTextFile(sourcePath).catch(() => "");
      const id = crypto.randomUUID();
      const filePath = noteFilePath(dir, id);
      const now = Date.now();
      markOwnWrite(filePath);
      await writeTextFile(filePath, content).catch(() => {});
      await writeNoteMeta(dir, {
        version: 2,
        id,
        fileName: `${deriveTitle(content) || getDefaultDocumentTitle(locale)} (${detected.marker})`,
        customName: true,
        createdAt: now,
        updatedAt: now,
        groupId: null,
        lastWriterMachineId: await getMachineId(),
      });
      await remove(sourcePath).catch(() => {});
    }
  }
}

// --- Startup reconciliation: folder ↔ manifest ---

export function getFileBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export async function reconcileFolder(
  dir: string,
  docs: NoteDoc[],
  groups: NoteGroup[],
  locale: Locale,
): Promise<{ docs: NoteDoc[]; groups: NoteGroup[]; changed: boolean }> {
  let entries: { name?: string }[];
  try {
    entries = await readDir(dir);
  } catch {
    return { docs, groups, changed: false };
  }

  const mdFiles = entries.filter((e) => e.name?.endsWith(".md"));
  const folderFileNames = new Set(mdFiles.map((e) => e.name!));
  const docFileNames = new Set(docs.map((d) => getFileBaseName(d.filePath)));

  let changed = false;
  let nextDocs = [...docs];
  let nextGroups = [...groups];

  // Add files in folder but missing from manifest
  for (const entry of mdFiles) {
    const name = entry.name!;
    if (docFileNames.has(name)) continue;

    const filePath = `${dir}/${name}`;
    let content = "";
    try { content = await readTextFile(filePath); } catch { continue; }

    const id = name.replace(/\.md$/, "");
    const { createdAt, updatedAt } = await getFileTimestamps(filePath);
    nextDocs.push({
      id,
      filePath,
      fileName: deriveTitle(content) || getDefaultDocumentTitle(locale),
      isDirty: false,
      content,
      createdAt,
      updatedAt,
    });
    changed = true;
  }

  // Remove docs whose files no longer exist
  const beforeLen = nextDocs.length;
  const removedIds = new Set<string>();
  nextDocs = nextDocs.filter((d) => {
    if (!d.filePath) return true;
    const name = getFileBaseName(d.filePath);
    if (folderFileNames.has(name)) return true;
    removedIds.add(d.id);
    return false;
  });
  if (nextDocs.length !== beforeLen) {
    changed = true;
    nextGroups = nextGroups.map((g) => ({
      ...g,
      noteIds: g.noteIds.filter((id) => !removedIds.has(id)),
    })).filter((g) => g.noteIds.length > 0);
  }

  return { docs: nextDocs, groups: nextGroups, changed };
}

export async function saveManifest(
  docs: NoteDoc[],
  activeId: string | null,
  groups?: NoteGroup[],
): Promise<void> {
  if (migrationInProgress) return;

  try {
    const dir = await getNotesDir();
    const machineId = await getMachineId();
    const noteGroups = groups ?? [];
    const groupMap = groupIdByNote(noteGroups);
    await Promise.all(docs.map((doc) => writeNoteMeta(
      dir,
      noteDocToMeta(doc, groupMap.get(doc.id) ?? null, machineId),
    )));

    await Promise.all(trashedNotesCache.map(async (note) => {
      const existing = await readNoteMeta(dir, note.id);
      await writeNoteMeta(dir, {
        version: 2,
        id: note.id,
        fileName: note.fileName,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        groupId: note.groupId,
        trashedAt: note.trashedAt,
        lastWriterMachineId: existing?.lastWriterMachineId ?? machineId,
        imageAssetMigrationV1CompletedAt: existing?.imageAssetMigrationV1CompletedAt,
      });
    }));

    // Remove orphan .meta/<id>.json for ids that no longer appear in either set
    // — e.g. when a .md file was deleted externally and reconcileFolder dropped
    // the doc. Otherwise readAllNoteMetas would resurrect it as an empty note.
    const validIds = new Set<string>([
      ...docs.map((d) => d.id),
      ...trashedNotesCache.map((t) => t.id),
    ]);
    const metaDir = await ensureMetaDir(dir);
    const metaEntries = await readDir(metaDir).catch(() => []);
    await Promise.all(metaEntries.map(async (entry) => {
      const name = entry.name;
      if (!name?.endsWith(".json") || name.endsWith(".tmp")) return;
      const id = name.replace(/\.json$/, "");
      if (!validIds.has(id)) await removeNoteMeta(dir, id);
    }));

    if (groups) {
      await persistGroups(groups);
      await persistGroupCollapsed(groups);
    }
    await persistActiveNote(activeId);
    await writeManifestCache(dir, {
      metas: await readAllNoteMetas(dir),
      groups: groups ?? [],
      trashedNotes: trashedNotesCache,
    }).catch(() => {});
  } catch {
    console.warn("Failed to persist note metadata.");
  }
}

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

  // Keep module-level cache in sync — updated synchronously (not deferred by React batching)
  const setTrashedNotes = (updater: TrashedNote[] | ((prev: TrashedNote[]) => TrashedNote[])) => {
    const next = typeof updater === "function" ? updater(trashedNotesCache) : updater;
    setTrashedNotesCache(next);
    setTrashedNotesState(next);
  };

  // Reset initialized when reloadKey changes so the effect re-runs
  useEffect(() => {
    if (reloadKey > 0) {
      initialized.current = false;
      setIsLoading(true);
    }
  }, [reloadKey]);

  useEffect(() => {
    if (!enabled || initialized.current) return;
    initialized.current = true;

    (async () => {
      try {
        const dir = await ensureNotesDir();
        await migrateLegacyManifestIfNeeded(dir);
        await absorbConflictFiles(dir, locale);

        const entries = await readDir(dir).catch(() => []);
        const markdownEntries = entries.filter((entry) => entry.name?.endsWith(".md") && !entry.name.endsWith(".tmp"));
        await Promise.all(markdownEntries.map((entry) => ensureMetaForMarkdownFile(dir, entry.name!, locale)));

        let metas = await readAllNoteMetas(dir);
        const liveMetas = metas.filter((meta) => !meta.trashedAt);
        let foundNotes = await Promise.all(
          liveMetas.map(async (meta) => {
            const filePath = noteFilePath(dir, meta.id);
            const content = await readFileContent(filePath);
            if (!meta.imageAssetMigrationV1CompletedAt) {
              setMigrationInProgress(true);
              try {
                await migrateDataUrlImagesToAssets([filePath]);
                meta.imageAssetMigrationV1CompletedAt = Date.now();
                await writeNoteMeta(dir, meta);
              } finally {
                setMigrationInProgress(false);
              }
            }
            return metaToNoteDoc(meta, dir, content);
          }),
        );

        if (foundNotes.length === 0) {
          const id = crypto.randomUUID();
          const filePath = noteFilePath(dir, id);
          const timestamp = Date.now();
          markOwnWrite(filePath);
          await writeTextFile(filePath, "");
          const meta: NoteMeta = {
            version: 2,
            id,
            fileName: getDefaultDocumentTitle(locale),
            createdAt: timestamp,
            updatedAt: timestamp,
            groupId: null,
            lastWriterMachineId: await getMachineId(),
          };
          await writeNoteMeta(dir, meta);
          foundNotes = [metaToNoteDoc(meta, dir, "")];
          metas = [meta];
        }

        const rawTrashed = metas
          .map((meta) => metaToTrashedNote(meta, dir))
          .filter((note): note is TrashedNote => note !== null);
        const purgedTrashed = await purgeExpiredTrash(rawTrashed);
        setTrashedNotes(purgedTrashed);

        const uiState = await readUiState();
        const storedGroups = await readStoredGroups(dir);
        const finalGroups = deriveNoteGroups(storedGroups, metas, uiState.groupCollapsed);
        const sorted = sortNotes(foundNotes, notesSortOrder, locale);
        setDocs(sorted);
        setGroups(finalGroups);

        const activeId = uiState.activeNoteId ?? uiState.lastOpenedNoteId ?? sorted[0]?.id ?? null;
        const nextActiveIndex = activeId
          ? sorted.findIndex((doc) => doc.id === activeId)
          : 0;
        const safeActiveIndex = nextActiveIndex >= 0 ? nextActiveIndex : 0;
        setActiveIndex(safeActiveIndex);
        await saveManifest(sorted, sorted[safeActiveIndex]?.id ?? null, finalGroups).catch(() => {});
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
        setIsLoading(false);
      }
    })();
  }, [enabled, locale, notesSortOrder, reloadKey]);

  return { docs, setDocs, activeIndex, setActiveIndex, groups, setGroups, trashedNotes, setTrashedNotes, isLoading };
}

export function stripInlineMarkdown(text: string): string {
  let s = text;
  // wiki links: [[Title]] → Title (must run before the regular link strip so
  // the outer brackets of the wiki-link syntax don't get treated as markdown
  // link text).
  s = s.replace(/\[\[([^\[\]\n]+)\]\]/g, "$1");
  // links: [text](url) → text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // inline code
  s = s.replace(/`([^`]*)`/g, "$1");
  // bold/italic (order matters: longest markers first)
  s = s.replace(/\*{1,3}(.*?)\*{1,3}/g, "$1");
  s = s.replace(/_{1,3}(.*?)_{1,3}/g, "$1");
  // strikethrough
  s = s.replace(/~~(.*?)~~/g, "$1");
  // HTML entities
  s = s.replace(/&[a-zA-Z]+;|&#\d+;/g, " ");
  return s.trim();
}

function stripBlockMarkers(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^(?:>\s*)+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    // task list checkbox: [ ], [x], [X] (with optional trailing whitespace)
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
