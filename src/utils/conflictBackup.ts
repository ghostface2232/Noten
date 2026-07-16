import type { FileSystem } from "./fs";
import { normalizeSep } from "./pathUtils";
import { NotenError } from "./notenError";
import { markdownEqual } from "./markdownEqual";

const README_BODY = `This folder holds note bodies preserved during sync
conflicts. Files are named
"\`{noteId}-{timestamp-ms}.md\`" and are kept indefinitely so you can recover
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

export function forgetKnownDiskContent(filePath: string): void {
  lastKnownDiskContent.delete(noteIdToDiskKey(filePath));
}

export function resetKnownDiskContent(): void {
  lastKnownDiskContent.clear();
}

async function writeConflictVersion(
  fs: FileSystem,
  notesDir: string,
  noteId: string,
  body: string,
): Promise<string> {
  const conflictsDir = `${normalizeSep(notesDir)}.conflicts`;
  try { await fs.mkdir(conflictsDir, { recursive: true }); } catch { /* ignore */ }
  const path = `${normalizeSep(conflictsDir)}${noteId}-${Date.now()}.md`;
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
  // First save in this session: seed the baseline, don't back up speculatively.
  if (lastKnown === undefined) {
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
