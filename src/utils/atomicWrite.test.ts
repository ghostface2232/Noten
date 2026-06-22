import { describe, it, expect, vi, beforeEach } from "vitest";
import { atomicWriteText } from "./atomicWrite";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";

// crashLog writes to disk in the real app; stub it so these unit tests don't
// depend on the logging side channel and don't spew during the run.
vi.mock("./crashLog", () => ({ logNotenError: vi.fn() }));

const PATH = "/notes/note.md";
const TMP = `${PATH}.tmp`;

describe("atomicWriteText", () => {
  let fs: InMemoryFileSystem & FaultInjectingFileSystem;

  beforeEach(async () => {
    fs = wrapWithFaults(createInMemoryFileSystem());
    await fs.mkdir("/notes", { recursive: true });
  });

  it("writes via temp + rename on the happy path and leaves no tmp behind", async () => {
    await atomicWriteText(fs, PATH, "hello");
    expect(await fs.readTextFile(PATH)).toBe("hello");
    expect(await fs.exists(TMP)).toBe(false);
  });

  describe("relaxed mode (default — rebuildable writers)", () => {
    it("degrades to a direct overwrite when the tmp write fails", async () => {
      fs.injectFault({ op: "writeTextFile", path: TMP, throwError: new Error("EBUSY tmp") });

      await atomicWriteText(fs, PATH, "degraded");

      expect(await fs.readTextFile(PATH)).toBe("degraded");
    });

    it("degrades to a direct overwrite and clears the tmp when rename fails", async () => {
      fs.injectFault({ op: "rename", path: TMP, throwError: new Error("EBUSY rename") });

      await atomicWriteText(fs, PATH, "degraded");

      expect(await fs.readTextFile(PATH)).toBe("degraded");
      expect(await fs.exists(TMP)).toBe(false);
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
