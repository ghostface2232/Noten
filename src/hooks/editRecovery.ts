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
 * Only `main` reopens under the same label and finds its own previous run's
 * records. A secondary window's label is new every time it opens, so its
 * records, whether it closed with edits journalled or died with the process,
 * come back through the orphan sweep: the sweeping window adopts every label
 * no live window owns. A live sibling's records are left alone: that window is
 * still protecting them.
 */
export async function recoverJournalledEdits(
  applyBody: (record: RecoveryRecord) => Promise<boolean>,
): Promise<RecoveryOutcome> {
  const [appData, notesDir] = await Promise.all([appDataDir(), getNotesDir()]);
  const liveLabels = (await getAllWindows()).map((w) => w.label);
  const windowLabel = getCurrentWindow().label;
  // Exactly one window sweeps the orphans, or two starting together replay the
  // same records and each writes its own .conflicts copy. The first live label
  // in sort order is a stable choice that needs no coordination between them.
  const sweeper = [...liveLabels].sort()[0] ?? windowLabel;
  const adoptLabels = sweeper === windowLabel
    ? await findOrphanedLabels(tauriFileSystem, appData, liveLabels)
    : [];
  return recoverEdits({
    fs: tauriFileSystem,
    appDataDir: appData,
    notesDir,
    windowLabel,
    adoptLabels,
    applyBody,
  });
}
