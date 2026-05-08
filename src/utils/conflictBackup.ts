import { mkdir, readTextFile, writeTextFile, exists } from "@tauri-apps/plugin-fs";

function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}

const README_BODY = `This folder holds backups of note bodies that were on disk
when another change was about to overwrite them. Files are named
"\`{noteId}-{timestamp-ms}.md\`" and are kept indefinitely so you can recover
content lost to a multi-device race.

Safe to delete anything in here once you've reviewed the contents.
`;

async function ensureReadme(notesDir: string, conflictsDir: string): Promise<void> {
  void notesDir; // signature symmetry; not currently used
  const path = `${normalizeSep(conflictsDir)}README.md`;
  try {
    if (await exists(path)) return;
  } catch { /* ignore */ }
  try { await writeTextFile(path, README_BODY); } catch { /* best-effort */ }
}

/**
 * The last content we believe is sitting on disk for each note. Updated when
 * we successfully write or when the watcher reloads. Used to detect that the
 * file changed under us (likely from another PC) before we overwrite it.
 */
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

/** Clear the entire baseline cache. Used when the notes directory changes. */
export function resetKnownDiskContent(): void {
  lastKnownDiskContent.clear();
}

/**
 * Write a backup of `body` into `{notesDir}/.conflicts/{noteId}-{ts}.md`.
 * Idempotent on duplicate calls within the same millisecond (suffix collision
 * is unlikely; if it happens we silently overwrite).
 */
export async function backupRemoteVersion(
  notesDir: string,
  noteId: string,
  body: string,
): Promise<string | null> {
  if (!body) return null;
  const conflictsDir = `${normalizeSep(notesDir)}.conflicts`;
  try { await mkdir(conflictsDir, { recursive: true }); } catch { /* ignore */ }
  const path = `${normalizeSep(conflictsDir)}${noteId}-${Date.now()}.md`;
  try {
    await writeTextFile(path, body);
    await ensureReadme(notesDir, conflictsDir);
    return path;
  } catch {
    return null;
  }
}

/**
 * Pre-write conflict detection. Reads the on-disk content of `filePath` and
 * compares it to the last-known disk content for the same path. If they
 * differ (= another writer changed the file) AND the would-be overwrite
 * differs from disk, the current disk content is backed up under
 * `.conflicts/`. Returns true if a backup was made.
 */
export async function backupIfRemoteWroteFirst(
  notesDir: string,
  filePath: string,
  noteId: string,
  intendedContent: string,
): Promise<boolean> {
  if (!filePath) return false;
  let diskContent: string | null = null;
  try {
    diskContent = await readTextFile(filePath);
  } catch {
    diskContent = null;
  }
  if (diskContent === null) return false;

  const lastKnown = getKnownDiskContent(filePath);
  // First save in this session — no baseline to compare to. Treat the current
  // disk state as our baseline going forward; do NOT back up speculatively.
  if (lastKnown === undefined) {
    setKnownDiskContent(filePath, diskContent);
    return false;
  }

  // Disk matches what we last knew — nothing to back up; we're not losing data.
  if (diskContent === lastKnown) return false;

  // Our planned write equals disk — nothing to overwrite.
  if (diskContent === intendedContent) return false;

  // Real conflict: disk has changes we never saw, and we'd overwrite them.
  await backupRemoteVersion(notesDir, noteId, diskContent);
  return true;
}
