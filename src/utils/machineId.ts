import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { joinPath } from "./storagePaths";

let machineIdCache: string | null = null;

export async function getMachineId(): Promise<string> {
  if (machineIdCache) return machineIdCache;

  const base = await appDataDir();
  const path = joinPath(base, "machine-id");
  try {
    const existing = (await readTextFile(path)).trim();
    if (existing) {
      machineIdCache = existing;
      return existing;
    }
  } catch {
    // Create below.
  }

  const id = crypto.randomUUID();
  await mkdir(base, { recursive: true }).catch(() => {});
  await writeTextFile(path, id).catch(() => {});
  machineIdCache = id;
  return id;
}
