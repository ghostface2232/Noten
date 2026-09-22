import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { exists } from "@tauri-apps/plugin-fs";
import { migrateNotesDir, clearManagedNotesData, isSameDirectory } from "./migrateNotesDir";
import { readMigrationJournal, clearMigrationJournal, type MigrationJournal } from "./migrationJournal";

/**
 * Finish a deferred migration cleanup recorded in the journal.
 *
 * Conservative by design (requirement: cleanup only after it is provably safe):
 * - runs only when this is the SOLE window, so no other window can still be
 *   editing the old directory;
 * - `merge` mode folds any late writes the old dir received after the copy back
 *   into the new dir (newer-wins) before clearing it — read/stat errors surface
 *   as `success:false` from migrateNotesDir and keep the journal for a retry;
 * - `backup-only` mode (use-selected-only) deletes the old managed data without
 *   merging, since the user chose not to combine the folders;
 * - the journal is dropped ONLY after the final step fully succeeds.
 *
 * Returns true when the cleanup completed (journal cleared), false when it was
 * deferred or failed (journal kept).
 *
 * The journal is a single slot that only a retained-source migration writes,
 * so a later fully drained migration back INTO the journalled old dir leaves
 * it in place. Its old dir is then the live library, and running it would
 * merge that library into the abandoned folder and clear it. Such a journal
 * is obsolete, not pending: the old dir is in use again, so nothing is left to
 * clean, and it is dropped without touching either folder.
 */
export async function runDeferredCleanup(journal: MigrationJournal, currentNotesDir: string): Promise<boolean> {
  if (isSameDirectory(journal.oldDir, currentNotesDir)) {
    await clearMigrationJournal();
    return true;
  }

  let windowCount: number;
  try {
    windowCount = (await getAllWebviewWindows()).length;
  } catch {
    return false; // can't confirm we're alone — defer to a later run
  }
  if (windowCount > 1) return false;

  // The old dir is already gone (cleaned externally, or by a prior partial
  // run): nothing left to do — drop the journal so we stop retrying it.
  try {
    if (!(await exists(journal.oldDir))) {
      await clearMigrationJournal();
      return true;
    }
  } catch { /* can't stat — fall through and let the merge/delete decide */ }

  if (journal.cleanupMode === "merge") {
    const result = await migrateNotesDir(journal.oldDir, journal.newDir, "merge", { clearSource: true });
    if (!result.success) return false;
  } else {
    const result = await clearManagedNotesData(journal.oldDir, journal.newDir);
    if (!result.success) return false;
  }
  await clearMigrationJournal();
  return true;
}

/**
 * Run any pending deferred cleanup. Best-effort: a failure leaves the journal
 * so a later launch retries. Safe to call at startup and again right after a
 * deferred migration (the single-window guard prevents racing other windows).
 */
export async function recoverPendingMigration(currentNotesDir: string): Promise<void> {
  const journal = await readMigrationJournal();
  if (!journal) return;
  try {
    await runDeferredCleanup(journal, currentNotesDir);
  } catch {
    /* leave the journal; next launch retries */
  }
}
