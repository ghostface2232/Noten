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
    // Typed into a projection doc: the session never read the file, so the
    // record has no base and its content is whatever the empty editor held
    // plus the keystrokes.
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ content: "typed", baseContent: null }));
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

  // A secondary window's label is new every time it opens, so an orphaned
  // label never comes back. Leaving its emptied directory behind grew the
  // recovery root by one directory per secondary window ever opened, all of
  // them listed and read on every start.
  it("removes an adopted label's directory once its records are resolved", async () => {
    fs.seedTextFile(NOTE_PATH, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, "win-1-1", record());
    fs.seedDir(`${APP_DATA}/recovery/win-2-1`);

    await recoverEdits(deps({ adoptLabels: ["win-1-1", "win-2-1"] }));

    expect(await fs.exists(`${APP_DATA}/recovery/win-1-1`)).toBe(false);
    expect(await fs.exists(`${APP_DATA}/recovery/win-2-1`)).toBe(false);
    expect(await findOrphanedLabels(fs, APP_DATA, ["main"])).toEqual([]);
  });

  it("keeps an adopted label's directory while a record in it is deferred", async () => {
    // No note file, so planRecovery preserves, which needs a write to
    // .conflicts; make that fail so the record stays journalled.
    await writeRecoveryRecord(fs, APP_DATA, "win-1-1", record({ filePath: `${DIR}/missing.md` }));
    const faulty = wrapWithFaults(fs);
    faulty.injectFault({ op: "writeTextFile", path: /\/\.conflicts\//, throwError: new Error("ENOSPC") });

    const outcome = await recoverEdits(deps({ fs: faulty, adoptLabels: ["win-1-1"] }));

    expect(outcome.deferred).toBe(1);
    expect(await readRecoveryRecords(fs, APP_DATA, "win-1-1")).toHaveLength(1);
  });

  it("keeps its own label's directory, which it may journal into again", async () => {
    fs.seedTextFile(NOTE_PATH, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());

    await recoverEdits(deps());

    expect(await fs.exists(`${APP_DATA}/recovery/${LABEL}`)).toBe(true);
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

describe("recoverEdits — a record from a different notes directory", () => {
  it("keeps the edit instead of writing into the old folder", async () => {
    // Written before a notes-directory change. Applying would put the body in
    // the OLD folder while the commit marks the live note clean, so the edit
    // would vanish from the library it was made in.
    fs.seedDir("/old-notes");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({
      filePath: `/old-notes/${NOTE_ID}.md`,
      baseContent: "what was there",
    }));
    const d = deps();

    const outcome = await recoverEdits(d);

    expect(d.applyBody).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ preserved: 1, applied: 0 });
    // Kept under the CURRENT folder, where the user is working.
    expect(await conflictFiles()).toHaveLength(1);
    expect(await fs.exists(`/old-notes/${NOTE_ID}.md`)).toBe(false);
  });
});

describe("recoverEdits — Windows paths and traversal", () => {
  it("applies a record when the notes directory is stored with a trailing separator", async () => {
    // The real shape on Windows. A raw prefix compare classified every record
    // as foreign here, so recovery silently never applied anything — on the
    // only platform the app ships to.
    const winDir = "D:\\Notes\\";
    const winPath = `D:\\Notes\\${NOTE_ID}.md`;
    fs.seedDir("D:\\Notes");
    fs.seedTextFile(winPath, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ filePath: winPath }));
    const d = deps({ notesDir: winDir });

    expect(await recoverEdits(d)).toMatchObject({ applied: 1, preserved: 0 });
    expect(d.applyBody).toHaveBeenCalled();
  });

  it("matches a backslash record path against a forward-slash notes dir", async () => {
    const winPath = `${DIR}\\${NOTE_ID}.md`;
    fs.seedTextFile(winPath, "what was on disk");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ filePath: winPath }));

    expect(await recoverEdits(deps())).toMatchObject({ applied: 1 });
  });

  it("refuses a record whose path climbs out of the notes directory", async () => {
    // filePath comes out of a JSON file and is handed to atomicWriteText.
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({
      filePath: `${DIR}/../escaped.md`,
    }));
    const d = deps();

    expect(await recoverEdits(d)).toMatchObject({ preserved: 1, applied: 0 });
    expect(d.applyBody).not.toHaveBeenCalled();
    expect(await fs.exists("/escaped.md")).toBe(false);
  });
});

describe("recoverEdits — the outcome has to match what actually happened", () => {
  it("does not count an emptied note as preserved, because nothing was written", async () => {
    // backupRemoteVersion refuses an empty body, so there is no .conflicts
    // file to point the user at. Counting it as preserved made the notice
    // name a file that does not exist.
    fs.seedTextFile(NOTE_PATH, "what the other device wrote");
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ content: "   " }));

    const outcome = await recoverEdits(deps());

    expect(outcome).toMatchObject({ preserved: 0, dropped: 1, deferred: 0 });
    expect(await conflictFiles()).toEqual([]);
    // Still consumed — leaving it would retry the same nothing every start.
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toEqual([]);
  });
});
