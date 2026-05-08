import { mkdir, readDir, copyFile, readTextFile, writeTextFile, exists, remove, rename } from "@tauri-apps/plugin-fs";
import {
  ensureMetaDir,
  metaDirFor,
  metaPathFor,
  readAllMeta,
  readMeta,
  writeMeta,
  type NoteMeta,
} from "./metadataIO";
import {
  groupsPathFor,
  readGroupsFile,
  writeGroupsWithMerge,
  genOrderKeyAfter,
  mergeGroupMaps,
  type SharedGroupEntry,
} from "./groupsIO";
import { getMachineId } from "./machineId";

interface ManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  customName?: boolean;
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

interface LegacyGroup {
  id: string;
  name: string;
  noteIds?: string[];
  collapsed?: boolean;
  createdAt?: number;
}

interface LegacyManifest {
  version: 1;
  notes: ManifestNote[];
  activeNoteId: string | null;
  groups?: LegacyGroup[];
  trashedNotes?: TrashedNoteEntry[];
  imageAssetMigrationV1CompletedAt?: number;
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
      || entry.name === "manifest.legacy.json"
      || entry.name === ".groups.json"
      || entry.name === ".meta"
      || entry.name === ".assets"
      || entry.name === ".trash"
      || entry.name === ".conflicts"
      || (entry.isFile && entry.name.endsWith(".md"));
    if (!isManagedRootEntry) continue;
    const target = `${base}${entry.name}`;
    try {
      await remove(target, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
}

async function readLegacyManifestFile(dir: string): Promise<LegacyManifest | null> {
  try {
    const path = `${normalizeSep(dir)}manifest.json`;
    const raw = await readTextFile(path);
    return JSON.parse(raw) as LegacyManifest;
  } catch {
    return null;
  }
}

/**
 * Decompose a legacy `manifest.json` (notes/groups/trashedNotes/activeNoteId)
 * into per-note `.meta/{id}.json` plus a shared `.groups.json` in `dir`.
 * Pre-existing `.meta` / `.groups.json` files are merged in (newer wins).
 */
async function decomposeLegacyIntoDir(
  dir: string,
  manifest: LegacyManifest,
  machineId: string,
): Promise<void> {
  await ensureMetaDir(dir);

  const noteIdToGroupId = new Map<string, string>();
  const sharedGroups: Record<string, SharedGroupEntry> = {};
  const now = Date.now();
  let lastKey: string | undefined;

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
    for (const noteId of g.noteIds ?? []) {
      noteIdToGroupId.set(noteId, g.id);
    }
  }
  if (Object.keys(sharedGroups).length > 0) {
    await writeGroupsWithMerge(dir, sharedGroups);
  }

  for (const n of manifest.notes ?? []) {
    if (!n.id) continue;
    const meta: NoteMeta = {
      version: 2,
      id: n.id,
      fileName: n.fileName,
      customName: n.customName || undefined,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      groupId: noteIdToGroupId.get(n.id) ?? null,
      trashedAt: null,
    };
    const existing = await readMeta(dir, n.id);
    if (existing && existing.updatedAt >= meta.updatedAt) continue;
    await writeMeta(dir, meta, machineId);
  }

  for (const t of manifest.trashedNotes ?? []) {
    if (!t.id) continue;
    const meta: NoteMeta = {
      version: 2,
      id: t.id,
      fileName: t.fileName,
      customName: undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      groupId: t.groupId ?? null,
      trashedAt: t.trashedAt,
      trashedFromPath: t.originalFilePath,
    };
    const existing = await readMeta(dir, t.id);
    if (existing && existing.updatedAt >= meta.updatedAt && existing.trashedAt != null) continue;
    await writeMeta(dir, meta, machineId);
  }
}

async function retireLegacyManifestAt(dir: string): Promise<void> {
  const base = normalizeSep(dir);
  const src = `${base}manifest.json`;
  try {
    if (!(await exists(src))) return;
  } catch { return; }
  const dst = `${base}manifest.legacy.json`;
  try {
    if (await exists(dst).catch(() => false)) {
      await remove(src).catch(() => {});
      return;
    }
    await rename(src, dst);
  } catch {
    try {
      const raw = await readTextFile(src);
      await writeTextFile(dst, raw);
      await remove(src);
    } catch { /* ignore */ }
  }
}

/**
 * Copy `.md` / `.meta` / `.groups.json` / `.trash` / `.assets` from `fromDir`
 * to `toDir`. Returns nothing — caller is responsible for clearing source.
 */
async function copySharedTree(fromDir: string, toDir: string): Promise<void> {
  const fromBase = normalizeSep(fromDir);
  const toBase = normalizeSep(toDir);

  await mkdir(toDir, { recursive: true });

  // .md files (root)
  let entries: { name?: string; isFile?: boolean; isDirectory?: boolean }[] = [];
  try { entries = await readDir(fromDir); } catch { entries = []; }
  for (const e of entries) {
    if (!e.name || !e.isFile) continue;
    if (!e.name.endsWith(".md")) continue;
    await copyFile(`${fromBase}${e.name}`, `${toBase}${e.name}`).catch(() => {});
  }

  // .meta directory (per-note sidecars)
  try {
    await copyDirRecursive(`${fromBase}.meta`, `${toBase}.meta`);
  } catch { /* may not exist */ }

  // .groups.json — copy if present, but if destination has one too, we merge later.
  try {
    if (await exists(`${fromBase}.groups.json`)) {
      // copy to a sibling if destination already has one; the merge below handles consolidation.
      const destExists = await exists(`${toBase}.groups.json`).catch(() => false);
      if (!destExists) {
        await copyFile(`${fromBase}.groups.json`, `${toBase}.groups.json`).catch(() => {});
      }
    }
  } catch { /* ignore */ }

  // .trash directory contents (md files only)
  try {
    const trashEntries = await readDir(`${fromBase}.trash`);
    const trashMd = trashEntries.filter((e) => e.name?.endsWith(".md") && e.isFile);
    if (trashMd.length > 0) {
      await mkdir(`${toBase}.trash`, { recursive: true });
      for (const e of trashMd) {
        await copyFile(`${fromBase}.trash/${e.name}`, `${toBase}.trash/${e.name}`).catch(() => {});
      }
    }
  } catch { /* may not exist */ }

  // .assets directory recursively
  try {
    await copyDirRecursive(`${fromBase}.assets`, `${toBase}.assets`);
  } catch { /* may not exist */ }
}

/**
 * Migrate the notes directory from `fromDir` to `toDir`. Strategy controls
 * what happens when both directories already contain shared state:
 *   - "merge": meta sidecars and groups are union-merged (per-id newer wins);
 *     conflicting `.md` bodies are won by the source file (newer mtime).
 *   - "overwrite": destination contents are wiped first, then source is copied.
 */
export async function migrateNotesDir(
  fromDir: string,
  toDir: string,
  mergeStrategy: "merge" | "overwrite",
): Promise<MigrationResult> {
  const from = normalizeSep(fromDir).replace(/[\\/]+$/, "");
  const to = normalizeSep(toDir).replace(/[\\/]+$/, "");
  if (from === to) return { success: true };

  const destinationIsInsideSource = isSameOrChildPath(fromDir, toDir);
  const machineId = await getMachineId();

  try {
    await mkdir(toDir, { recursive: true });

    // Decompose any legacy manifest.json sitting in source / destination so the
    // rest of the migration only deals with `.meta` and `.groups.json`.
    const sourceLegacy = await readLegacyManifestFile(fromDir);
    if (sourceLegacy) {
      await decomposeLegacyIntoDir(fromDir, sourceLegacy, machineId);
      await retireLegacyManifestAt(fromDir);
    }
    const destLegacy = await readLegacyManifestFile(toDir);
    if (destLegacy) {
      await decomposeLegacyIntoDir(toDir, destLegacy, machineId);
      await retireLegacyManifestAt(toDir);
    }

    if (mergeStrategy === "overwrite") {
      // Wipe destination managed entries first.
      await clearDirContents(toDir);
      await copySharedTree(fromDir, toDir);

      if (!destinationIsInsideSource) {
        await clearDirContents(fromDir);
      }
      return { success: true };
    }

    // merge strategy ──
    // Build a snapshot of source meta + groups before copying so we can merge
    // with destination state without losing per-id information.
    const sourceMeta = await readAllMeta(fromDir);
    const sourceGroupsFile = await readGroupsFile(fromDir);

    await copySharedTree(fromDir, toDir);

    // Merge meta: destination already has the source meta files copied. For
    // any id where destination meta existed prior, pick the newer.
    // Implementation: re-read both, write merged.
    const destMetaAfter = await readAllMeta(toDir);
    for (const [id, src] of sourceMeta) {
      const dest = destMetaAfter.get(id);
      if (!dest) {
        // copy-step already wrote it; nothing to do.
        continue;
      }
      const winner = src.updatedAt > dest.updatedAt ? src : dest;
      // If the winner is `src` and dest currently holds something newer, restore winner.
      if (winner === src && dest.updatedAt < src.updatedAt) {
        await writeMeta(toDir, src, machineId);
      } else if (winner === dest) {
        await writeMeta(toDir, dest, machineId);
      }
    }

    // Merge .groups.json: union with newer-wins per group entry.
    const destGroupsFile = await readGroupsFile(toDir);
    const merged = mergeGroupMaps(destGroupsFile.groups, sourceGroupsFile.groups);
    if (Object.keys(merged).length > 0) {
      await writeGroupsWithMerge(toDir, merged);
    }

    if (!destinationIsInsideSource) {
      await clearDirContents(fromDir);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Returns true if a given directory contains *any* recognised Noten state
 * (live `.meta` sidecars, a legacy `manifest.json`, or `.groups.json`).
 * Used by the App's path-change flow to decide whether to prompt for merge.
 */
export async function hasManifest(dir: string): Promise<boolean> {
  const base = normalizeSep(dir);
  try {
    if (await exists(`${base}manifest.json`)) return true;
  } catch { /* ignore */ }
  try {
    if (await exists(`${base}.groups.json`)) return true;
  } catch { /* ignore */ }
  try {
    const metaEntries = await readDir(`${base}.meta`);
    if (metaEntries.some((e) => e.name?.endsWith(".json"))) return true;
  } catch { /* ignore */ }
  return false;
}

// Path helpers used by callers that just need them.
export { metaDirFor, metaPathFor, groupsPathFor };
