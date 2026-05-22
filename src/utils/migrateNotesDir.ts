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
import { getFileTimestamps } from "./fileTimestamps";
import { backupRemoteVersion } from "./conflictBackup";

interface ManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  color?: NoteMeta["color"];
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
  pinned?: boolean;
  color?: NoteMeta["color"];
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
    throw new Error(`Failed to read source directory: ${srcDir}`);
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

async function clearDirContents(dir: string, protectedPath?: string, strict = false): Promise<void> {
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
    if (protectedPath && isSameOrChildPath(target, protectedPath)) continue;
    try {
      await remove(target, { recursive: true });
    } catch {
      if (strict) throw new Error(`Failed to remove managed entry: ${target}`);
      /* best-effort */
    }
  }
}

async function assertReadableDirIfExists(dir: string): Promise<void> {
  if (!(await exists(dir).catch(() => false))) return;
  await readDir(dir);
}

async function assertReadableFileIfExists(path: string): Promise<void> {
  if (!(await exists(path).catch(() => false))) return;
  await readTextFile(path);
}

export async function clearManagedNotesData(dir: string, protectedPath?: string): Promise<MigrationResult> {
  try {
    await clearDirContents(dir, protectedPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
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

/** Decompose a legacy manifest into sidecars, merging existing shared state. */
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
      pinned: n.pinned === true,
      color: n.color,
      groupId: noteIdToGroupId.get(n.id) ?? null,
      groupUpdatedAt: n.updatedAt,
      trashedAt: null,
    };
    const existing = await readMeta(dir, n.id);
    const mergedMeta = mergeMetaForMigration(meta, existing ?? undefined);
    if (existing && metasEqual(existing, mergedMeta)) continue;
    await writeMeta(dir, mergedMeta, machineId);
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
      pinned: t.pinned === true,
      color: t.color,
      groupId: t.groupId ?? null,
      groupUpdatedAt: t.updatedAt,
      trashedAt: t.trashedAt,
      trashedFromPath: t.originalFilePath,
    };
    const existing = await readMeta(dir, t.id);
    const mergedMeta = mergeMetaForMigration(meta, existing ?? undefined);
    if (existing && metasEqual(existing, mergedMeta)) continue;
    await writeMeta(dir, mergedMeta, machineId);
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

/** Copy all managed shared state for the overwrite strategy. */
async function copySharedTreeForOverwrite(fromDir: string, toDir: string): Promise<void> {
  const fromBase = normalizeSep(fromDir);
  const toBase = normalizeSep(toDir);

  await mkdir(toDir, { recursive: true });

  let entries: { name?: string; isFile?: boolean; isDirectory?: boolean }[] = [];
  try { entries = await readDir(fromDir); } catch { entries = []; }
  for (const e of entries) {
    if (!e.name || !e.isFile) continue;
    if (!e.name.endsWith(".md")) continue;
    await copyFile(`${fromBase}${e.name}`, `${toBase}${e.name}`);
  }

  if (await exists(`${fromBase}.meta`).catch(() => false)) {
    await copyDirRecursive(`${fromBase}.meta`, `${toBase}.meta`);
  }

  if (await exists(`${fromBase}.groups.json`).catch(() => false)) {
    await copyFile(`${fromBase}.groups.json`, `${toBase}.groups.json`);
  }

  if (await exists(`${fromBase}.trash`).catch(() => false)) {
    const trashEntries = await readDir(`${fromBase}.trash`);
    const trashMd = trashEntries.filter((e) => e.name?.endsWith(".md") && e.isFile);
    if (trashMd.length > 0) {
      await mkdir(`${toBase}.trash`, { recursive: true });
      for (const e of trashMd) {
        await copyFile(`${fromBase}.trash/${e.name}`, `${toBase}.trash/${e.name}`);
      }
    }
  }

  if (await exists(`${fromBase}.assets`).catch(() => false)) {
    await copyDirRecursive(`${fromBase}.assets`, `${toBase}.assets`);
  }

  if (await exists(`${fromBase}.conflicts`).catch(() => false)) {
    try {
      await copyDirRecursive(`${fromBase}.conflicts`, `${toBase}.conflicts`);
    } catch { /* best-effort */ }
  }
}

async function readMdMtimes(dir: string, required = false): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let entries: { name?: string; isFile?: boolean }[] = [];
  try { entries = await readDir(dir); } catch (err) {
    if (required) throw err;
    return out;
  }
  for (const e of entries) {
    if (!e.name || !e.isFile) continue;
    if (!e.name.endsWith(".md")) continue;
    const ts = await getFileTimestamps(`${normalizeSep(dir)}${e.name}`);
    out.set(e.name, ts.updatedAt);
  }
  return out;
}

