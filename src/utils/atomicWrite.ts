import type { FileSystem } from "./fs";
import { NotenError } from "./notenError";
import { logNotenError } from "./crashLog";

export interface AtomicWriteOptions {
  /**
   * Fail-closed mode for the single-source-of-truth note body (.md).
   *
   * When true, a tmp-write or rename failure is NOT degraded to a non-atomic
   * direct overwrite: the failure is logged and rethrown so the caller keeps
   * the doc dirty and retries. Degrading exactly when antivirus / OneDrive
   * locked the rename is the worst moment to abandon atomicity — a crash mid
   * direct-overwrite can truncate the body. The prior on-disk body is left
   * intact (rename never starts) so the retry self-heals a transient lock.
   *
   * Rebuildable writers (local cache, .meta sidecars, .groups.json, settings)
   * omit this and accept the relaxed direct-overwrite fallback.
   */
  failClosed?: boolean;
}

/**
 * Write text atomically: write to `${path}.tmp` then rename to the target.
 * Rename is atomic on the same filesystem, so readers never see a partial file.
 *
 * Used for note bodies (.md — the single source of truth), .meta sidecars,
 * .groups.json and settings. The note-dir watcher must keep ignoring the
 * `${path}.tmp` names this produces (it filters on `.md` / `.json` suffixes).
 *
 * Relaxed mode (default): if the tmp write or the rename fails (antivirus
 * locks, OneDrive driver quirks, permission issues), we degrade to a direct
 * overwrite — the least-atomic possible write. Silent degradation makes silent
 * corruption windows undiagnosable, so each degradation is recorded via
 * crashLog under META_WRITE_FAILED (historical name; covers body writes too).
 * Severity is recoverable: the write completes, only the durability guarantee
 * is forfeit.
 *
 * Fail-closed mode (`{ failClosed: true }`, used for the body): never degrade —
 * log the stage and rethrow so the caller defers the write and retries.
 */
export async function atomicWriteText(
  fs: FileSystem,
  path: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const { failClosed = false } = opts;
  const tmp = `${path}.tmp`;
  try {
    await fs.writeTextFile(tmp, content);
  } catch (err) {
    void logNotenError(new NotenError(
      "META_WRITE_FAILED",
      "recoverable",
      failClosed
        ? "atomicWriteText: tmp write failed; fail-closed, deferring to caller retry"
        : "atomicWriteText: tmp write failed; degrading to non-atomic direct write",
      { context: { filePath: path, stage: "tmp", failClosed }, cause: err },
    ));
    if (failClosed) throw err;
    await fs.writeTextFile(path, content);
    return;
  }

  try {
    await fs.rename(tmp, path);
  } catch (err) {
    void logNotenError(new NotenError(
      "META_WRITE_FAILED",
      "recoverable",
      failClosed
        ? "atomicWriteText: rename failed; fail-closed, deferring to caller retry"
        : "atomicWriteText: rename failed; degrading to non-atomic direct write",
      { context: { filePath: path, stage: "rename", failClosed }, cause: err },
    ));
    if (failClosed) {
      // The live target is untouched (rename never landed), so the prior body
      // survives. Drop the orphan tmp and surface the failure for retry.
      try { await fs.remove(tmp); } catch { /* ignore */ }
      throw err;
    }
    try {
      await fs.writeTextFile(path, content);
    } finally {
      try { await fs.remove(tmp); } catch { /* ignore */ }
    }
  }
}
