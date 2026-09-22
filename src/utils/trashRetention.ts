import type { FileSystem } from "./fs";
import type { TrashedNote } from "./noteTypes";
import { atomicWriteText } from "./atomicWrite";

export const TRASH_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * When THIS machine first saw a given trash incarnation, on its own clock.
 *
 * `trashedAt` is stamped by whichever machine deleted the note. A machine
 * whose clock ran 14+ days slow (dead CMOS battery, a VM restored from a
 * snapshot, a boot before NTP) stamped a time that every healthy machine reads
 * as already expired, and the next launch permanently deleted a note the user
 * could still expect to restore. A local first-seen time bounds the real
 * elapsed time from below no matter whose clock stamped the deletion.
 */
export interface TrashObservation {
  /** The incarnation seen; a re-trash after a restore restarts the count. */
  trashedAt: number;
  seenAt: number;
}

export type TrashObservations = Record<string, TrashObservation>;

interface TrashObservationsFile {
  version: 1;
  observations: TrashObservations;
}

/**
 * Record every incarnation not seen before and drop ids no longer in the
 * trash. A missing or reset record only delays a purge, never hastens one.
 */
export function observeTrash(
  previous: TrashObservations,
  trashedNotes: readonly TrashedNote[],
  now: number,
): TrashObservations {
  const next: TrashObservations = {};
  for (const note of trashedNotes) {
    const seen = previous[note.id];
    next[note.id] = seen && seen.trashedAt === note.trashedAt
      ? seen
      : { trashedAt: note.trashedAt, seenAt: now };
  }
  return next;
}

/**
 * Expired only when both clocks agree: the deleting machine's stamp and this
 * machine's own observation. A stamp from the future (a fast deleting clock)
 * keeps the note, as it always has.
 */
export function isTrashExpired(
  note: TrashedNote,
  observation: TrashObservation | undefined,
  now: number,
): boolean {
  if (!observation || observation.trashedAt !== note.trashedAt) return false;
  return now - note.trashedAt > TRASH_RETENTION_MS
    && now - observation.seenAt > TRASH_RETENTION_MS;
}

export async function readTrashObservations(fs: FileSystem, path: string): Promise<TrashObservations> {
  try {
    const parsed = JSON.parse(await fs.readTextFile(path)) as Partial<TrashObservationsFile>;
    if (parsed?.version !== 1 || !parsed.observations || typeof parsed.observations !== "object") return {};
    const out: TrashObservations = {};
    for (const [id, value] of Object.entries(parsed.observations)) {
      if (typeof value?.trashedAt === "number" && typeof value?.seenAt === "number") {
        out[id] = { trashedAt: value.trashedAt, seenAt: value.seenAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeTrashObservations(
  fs: FileSystem,
  path: string,
  observations: TrashObservations,
): Promise<void> {
  const file: TrashObservationsFile = { version: 1, observations };
  await atomicWriteText(fs, path, JSON.stringify(file));
}
