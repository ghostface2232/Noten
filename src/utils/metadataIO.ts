import type { FileSystem } from "./fs";
import { atomicWriteText } from "./atomicWrite";
import { markOwnWrite } from "../hooks/ownWriteTracker";
import { isNoteColorId, type NoteColorId } from "./noteColors";
import { normalizeSep } from "./pathUtils";

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

function isValidMeta(obj: unknown): obj is NoteMeta {
  if (!obj || typeof obj !== "object") return false;
  const m = obj as Record<string, unknown>;
  return typeof m.id === "string"
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
  return serialized;
}

export async function removeMeta(fs: FileSystem, notesDir: string, noteId: string): Promise<void> {
  const path = metaPathFor(notesDir, noteId);
  // Mark intent so the watcher's "deleted" event for our own removal is
  // ignored by the time-based filter at least; reconcile cleans up regardless.
  markOwnWrite(path);
  try {
    await fs.remove(path);
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
  const names = await listMetaFiles(fs, notesDir);
  const out = new Map<string, NoteMeta>();
  await Promise.all(names.map(async (name) => {
    const id = name.replace(/\.json$/, "");
    const meta = await readMeta(fs, notesDir, id);
    if (meta && meta.id === id) out.set(id, meta);
  }));
  return out;
}