async function readTrashMdMtimes(dir: string, required = false): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const trashDir = `${normalizeSep(dir)}.trash`;
  let entries: { name?: string; isFile?: boolean }[] = [];
  try { entries = await readDir(trashDir); } catch (err) {
    if (required) throw err;
    return out;
  }
  for (const e of entries) {
    if (!e.name || !e.isFile) continue;
    if (!e.name.endsWith(".md")) continue;
    const ts = await getFileTimestamps(`${normalizeSep(trashDir)}${e.name}`);
    out.set(e.name, ts.updatedAt);
  }
  return out;
}

function metasEqual(a: NoteMeta, b: NoteMeta): boolean {
  return a.id === b.id
    && a.fileName === b.fileName
    && (a.customName === true) === (b.customName === true)
    && a.createdAt === b.createdAt
    && a.updatedAt === b.updatedAt
    && (a.pinned === true) === (b.pinned === true)
    && (a.color ?? null) === (b.color ?? null)
    && (a.groupId ?? null) === (b.groupId ?? null)
    && (a.groupUpdatedAt ?? a.updatedAt) === (b.groupUpdatedAt ?? b.updatedAt)
    && (a.trashedAt ?? null) === (b.trashedAt ?? null)
    && (a.trashedFromPath ?? null) === (b.trashedFromPath ?? null);
}

function mergeMetaForMigration(source: NoteMeta, dest: NoteMeta | undefined): NoteMeta {
  if (!dest) return source;

  const bodyWinner = source.updatedAt > dest.updatedAt ? source : dest;
  const other = bodyWinner === source ? dest : source;
  const bodyWinnerColor = bodyWinner.color ?? null;
  const otherColor = other.color ?? null;
  const sourceGroupUpdatedAt = source.groupUpdatedAt ?? source.updatedAt;
  const destGroupUpdatedAt = dest.groupUpdatedAt ?? dest.updatedAt;
  const groupWinner = sourceGroupUpdatedAt > destGroupUpdatedAt
    ? source
    : sourceGroupUpdatedAt < destGroupUpdatedAt
      ? dest
      : (dest.groupId ? dest : source);

  return {
    ...bodyWinner,
    customName: bodyWinner.customName || undefined,
    createdAt: Math.min(source.createdAt, dest.createdAt),
    // pinned/color use independent clocks from body/title updates.
    pinned: source.pinned === true || dest.pinned === true,
    color: bodyWinnerColor ?? otherColor ?? undefined,
    groupId: groupWinner.groupId ?? null,
    groupUpdatedAt: groupWinner.groupUpdatedAt ?? groupWinner.updatedAt,
    trashedAt: bodyWinner.trashedAt ?? null,
    trashedFromPath: bodyWinner.trashedFromPath ?? other.trashedFromPath ?? null,
  };
}

/** Union-copy immutable-name trees such as `.assets/` and `.conflicts/`. */
async function unionCopyMissing(srcDir: string, destDir: string): Promise<void> {
  const entries = await readDir(srcDir);
  await mkdir(destDir, { recursive: true }).catch(() => {});
  const srcBase = normalizeSep(srcDir);
  const destBase = normalizeSep(destDir);
  for (const entry of entries) {
    if (!entry.name) continue;
    const srcPath = `${srcBase}${entry.name}`;
    const destPath = `${destBase}${entry.name}`;
    if (entry.isDirectory) {
      await unionCopyMissing(srcPath, destPath);
    } else if (entry.isFile) {
      const destAlready = await exists(destPath).catch(() => false);
      if (destAlready) continue;
      await copyFile(srcPath, destPath);
    }
  }
}

/** Best-effort backup before a merge overwrites a differing destination body. */
async function backupOverwrittenBody(
  srcPath: string,
  destPath: string,
  toDir: string,
  noteId: string,
): Promise<void> {
  try {
    const destBody = await readTextFile(destPath);
    if (!destBody) return;
    const srcBody = await readTextFile(srcPath);
    if (destBody === srcBody) return;
    await backupRemoteVersion(toDir, noteId, destBody);
  } catch { /* best-effort backup */ }
}

