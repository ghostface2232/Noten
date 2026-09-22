import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults } from "./fs.fault.test-utils";
import { recoverEdits, findOrphanedLabels } from "./recoverEdits";
import {
  writeRecoveryRecord,
  readRecoveryRecords,
  type RecoveryRecord,
} from "./recoveryJournal";

vi.mock("./crashLog", () => ({ logNotenError: vi.fn(() => Promise.resolve()) }));

const APP_DATA = "/appdata";
const DIR = "/notes";
const LABEL = "main";
const NOTE_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_PATH = `${DIR}/${NOTE_ID}.md`;

let fs: InMemoryFileSystem;

function record(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    version: 1,
    docId: NOTE_ID,
    filePath: NOTE_PATH,
    content: "the unsaved edit",
    baseContent: "what was on disk",
    editSerial: 3,
    updatedAt: 1000,
    ...overrides,
  };
}

function deps(over: Partial<Parameters<typeof recoverEdits>[0]> = {}) {
  return {
    fs,
    appDataDir: APP_DATA,
    notesDir: DIR,
    windowLabel: LABEL,
    applyBody: vi.fn(async () => true),
    ...over,
  };
}

/** Preserved bodies only — `.conflicts` also holds the folder's README. */
async function conflictFiles(noteId = NOTE_ID): Promise<string[]> {
  if (!(await fs.exists(`${DIR}/.conflicts`))) return [];
  const entries = await fs.readDir(`${DIR}/.conflicts`);
  return entries.map((e) => e.name!).filter((n) => n.startsWith(noteId));
}

beforeEach(() => {
  fs = createInMemoryFileSystem();
  fs.seedDir(APP_DATA);
  fs.seedDir(DIR);
});

describe("recoverEdits — replaying a journal left by a crash", () => {
  it("applies an edit whose note nobody else touched", async () => {
    fs.seedTextFile(NOTE_PATH, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    const d = deps();

    const outcome = await recoverEdits(d);

    expect(outcome).toMatchObject({ applied: 1, preserved: 0, dropped: 0, deferred: 0 });
    expect(d.applyBody).toHaveBeenCalledWith(expect.objectContaining({ content: "the unsaved edit" }));
    // The record is consumed, so a second run is a no-op.
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toEqual([]);
  });

  it("keeps the other device's version and preserves the edit when disk moved", async () => {
    fs.seedTextFile(NOTE_PATH, "what the other device wrote");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    const d = deps();

    const outcome = await recoverEdits(d);

    expect(outcome).toMatchObject({ applied: 0, preserved: 1 });
    expect(d.applyBody).not.toHaveBeenCalled();
    // The note keeps the remote body...
    expect(await fs.readTextFile(NOTE_PATH)).toBe("what the other device wrote");
    // ...and the unsaved work is still retrievable.
    const kept = await conflictFiles();
    expect(kept).toHaveLength(1);
    expect(await fs.readTextFile(`${DIR}/.conflicts/${kept[0]}`)).toBe("the unsaved edit");
  });

  it("never applies a record with no base, whatever the disk holds", async () => {
    // The projection case reaching recovery: applying would write an empty
    // body over a real note, which is the C1 loss by another route.
    fs.seedTextFile(NOTE_PATH, "the real note body");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ content: "", baseContent: null }));
    const d = deps();

    const outcome = await recoverEdits(d);

    expect(d.applyBody).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ applied: 0, preserved: 1 });
    expect(await fs.readTextFile(NOTE_PATH)).toBe("the real note body");
  });

  it("drops a record the disk already caught up with", async () => {
    // The save landed and the clear did not — the case that makes the
    // fire-and-forget clear on success safe.
    fs.seedTextFile(NOTE_PATH, "the unsaved edit");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    const d = deps();

    const outcome = await recoverEdits(d);

    expect(outcome).toMatchObject({ applied: 0, preserved: 0, dropped: 1 });
    expect(d.applyBody).not.toHaveBeenCalled();
    expect(await conflictFiles()).toEqual([]);
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toEqual([]);
  });

  it("preserves an edit whose note was deleted elsewhere rather than resurrecting it", async () => {
    // NOTE_PATH intentionally not seeded.
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());

    const outcome = await recoverEdits(deps());

    expect(outcome).toMatchObject({ preserved: 1 });
    expect(await fs.exists(NOTE_PATH)).toBe(false);
    expect(await conflictFiles()).toHaveLength(1);
  });
});

describe("recoverEdits — a record it cannot resolve is kept, never thrown away", () => {
  it("defers when the note body cannot be read this run", async () => {
    fs.seedTextFile(NOTE_PATH, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: new RegExp(`${NOTE_ID}\\.md$`),
      throwError: new Error("EBUSY: cloud-sync hydration"),
    });
    const d = deps({ fs: faultFs });

    const outcome = await recoverEdits(d);

    // An unreadable file says nothing about what the note holds, so guessing
    // either way would be wrong.
    expect(outcome).toMatchObject({ deferred: 1, applied: 0, preserved: 0 });
    expect(d.applyBody).not.toHaveBeenCalled();
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toHaveLength(1);
  });

  it("keeps the record when applying it fails", async () => {
    fs.seedTextFile(NOTE_PATH, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    const d = deps({ applyBody: vi.fn(async () => false) });

    const outcome = await recoverEdits(d);

    expect(outcome).toMatchObject({ deferred: 1, applied: 0 });
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toHaveLength(1);
  });

  it("keeps the record when the .conflicts copy fails", async () => {
    fs.seedTextFile(NOTE_PATH, "what the other device wrote");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "writeTextFile",
      path: /\.conflicts/,
      throwError: new Error("EPERM"),
    });

    const outcome = await recoverEdits(deps({ fs: faultFs }));

    expect(outcome).toMatchObject({ deferred: 1, preserved: 0 });
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toHaveLength(1);
  });

  it("one unresolvable record does not stop the others", async () => {
    const second = "00000000-0000-4000-8000-000000000002";
    fs.seedTextFile(NOTE_PATH, "what was on disk");
    fs.seedTextFile(`${DIR}/${second}.md`, "base two");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({
      docId: second,
      filePath: `${DIR}/${second}.md`,
      baseContent: "base two",
      content: "second edit",
    }));
    const applyBody = vi.fn(async (r: RecoveryRecord) => r.docId === second);

    const outcome = await recoverEdits(deps({ applyBody }));

    expect(outcome).toMatchObject({ applied: 1, deferred: 1 });
  });
});

describe("recoverEdits — adopting a window that never reopened", () => {
  it("also replays records from adopted labels", async () => {
    fs.seedTextFile(NOTE_PATH, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, "window-2", record());
    const d = deps({ adoptLabels: ["window-2"] });

    const outcome = await recoverEdits(d);

    expect(outcome).toMatchObject({ applied: 1 });
    expect(await readRecoveryRecords(fs, APP_DATA, "window-2")).toEqual([]);
  });

  it("leaves a live sibling window's records alone", async () => {
    await writeRecoveryRecord(fs, APP_DATA, "main", record());
    await writeRecoveryRecord(fs, APP_DATA, "window-2", record());

    const orphans = await findOrphanedLabels(fs, APP_DATA, ["main", "window-2"]);
    expect(orphans).toEqual([]);

    const afterClose = await findOrphanedLabels(fs, APP_DATA, ["main"]);
    expect(afterClose).toEqual(["window-2"]);
  });
});
