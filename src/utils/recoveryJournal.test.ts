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
  planRecovery,
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

describe("planRecovery — nothing uncertain is ever applied", () => {
  it("drops a record the disk already holds", async () => {
    // The save landed after all, or a later one did. Also what makes a stale
    // record harmless: clearing on success is fire-and-forget.
    expect(planRecovery(record({ content: "same" }), "same")).toEqual({ action: "drop" });
  });

  it("drops a record the disk holds modulo line endings", () => {
    expect(planRecovery(record({ content: "a\nb\n" }), "a\r\nb")).toEqual({ action: "drop" });
  });

  it("applies when the disk still holds exactly what the edit was made against", () => {
    const plan = planRecovery(
      record({ content: "my unsaved work", baseContent: "what was there" }),
      "what was there",
    );
    expect(plan).toEqual({ action: "apply" });
  });

  it("preserves rather than applies when the disk moved underneath", () => {
    // Another device wrote while this machine was gone. Its version stays.
    const plan = planRecovery(
      record({ content: "my unsaved work", baseContent: "what was there" }),
      "what the other device wrote",
    );
    expect(plan).toEqual({ action: "preserve", reason: "diverged" });
  });

  it("preserves when the record has no base", () => {
    // The projection case, reached through the journal: a load that failed
    // leaves every note looking empty against a real filePath, and an edit
    // made there would record an empty body with no base. Applying it would
    // be the C1 deletion by another route.
    const plan = planRecovery(
      record({ content: "", baseContent: null }),
      "the real note body",
    );
    expect(plan).toEqual({ action: "preserve", reason: "unknown-base" });
  });

  it("preserves when the file no longer exists", () => {
    // Deleted on another device. Writing the body back would resurrect it.
    const plan = planRecovery(record({ baseContent: "what was there" }), null);
    expect(plan).toEqual({ action: "preserve", reason: "missing-file" });
  });

  it("preserves an edit that never had a file at all", () => {
    // A doc whose provisioning kept failing: the text exists nowhere else, so
    // it has to be kept, but there is no note to apply it to.
    const plan = planRecovery(record({ filePath: "", baseContent: null }), null);
    expect(plan).toEqual({ action: "preserve", reason: "missing-file" });
  });

  it("never applies over a body it cannot account for", () => {
    // The whole point, stated as a property: apply requires that the disk
    // equals the recorded base.
    const disks = ["what was there", "something else", ""];
    const bases = ["what was there", null];
    for (const diskContent of disks) {
      for (const baseContent of bases) {
        const plan = planRecovery(record({ content: "edit", baseContent }), diskContent);
        if (plan.action === "apply") {
          expect(baseContent).not.toBeNull();
          expect(diskContent).toBe(baseContent);
        }
      }
    }
  });
});
