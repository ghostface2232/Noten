import type { FileSystem } from "./fs";
import { normalizeSep } from "./pathUtils";
import { NotenError } from "./notenError";
import { markdownEqual } from "./markdownEqual";

const README_BODY = `This folder holds note bodies preserved during sync
conflicts. Files are named
"\`{noteId}-{timestamp-ms}-{unique-id}.md\`" and are kept indefinitely so you can recover
content lost to a multi-device race.

Safe to delete anything in here once you've reviewed the contents.
`;

async function ensureReadme(fs: FileSystem, notesDir: string, conflictsDir: string): Promise<void> {
  void notesDir; // signature symmetry; not currently used
  const path = `${normalizeSep(conflictsDir)}README.md`;
  try {
    if (await fs.exists(path)) return;
  } catch { /* ignore */ }
  try { await fs.writeTextFile(path, README_BODY); } catch { /* best-effort */ }
}

// Last known on-disk note bodies, used to detect unseen remote writes.
//
// The ABSENCE of an entry is load-bearing: it means this session has neither
// read nor written that path's body, so the bytes on disk are unknown to us.
// Every path that learns a body seeds it — the loader's attachDocContents
// (read), provisionNoteFile and rewriteNoteFile (write), autosave after a
// durable write, and the watcher after an external change. A doc that reached
// the store as a manifest-cache projection (`content: ""` with a real
// filePath, the state a failed load leaves behind) therefore has NO entry,
// and the two destructive consumers below and in pruneEmptyCurrentDoc key off
// exactly that to refuse to act on a body they have never seen.
const lastKnownDiskContent = new Map<string, string>();

export function noteIdToDiskKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

export function setKnownDiskContent(filePath: string, content: string): void {
  lastKnownDiskContent.set(noteIdToDiskKey(filePath), content);
}

export function getKnownDiskContent(filePath: string): string | undefined {
  return lastKnownDiskContent.get(noteIdToDiskKey(filePath));
}

/**
 * Whether this session has never read or written the body at `filePath`, so
 * an empty in-memory body proves nothing about the file.
 *
 * Every site that PERMANENTLY deletes a note body — the three empty-note
 * prunes, which bypass both trash and conflict backup — must refuse when this
 * is true. A manifest-cache projection carries `content: ""` against a real
 * filePath, and a load that fails after committing it leaves the whole library
 * looking like empty notes.
 */
export function hasUnknownDiskBody(filePath: string): boolean {
  return !!filePath && getKnownDiskContent(filePath) === undefined;
}

export function forgetKnownDiskContent(filePath: string): void {
  lastKnownDiskContent.delete(noteIdToDiskKey(filePath));
}

export function resetKnownDiskContent(): void {
  lastKnownDiskContent.clear();
}

export type KnownDiskContentSnapshot = ReadonlyMap<string, string>;

/**
 * Capture the baselines so a rolled-back directory change can put them back.
 * Re-deriving them from the preserved library instead would be wrong: a doc
 * that is still a manifest-cache projection holds `content: ""` it never read,
 * and seeding that would arm the empty-note prunes against a real body.
 */
export function snapshotKnownDiskContent(): KnownDiskContentSnapshot {
  return new Map(lastKnownDiskContent);
}

export function restoreKnownDiskContent(snapshot: KnownDiskContentSnapshot): void {
  lastKnownDiskContent.clear();
  for (const [key, content] of snapshot) lastKnownDiskContent.set(key, content);
}

async function writeConflictVersion(
  fs: FileSystem,
  notesDir: string,
  noteId: string,
  body: string,
): Promise<string> {
  const conflictsDir = `${normalizeSep(notesDir)}.conflicts`;
  try { await fs.mkdir(conflictsDir, { recursive: true }); } catch { /* ignore */ }
  // Multiple windows can preserve different bodies for the same note in the
  // same millisecond. The UUID prevents one recovery artifact from silently
  // overwriting the other; an in-process counter or exists-then-write check
  // would still race across windows.
  const path = `${normalizeSep(conflictsDir)}${noteId}-${Date.now()}-${crypto.randomUUID()}.md`;
  try {
    await fs.writeTextFile(path, body);
    await ensureReadme(fs, notesDir, conflictsDir);
    return path;
  } catch (err) {
    // The .conflicts safety net could not be written. Previously this returned
    // null silently and the caller continued to overwrite the live file, so a
    // backup failure was indistinguishable from "no backup needed". Throw so
    // the caller (autosave) can defer the save instead of dropping the user's
    // only recovery surface.
    throw new NotenError(
      "BACKUP_FAILED",
      "fatal",
      "writeConflictVersion: conflict body write failed",
      { context: { filePath: path, noteId }, cause: err },
    );
  }
}

