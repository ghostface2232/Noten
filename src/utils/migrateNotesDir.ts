import { mkdir, readDir, copyFile, readTextFile, writeTextFile, exists, remove } from "@tauri-apps/plugin-fs";

interface ManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  createdAt: number;
  updatedAt: number;
}

interface TrashedNoteEntry {
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
  notes: ManifestNote[];
  activeNoteId: string | null;
  groups?: unknown[];
  trashedNotes?: TrashedNoteEntry[];
}

export interface MigrationResult {
  success: boolean;
  error?: string;
}

function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}

function normalizePathForCompare(path: string): string {
  return normalizeSep(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isSameOrChildPath(parentPath: string, candidatePath: string): boolean {
  const parent = normalizePathForCompare(parentPath);
  const candidate = normalizePathForCompare(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  let entries;
  try {
    entries = await readDir(srcDir);
  } catch {
    // Source directory doesn't exist — nothing to copy
    return;
  }
  await mkdir(destDir, { recursive: true });
  const srcBase = normalizeSep(srcDir);
  const destBase = normalizeSep(destDir);
  for (const entry of entries) {
    if (!entry.name) continue;
    const srcPath = `${srcBase}${entry.name}`;
    const destPath = `${destBase}${entry.name}`;
    if (entry.isDirectory) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function clearDirContents(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return;
  }
  const base = normalizeSep(dir);
  for (const entry of entries) {
    if (!entry.name) continue;
    const isManagedRootEntry = entry.name === "manifest.json"
      || entry.name === ".assets"
      || entry.name === ".trash"
      || (entry.isFile && entry.name.endsWith(".md"));
    if (!isManagedRootEntry) continue;
    const target = `${base}${entry.name}`;
    try {
      await remove(target, { recursive: true });
    } catch {
      // Best-effort cleanup — ignore locked / in-use files
    }
  }
}

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? "";
}

function rewriteFilePaths(manifest: Manifest, toDir: string): Manifest {
  const base = normalizeSep(toDir);
  const trashBase = `${base}.trash/`;
  return {
    ...manifest,
    notes: manifest.notes.map((n) => ({
      ...n,
      filePath: `${base}${getFileName(n.filePath)}`,
    })),
    trashedNotes: manifest.trashedNotes?.map((n) => ({
      ...n,
      originalFilePath: `${base}${getFileName(n.originalFilePath)}`,
      trashFilePath: `${trashBase}${getFileName(n.trashFilePath)}`,
    })),
  };
}

async function readManifestFile(dir: string): Promise<Manifest | null> {
  try {
    const path = `${normalizeSep(dir)}manifest.json`;
    const raw = await readTextFile(path);
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

function mergeManifests(source: Manifest, dest: Manifest, toDir: string): Manifest {
  const base = normalizeSep(toDir);
  const trashBase = `${base}.trash/`;

  // Merge notes: destination first, source overwrites by ID
  const noteMap = new Map<string, ManifestNote>();
  for (const n of dest.notes) {
    noteMap.set(n.id, { ...n, filePath: `${base}${getFileName(n.filePath)}` });
  }
  for (const n of source.notes) {
    noteMap.set(n.id, { ...n, filePath: `${base}${getFileName(n.filePath)}` });
  }

  // Merge groups: destination first, source overwrites by ID
  const groupMap = new Map<string, unknown>();
  for (const g of dest.groups ?? []) {
    const gObj = g as { id: string };
    groupMap.set(gObj.id, g);
  }
  for (const g of source.groups ?? []) {
    const gObj = g as { id: string };
    groupMap.set(gObj.id, g);
  }

  // Merge trashedNotes: destination first, source overwrites by ID
  const trashMap = new Map<string, TrashedNoteEntry>();
  for (const n of dest.trashedNotes ?? []) {
    trashMap.set(n.id, { ...n, originalFilePath: `${base}${getFileName(n.originalFilePath)}`, trashFilePath: `${trashBase}${getFileName(n.trashFilePath)}` });
  }
  for (const n of source.trashedNotes ?? []) {
    trashMap.set(n.id, { ...n, originalFilePath: `${base}${getFileName(n.originalFilePath)}`, trashFilePath: `${trashBase}${getFileName(n.trashFilePath)}` });
  }

  return {
    version: 1,
    notes: Array.from(noteMap.values()),
    activeNoteId: source.activeNoteId,
    groups: groupMap.size > 0 ? Array.from(groupMap.values()) : undefined,
    trashedNotes: trashMap.size > 0 ? Array.from(trashMap.values()) : undefined,
  };
}

export async function migrateNotesDir(
  fromDir: string,
  toDir: string,
  mergeStrategy: "merge" | "overwrite",
): Promise<MigrationResult> {
  // Same directory — nothing to do
  const from = normalizeSep(fromDir).replace(/[\\/]+$/, "");
  const to = normalizeSep(toDir).replace(/[\\/]+$/, "");
  if (from === to) return { success: true };
  const destinationIsInsideSource = isSameOrChildPath(fromDir, toDir);

  try {
    await mkdir(toDir, { recursive: true });

    // Copy .md files
    const entries = await readDir(fromDir);
    const mdFiles = entries.filter((e) => e.name?.endsWith(".md"));
    for (const entry of mdFiles) {
      const srcPath = `${normalizeSep(fromDir)}${entry.name}`;
      const destPath = `${normalizeSep(toDir)}${entry.name}`;
      await copyFile(srcPath, destPath);
    }

    // Copy .trash directory contents
    const fromTrash = `${normalizeSep(fromDir)}.trash`;
    try {
      const trashEntries = await readDir(fromTrash);
      const trashMdFiles = trashEntries.filter((e) => e.name?.endsWith(".md"));
      if (trashMdFiles.length > 0) {
        const toTrash = `${normalizeSep(toDir)}.trash`;
        await mkdir(toTrash, { recursive: true });
        for (const entry of trashMdFiles) {
          const srcPath = `${normalizeSep(fromTrash)}${entry.name}`;
          const destPath = `${normalizeSep(toTrash)}${entry.name}`;
          await copyFile(srcPath, destPath);
        }
      }
    } catch { /* .trash directory may not exist — skip */ }

    // Copy .assets directory (images) recursively
    const fromAssets = `${normalizeSep(fromDir)}.assets`;
    const toAssets = `${normalizeSep(toDir)}.assets`;
    try {
      await copyDirRecursive(fromAssets, toAssets);
    } catch { /* .assets may not exist — skip */ }

    // Handle manifest
    const sourceManifest = await readManifestFile(fromDir);
    if (!sourceManifest) {
      // No manifest in source — still clear whatever we just copied over
      if (!destinationIsInsideSource) {
        await clearDirContents(fromDir);
      }
      return { success: true };
    }

    if (mergeStrategy === "merge") {
      const destManifest = await readManifestFile(toDir);
      if (destManifest) {
        const merged = mergeManifests(sourceManifest, destManifest, toDir);
        await writeTextFile(
          `${normalizeSep(toDir)}manifest.json`,
          JSON.stringify(merged, null, 2),
        );
      } else {
        const rewritten = rewriteFilePaths(sourceManifest, toDir);
        await writeTextFile(
          `${normalizeSep(toDir)}manifest.json`,
          JSON.stringify(rewritten, null, 2),
        );
      }
    } else {
      const rewritten = rewriteFilePaths(sourceManifest, toDir);
      await writeTextFile(
        `${normalizeSep(toDir)}manifest.json`,
        JSON.stringify(rewritten, null, 2),
      );
    }

    // Clear contents of source directory (but keep the folder itself),
    // so the old AppData notes folder remains available for future reset
    // without leaving stale copies behind.
    if (!destinationIsInsideSource) {
      await clearDirContents(fromDir);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function hasManifest(dir: string): Promise<boolean> {
  try {
    return await exists(`${normalizeSep(dir)}manifest.json`);
  } catch {
    return false;
  }
}
