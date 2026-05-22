import { mkdir, readDir, readTextFile, rename, remove, exists, copyFile } from "@tauri-apps/plugin-fs";
import { metaDirFor, metaPathFor, readMeta, writeMeta, type NoteMeta } from "./metadataIO";
import { groupsPathFor, writeGroupsWithMerge } from "./groupsIO";
import { getMachineIdCached } from "./machineId";
import { atomicWriteText } from "./atomicWrite";

function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}

/**
 * OneDrive conflict suffix patterns we recognise.
 * Matches both the "-HOSTNAME.md" form and the " (1).md" form, and Dropbox's
 * "-conflict-YYYY-MM-DD" form. Anchored to end of the stem so uuid-prefix still
 * works for .md, and so hyphens in filenames don't trigger false positives.
 */
const CONFLICT_SUFFIX_RE = /(?:[- ]\(\d+\)|-\w+(?:-conflicted copy)?|-conflicted copy \d{4}-\d{2}-\d{2}|-DESKTOP-[A-Z0-9]+|-LAPTOP-[A-Z0-9]+|-PC-[A-Z0-9-]+| \(\w+[-\w]*'s conflicted copy \d{4}-\d{2}-\d{2}\))$/i;

/**
 * Looser pattern for sidecars/groups files where the stem is well-known:
 * foo.json -> foo (1).json / foo-conflict-2024-01-01.json etc.
 */
function isConflictFileName(name: string, baseStem: string, ext: string): boolean {
  if (!name.endsWith(ext)) return false;
  if (name === `${baseStem}${ext}`) return false;
  const stem = name.slice(0, -ext.length);
  if (!stem.startsWith(baseStem)) return false;
  const suffix = stem.slice(baseStem.length);
  if (!suffix) return false;
  // common synced-file suffix shapes
  return (
    /^[- ]\(\d+\)$/.test(suffix) ||                         // " (1)" or "-(1)"
    /^-conflicted copy \d{4}-\d{2}-\d{2}$/i.test(suffix) || // Dropbox
    /^ \(.+'s conflicted copy \d{4}-\d{2}-\d{2}\)$/i.test(suffix) || // Dropbox long
    /^-DESKTOP-[A-Z0-9-]+$/i.test(suffix) ||                 // OneDrive Windows
    /^-[A-Z0-9-]{3,}$/i.test(suffix)                         // OneDrive generic host
  );
}

/** Strip any recognised conflict suffix from a stem. Returns null if nothing matched. */
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

/**
 * Scan the shared notes folder for OneDrive/Dropbox conflict copies and absorb them.
 *
 *  - `manifest*.json` conflict copies → left in place; legacy manifests may contain state not safely decomposed here.
 *  - `.groups*.json` / `.groups (1).json` etc. → merged into `.groups.json`, then deleted only after a confirmed write.
 *  - `.meta/{uuid}-{suffix}.json` → merged into the canonical `.meta/{uuid}.json`, then deleted only after a confirmed write.
 *  - Root `{stem}-{suffix}.md` where stem is a UUID of a known note → re-homed under a new UUID
 *    with a " (from …)" label.
 */
export async function scanAndAbsorbConflicts(notesDir: string): Promise<ConflictScanResult> {
  const result: ConflictScanResult = {
    absorbedMdNotes: 0,
    mergedGroupsConflicts: 0,
    mergedMetaConflicts: 0,
    removedManifestConflicts: 0,
  };

  const dirBase = normalizeSep(notesDir);
  let rootEntries: { name?: string; isFile?: boolean; isDirectory?: boolean }[] = [];
  try {
    rootEntries = await readDir(notesDir);
  } catch {
    return result;
  }

  // ── manifest conflict copies ──
  // Do not delete these here. A legacy conflict manifest can be the only copy
  // containing old note/group/trash state, and this scanner cannot safely
  // decompose it without body-file context.

  // ── .groups.json conflicts: merge then delete ──
  for (const e of rootEntries) {
    if (!e.name || !e.isFile) continue;
    if (e.name === ".groups.json") continue;
    if (isConflictFileName(e.name, ".groups", ".json")) {
      const path = `${dirBase}${e.name}`;
      let merged = false;
      try {
        const raw = await readTextFile(path);
        const parsed = JSON.parse(raw) as { groups?: unknown };
        if (parsed && typeof parsed === "object" && parsed.groups && typeof parsed.groups === "object") {
          await writeGroupsWithMerge(notesDir, parsed.groups as Record<string, import("./groupsIO").SharedGroupEntry>);
          result.mergedGroupsConflicts++;
          merged = true;
        }
      } catch { /* ignore broken file */ }
      if (merged) {
        try { await remove(path); } catch { /* keep for retry */ }
      }
    }
  }

  // ── .meta/{uuid}*.json conflicts: merge into canonical by picking newer updatedAt ──
  const metaDir = metaDirFor(notesDir);
  let metaEntries: { name?: string; isFile?: boolean }[] = [];
  try { metaEntries = await readDir(metaDir); } catch { metaEntries = []; }

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
      const raw = await readTextFile(conflictPath);
      const remote = JSON.parse(raw) as NoteMeta;
      if (!remote || typeof remote !== "object" || remote.id !== canonicalStem) {
        continue;
      }
      const local = await readMeta(notesDir, canonicalStem);
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
      // Layer winner on top of local so optional fields (e.g. trashedFromPath)
      // present only on the loser are preserved when not contradicted. Group
      // membership has its own clock so body/title conflicts do not overwrite it.
      const mergedMeta = {
        ...local,
        ...winner,
        id: canonicalStem,
        pinned: local?.pinned === true || remote.pinned === true,
        color: winnerColor ?? localColor ?? remoteColor ?? undefined,
        groupId: groupWinner?.groupId ?? null,
        groupUpdatedAt: groupWinner?.groupUpdatedAt ?? groupWinner?.updatedAt,
      };
      await writeMeta(notesDir, mergedMeta, getMachineIdCached());
      result.mergedMetaConflicts++;
      merged = true;
    } catch { /* ignore */ }
    if (merged) {
      try { await remove(conflictPath); } catch { /* keep for retry */ }
    }
  }

  // ── Root .md conflict copies ──
  //   * UUID stems: absorb as new note only if the body differs, else just remove.
  //   * non-UUID stems: leave untouched (legacy import flow handles them).
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
    try { conflictBody = await readTextFile(conflictPath); } catch { continue; }

    let canonicalBody = "";
    try { canonicalBody = await readTextFile(canonicalPath); } catch { /* canonical missing */ }

    if (canonicalBody === conflictBody) {
      try { await remove(conflictPath); } catch { /* ignore */ }
      continue;
    }

    // Create a new note UUID for the conflict body. Copy the canonical meta as a seed.
    const newId = crypto.randomUUID();
    const newPath = `${dirBase}${newId}.md`;
    try {
      await rename(conflictPath, newPath);
    } catch {
      try {
        await copyFile(conflictPath, newPath);
        await remove(conflictPath);
      } catch {
        continue;
      }
    }

    const seed = await readMeta(notesDir, canonicalStem);
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
    await writeMeta(notesDir, newMeta, getMachineIdCached());
    result.absorbedMdNotes++;
  }

  return result;
}

/** Rename a legacy `manifest.json` to `manifest.legacy.json` if present and not already done. */
export async function retireLegacyManifest(notesDir: string): Promise<boolean> {
  const base = normalizeSep(notesDir);
  const src = `${base}manifest.json`;
  const dst = `${base}manifest.legacy.json`;
  try {
    if (!(await exists(src))) return false;
  } catch {
    return false;
  }
  try {
    const existsDst = await exists(dst).catch(() => false);
    if (existsDst) {
      await remove(src).catch(() => {});
      return true;
    }
    await rename(src, dst);
    return true;
  } catch {
    // Fallback: copy + delete
    try {
      const raw = await readTextFile(src);
      await atomicWriteText(dst, raw);
      await remove(src);
      return true;
    } catch {
      return false;
    }
  }
}

/** Ensure notes dir and its .meta subdir exist. */
export async function ensureSharedDirs(notesDir: string): Promise<void> {
  await mkdir(notesDir, { recursive: true }).catch(() => {});
  await mkdir(metaDirFor(notesDir), { recursive: true }).catch(() => {});
}

/** Expose path helpers for callers that just need them. */
export { metaPathFor, groupsPathFor };