/** Move managed note data. Merge preserves both sides with newer-wins clocks. */
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
      await clearDirContents(toDir, undefined, true);
      await copySharedTreeForOverwrite(fromDir, toDir);

      if (!destinationIsInsideSource) {
        await clearDirContents(fromDir);
      }
      return { success: true };
    }

    // Snapshot both sides before writing so newer-wins is based on original
    // source and destination state.
    const fromBase = normalizeSep(fromDir);
    const toBase = normalizeSep(toDir);

    await assertReadableDirIfExists(`${fromBase}.meta`);
    await assertReadableDirIfExists(`${toBase}.meta`);
    await assertReadableDirIfExists(`${fromBase}.assets`);
    await assertReadableFileIfExists(`${fromBase}.groups.json`);
    await assertReadableFileIfExists(`${toBase}.groups.json`);

    const sourceMeta = await readAllMeta(fromDir);
    const destMetaBefore = await readAllMeta(toDir);

    const sourceMdMtimes = await readMdMtimes(fromDir, true);
    const destMdMtimes = await readMdMtimes(toDir, true);

    const sourceTrashMtimes = await readTrashMdMtimes(
      fromDir,
      await exists(`${fromBase}.trash`).catch(() => false),
    );
    const destTrashMtimes = await readTrashMdMtimes(
      toDir,
      await exists(`${toBase}.trash`).catch(() => false),
    );

    const sourceGroupsFile = await readGroupsFile(fromDir);
    const destGroupsBefore = await readGroupsFile(toDir);

    for (const [name, srcMtime] of sourceMdMtimes) {
      const destMtime = destMdMtimes.get(name);
      if (destMtime === undefined) {
        await copyFile(`${fromBase}${name}`, `${toBase}${name}`);
        continue;
      }
      if (destMtime >= srcMtime) continue;
      await backupOverwrittenBody(
        `${fromBase}${name}`, `${toBase}${name}`, toDir, name.replace(/\.md$/i, ""),
      );
      await copyFile(`${fromBase}${name}`, `${toBase}${name}`);
    }
    // Group membership has its own clock; do not let body/title clocks erase it.
    await ensureMetaDir(toDir);
    for (const [id, src] of sourceMeta) {
      const dest = destMetaBefore.get(id);
      const mergedMeta = mergeMetaForMigration(src, dest);
      if (dest && metasEqual(dest, mergedMeta)) continue;
      await writeMeta(toDir, mergedMeta, machineId);
    }
    if (sourceTrashMtimes.size > 0) {
      await mkdir(`${toBase}.trash`, { recursive: true }).catch(() => {});
      for (const [name, srcMtime] of sourceTrashMtimes) {
        const destMtime = destTrashMtimes.get(name);
        if (destMtime === undefined) {
          await copyFile(`${fromBase}.trash/${name}`, `${toBase}.trash/${name}`);
          continue;
        }
        if (destMtime >= srcMtime) continue;
        await backupOverwrittenBody(
          `${fromBase}.trash/${name}`, `${toBase}.trash/${name}`, toDir, name.replace(/\.md$/i, ""),
        );
        await copyFile(`${fromBase}.trash/${name}`, `${toBase}.trash/${name}`);
      }
    }

    if (await exists(`${fromBase}.assets`).catch(() => false)) {
      await unionCopyMissing(`${fromBase}.assets`, `${toBase}.assets`);
    }

    const merged = mergeGroupMaps(destGroupsBefore.groups, sourceGroupsFile.groups);
    if (Object.keys(merged).length > 0) {
      await writeGroupsWithMerge(toDir, merged);
    }

    if (await exists(`${fromBase}.conflicts`).catch(() => false)) {
      try {
        await unionCopyMissing(`${fromBase}.conflicts`, `${toBase}.conflicts`);
      } catch { /* best-effort */ }
    }

    if (!destinationIsInsideSource) {
      await clearDirContents(fromDir);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function hasExistingNotenData(dir: string): Promise<boolean> {
  const base = normalizeSep(dir);
  try {
    const entries = await readDir(dir);
    if (entries.some((e) => e.isFile && e.name?.endsWith(".md"))) return true;
  } catch { /* ignore */ }
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
  try {
    const trashEntries = await readDir(`${base}.trash`);
    if (trashEntries.some((e) => e.isFile && e.name?.endsWith(".md"))) return true;
  } catch { /* ignore */ }
  try {
    const assetEntries = await readDir(`${base}.assets`);
    if (assetEntries.some((e) => e.name)) return true;
  } catch { /* ignore */ }
  return false;
}

export const hasManifest = hasExistingNotenData;

export { metaDirFor, metaPathFor, groupsPathFor };
