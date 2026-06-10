import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";
import { scanAndAbsorbConflicts } from "./conflictFileDetector";
import { readMeta, type NoteMeta } from "./metadataIO";
import { NotenError } from "./notenError";

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

async function getMockedLogger() {
  const { logNotenError } = await import("./crashLog");
  return logNotenError as unknown as ReturnType<typeof vi.fn>;
}

const DIR = "/notes";

let inner: InMemoryFileSystem;
let fs: InMemoryFileSystem & FaultInjectingFileSystem;

beforeEach(async () => {
  inner = createInMemoryFileSystem();
  inner.seedDir(DIR);
  fs = wrapWithFaults(inner);
  (await getMockedLogger()).mockClear();
});

describe("scanAndAbsorbConflicts", () => {
  it("logs CONFLICT_SCAN_FAILED when the notes-dir readDir throws", async () => {
    // Previously the catch returned a zero-counter result silently, making a
    // transient cloud-sync readDir failure indistinguishable from "no
    // conflicts present". The next launch retries, but a user who quits
    // between cycles had no diagnostic trace.
    fs.injectFault({
      op: "readDir",
      path: DIR,
      throwError: new Error("EBUSY: cloud-sync placeholder"),
    });

    const result = await scanAndAbsorbConflicts(fs, DIR);

    expect(result).toEqual({
      absorbedMdNotes: 0,
      mergedGroupsConflicts: 0,
      mergedMetaConflicts: 0,
      removedManifestConflicts: 0,
    });

    const logger = await getMockedLogger();
    expect(logger).toHaveBeenCalledTimes(1);
    const reported = logger.mock.calls[0][0] as NotenError;
    expect(reported).toBeInstanceOf(NotenError);
    expect(reported.code).toBe("CONFLICT_SCAN_FAILED");
    expect(reported.severity).toBe("recoverable");
    expect(reported.context).toMatchObject({ notesDir: DIR });
  });

  it("does not log on the canonical empty-dir happy path", async () => {
    const result = await scanAndAbsorbConflicts(fs, DIR);

    expect(result.absorbedMdNotes).toBe(0);
    const logger = await getMockedLogger();
    expect(logger).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Meta conflict merge — the 3-clock arbitration at the heart of multi-PC sync:
//   - body/title fields follow updatedAt last-write-wins (local wins ties)
//   - pinned is OR-merged (a pin on either machine survives)
//   - group membership has its OWN clock (groupUpdatedAt), independent of the
//     body/title winner — a fresher group move must survive a fresher title.
// ---------------------------------------------------------------------------

const NOTE_ID = "11111111-1111-1111-1111-111111111111";

function makeMeta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    version: 2,
    id: NOTE_ID,
    fileName: "Note",
    createdAt: 100,
    updatedAt: 1000,
    groupId: null,
    trashedAt: null,
    ...overrides,
  };
}

function seedMetaFile(name: string, meta: NoteMeta): void {
  inner.seedTextFile(`${DIR}/.meta/${name}`, JSON.stringify(meta));
}

describe("scanAndAbsorbConflicts — meta conflict merge", () => {
  it("remote title wins by updatedAt while the fresher local group move survives", async () => {
    seedMetaFile(`${NOTE_ID}.json`, makeMeta({
      fileName: "Local Title",
      updatedAt: 2000,
      pinned: false,
      groupId: "g-local",
      groupUpdatedAt: 5000,
    }));
    seedMetaFile(`${NOTE_ID}-DESKTOP-ABC123.json`, makeMeta({
      fileName: "Remote Title",
      updatedAt: 3000,
      pinned: true,
      groupId: null,
      groupUpdatedAt: 1000,
    }));

    const result = await scanAndAbsorbConflicts(fs, DIR);
    expect(result.mergedMetaConflicts).toBe(1);

    const merged = await readMeta(fs, DIR, NOTE_ID);
    expect(merged).not.toBeNull();
    // Title/body clock: remote is newer.
    expect(merged!.fileName).toBe("Remote Title");
    expect(merged!.updatedAt).toBe(3000);
    // OR-merge: pinned on either machine survives.
    expect(merged!.pinned).toBe(true);
    // Independent group clock: the local group move (5000) beats remote (1000)
    // even though remote won the title.
    expect(merged!.groupId).toBe("g-local");
    expect(merged!.groupUpdatedAt).toBe(5000);

    // The conflict sidecar is consumed.
    expect(await fs.exists(`${DIR}/.meta/${NOTE_ID}-DESKTOP-ABC123.json`)).toBe(false);
  });

  it("local title wins ties/newer while a fresher remote group move survives", async () => {
    seedMetaFile(`${NOTE_ID}.json`, makeMeta({
      fileName: "Local Title",
      updatedAt: 3000,
      groupId: "g-old",
      groupUpdatedAt: 1000,
    }));
    seedMetaFile(`${NOTE_ID} (1).json`, makeMeta({
      fileName: "Remote Title",
      updatedAt: 2000,
      groupId: "g-new",
      groupUpdatedAt: 4000,
    }));

    const result = await scanAndAbsorbConflicts(fs, DIR);
    expect(result.mergedMetaConflicts).toBe(1);

    const merged = await readMeta(fs, DIR, NOTE_ID);
    expect(merged!.fileName).toBe("Local Title");
    expect(merged!.groupId).toBe("g-new");
    expect(merged!.groupUpdatedAt).toBe(4000);
  });

  it("ignores a conflict sidecar whose id does not match its canonical stem", async () => {
    seedMetaFile(`${NOTE_ID}.json`, makeMeta());
    // id field points at a DIFFERENT note — merging it would corrupt NOTE_ID's meta.
    seedMetaFile(`${NOTE_ID} (1).json`, makeMeta({ id: "22222222-2222-2222-2222-222222222222" }));

    const result = await scanAndAbsorbConflicts(fs, DIR);
    expect(result.mergedMetaConflicts).toBe(0);
    // Not consumed — left for inspection/retry.
    expect(await fs.exists(`${DIR}/.meta/${NOTE_ID} (1).json`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Body conflict absorb — `<uuid> (1).md` becomes its OWN note (never silently
// merged into or dropped against the canonical body), seeded from the
// canonical meta so it lands in the same group with a recognizable name.
// ---------------------------------------------------------------------------

describe("scanAndAbsorbConflicts — md body absorb", () => {
  function listRootMd(): string[] {
    const out: string[] = [];
    for (const [path, val] of inner.snapshot()) {
      if (val === "<dir>") continue;
      const m = path.match(/^\/notes\/([^/]+\.md)$/);
      if (m) out.push(m[1]);
    }
    return out;
  }

  it("absorbs a diverged conflict copy as a new note seeded from the canonical meta", async () => {
    inner.seedTextFile(`${DIR}/${NOTE_ID}.md`, "local body");
    inner.seedTextFile(`${DIR}/${NOTE_ID} (1).md`, "remote body");
    seedMetaFile(`${NOTE_ID}.json`, makeMeta({ fileName: "My Note", groupId: "g1", pinned: true }));

    const result = await scanAndAbsorbConflicts(fs, DIR);
    expect(result.absorbedMdNotes).toBe(1);

    // Conflict copy consumed; canonical body untouched.
    expect(await fs.exists(`${DIR}/${NOTE_ID} (1).md`)).toBe(false);
    expect(await fs.readTextFile(`${DIR}/${NOTE_ID}.md`)).toBe("local body");

    // The remote body now lives under a fresh uuid.
    const mdFiles = listRootMd();
    expect(mdFiles).toHaveLength(2);
    const newName = mdFiles.find((n) => n !== `${NOTE_ID}.md`)!;
    expect(await fs.readTextFile(`${DIR}/${newName}`)).toBe("remote body");

    // Its meta is seeded from the canonical note: same group, conflict-tagged
    // custom name so the user can tell the copies apart.
    const newId = newName.replace(/\.md$/, "");
    const newMeta = await readMeta(fs, DIR, newId);
    expect(newMeta).not.toBeNull();
    expect(newMeta!.fileName).toBe("My Note ((1))");
    expect(newMeta!.customName).toBe(true);
    expect(newMeta!.groupId).toBe("g1");
    expect(newMeta!.trashedAt).toBeNull();
  });

  it("drops an identical conflict copy without creating a duplicate note", async () => {
    inner.seedTextFile(`${DIR}/${NOTE_ID}.md`, "same body");
    inner.seedTextFile(`${DIR}/${NOTE_ID} (1).md`, "same body");
    seedMetaFile(`${NOTE_ID}.json`, makeMeta());

    const result = await scanAndAbsorbConflicts(fs, DIR);

    expect(result.absorbedMdNotes).toBe(0);
    expect(await fs.exists(`${DIR}/${NOTE_ID} (1).md`)).toBe(false);
    expect(listRootMd()).toEqual([`${NOTE_ID}.md`]);
  });

  it("leaves non-conflict filenames alone", async () => {
    inner.seedTextFile(`${DIR}/${NOTE_ID}.md`, "body");
    inner.seedTextFile(`${DIR}/notes-export.md`, "a user file");

    const result = await scanAndAbsorbConflicts(fs, DIR);

    expect(result.absorbedMdNotes).toBe(0);
    expect(await fs.exists(`${DIR}/notes-export.md`)).toBe(true);
  });
});
