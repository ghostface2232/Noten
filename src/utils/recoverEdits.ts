import type { FileSystem } from "./fs";
import { backupRemoteVersion } from "./conflictBackup";
import { logNotenError } from "./crashLog";
import { NotenError } from "./notenError";
import { isStrictSubpath } from "./pathUtils";
import {
  clearRecoveryRecord,
  listRecoveryLabels,
  planRecovery,
  readRecoveryRecords,
  removeRecoveryLabelIfEmpty,
  type RecoveryRecord,
} from "./recoveryJournal";

// Replays the recovery journal once the library is loaded.
//
// Runs AFTER hydration rather than inside it, for two reasons. Deciding what
// to do with a record needs the note's current disk body, which is exactly
// what the loader reads (and what seeds the conflict baseline); and applying a
// record is a fresh local intent, so it belongs on the normal local commit
// path, not on hydration's generation-bound one.

export interface RecoverEditsDeps {
  fs: FileSystem;
  appDataDir: string;
  notesDir: string;
  /** This window's label. Labels are reused across runs, so a window finds its
   *  own previous run's records. */
  windowLabel: string;
  /** Labels this window should also adopt — ones whose window did not reopen.
   *  Empty for a window that is not responsible for the sweep. */
  adoptLabels?: string[];
  /** Write a recovered body back as an ordinary local edit. Returns whether it
   *  landed; a record whose apply fails is kept for the next attempt. */
  applyBody: (record: RecoveryRecord) => Promise<boolean>;
}

export interface RecoveryOutcome {
  /** Records whose body was written back to its note. */
  applied: number;
  /** Records kept under `.conflicts/` because applying them was not provably
   *  safe. These need the user to look. */
  preserved: number;
  /** Records the disk had already caught up with. */
  dropped: number;
  /** Records that could not be resolved this run and stay in the journal. */
  deferred: number;
}

async function readDiskBody(fs: FileSystem, filePath: string): Promise<string | null | undefined> {
  if (!filePath) return null;
  try {
    if (!(await fs.exists(filePath))) return null;
    return await fs.readTextFile(filePath);
  } catch {
    // The file is there but unreadable (cloud placeholder, AV lock). Unlike a
    // missing file this says nothing about what the note holds, so the record
    // must survive to the next run rather than be resolved on a guess.
    return undefined;
  }
}

/**
 * Whether a record's note file belongs to the notes directory in use now.
 *
 * Through `isStrictSubpath`, which unifies both separators and resolves `.`,
 * `..` and empty segments. A raw prefix compare got this wrong twice over: it
 * never converted `\` to `/`, so a notes directory stored with a trailing
 * separator classified EVERY record as foreign and recovery could never apply
 * anything; and `filePath` comes out of a JSON file, so a traversal segment
 * would have passed a prefix check straight into `atomicWriteText`.
 */
function isInsideNotesDir(filePath: string, notesDir: string): boolean {
  if (!filePath) return false;
  return isStrictSubpath(notesDir, filePath);
}

export async function recoverEdits(deps: RecoverEditsDeps): Promise<RecoveryOutcome> {
  const { fs, appDataDir, notesDir, windowLabel, applyBody } = deps;
  const outcome: RecoveryOutcome = { applied: 0, preserved: 0, dropped: 0, deferred: 0 };

  const preserve = async (record: RecoveryRecord, reason: string): Promise<"kept" | "nothing" | "failed"> => {
    // An emptied note is a real edit — it is why backupLocalDeletionVersion
    // exists — but backupRemoteVersion refuses an empty body, so there is no
    // file to point the user at. Report that honestly instead of counting it
    // as preserved and showing a notice about a .conflicts copy that is not
    // there.
    if (!record.content.trim()) return "nothing";
    try {
      await backupRemoteVersion(fs, notesDir, record.docId, record.content);
    } catch (err) {
      void logNotenError(new NotenError(
        "BACKUP_FAILED",
        "fatal",
        "recoverEdits: could not keep an unsaved edit; leaving it journalled for the next run",
        { context: { noteId: record.docId, filePath: record.filePath, reason }, cause: err },
      ));
      return "failed";
    }
    void logNotenError(new NotenError(
      "BACKUP_FAILED",
      "recoverable",
      `recoverEdits: kept an unsaved edit under .conflicts (${reason})`,
      { context: { noteId: record.docId, filePath: record.filePath, reason } },
    ));
    return "kept";
  };

  const labels = new Set<string>([windowLabel]);
  for (const label of deps.adoptLabels ?? []) labels.add(label);

  for (const label of labels) {
    let records: RecoveryRecord[];
    try {
      records = await readRecoveryRecords(fs, appDataDir, label);
    } catch {
      continue;
    }
    for (const record of records) {
      // A record written before a notes-directory change points into the old
      // folder. Applying it would write the body there while the commit marks
      // the live note clean, so the edit would vanish from the library it was
      // made in. Keep it instead, under the CURRENT folder's .conflicts.
      if (!isInsideNotesDir(record.filePath, notesDir)) {
        const kept = await preserve(record, "foreign-path");
        if (kept === "failed") {
          outcome.deferred += 1;
          continue;
        }
        if (kept === "kept") outcome.preserved += 1;
        else outcome.dropped += 1;
        await clearRecoveryRecord(fs, appDataDir, label, record.docId);
        continue;
      }
      const diskContent = await readDiskBody(fs, record.filePath);
      if (diskContent === undefined) {
        outcome.deferred += 1;
        continue;
      }
      const plan = planRecovery(record, diskContent);
      try {
        if (plan.action === "apply") {
          if (!(await applyBody(record))) {
            outcome.deferred += 1;
            continue;
          }
          outcome.applied += 1;
        } else if (plan.action === "preserve") {
          // Keep the work and leave the note alone.
          const kept = await preserve(record, plan.reason);
          if (kept === "failed") {
            outcome.deferred += 1;
            continue;
          }
          if (kept === "kept") outcome.preserved += 1;
          else outcome.dropped += 1;
        } else {
          outcome.dropped += 1;
        }
      } catch (err) {
        // Could not resolve this record. Leave it in the journal: another run
        // can still try, and dropping it would throw the edit away.
        outcome.deferred += 1;
        void logNotenError(new NotenError(
          "BACKUP_FAILED",
          "fatal",
          "recoverEdits: could not resolve a journalled edit; keeping it for the next run",
          { context: { noteId: record.docId, filePath: record.filePath }, cause: err },
        ));
        continue;
      }
      await clearRecoveryRecord(fs, appDataDir, label, record.docId);
    }
    // Own label excluded: this window may journal again at any moment.
    if (label !== windowLabel) await removeRecoveryLabelIfEmpty(fs, appDataDir, label);
  }

  return outcome;
}

/** Labels holding records that no live window owns. The caller passes the
 *  labels currently open so a sibling window's in-flight records are left
 *  alone. */
export async function findOrphanedLabels(
  fs: FileSystem,
  appDataDir: string,
  liveLabels: readonly string[],
): Promise<string[]> {
  const live = new Set(liveLabels);
  try {
    return (await listRecoveryLabels(fs, appDataDir)).filter((label) => !live.has(label));
  } catch {
    return [];
  }
}
