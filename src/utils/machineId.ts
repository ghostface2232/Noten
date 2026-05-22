import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

let cache: string | null = null;

async function getPath(): Promise<string> {
  const base = await appDataDir();
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  await mkdir(base, { recursive: true }).catch(() => {});
  return `${base}${sep}machine-id`;
}

export async function getMachineId(): Promise<string> {
  if (cache) return cache;
  const path = await getPath();
  try {
    const raw = (await readTextFile(path)).trim();
    if (raw) {
      cache = raw;
      return cache;
    }
  } catch { /* fall through */ }

  const id = crypto.randomUUID();
  try {
    await writeTextFile(path, id);
  } catch {
    // If we cannot persist, still return an in-memory id for this session.
  }
  cache = id;
  return id;
}

/** Sync accessor — returns empty string if not yet loaded. Use getMachineId() first at startup. */
export function getMachineIdCached(): string {
  return cache ?? "";
}
