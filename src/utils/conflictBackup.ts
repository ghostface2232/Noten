import type { FileSystem } from "./fs";
import { normalizeSep } from "./pathUtils";
import { NotenError } from "./notenError";

const README_BODY = `This folder holds backups of note bodies that were on disk
when another change was about to overwrite them. Files are named
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

export async function backupRemoteVersion(
  fs: FileSystem,
  notesDir: string,
  noteId: string,
  body: string,
): Promise<string | null> {
  if (!body) return null;
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
      "backupRemoteVersion: conflict body write failed",
      { context: { filePath: path, noteId }, cause: err },
    );
  }
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

  if (diskContent === lastKnown) return false;

  if (diskContent === intendedContent) return false;

  await backupRemoteVersion(fs, notesDir, noteId, diskContent);
  return true;
}
