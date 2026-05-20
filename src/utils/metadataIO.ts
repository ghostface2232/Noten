import { mkdir, readDir, readTextFile, remove } from "@tauri-apps/plugin-fs";
import { atomicWriteText } from "./atomicWrite";
import { markOwnWrite } from "../hooks/ownWriteTracker";

export interface NoteMeta {
  version: 2;
  id: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  groupId: string | null;
  /** If set, note lives under `.trash/` (body file is `.trash/{id}.md`). */
  trashedAt: number | null;
  /** Original file path when trashed — preserved for restore. Shared safely since all PCs point at same folder. */
  trashedFromPath?: string | null;
  lastWriterMachineId?: string;
}

function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}

export function metaDirFor(notesDir: string): string {
  return `${normalizeSep(notesDir)}.meta`;
}

export function metaPathFor(notesDir: string, noteId: string): string {
  return `${metaDirFor(notesDir)}/${noteId}.json`;
}

export async function ensureMetaDir(notesDir: string): Promise<string> {
  const dir = metaDirFor(notesDir);
  await mkdir(dir, { recursive: true }).catch(() => {});
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

export async function readMeta(notesDir: string, noteId: string): Promise<NoteMeta | null> {
  try {
    const raw = await readTextFile(metaPathFor(notesDir, noteId));
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidMeta(parsed)) return null;
    const m = parsed as NoteMeta;
    return {
      ...m,
      version: 2,
      pinned: m.pinned === true,
      trashedAt: typeof m.trashedAt === "number" ? m.trashedAt : null,
    };
  } catch {
    return null;
  }
}

export async function writeMeta(notesDir: string, meta: NoteMeta, machineId: string): Promise<string> {
  await ensureMetaDir(notesDir);
  const path = metaPathFor(notesDir, meta.id);
  const normalized: NoteMeta = {
    version: 2,
    id: meta.id,
    fileName: meta.fileName,
    customName: meta.customName || undefined,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pinned: meta.pinned === true ? true : undefined,
    groupId: meta.groupId ?? null,
    trashedAt: meta.trashedAt ?? null,
    trashedFromPath: meta.trashedFromPath ?? null,
    lastWriterMachineId: machineId || meta.lastWriterMachineId || undefined,
  };
  const serialized = JSON.stringify(normalized, null, 2);
  // Suppress watcher reprocessing: same content recorded for hash-based match.
  markOwnWrite(path, serialized);
  await atomicWriteText(path, serialized);
  return serialized;
}

export async function removeMeta(notesDir: string, noteId: string): Promise<void> {
  const path = metaPathFor(notesDir, noteId);
  // Mark intent so the watcher's "deleted" event for our own removal is
  // ignored by the time-based filter at least; reconcile cleans up regardless.
  markOwnWrite(path);
  try {
    await remove(path);
  } catch { /* already gone */ }
}

export async function listMetaFiles(notesDir: string): Promise<string[]> {
  try {
    const entries = await readDir(metaDirFor(notesDir));
    return entries
      .filter((e) => e.name && e.name.endsWith(".json") && !e.name.endsWith(".tmp.json") && !e.name.endsWith(".tmp"))
      .map((e) => e.name!);
  } catch {
    return [];
  }
}

/** Read all metadata files from {notesDir}/.meta. Returns entries keyed by id. */
export async function readAllMeta(notesDir: string): Promise<Map<string, NoteMeta>> {
  const names = await listMetaFiles(notesDir);
  const out = new Map<string, NoteMeta>();
  await Promise.all(names.map(async (name) => {
    const id = name.replace(/\.json$/, "");
    const meta = await readMeta(notesDir, id);
    if (meta && meta.id === id) out.set(id, meta);
  }));
  return out;
}
