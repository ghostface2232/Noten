import { exists, mkdir, readDir, readTextFile, remove } from "@tauri-apps/plugin-fs";
import type { NoteDoc, TrashedNote } from "../hooks/useNotesLoader";
import { getMachineId } from "./machineId";
import { writeJsonAtomic } from "./atomicJson";
import { fileNameFromPath, metaDirPath, metaFilePath, noteFilePath, trashDirPath } from "./storagePaths";

export interface NoteMeta {
  version: 2;
  id: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  groupId: string | null;
  trashedAt?: number;
  lastWriterMachineId: string;
  imageAssetMigrationV1CompletedAt?: number;
}

export function noteDocToMeta(doc: NoteDoc, groupId: string | null, lastWriterMachineId: string): NoteMeta {
  return {
    version: 2,
    id: doc.id,
    fileName: doc.fileName,
    ...(doc.customName ? { customName: true } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    groupId,
    lastWriterMachineId,
  };
}

export function metaToNoteDoc(meta: NoteMeta, notesDir: string, content: string): NoteDoc {
  return {
    id: meta.id,
    filePath: noteFilePath(notesDir, meta.id),
    fileName: meta.fileName,
    isDirty: false,
    content,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.customName ? { customName: true } : {}),
  };
}

export function metaToTrashedNote(meta: NoteMeta, notesDir: string): TrashedNote | null {
  if (!meta.trashedAt) return null;
  const fileName = `${meta.id}.md`;
  return {
    id: meta.id,
    fileName: meta.fileName,
    originalFilePath: noteFilePath(notesDir, meta.id),
    trashFilePath: `${trashDirPath(notesDir)}/${fileName}`,
    trashedAt: meta.trashedAt,
    groupId: meta.groupId,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export async function ensureMetaDir(notesDir: string): Promise<string> {
  const dir = metaDirPath(notesDir);
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

export async function readNoteMeta(notesDir: string, noteId: string): Promise<NoteMeta | null> {
  try {
    const raw = await readTextFile(metaFilePath(notesDir, noteId));
    const parsed = JSON.parse(raw) as Partial<NoteMeta>;
    if (parsed.version !== 2 || !parsed.id) return null;
    return {
      version: 2,
      id: parsed.id,
      fileName: parsed.fileName || `${parsed.id}.md`,
      customName: parsed.customName,
      createdAt: Number(parsed.createdAt) || Date.now(),
      updatedAt: Number(parsed.updatedAt) || Date.now(),
      groupId: parsed.groupId ?? null,
      trashedAt: parsed.trashedAt,
      lastWriterMachineId: parsed.lastWriterMachineId || "unknown",
      imageAssetMigrationV1CompletedAt: parsed.imageAssetMigrationV1CompletedAt,
    };
  } catch {
    return null;
  }
}

export async function readAllNoteMetas(notesDir: string): Promise<NoteMeta[]> {
  const dir = await ensureMetaDir(notesDir);
  let entries: { name?: string; isFile?: boolean }[] = [];
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }

  const metas = await Promise.all(
    entries
      .filter((entry) => entry.name?.endsWith(".json") && !entry.name.endsWith(".tmp"))
      .map((entry) => readNoteMeta(notesDir, entry.name!.replace(/\.json$/, ""))),
  );
  return metas.filter((meta): meta is NoteMeta => meta !== null);
}

export async function writeNoteMeta(notesDir: string, meta: NoteMeta): Promise<void> {
  await ensureMetaDir(notesDir);
  await writeJsonAtomic(metaFilePath(notesDir, meta.id), meta);
}

export async function writeDocMeta(notesDir: string, doc: NoteDoc, groupId: string | null): Promise<void> {
  const machineId = await getMachineId();
  await writeNoteMeta(notesDir, noteDocToMeta(doc, groupId, machineId));
}

export async function removeNoteMeta(notesDir: string, noteId: string): Promise<void> {
  try {
    await remove(metaFilePath(notesDir, noteId));
  } catch {
    // Already gone.
  }
}

export async function metaExists(notesDir: string, noteId: string): Promise<boolean> {
  try {
    return await exists(metaFilePath(notesDir, noteId));
  } catch {
    return false;
  }
}

export async function updateNoteMeta(
  notesDir: string,
  noteId: string,
  updater: (meta: NoteMeta | null) => NoteMeta | null,
): Promise<NoteMeta | null> {
  const next = updater(await readNoteMeta(notesDir, noteId));
  if (!next) return null;
  await writeNoteMeta(notesDir, next);
  return next;
}

export function metaIdFromFileName(name: string): string {
  return fileNameFromPath(name).replace(/\.json$/, "");
}
