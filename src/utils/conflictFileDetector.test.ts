import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";
import { scanAndAbsorbConflicts } from "./conflictFileDetector";
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
