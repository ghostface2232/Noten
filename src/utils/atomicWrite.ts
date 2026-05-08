import { writeTextFile, rename, remove } from "@tauri-apps/plugin-fs";

/**
 * Write text atomically: write to `${path}.tmp` then rename to the target.
 * Rename is atomic on the same filesystem, so readers never see a partial file.
 * Falls back to direct write if rename isn't supported.
 */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await writeTextFile(tmp, content);
  } catch (err) {
    await writeTextFile(path, content);
    return;
  }

  try {
    await rename(tmp, path);
  } catch {
    // Rename may fail on Windows if target exists on some FS drivers. Fall back.
    try {
      await writeTextFile(path, content);
    } finally {
      try { await remove(tmp); } catch { /* ignore */ }
    }
  }
}
