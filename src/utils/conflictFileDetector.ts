import type { FileSystem } from "./fs";
import { metaDirFor, metaPathFor, readMeta, writeMeta, type NoteMeta } from "./metadataIO";
import { groupsPathFor, writeGroupsWithMerge } from "./groupsIO";
import { getMachineIdCached } from "./machineId";
import { atomicWriteText } from "./atomicWrite";
import { normalizeSep } from "./pathUtils";
import { NotenError } from "./notenError";
import { logNotenError } from "./crashLog";

/** Known OneDrive/Dropbox conflict suffixes, anchored to the filename stem. */
const CONFLICT_SUFFIX_RE = /(?:[- ]\(\d+\)|-\w+(?:-conflicted copy)?|-conflicted copy \d{4}-\d{2}-\d{2}|-DESKTOP-[A-Z0-9]+|-LAPTOP-[A-Z0-9]+|-PC-[A-Z0-9-]+| \(\w+[-\w]*'s conflicted copy \d{4}-\d{2}-\d{2}\))$/i;

function isConflictFileName(name: string, baseStem: string, ext: string): boolean {
  if (!name.endsWith(ext)) return false;
  if (name === `${baseStem}${ext}`) return false;
  const stem = name.slice(0, -ext.length);
  if (!stem.startsWith(baseStem)) return false;
  const suffix = stem.slice(baseStem.length);
  if (!suffix) return false;
  return (
    /^[- ]\(\d+\)$/.test(suffix) ||                         // " (1)" or "-(1)"
    /^-conflicted copy \d{4}-\d{2}-\d{2}$/i.test(suffix) || // Dropbox
    /^ \(.+'s conflicted copy \d{4}-\d{2}-\d{2}\)$/i.test(suffix) || // Dropbox long
    /^-DESKTOP-[A-Z0-9-]+$/i.test(suffix) ||                 // OneDrive Windows
    /^-[A-Z0-9-]{3,}$/i.test(suffix)                         // OneDrive generic host
  );
}

function stripConflictSuffix(stem: string): string | null {
  const m = stem.match(CONFLICT_SUFFIX_RE);
  if (!m) return null;
  return stem.slice(0, stem.length - m[0].length);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConflictScanResult {
  absorbedMdNotes: number;
  mergedGroupsConflicts: number;
  mergedMetaConflicts: number;
  removedManifestConflicts: number;
}

/** Absorb safe OneDrive/Dropbox conflict copies in the shared notes folder. */
export async function scanAndAbsorbConflicts(fs: FileSystem, notesDir: string): Promise<ConflictScanResult> {
  const result: ConflictScanResult = {
    absorbedMdNotes: 0,
    mergedGroupsConflicts: 0,
    mergedMetaConflicts: 0,
    removedManifestConflicts: 0,
  };

  const dirBase = normalizeSep(notesDir);
  let rootEntries: { name?: string; isFile?: boolean; isDirectory?: boolean }[] = [];
  try {
    rootEntries = await fs.readDir(notesDir);
  } catch (err) {
    // Previously this swallowed and returned a zero-counter result, so a
    // transient readDir failure (cloud-sync placeholder on the dir itself)
    // looked identical to "no conflicts present". The next reconcile retries
    // anyway, but a user who quits between cycles loses the absorb pass with
    // no diagnostic trace.
    void logNotenError(new NotenError(
      "CONFLICT_SCAN_FAILED",
      "recoverable",
      "scanAndAbsorbConflicts: notes-dir readDir failed; skipping this pass",
      { context: { notesDir }, cause: err },
    ));
    return result;
  }

  // Leave manifest conflicts; they may be the only copy of legacy state.
  for (const e of rootEntries) {
    if (!e.name || !e.isFile) continue;
    if (e.name === ".groups.json") continue;
    if (isConflictFileName(e.name, ".groups", ".json")) {
      const path = `${dirBase}${e.name}`;
      let merged = false;
      try {
        const raw = await fs.readTextFile(path);
        const parsed = JSON.parse(raw) as { groups?: unknown };
        if (parsed && typeof parsed === "object" && parsed.groups && typeof parsed.groups === "object") {
          await writeGroupsWithMerge(fs, notesDir, parsed.groups as Record<string, import("./groupsIO").SharedGroupEntry>);
          result.mergedGroupsConflicts++;
          merged = true;
        }
      } catch { /* ignore broken file */ }
      if (merged) {
        try { await fs.remove(path); } catch { /* keep for retry */ }
      }
    }
  }

  const metaDir = metaDirFor(notesDir);
  let metaEntries: { name?: string; isFile?: boolean }[] = [];
  try { metaEntries = await fs.readDir(metaDir); } catch { metaEntries = []; }

  for (const e of metaEntries) {
    if (!e.name || !e.isFile) continue;
    if (!e.name.endsWith(".json")) continue;
    const stem = e.name.slice(0, -".json".length);
    if (UUID_RE.test(stem)) continue;
    const canonicalStem = stripConflictSuffix(stem);
    if (!canonicalStem || !UUID_RE.test(canonicalStem)) continue;

    const conflictPath = `${metaDir}/${e.name}`;
    let merged = false;
    try {
      const raw = await fs.readTextFile(conflictPath);
      const remote = JSON.parse(raw) as NoteMeta;
      if (!remote || typeof remote !== "object" || remote.id !== canonicalStem) {
        continue;
      }
      const local = await readMeta(fs, notesDir, canonicalStem);
      const winnerIsLocal = !!(local && local.updatedAt >= remote.updatedAt);
      const winner = winnerIsLocal ? local! : remote;
      const localGroupUpdatedAt = local ? (local.groupUpdatedAt ?? local.updatedAt) : -1;
      const remoteGroupUpdatedAt = remote.groupUpdatedAt ?? remote.updatedAt;
      const groupWinner = remoteGroupUpdatedAt > localGroupUpdatedAt
        ? remote
        : remoteGroupUpdatedAt < localGroupUpdatedAt
          ? local
          : (local?.groupId ? local : remote);
      const winnerColor = winner.color ?? null;
      const localColor = local?.color ?? null;
      const remoteColor = remote.color ?? null;
      // Group membership has its own clock, independent of body/title conflicts.
      const mergedMeta = {
        ...local,
        ...winner,
        id: canonicalStem,
        pinned: local?.pinned === true || remote.pinned === true,
        color: winnerColor ?? localColor ?? remoteColor ?? undefined,
        groupId: groupWinner?.groupId ?? null,
        groupUpdatedAt: groupWinner?.groupUpdatedAt ?? groupWinner?.updatedAt,
      };
      await writeMeta(fs, notesDir, mergedMeta, getMachineIdCached());
      result.mergedMetaConflicts++;
      merged = true;
    } catch { /* ignore */ }
    if (merged) {
      try { await fs.remove(conflictPath); } catch { /* keep for retry */ }
    }
  }

  for (const e of rootEntries) {
    if (!e.name || !e.isFile) continue;
    if (!e.name.endsWith(".md")) continue;
    const stem = e.name.slice(0, -".md".length);
    if (UUID_RE.test(stem)) continue;
    const canonicalStem = stripConflictSuffix(stem);
    if (!canonicalStem || !UUID_RE.test(canonicalStem)) continue;

    const conflictPath = `${dirBase}${e.name}`;
    const canonicalPath = `${dirBase}${canonicalStem}.md`;

    let conflictBody = "";
    try { conflictBody = await fs.readTextFile(conflictPath); } catch { continue; }

    let canonicalBody = "";
    try { canonicalBody = await fs.readTextFile(canonicalPath); } catch { /* canonical missing */ }

    if (canonicalBody === conflictBody) {
      try { await fs.remove(conflictPath); } catch { /* ignore */ }
      continue;
    }

    const newId = crypto.randomUUID();
    const newPath = `${dirBase}${newId}.md`;
    try {
      await fs.rename(conflictPath, newPath);
    } catch {
      try {
        await fs.copyFile(conflictPath, newPath);
        await fs.remove(conflictPath);
      } catch {
        continue;
      }
    }

    const seed = await readMeta(fs, notesDir, canonicalStem);
    const suffixTag = stem.slice(canonicalStem.length).replace(/^[- ]/, "") || "conflict";
    const now = Date.now();
    const newMeta: NoteMeta = {
      version: 2,
      id: newId,
      fileName: `${seed?.fileName ?? canonicalStem} (${suffixTag})`,
      customName: true,
      createdAt: seed?.createdAt ?? now,
      updatedAt: now,
      pinned: seed?.pinned === true,
      color: seed?.color,
      groupId: seed?.groupId ?? null,
      groupUpdatedAt: seed?.groupUpdatedAt ?? seed?.updatedAt ?? now,
      trashedAt: null,
    };
    await writeMeta(fs, notesDir, newMeta, getMachineIdCached());
    result.absorbedMdNotes++;
  }

  return result;
}

export async function retireLegacyManifest(fs: FileSystem, notesDir: string): Promise<boolean> {
  const base = normalizeSep(notesDir);
  const src = `${base}manifest.json`;
  const dst = `${base}manifest.legacy.json`;
  try {
    if (!(await fs.exists(src))) return false;
  } catch {
    return false;
  }
  try {
    const existsDst = await fs.exists(dst).catch(() => false);
    if (existsDst) {
      await fs.remove(src).catch(() => {});
      return true;
    }
    await fs.rename(src, dst);
    return true;
  } catch {
    try {
      const raw = await fs.readTextFile(src);
      await atomicWriteText(fs, dst, raw);
      await fs.remove(src);
      return true;
    } catch {
      return false;
    }
  }
}

export async function ensureSharedDirs(fs: FileSystem, notesDir: string): Promise<void> {
  await fs.mkdir(notesDir, { recursive: true }).catch(() => {});
  await fs.mkdir(metaDirFor(notesDir), { recursive: true }).catch(() => {});
}

export { metaPathFor, groupsPathFor };
