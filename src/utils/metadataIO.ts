import type { FileSystem } from "./fs";
import { atomicWriteText } from "./atomicWrite";
import { markOwnWrite } from "../hooks/ownWriteTracker";
import { isNoteColorId, type NoteColorId } from "./noteColors";
import { isValidNoteId } from "./noteId";
import { normalizeSep } from "./pathUtils";
import { NotenError } from "./notenError";
import { logNotenError } from "./crashLog";

export interface NoteMeta {
  version: 2;
  id: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** User-assigned color label (sidebar icon tint). */
  color?: NoteColorId;
  groupId: string | null;
  /** Last time this note's group membership changed. */
  groupUpdatedAt?: number;
  /** If set, note lives under `.trash/` (body file is `.trash/{id}.md`). */
  trashedAt: number | null;
  /** Original file path when trashed — preserved for restore. Shared safely since all PCs point at same folder. */
  trashedFromPath?: string | null;
  lastWriterMachineId?: string;
}

export function metaDirFor(notesDir: string): string {
  return `${normalizeSep(notesDir)}.meta`;
}

export function metaPathFor(notesDir: string, noteId: string): string {
  return `${metaDirFor(notesDir)}/${noteId}.json`;
}

export async function ensureMetaDir(fs: FileSystem, notesDir: string): Promise<string> {
  const dir = metaDirFor(notesDir);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

// readAllMeta is the hot spot: persistDecomposedState calls it on every
// autosave (resolveGroupSnapshot needs disk truth), reconcileFolder calls it
// twice per pass. With N notes on a cloud-sync folder, that's N JSON reads
// each time, ~10-50ms per file. Short TTL cache keeps the per-flow second-and-
// later calls free; per-write hooks keep the cache consistent with our own
// disk ops so we don't have to invalidate-then-refill.
//
// Keyed by FileSystem instance via WeakMap so tests using fresh in-memory fs
// instances get isolated cache automatically (no manual reset in beforeEach).
interface ReadAllMetaCacheEntry {
  result: Map<string, NoteMeta>;
  expiresAt: number;
}
const READ_ALL_META_TTL_MS = 500;
const readAllMetaCache = new WeakMap<FileSystem, Map<string, ReadAllMetaCacheEntry>>();

function getCacheBucket(fs: FileSystem): Map<string, ReadAllMetaCacheEntry> {
  let bucket = readAllMetaCache.get(fs);
  if (!bucket) {
    bucket = new Map();
    readAllMetaCache.set(fs, bucket);
  }
  return bucket;
}

function lookupReadAllMetaCache(fs: FileSystem, notesDir: string): Map<string, NoteMeta> | null {
  const bucket = readAllMetaCache.get(fs);
  if (!bucket) return null;
  const entry = bucket.get(notesDir);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    bucket.delete(notesDir);
    return null;
  }
  return entry.result;
}

function setReadAllMetaCache(fs: FileSystem, notesDir: string, result: Map<string, NoteMeta>): void {
  const bucket = getCacheBucket(fs);
  bucket.set(notesDir, { result, expiresAt: Date.now() + READ_ALL_META_TTL_MS });
}

function patchCachedMeta(fs: FileSystem, notesDir: string, meta: NoteMeta): void {
  const bucket = readAllMetaCache.get(fs);
  const entry = bucket?.get(notesDir);
  if (entry) entry.result.set(meta.id, meta);
}

function dropCachedMeta(fs: FileSystem, notesDir: string, noteId: string): void {
  const bucket = readAllMetaCache.get(fs);
  const entry = bucket?.get(notesDir);
  if (entry) entry.result.delete(noteId);
}

/** Drop the readAllMeta cache for this fs (or this dir if provided). */
export function invalidateReadAllMetaCache(fs: FileSystem, notesDir?: string): void {
  const bucket = readAllMetaCache.get(fs);
  if (!bucket) return;
  if (notesDir) bucket.delete(notesDir);
  else bucket.clear();
}

function isValidMeta(obj: unknown): obj is NoteMeta {
  if (!obj || typeof obj !== "object") return false;
  const m = obj as Record<string, unknown>;
  // id must be a path-safe single segment: it is concatenated into
  // `.meta/<id>.json`, `<id>.md`, and `.assets/<id>/` everywhere downstream.
  return isValidNoteId(m.id)
    && typeof m.fileName === "string"
    && typeof m.createdAt === "number"
    && typeof m.updatedAt === "number"
    && (m.groupId === null || typeof m.groupId === "string");
}

export async function readMeta(fs: FileSystem, notesDir: string, noteId: string): Promise<NoteMeta | null> {
  const path = metaPathFor(notesDir, noteId);
  if (!(await fs.exists(path))) return null;

  const raw = await fs.readTextFile(path);
  const parsed = JSON.parse(raw) as unknown;
  if (!isValidMeta(parsed)) {
    throw new Error(`Invalid note metadata: ${path}`);
  }
  const m = parsed as NoteMeta;
  return {
    ...m,
    version: 2,
    pinned: m.pinned === true,
    color: isNoteColorId(m.color) ? m.color : undefined,
    trashedAt: typeof m.trashedAt === "number" ? m.trashedAt : null,
  };
}

