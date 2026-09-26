import { describe, it, expect, vi, beforeEach } from "vitest";
import { atomicWriteText } from "./atomicWrite";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";
import { logNotenError } from "./crashLog";
import { NotenError } from "./notenError";

vi.mock("./crashLog", () => ({ logNotenError: vi.fn() }));

const logger = vi.mocked(logNotenError);

const PATH = "/notes/note.md";
const TMP = `${PATH}.tmp`;

describe("atomicWriteText", () => {
  let fs: InMemoryFileSystem & FaultInjectingFileSystem;

  beforeEach(async () => {
    fs = wrapWithFaults(createInMemoryFileSystem());
    await fs.mkdir("/notes", { recursive: true });
    logger.mockClear();
  });

  it("writes via temp + rename on the happy path, leaves no tmp behind, and reports no degradation", async () => {
    await atomicWriteText(fs, PATH, "hello");
    expect(await fs.readTextFile(PATH)).toBe("hello");
    expect(await fs.exists(TMP)).toBe(false);
    // A report on success would make the degradation signal meaningless.
    expect(logger).not.toHaveBeenCalled();
  });

  describe("relaxed mode (default — rebuildable writers)", () => {
    it("degrades to a direct overwrite and reports META_WRITE_FAILED at stage tmp when the tmp write fails", async () => {
      fs.injectFault({ op: "writeTextFile", path: TMP, throwError: new Error("EPERM: .tmp blocked") });

      await atomicWriteText(fs, PATH, "degraded");

      expect(await fs.readTextFile(PATH)).toBe("degraded");
      expect(await fs.exists(TMP)).toBe(false);
      expect(fs.callCount("writeTextFile", TMP)).toBe(1);
      expect(fs.callCount("writeTextFile", PATH)).toBe(1);

      expect(logger).toHaveBeenCalledTimes(1);
      const reported = logger.mock.calls[0][0];
      expect(reported.code).toBe("META_WRITE_FAILED");
      expect(reported.severity).toBe("recoverable");
      expect(reported.context).toMatchObject({ filePath: PATH, stage: "tmp" });
    });

    it("degrades to a direct overwrite, clears the tmp, and reports META_WRITE_FAILED at stage rename when rename fails", async () => {
      fs.injectFault({ op: "rename", path: TMP, throwError: new Error("EBUSY: rename target locked") });

      await atomicWriteText(fs, PATH, "degraded");

      expect(await fs.readTextFile(PATH)).toBe("degraded");
      expect(await fs.exists(TMP)).toBe(false);
      expect(fs.callCount("writeTextFile", PATH)).toBe(1);
      expect(fs.callCount("writeTextFile", TMP)).toBe(1);

      expect(logger).toHaveBeenCalledTimes(1);
      const reported = logger.mock.calls[0][0];
      expect(reported).toBeInstanceOf(NotenError);
      expect(reported.code).toBe("META_WRITE_FAILED");
      expect(reported.severity).toBe("recoverable");
      expect(reported.context).toMatchObject({ filePath: PATH, stage: "rename" });
    });

    it("returns to tmp-then-rename once a transient rename failure clears, reporting only the degraded call", async () => {
      fs.injectFault({ op: "rename", path: TMP, times: 1, throwError: new Error("EBUSY") });

      await atomicWriteText(fs, PATH, "v1");
      expect(await fs.readTextFile(PATH)).toBe("v1");

      await atomicWriteText(fs, PATH, "v2");
      expect(await fs.readTextFile(PATH)).toBe("v2");
      expect(await fs.exists(TMP)).toBe(false);

      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger.mock.calls[0][0].code).toBe("META_WRITE_FAILED");
    });
  });

  describe("fail-closed mode (body — single source of truth)", () => {
    it("throws and does NOT overwrite the target when the tmp write fails", async () => {
      fs.seedTextFile(PATH, "old body");
      fs.injectFault({ op: "writeTextFile", path: TMP, throwError: new Error("EBUSY tmp") });

      await expect(
        atomicWriteText(fs, PATH, "new body", { failClosed: true }),
      ).rejects.toThrow("EBUSY tmp");

      // The prior body must survive; no direct overwrite happened.
      expect(await fs.readTextFile(PATH)).toBe("old body");
    });

    it("throws, leaves the prior body intact, and clears the tmp when rename fails", async () => {
      fs.seedTextFile(PATH, "old body");
      fs.injectFault({ op: "rename", path: TMP, throwError: new Error("EBUSY rename") });

      await expect(
        atomicWriteText(fs, PATH, "new body", { failClosed: true }),
      ).rejects.toThrow("EBUSY rename");

      expect(await fs.readTextFile(PATH)).toBe("old body");
      expect(await fs.exists(TMP)).toBe(false);
    });
  });
});
