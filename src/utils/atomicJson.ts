import { remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { markOwnWrite } from "../hooks/ownWriteTracker";
import { sha256Hex } from "./hash";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
  const text = JSON.stringify(value, null, 2);
  const hash = await sha256Hex(text);
  markOwnWrite(tmpPath, hash);
  await writeTextFile(tmpPath, text);
  markOwnWrite(path, hash);
  await remove(path).catch(() => {});
  await rename(tmpPath, path);
}
