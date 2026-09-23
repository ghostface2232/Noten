import { describe, expect, it } from "vitest";
import { createInMemoryFileSystem } from "./fs.test-utils";
import type { TrashedNote } from "./noteTypes";
import {
  TRASH_RETENTION_MS,
  isTrashExpired,
  observeTrash,
  trashDaysLeft,
  readTrashObservations,
  writeTrashObservations,
} from "./trashRetention";

const DAY = 24 * 60 * 60 * 1000;

function trashed(id: string, trashedAt: number): TrashedNote {
  return {
    id,
    fileName: id,
    originalFilePath: `/notes/${id}.md`,
    trashFilePath: `/notes/.trash/${id}.md`,
    trashedAt,
    groupId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("trash retention", () => {
  const now = 100 * DAY;

  it("keeps a stamp from a slow clock until this machine has seen it for the full period", () => {
    // Deleted on a machine whose clock ran 20 days slow: the stamp already
    // reads as expired here on first sight.
    const note = trashed("a", now - 20 * DAY);
    const firstLaunch = observeTrash({}, [note], now);
    expect(isTrashExpired(note, undefined, now)).toBe(false);
    expect(isTrashExpired(note, firstLaunch.a, now + 13 * DAY)).toBe(false);
    expect(isTrashExpired(note, firstLaunch.a, now + TRASH_RETENTION_MS + 1)).toBe(true);
  });

  it("does not purge before the deleting machine's own period either", () => {
    const note = trashed("a", now - 2 * DAY);
    const observed = { a: { trashedAt: note.trashedAt, seenAt: now - 30 * DAY } };
    expect(isTrashExpired(note, observed.a, now)).toBe(false);
  });

  it("restarts the count for a new incarnation of the same id", () => {
    const first = trashed("a", now - 30 * DAY);
    const seen = observeTrash({}, [first], now - 30 * DAY);
    const retrashed = trashed("a", now - 20 * DAY);
    expect(isTrashExpired(retrashed, seen.a, now)).toBe(false);
    const next = observeTrash(seen, [retrashed], now);
    expect(next.a).toEqual({ trashedAt: retrashed.trashedAt, seenAt: now });
  });

  it("keeps existing observations and forgets an absent id only after a long absence", () => {
    // The file is per machine, the trash in hand is one library's: an id
    // missing from it may belong to a library the user switched away from.
    const kept = trashed("a", 5);
    const previous = {
      a: { trashedAt: 5, seenAt: 7 },
      otherLibrary: { trashedAt: 1, seenAt: now - 30 * DAY },
      longGone: { trashedAt: 1, seenAt: now - 120 * DAY },
    };
    expect(observeTrash(previous, [kept], now)).toEqual({
      a: { trashedAt: 5, seenAt: 7 },
      otherLibrary: { trashedAt: 1, seenAt: now - 30 * DAY },
    });
  });

  it("shows days left from the later of the stamp and this machine's sighting", () => {
    const skewed = trashed("a", now - 20 * DAY);
    expect(trashDaysLeft(skewed, undefined, now)).toBe(14);
    expect(trashDaysLeft(skewed, { trashedAt: skewed.trashedAt, seenAt: now - 3 * DAY }, now)).toBe(11);
    const own = trashed("b", now - 3 * DAY - 1);
    expect(trashDaysLeft(own, { trashedAt: own.trashedAt, seenAt: own.trashedAt }, now)).toBe(11);
    expect(trashDaysLeft(own, { trashedAt: own.trashedAt, seenAt: own.trashedAt }, now + 30 * DAY)).toBe(0);
  });

  it("round-trips through disk and treats a damaged file as nothing observed", async () => {
    const fs = createInMemoryFileSystem();
    fs.seedDir("/app");
    await writeTrashObservations(fs, "/app/trash-observed.json", { a: { trashedAt: 5, seenAt: 7 } });
    expect(await readTrashObservations(fs, "/app/trash-observed.json")).toEqual({ a: { trashedAt: 5, seenAt: 7 } });

    fs.seedTextFile("/app/trash-observed.json", "{\"version\":1,\"observations\":{\"a\":{\"trashedAt\":\"x\"}}}");
    expect(await readTrashObservations(fs, "/app/trash-observed.json")).toEqual({});
    fs.seedTextFile("/app/trash-observed.json", "{trunc");
    expect(await readTrashObservations(fs, "/app/trash-observed.json")).toEqual({});
    expect(await readTrashObservations(fs, "/app/missing.json")).toEqual({});
  });
});
