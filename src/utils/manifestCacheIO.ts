import { readTextFile } from "@tauri-apps/plugin-fs";
import type { NoteGroup, TrashedNote } from "../hooks/useNotesLoader";
import { writeJsonAtomic } from "./atomicJson";
import type { NoteMeta } from "./metadataIO";
import { manifestCachePath } from "./storagePaths";

export interface ManifestCache {
  version: 2;
  metas: NoteMeta[];
  groups: NoteGroup[];
  trashedNotes: TrashedNote[];
  cachedAt: number;
}

export async function readManifestCache(notesDir: string): Promise<ManifestCache | null> {
  try {
    const raw = await readTextFile(manifestCachePath(notesDir));
    const parsed = JSON.parse(raw) as ManifestCache;
    return parsed.version === 2 ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeManifestCache(
  notesDir: string,
  cache: Omit<ManifestCache, "version" | "cachedAt">,
): Promise<void> {
  await writeJsonAtomic(manifestCachePath(notesDir), {
    version: 2,
    ...cache,
    cachedAt: Date.now(),
  });
}
