import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, exists, remove } from "@tauri-apps/plugin-fs";
import { tauriFileSystem } from "./fs";
import { atomicWriteText } from "./atomicWrite";

// Durable record of a migration whose source directory was committed-but-not-
// yet-cleaned (a deferred cleanup). Lives in AppData — NOT inside the notes
// dirs — so it is still found if the user moves a notes folder or a cloud
// client lags. A later run (or the migrating window once it is safe) reads
// this to finish clearing the old directory.
//
// We only persist the cleanup-pending phase: copy→commit is already crash-safe
// (the source stays authoritative until the setting commits), so the only new
// state the deferral introduces is "committed, source still needs cleaning".

export type MigrationCleanupMode =
  // Fold any late writes the old dir received after the copy back into the new
  // dir (newer-wins) before deleting — used by merge / overwrite / reset.
  | "merge"
  // Delete the old dir's managed data without merging — used by
  // use-selected-only, where the user chose NOT to combine the two folders.
  | "backup-only";

export interface MigrationJournal {
  migrationId: string;
  oldDir: string;
  /** Resolved target dir. For a reset this is the resolved default dir. */
  newDir: string;
  cleanupMode: MigrationCleanupMode;
  startedAt: number;
}

let pathPromise: Promise<string> | null = null;

async function journalPath(): Promise<string> {
  if (!pathPromise) {
    pathPromise = appDataDir().then(async (dir) => {
      const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
      await mkdir(dir, { recursive: true }).catch(() => {});
      return `${dir}${sep}migration-journal.json`;
    });
  }
  return pathPromise;
}

function isCleanupMode(v: unknown): v is MigrationCleanupMode {
  return v === "merge" || v === "backup-only";
}

export async function readMigrationJournal(): Promise<MigrationJournal | null> {
  try {
    const path = await journalPath();
    if (!(await exists(path))) return null;
    const parsed = JSON.parse(await readTextFile(path)) as Partial<MigrationJournal>;
    if (
      !parsed
      || typeof parsed.migrationId !== "string"
      || typeof parsed.oldDir !== "string"
      || typeof parsed.newDir !== "string"
      || !isCleanupMode(parsed.cleanupMode)
    ) {
      return null;
    }
    return {
      migrationId: parsed.migrationId,
      oldDir: parsed.oldDir,
      newDir: parsed.newDir,
      cleanupMode: parsed.cleanupMode,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function writeMigrationJournal(journal: MigrationJournal): Promise<void> {
  const path = await journalPath();
  await atomicWriteText(tauriFileSystem, path, JSON.stringify(journal, null, 2));
}

export async function clearMigrationJournal(): Promise<void> {
  try {
    const path = await journalPath();
    if (await exists(path)) await remove(path);
  } catch {
    /* best-effort: a stale journal at worst triggers one extra cleanup pass */
  }
}
