import type { FileSystem } from "./fs";
import type { TrashedNote } from "./noteTypes";
import { removeNoteAssetDir } from "./imageAssetUtils";
import { removeMeta } from "./metadataIO";
import { logNotenError } from "./crashLog";
import { NotenError } from "./notenError";
import { markOwnWrite } from "../hooks/ownWriteTracker";

/**
 * Permanently removes a trashed note's files: the .trash body first, then its
 * assets and sidecar. Returns false when the body is still on disk (a cloud
 * sync client or another process holding it), leaving the assets and sidecar
 * untouched so the entry keeps listing in trash and the delete can be retried.
 *
 * Treating that failure as success used to drop the entry anyway and remove
 * its sidecar — the trash list is built from sidecars, so the body stayed in
 * .trash with nothing pointing at it and nothing ever deleting it.
 *
 * `notesDir` null (unresolvable) still removes the body; the sidecar left
 * behind is bodyless and reconcile's orphan-meta cleanup takes it.
 */
export async function purgeTrashedNoteFiles(
  fs: FileSystem,
  notesDir: string | null,
  note: TrashedNote,
): Promise<boolean> {
  try {
    await fs.remove(note.trashFilePath);
  } catch (err) {
    // A missing body is the goal state (already purged, e.g. by a peer).
    // Anything else — including an exists() that itself fails — means the
    // body may still be there.
    let stillThere = true;
    try { stillThere = await fs.exists(note.trashFilePath); } catch { /* unknown: keep */ }
    if (stillThere) {
      void logNotenError(new NotenError(
        "TRASH_PURGE_FAILED",
        "recoverable",
        err instanceof Error ? err.message : String(err),
        { context: { noteId: note.id, filePath: note.trashFilePath }, cause: err },
      ));
      return false;
    }
  }
  if (notesDir) {
    await removeNoteAssetDir(notesDir, note.id);
    await removeMeta(fs, notesDir, note.id);
  }
  return true;
}

/**
 * Removes the .trash copy a restore leaves behind once the root body is in
 * place. A copy that cannot be removed is logged and left alone; the restore
 * itself stands. The next delete of the note overwrites it.
 *
 * There is deliberately no retry or later sweep. A peer window's reconcile
 * can adopt the restored note from disk before this restore publishes, and a
 * delete there writes a fresh trash copy to this same path — indistinguishable
 * from the leftover, so removing it after any delay could lose the note.
 */
export async function removeRestoredTrashCopy(
  fs: FileSystem,
  noteId: string,
  trashPath: string,
): Promise<boolean> {
  markOwnWrite(trashPath);
  try {
    await fs.remove(trashPath);
    return true;
  } catch (err) {
    try {
      if (!await fs.exists(trashPath)) return true;
    } catch { /* unknown: report it */ }
    void logNotenError(new NotenError(
      "TRASH_PURGE_FAILED",
      "recoverable",
      err instanceof Error ? err.message : String(err),
      { context: { stage: "restoreNote", noteId, filePath: trashPath }, cause: err },
    ));
    return false;
  }
}
