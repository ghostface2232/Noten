import { appDataDir } from "@tauri-apps/api/path";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { tauriFileSystem } from "../utils/fs";
import { findOrphanedLabels, recoverEdits, type RecoveryOutcome } from "../utils/recoverEdits";
import type { RecoveryRecord } from "../utils/recoveryJournal";
import { getNotesDir } from "./useNotesLoader";

/**
 * Tauri binding for the recovery replay. Kept apart from `recoverEdits` so the
 * decisions stay testable without a window or an app-data path.
 *
 * Window labels are reused across app runs, so a window normally finds its own
 * previous run's records. It also adopts labels no live window owns — a second
 * window that was open when the process died and did not reopen this time. A
 * live sibling's records are left alone: that window is still protecting them.
 */
export async function recoverJournalledEdits(
  applyBody: (record: RecoveryRecord) => Promise<boolean>,
): Promise<RecoveryOutcome> {
  const [appData, notesDir] = await Promise.all([appDataDir(), getNotesDir()]);
  const liveLabels = (await getAllWindows()).map((w) => w.label);
  const windowLabel = getCurrentWindow().label;
  const adoptLabels = await findOrphanedLabels(tauriFileSystem, appData, liveLabels);
  return recoverEdits({
    fs: tauriFileSystem,
    appDataDir: appData,
    notesDir,
    windowLabel,
    adoptLabels,
    applyBody,
  });
}
