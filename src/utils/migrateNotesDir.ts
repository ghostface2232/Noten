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

interface ManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
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
      pinned: n.pinned === true,
      groupId: noteIdToGroupId.get(n.id) ?? null,
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
      groupId: t.groupId ?? null,
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

/**
 * Copy `.md` / `.meta` / `.groups.json` / `.trash` / `.assets` from `fromDir`
 * to `toDir` UNCONDITIONALLY (source overwrites destination on collision).
 * Used only by the "overwrite" strategy — merge runs the snapshot-based
 * `mergeMigrate` path which makes per-id / per-name newer-wins decisions.
 */
async function copySharedTreeForOverwrite(fromDir: string, toDir: string): Promise<void> {
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

  // .groups.json — overwrite copies; merge path handles its own union write.
  try {
    if (await exists(`${fromBase}.groups.json`)) {
      await copyFile(`${fromBase}.groups.json`, `${toBase}.groups.json`).catch(() => {});
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

// ── Helpers used only by the merge path ────────────────────────────────────

/** filename → mtime (ms) for every `.md` file directly inside `dir`. */
async function readMdMtimes(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let entries: { name?: string; isFile?: boolean }[] = [];
  try { entries = await readDir(dir); } catch { return out; }
  for (const e of entries) {
    if (!e.name || !e.isFile) continue;
    if (!e.name.endsWith(".md")) continue;
    const ts = await getFileTimestamps(`${normalizeSep(dir)}${e.name}`);
    out.set(e.name, ts.updatedAt);
  }
  return out;
}

/** filename → mtime (ms) for every `.md` file inside `dir/.trash`. */
async function readTrashMdMtimes(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const trashDir = `${normalizeSep(dir)}.trash`;
  let entries: { name?: string; isFile?: boolean }[] = [];
  try { entries = await readDir(trashDir); } catch { return out; }
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
    && (a.groupId ?? null) === (b.groupId ?? null)
    && (a.trashedAt ?? null) === (b.trashedAt ?? null)
    && (a.trashedFromPath ?? null) === (b.trashedFromPath ?? null);
}

function mergeMetaForMigration(source: NoteMeta, dest: NoteMeta | undefined): NoteMeta {
  if (!dest) return source;

  const winner = source.updatedAt > dest.updatedAt ? source : dest;
  const loser = winner === source ? dest : source;
  const groupId = winner.groupId ?? loser.groupId ?? null;

  return {
    ...winner,
    customName: winner.customName || undefined,
    pinned: winner.pinned === true,
    groupId,
    trashedAt: winner.trashedAt ?? null,
    trashedFromPath: winner.trashedFromPath ?? loser.trashedFromPath ?? null,
  };
}

/**
 * Union-copy `.assets/{noteId}/{hash}.{ext}` from source into destination.
 * Asset filenames are SHA-256 of the body, so a destination file with the
 * same name has identical content — skip those, copy only the absent ones.
 */
async function mergedCopyAssets(srcDir: string, destDir: string): Promise<void> {
  let entries: { name?: string; isFile?: boolean; isDirectory?: boolean }[] = [];
  try { entries = await readDir(srcDir); } catch { return; }
  await mkdir(destDir, { recursive: true }).catch(() => {});
  const srcBase = normalizeSep(srcDir);
  const destBase = normalizeSep(destDir);
  for (const entry of entries) {
    if (!entry.name) continue;
    const srcPath = `${srcBase}${entry.name}`;
    const destPath = `${destBase}${entry.name}`;
    if (entry.isDirectory) {
      await mergedCopyAssets(srcPath, destPath);
    } else if (entry.isFile) {
      const destAlready = await exists(destPath).catch(() => false);
      if (destAlready) continue;
      await copyFile(srcPath, destPath).catch(() => {});
    }
  }
}

/**
 * Migrate the notes directory from `fromDir` to `toDir`. Strategy controls
 * what happens when both directories already contain shared state:
 *   - "merge": both sides' state is preserved; on collision, per-id `.meta`
 *     and per-filename `.md` / `.trash` files are reconciled by mtime/
 *     `updatedAt` — newer wins on either side. `.groups.json` is union-merged
 *     by `mergeGroupMaps` (newer `updatedAt` / `orderUpdatedAt` per id).
 *     `.assets/` is union-copied by content-hash filename (no overwrite).
 *   - "overwrite": destination contents are wiped first, then source is copied
 *     unconditionally.
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
      await copySharedTreeForOverwrite(fromDir, toDir);

      if (!destinationIsInsideSource) {
        await clearDirContents(fromDir);
      }
      return { success: true };
    }

    // ── merge strategy ─────────────────────────────────────────────────────
    // CRUCIAL: snapshot BOTH sides before touching the destination. The old
    // implementation copied source over destination first, then tried to
    // restore — but by the time it re-read the destination the original meta
    // was gone, so per-id newer-wins silently became "source always wins".
    //
    // The corrected flow takes per-id and per-filename snapshots up-front,
    // then performs only the writes that actually change the destination.
    const fromBase = normalizeSep(fromDir);
    const toBase = normalizeSep(toDir);

    const sourceMeta = await readAllMeta(fromDir);
    const destMetaBefore = await readAllMeta(toDir);

    const sourceMdMtimes = await readMdMtimes(fromDir);
    const destMdMtimes = await readMdMtimes(toDir);

    const sourceTrashMtimes = await readTrashMdMtimes(fromDir);
    const destTrashMtimes = await readTrashMdMtimes(toDir);

    const sourceGroupsFile = await readGroupsFile(fromDir);
    const destGroupsBefore = await readGroupsFile(toDir);

    // 1) Root .md bodies — per-filename mtime newer-wins.
    for (const [name, srcMtime] of sourceMdMtimes) {
      const destMtime = destMdMtimes.get(name);
      if (destMtime !== undefined && destMtime >= srcMtime) continue; // dest newer or equal → keep
      await copyFile(`${fromBase}${name}`, `${toBase}${name}`).catch(() => {});
    }
    // dest-only .md files were never touched → preserved automatically.

    // 2) `.meta/{id}.json` — per-id `updatedAt` newer-wins for title/body
    // metadata, but preserve non-null group membership. Group moves do not
    // bump note `updatedAt`, so treating it as a whole-file clock can eject
    // grouped notes during cloud-folder merges.
    await ensureMetaDir(toDir);
    for (const [id, src] of sourceMeta) {
      const dest = destMetaBefore.get(id);
      const mergedMeta = mergeMetaForMigration(src, dest);
      if (dest && metasEqual(dest, mergedMeta)) continue;
      await writeMeta(toDir, mergedMeta, machineId).catch(() => {});
    }
    // dest-only meta ids: still on disk untouched → preserved.

    // 3) `.trash/{name}.md` — per-filename mtime newer-wins.
    if (sourceTrashMtimes.size > 0) {
      await mkdir(`${toBase}.trash`, { recursive: true }).catch(() => {});
      for (const [name, srcMtime] of sourceTrashMtimes) {
        const destMtime = destTrashMtimes.get(name);
        if (destMtime !== undefined && destMtime >= srcMtime) continue;
        await copyFile(`${fromBase}.trash/${name}`, `${toBase}.trash/${name}`).catch(() => {});
      }
    }

    // 4) `.assets/` — content-addressed filenames; union-copy without overwrite.
    try {
      await mergedCopyAssets(`${fromBase}.assets`, `${toBase}.assets`);
    } catch { /* may not exist */ }

    // 5) `.groups.json` — union with `mergeGroupMaps` (newer-wins per entry).
    const merged = mergeGroupMaps(destGroupsBefore.groups, sourceGroupsFile.groups);
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
