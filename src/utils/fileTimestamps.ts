import { stat } from "@tauri-apps/plugin-fs";

export interface FileTimestamps {
  createdAt: number;
  updatedAt: number;
}

export async function getFileTimestamps(filePath: string): Promise<FileTimestamps> {
  const now = Date.now();
  try {
    const info = await stat(filePath);
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
