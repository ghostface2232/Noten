import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults } from "./fs.fault.test-utils";
import {
  writeRecoveryRecord,
  readRecoveryRecords,
  clearRecoveryRecord,
  listRecoveryLabels,
  recoveryRecordPathFor,
  recoveryLabelDirFor,
  isValidWindowLabel,
  type RecoveryRecord,
} from "./recoveryJournal";

const APP_DATA = "/appdata";
const LABEL = "main";
const NOTE_ID = "00000000-0000-4000-8000-000000000001";

let fs: InMemoryFileSystem;

function record(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    version: 1,
    docId: NOTE_ID,
    filePath: `/notes/${NOTE_ID}.md`,
    content: "unsaved body",
    baseContent: "body that was on disk",
    editSerial: 7,
    updatedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  fs = createInMemoryFileSystem();
  fs.seedDir(APP_DATA);
});

describe("recoveryJournal — round trip", () => {
  it("writes a record and reads it back", async () => {
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());

    const found = await readRecoveryRecords(fs, APP_DATA, LABEL);

    expect(found).toEqual([record()]);
  });

  it("keeps only the latest record per note", async () => {
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ content: "first", editSerial: 1 }));
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ content: "second", editSerial: 2 }));

    const found = await readRecoveryRecords(fs, APP_DATA, LABEL);

    // A file per note, overwritten — recovery wants each note's latest body,
    // not the history between.
    expect(found).toHaveLength(1);
    expect(found[0].content).toBe("second");
  });

  it("returns an empty list when nothing was ever journalled", async () => {
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toEqual([]);
  });

  it("clears one record without disturbing the others", async () => {
    const other = "00000000-0000-4000-8000-000000000002";
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ docId: other }));

    await clearRecoveryRecord(fs, APP_DATA, LABEL, NOTE_ID);

    const found = await readRecoveryRecords(fs, APP_DATA, LABEL);
    expect(found.map((r) => r.docId)).toEqual([other]);
  });

  it("clearing a record that was never written is not an error", async () => {
    await expect(clearRecoveryRecord(fs, APP_DATA, LABEL, NOTE_ID)).resolves.toBeUndefined();
  });
});

describe("recoveryJournal — a bad record does not strand the good ones", () => {
  it("skips an unparseable file and still returns the rest", async () => {
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    // A record from a build that died mid-write, or hand-edited.
    fs.seedTextFile(`${recoveryLabelDirFor(APP_DATA, LABEL)}/broken.json`, "{ not json");

    const found = await readRecoveryRecords(fs, APP_DATA, LABEL);

    expect(found.map((r) => r.docId)).toEqual([NOTE_ID]);
  });

  it("skips a record whose docId disagrees with its filename", async () => {
    // The filename is what recovery would act on, so a disagreement means we
    // cannot tell which note the body belongs to. Neither answer is safe.
    fs.seedTextFile(
      recoveryRecordPathFor(APP_DATA, LABEL, NOTE_ID),
      JSON.stringify(record({ docId: "00000000-0000-4000-8000-000000000009" })),
    );

    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toEqual([]);
  });

  it("skips a record missing required fields", async () => {
    fs.seedTextFile(
      recoveryRecordPathFor(APP_DATA, LABEL, NOTE_ID),
      JSON.stringify({ version: 1, docId: NOTE_ID }),
    );

    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toEqual([]);
  });

  it("ignores the atomic writer's own .tmp files", async () => {
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record());
    fs.seedTextFile(`${recoveryRecordPathFor(APP_DATA, LABEL, NOTE_ID)}.tmp`, "half-written");

    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toHaveLength(1);
  });
});

describe("recoveryJournal — path segments are untrusted", () => {
  it("refuses a note id that would escape the recovery directory", async () => {
    await writeRecoveryRecord(fs, APP_DATA, LABEL, record({ docId: ".." }));

    expect(await fs.exists(`${recoveryLabelDirFor(APP_DATA, LABEL)}/...json`)).toBe(false);
    expect(await readRecoveryRecords(fs, APP_DATA, LABEL)).toEqual([]);
  });

  it("refuses an unsafe window label", async () => {
    expect(isValidWindowLabel("main")).toBe(true);
    expect(isValidWindowLabel("window-2")).toBe(true);
    expect(isValidWindowLabel("..")).toBe(false);
    expect(isValidWindowLabel("a/b")).toBe(false);
    expect(isValidWindowLabel("")).toBe(false);

    await writeRecoveryRecord(fs, APP_DATA, "../evil", record());
    expect(await readRecoveryRecords(fs, APP_DATA, "../evil")).toEqual([]);
  });
});

describe("recoveryJournal — write failures are visible to the caller", () => {
  it("rejects rather than degrading to a non-atomic write", async () => {
    // The caller treats a successful write as permission to stop protecting
    // the edit in memory, so a write that only half-landed must not resolve.
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "writeTextFile",
      path: /recovery/,
      throwError: new Error("EPERM"),
    });

    await expect(writeRecoveryRecord(faultFs, APP_DATA, LABEL, record())).rejects.toThrow();
  });
});

describe("recoveryJournal — label sweep", () => {
  it("lists the labels that hold records", async () => {
    await writeRecoveryRecord(fs, APP_DATA, "main", record());
    await writeRecoveryRecord(fs, APP_DATA, "window-2", record());

    expect((await listRecoveryLabels(fs, APP_DATA)).sort()).toEqual(["main", "window-2"]);
  });

  it("returns nothing before any record exists", async () => {
    expect(await listRecoveryLabels(fs, APP_DATA)).toEqual([]);
  });
});
