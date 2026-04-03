import { useState, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile, readDir, remove } from "@tauri-apps/plugin-fs";
import { markOwnWrite } from "./ownWriteTracker";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { getFileTimestamps } from "../utils/fileTimestamps";

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
}

const UI_STATE_STORAGE_KEY = "markdown-studio-ui-state";

let notesDirCache: string | null = null;

// --- Module-level trashedNotes cache (avoids disk I/O in saveManifest) ---

let trashedNotesCache: TrashedNote[] = [];
export function getTrashedNotesCache(): TrashedNote[] { return trashedNotesCache; }
export function setTrashedNotesCache(notes: TrashedNote[]) { trashedNotesCache = notes; }

/** Migration in progress — blocks saveManifest writes */
export let migrationInProgress = false;
export function setMigrationInProgress(v: boolean) { migrationInProgress = v; }

export function sortNotes(docs: NoteDoc[], order: NotesSortOrder): NoteDoc[] {
  const sorted = [...docs];
  const desc = order.endsWith("-desc");
  const direction = desc ? -1 : 1;
  const byCreated = order.startsWith("created");

  sorted.sort((a, b) => {
    const primaryDiff = byCreated
      ? a.createdAt - b.createdAt
      : a.updatedAt - b.updatedAt;
    if (primaryDiff !== 0) return primaryDiff * direction;

    const secondaryDiff = byCreated
      ? a.updatedAt - b.updatedAt
      : a.createdAt - b.createdAt;
    if (secondaryDiff !== 0) return secondaryDiff * direction;

    return a.fileName.localeCompare(b.fileName);
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

  for (const note of trashedNotes) {
    if (now - note.trashedAt > TRASH_RETENTION_MS) {
      try { await remove(note.trashFilePath); } catch { /* file may already be gone */ }
    } else {
      kept.push(note);
    }
  }

  return kept;
}

// --- File-based manifest ---

async function readManifestFromFile(dir: string): Promise<Manifest | null> {
  try {
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    const raw = await readTextFile(`${dir}${sep}manifest.json`);
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

async function writeManifestToFile(dir: string, manifest: Manifest): Promise<void> {
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  const manifestPath = `${dir}${sep}manifest.json`;
  markOwnWrite(manifestPath);
  await writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
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

function writeStoredManifest(manifest: Manifest) {
  localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(manifest));
}

// --- Unified manifest read/write ---

async function readManifest(dir: string): Promise<Manifest | null> {
  // Primary: file-based manifest
  const fileManifest = await readManifestFromFile(dir);
  if (fileManifest) return fileManifest;

  // Fallback: localStorage (one-time migration)
  const lsManifest = readStoredManifest();
  if (lsManifest) {
    // Migrate to file-based
    try {
      await writeManifestToFile(dir, lsManifest);
    } catch {
      console.warn("Failed to migrate manifest from localStorage to file.");
    }
    return lsManifest;
  }

  return null;
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeManifestToFile(dir, manifest);
  // Also write to localStorage as backup
  writeStoredManifest(manifest);
}

async function readFileContent(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch {
    return "";
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

  const trashed = trashedNotesCache;
  const manifest: Manifest = {
    version: 1,
    notes: docs.map(({ id, filePath, fileName, createdAt, updatedAt, customName }) => ({
      id,
      filePath,
      fileName,
      createdAt,
      updatedAt,
      ...(customName ? { customName } : {}),
    })),
    activeNoteId: activeId,
    groups: groups && groups.length > 0 ? groups : undefined,
    trashedNotes: trashed.length > 0 ? trashed : undefined,
  };

  try {
    const dir = await getNotesDir();
    await writeManifest(dir, manifest);
  } catch {
    console.warn("Failed to persist UI state manifest.");
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
        const manifest = await readManifest(dir);

        // Auto-purge expired trash on startup
        const rawTrashed = manifest?.trashedNotes ?? [];
        const purgedTrashed = await purgeExpiredTrash(rawTrashed);
        const trashChanged = purgedTrashed.length !== rawTrashed.length;
        setTrashedNotes(purgedTrashed);

        if (manifest && manifest.notes.length > 0) {
          const loaded = await Promise.all(
            manifest.notes.map(async (entry) => {
              const content = await readFileContent(entry.filePath);
              return { ...entry, isDirty: false, content } as NoteDoc;
            }),
          );

          // Reconcile: pick up new .md files not in manifest, drop missing ones
          const { docs: reconciled, groups: reconciledGroups, changed: reconcileChanged } =
            await reconcileFolder(dir, loaded, manifest.groups ?? [], locale);

          const finalDocs = reconcileChanged ? reconciled : loaded;
          const finalGroups = reconcileChanged ? reconciledGroups : (manifest.groups ?? []);

          const sorted = sortNotes(finalDocs, notesSortOrder);
          setDocs(sorted);
          setGroups(finalGroups);

          const activeId = manifest.activeNoteId ?? sorted[0]?.id ?? null;
          const nextActiveIndex = activeId
            ? sorted.findIndex((doc) => doc.id === activeId)
            : 0;
          setActiveIndex(nextActiveIndex >= 0 ? nextActiveIndex : 0);

          // Persist if reconciliation or trash purge made changes
          if (reconcileChanged || trashChanged) {
            const aid = sorted[nextActiveIndex >= 0 ? nextActiveIndex : 0]?.id ?? null;
            await saveManifest(sorted, aid, finalGroups).catch(() => {});
          }
        } else {
          let foundNotes: NoteDoc[] = [];

          try {
            const entries = await readDir(dir);
            const markdownEntries = entries.filter((entry) => entry.name?.endsWith(".md"));
            foundNotes = await Promise.all(
              markdownEntries.map(async (entry) => {
                const id = entry.name!.replace(/\.md$/, "");
                const filePath = `${dir}/${entry.name}`;
                const content = await readFileContent(filePath);
                const { createdAt, updatedAt } = await getFileTimestamps(filePath);
                return {
                  id,
                  filePath,
                  fileName: deriveTitle(content) || getDefaultDocumentTitle(locale),
                  isDirty: false,
                  content,
                  createdAt,
                  updatedAt,
                } as NoteDoc;
              }),
            );
          } catch {
            console.warn("Failed to scan notes directory.");
          }

          if (foundNotes.length === 0) {
            const id = crypto.randomUUID();
            const filePath = `${dir}/${id}.md`;
            const timestamp = Date.now();
            await writeTextFile(filePath, "");
            foundNotes = [{
              id,
              filePath,
              fileName: getDefaultDocumentTitle(locale),
              isDirty: false,
              content: "",
              createdAt: timestamp,
              updatedAt: timestamp,
            }];
          }

          const sorted = sortNotes(foundNotes, notesSortOrder);
          setDocs(sorted);
          setActiveIndex(0);
          await saveManifest(sorted, sorted[0]?.id ?? null);
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
        setIsLoading(false);
      }
    })();
  }, [enabled, locale, notesSortOrder, reloadKey]);

  return { docs, setDocs, activeIndex, setActiveIndex, groups, setGroups, trashedNotes, setTrashedNotes, isLoading };
}

function stripInlineMarkdown(text: string): string {
  let s = text;
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

export function deriveTitle(content: string): string {
  if (!content) return "";
  const lines = content.trimStart().split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // skip images and code fences
    if (line.startsWith("![") || line.startsWith("<img") || line.startsWith("```")) continue;
    const stripped = line
      // headings
      .replace(/^#+\s*/, "")
      // block quotes (possibly nested)
      .replace(/^(?:>\s*)+/, "")
      // unordered list markers
      .replace(/^[-*+]\s+/, "")
      // ordered list markers
      .replace(/^\d+\.\s+/, "");
    const heading = stripInlineMarkdown(stripped);
    if (heading) return heading.slice(0, 20);
  }
  return "";
}
