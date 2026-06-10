import type { FileSystem } from "./fs";
import { NotenError } from "./notenError";
import { logNotenError } from "./crashLog";

/**
 * Write text atomically: write to `${path}.tmp` then rename to the target.
 * Rename is atomic on the same filesystem, so readers never see a partial file.
 *
 * Used for note bodies (.md — the single source of truth), .meta sidecars,
 * .groups.json and settings. The note-dir watcher must keep ignoring the
 * `${path}.tmp` names this produces (it filters on `.md` / `.json` suffixes).
 *
 * If the tmp write or the rename fails (antivirus locks, OneDrive driver
 * quirks, permission issues), we degrade to a direct overwrite — the
 * least-atomic possible write. Silent degradation makes silent corruption
 * windows undiagnosable, so each degradation is recorded via crashLog
 * under META_WRITE_FAILED (historical name; covers body writes too).
 * Severity is recoverable: the write completes, only the durability
 * guarantee is forfeit.
 */
export async function atomicWriteText(fs: FileSystem, path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await fs.writeTextFile(tmp, content);
  } catch (err) {
    void logNotenError(new NotenError(
      "META_WRITE_FAILED",
      "recoverable",
      "atomicWriteText: tmp write failed; degrading to non-atomic direct write",
      { context: { filePath: path, stage: "tmp" }, cause: err },
    ));
    await fs.writeTextFile(path, content);
    return;
  }

  try {
    await fs.rename(tmp, path);
  } catch (err) {
    void logNotenError(new NotenError(
      "META_WRITE_FAILED",
      "recoverable",
      "atomicWriteText: rename failed; degrading to non-atomic direct write",
      { context: { filePath: path, stage: "rename" }, cause: err },
    ));
    try {
      await fs.writeTextFile(path, content);
    } finally {
      try { await fs.remove(tmp); } catch { /* ignore */ }
    }
  }
}
