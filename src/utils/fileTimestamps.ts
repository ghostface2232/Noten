import type { FileSystem } from "./fs";

export interface FileTimestamps {
  createdAt: number;
  updatedAt: number;
}

export async function getFileTimestamps(fs: FileSystem, filePath: string): Promise<FileTimestamps> {
  const now = Date.now();
  try {
    const info = await fs.stat(filePath);
    const mtime = info.mtime ? info.mtime.getTime() : null;
    const birthtime = info.birthtime ? info.birthtime.getTime() : null;
    return {
      createdAt: birthtime ?? mtime ?? now,
      updatedAt: mtime ?? now,
    };
  } catch {
    return { createdAt: now, updatedAt: now };
  }
}