export async function writeMeta(fs: FileSystem, notesDir: string, meta: NoteMeta, machineId: string): Promise<string> {
  await ensureMetaDir(fs, notesDir);
  const path = metaPathFor(notesDir, meta.id);
  const normalized: NoteMeta = {
    version: 2,
    id: meta.id,
    fileName: meta.fileName,
    customName: meta.customName || undefined,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pinned: meta.pinned === true ? true : undefined,
    color: isNoteColorId(meta.color) ? meta.color : undefined,
    groupId: meta.groupId ?? null,
    groupUpdatedAt: typeof meta.groupUpdatedAt === "number" ? meta.groupUpdatedAt : undefined,
    trashedAt: meta.trashedAt ?? null,
    trashedFromPath: meta.trashedFromPath ?? null,
    lastWriterMachineId: machineId || meta.lastWriterMachineId || undefined,
  };
  const serialized = JSON.stringify(normalized, null, 2);
  // Suppress watcher reprocessing: same content recorded for hash-based match.
  markOwnWrite(path, serialized);
  await atomicWriteText(fs, path, serialized);
  patchCachedMeta(fs, notesDir, normalized);
  return serialized;
}

export async function removeMeta(fs: FileSystem, notesDir: string, noteId: string): Promise<void> {
  // Defense-in-depth: never let an unsafe id reach a filesystem remove.
  // Validation upstream should already exclude these, so reaching here is a bug.
  if (!isValidNoteId(noteId)) {
    void logNotenError(new NotenError(
      "INVALID_NOTE_ID",
      "recoverable",
      "removeMeta: refusing to remove sidecar for unsafe id",
      { context: { notesDir, noteId } },
    ));
    return;
  }
  const path = metaPathFor(notesDir, noteId);
  // Mark intent so the watcher's "deleted" event for our own removal is
  // ignored by the time-based filter at least; reconcile cleans up regardless.
  markOwnWrite(path);
  try {
    await fs.remove(path);
    dropCachedMeta(fs, notesDir, noteId);
  } catch { /* already gone */ }
}

export async function listMetaFiles(fs: FileSystem, notesDir: string): Promise<string[]> {
  const dir = metaDirFor(notesDir);
  if (!(await fs.exists(dir))) return [];
  const entries = await fs.readDir(dir);
  return entries
    .filter((e) => e.name && e.name.endsWith(".json") && !e.name.endsWith(".tmp.json") && !e.name.endsWith(".tmp"))
    .map((e) => e.name!);
}

/** Read all metadata files from {notesDir}/.meta. Returns entries keyed by id. */
export async function readAllMeta(fs: FileSystem, notesDir: string): Promise<Map<string, NoteMeta>> {
  // Short-TTL cache: keyed by (fs, notesDir). Callers get a clone so they can
  // mutate freely without poisoning the cache; writeMeta / removeMeta patch
  // the cached map in place so the cache stays consistent with our own writes
  // through the TTL window (instead of being invalidated and refilled).
  const cached = lookupReadAllMetaCache(fs, notesDir);
  if (cached) return new Map(cached);

  const names = await listMetaFiles(fs, notesDir);
  const out = new Map<string, NoteMeta>();
  // Per-id read with TOCTOU defense. listMetaFiles snapshots a directory
  // listing; readMeta then runs exists() + readTextFile() for each name. A
  // concurrent removeMeta (own pruneEmptyCurrentDoc / newNote.willReplace, or
  // a sibling window) can land between the listing and the read, or between
  // exists and readTextFile — surfacing as "os error 2" inside Promise.all and
  // failing the whole aggregate (PERSIST_FAILED / RECONCILE_FAILED).
  //
  // readMeta itself is contractually forbidden from catching (contract:
  // shared metadata reads fail closed — transient unreadable must not look
  // like absent state, or reconcile will write default meta over a locked
  // sidecar and lose groupId). We can still distinguish *here*: on error,
  // re-check existence. File gone = deletion raced this read, drop silently.
  // File still present = real unreadable, propagate so the aggregate still
  // fails closed for that case.
  await Promise.all(names.map(async (name) => {
    const id = name.replace(/\.json$/, "");
    // A sidecar whose filename stem is not a path-safe id (e.g. `...json` →
    // `..`) is corrupt or hostile. Never surface it as a note: its id is later
    // concatenated into `.assets/<id>/` and recursively deleted on trash purge,
    // and `..` there escapes to the notes root.
    if (!isValidNoteId(id)) {
      void logNotenError(new NotenError(
        "INVALID_NOTE_ID",
        "recoverable",
        "readAllMeta: skipping meta sidecar with unsafe filename id",
        { context: { notesDir, name } },
      ));
      return;
    }
    try {
      const meta = await readMeta(fs, notesDir, id);
      if (meta && meta.id === id) out.set(id, meta);
    } catch (err) {
      let stillExists = false;
      try { stillExists = await fs.exists(metaPathFor(notesDir, id)); } catch { stillExists = false; }
      if (stillExists) throw err;
    }
  }));

  // Cache the canonical map (the one we own); return a clone so callers
  // can't mutate our cache view.
  setReadAllMetaCache(fs, notesDir, out);
  return new Map(out);
}