export async function backupRemoteVersion(
  fs: FileSystem,
  notesDir: string,
  noteId: string,
  body: string,
): Promise<string | null> {
  if (!body) return null;
  return writeConflictVersion(fs, notesDir, noteId, body);
}

/** Preserve dirty local content that lost to a deletion in another window. */
export async function backupLocalDeletionVersion(
  fs: FileSystem,
  notesDir: string,
  noteId: string,
  body: string,
): Promise<string> {
  // An empty body is still a real edit when the user cleared all text.
  return writeConflictVersion(fs, notesDir, noteId, body);
}

/** Back up an unseen remote body before overwriting it. */
export async function backupIfRemoteWroteFirst(
  fs: FileSystem,
  notesDir: string,
  filePath: string,
  noteId: string,
  intendedContent: string,
): Promise<boolean> {
  if (!filePath) return false;
  let diskContent: string;
  try {
    diskContent = await fs.readTextFile(filePath);
  } catch (err) {
    // A read failure has two very different meanings:
    //
    // 1. The file is simply gone (deleted on another device and synced here,
    //    or trashed externally). There is nothing on disk to back up, so the
    //    save is safe — the body write below recreates the file. Treating
    //    this as fatal used to leave a dirty note permanently unsaveable:
    //    every autosave threw, and the whole editing session was silently
    //    lost on close.
    // 2. The file exists but can't be read (cloud-sync placeholder
    //    hydration, AV lock). We genuinely cannot verify whether a remote
    //    body would be overwritten, so defer the save.
    let fileExists = true;
    try {
      fileExists = await fs.exists(filePath);
    } catch { /* can't even stat — keep fatal path below */ }
    if (!fileExists) {
      // The save will recreate the file; drop the stale baseline so the
      // recreated content seeds a fresh one.
      forgetKnownDiskContent(filePath);
      return false;
    }
    // Previously this swallowed to diskContent=null and returned false ("no
    // backup needed"), which lied: we couldn't check, so we don't know.
    // Throw so the caller defers the save rather than overwriting blind.
    throw new NotenError(
      "BACKUP_FAILED",
      "fatal",
      "backupIfRemoteWroteFirst: pre-save read failed; cannot verify whether remote wrote first",
      { context: { filePath, noteId }, cause: err },
    );
  }

  const lastKnown = getKnownDiskContent(filePath);
  // No baseline: this session has never seen this file's body (see the map's
  // comment). Seeding and returning false would let the write destroy unseen
  // content — the projection case, where `intendedContent` is the empty body
  // a failed load left in memory and the disk still holds the real note.
  // Back up whenever the disk holds something we are not about to write; an
  // empty or already-matching file has nothing to lose, so it still seeds
  // silently and keeps the ordinary first-save path backup-free.
  if (lastKnown === undefined) {
    if (diskContent !== "" && !markdownEqual(diskContent, intendedContent)) {
      await backupRemoteVersion(fs, notesDir, noteId, diskContent);
      setKnownDiskContent(filePath, diskContent);
      return true;
    }
    setKnownDiskContent(filePath, diskContent);
    return false;
  }

  // Cosmetic-only divergence (line endings / trailing newline rewritten by a
  // cloud client) is not a real remote edit — skip the backup. markdownEqual is
  // intentionally conservative, so any meaningful change still falls through to
  // the backup below rather than being silently dropped.
  if (markdownEqual(diskContent, lastKnown)) return false;

  if (markdownEqual(diskContent, intendedContent)) return false;

  await backupRemoteVersion(fs, notesDir, noteId, diskContent);
  return true;
}
