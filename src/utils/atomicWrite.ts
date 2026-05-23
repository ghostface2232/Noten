import type { FileSystem } from "./fs";

/**
 * Write text atomically: write to `${path}.tmp` then rename to the target.
 * Rename is atomic on the same filesystem, so readers never see a partial file.
 * Falls back to direct write if rename isn't supported.
 */
export async function atomicWriteText(fs: FileSystem, path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await fs.writeTextFile(tmp, content);
  } catch {
    await fs.writeTextFile(path, content);
    return;
  }

  try {
    await fs.rename(tmp, path);
  } catch {
    // Rename may fail on Windows if target exists on some FS drivers. Fall back.
    try {
      await fs.writeTextFile(path, content);
    } finally {
      try { await fs.remove(tmp); } catch { /* ignore */ }
    }
  }
}
