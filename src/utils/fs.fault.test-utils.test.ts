import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";
import { atomicWriteText } from "./atomicWrite";
import { NotenError } from "./notenError";

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

// Hoist-safe lookup of the mocked logger so each test can assert against it.
async function getMockedLogger() {
  const { logNotenError } = await import("./crashLog");
  return logNotenError as unknown as ReturnType<typeof vi.fn>;
}

let inner: InMemoryFileSystem;
let fs: InMemoryFileSystem & FaultInjectingFileSystem;

beforeEach(async () => {
  inner = createInMemoryFileSystem();
  inner.seedDir("/notes");
  fs = wrapWithFaults(inner);
  (await getMockedLogger()).mockClear();
});

describe("wrapWithFaults — wrapper semantics", () => {
  it("passes through when no rules are registered", async () => {
    await fs.writeTextFile("/notes/a.md", "hello");
    expect(await fs.readTextFile("/notes/a.md")).toBe("hello");
    expect(fs.callCount("writeTextFile")).toBe(1);
    expect(fs.callCount("readTextFile")).toBe(1);
  });

  it("throws the configured error and skips the inner op", async () => {
    fs.injectFault({
      op: "writeTextFile",
      path: "/notes/locked.md",
      throwError: new Error("EBUSY: file locked by AV"),
    });

    await expect(fs.writeTextFile("/notes/locked.md", "x")).rejects.toThrow(/EBUSY/);
    // Inner side-effect must not have happened.
    expect(await fs.exists("/notes/locked.md")).toBe(false);
  });

  it("retires after `times` failures, then lets the inner op succeed", async () => {
    fs.injectFault({
      op: "rename",
      path: "/notes/a.md.tmp",
      times: 2,
      throwError: new Error("EBUSY"),
    });
    await fs.writeTextFile("/notes/a.md.tmp", "x");

    await expect(fs.rename("/notes/a.md.tmp", "/notes/a.md")).rejects.toThrow(/EBUSY/);
    await fs.writeTextFile("/notes/a.md.tmp", "x");
    await expect(fs.rename("/notes/a.md.tmp", "/notes/a.md")).rejects.toThrow(/EBUSY/);
    await fs.writeTextFile("/notes/a.md.tmp", "x");
    // Third call: rule has retired, rename goes through.
    await fs.rename("/notes/a.md.tmp", "/notes/a.md");

    expect(await fs.exists("/notes/a.md")).toBe(true);
    expect(await fs.exists("/notes/a.md.tmp")).toBe(false);
  });

  it("transforms the inner result without skipping the op", async () => {
    fs.seedTextFile("/notes/placeholder.md", "ghost");
    fs.injectFault({
      op: "stat",
      path: "/notes/placeholder.md",
      transformResult: (s) => ({ ...(s as object), mtime: null }),
    });

    const info = await fs.stat("/notes/placeholder.md");
    expect(info.mtime).toBeNull();
    // Other paths unaffected.
    const other = await fs.stat("/notes");
    expect(other.mtime).not.toBeNull();
  });

  it("matches by RegExp across many paths", async () => {
    fs.injectFault({
      op: "writeTextFile",
      path: /\.tmp$/,
      throwError: new Error("ENOSPC"),
    });
    await expect(fs.writeTextFile("/notes/a.md.tmp", "x")).rejects.toThrow(/ENOSPC/);
    await expect(fs.writeTextFile("/notes/b.md.tmp", "x")).rejects.toThrow(/ENOSPC/);
    // Non-matching path is fine.
    await fs.writeTextFile("/notes/c.md", "x");
    expect(await fs.exists("/notes/c.md")).toBe(true);
  });

  it("clearFaults drops every rule", async () => {
    fs.injectFault({ op: "writeTextFile", throwError: new Error("nope") });
    fs.clearFaults();
    await fs.writeTextFile("/notes/a.md", "ok");
    expect(await fs.readTextFile("/notes/a.md")).toBe("ok");
  });
});

describe("wrapWithFaults — exercises code paths the bare in-memory FS cannot", () => {
  it("atomicWriteText degrades to direct write and reports META_WRITE_FAILED when rename rejects", async () => {
    // Models AV / OneDrive holding a lock on the destination during rename.
    // The fallback is a *degraded* path — atomicity is forfeit — so the test
    // must verify the degradation was reported, not just that the write succeeded.
    fs.injectFault({
      op: "rename",
      path: "/notes/meta.json.tmp",
      throwError: new Error("EBUSY: rename target locked"),
    });

    await atomicWriteText(fs, "/notes/meta.json", "{}");

    // Final file exists with the right content, tmp is cleaned up.
    expect(await fs.readTextFile("/notes/meta.json")).toBe("{}");
    expect(await fs.exists("/notes/meta.json.tmp")).toBe(false);
    // The fallback path writes the destination directly.
    expect(fs.callCount("writeTextFile", "/notes/meta.json")).toBe(1);
    expect(fs.callCount("writeTextFile", "/notes/meta.json.tmp")).toBe(1);

    // Degradation must be signaled so silent corruption windows stay diagnosable.
    const logger = await getMockedLogger();
    expect(logger).toHaveBeenCalledTimes(1);
    const reported = logger.mock.calls[0][0] as NotenError;
    expect(reported).toBeInstanceOf(NotenError);
    expect(reported.code).toBe("META_WRITE_FAILED");
    expect(reported.severity).toBe("recoverable");
    expect(reported.context).toMatchObject({ filePath: "/notes/meta.json", stage: "rename" });
  });

  it("atomicWriteText degrades to direct write and reports META_WRITE_FAILED when tmp write rejects", async () => {
    // Models a quota error or `.tmp` filter that only affects the tmp suffix.
    fs.injectFault({
      op: "writeTextFile",
      path: "/notes/meta.json.tmp",
      throwError: new Error("EPERM: .tmp blocked"),
    });

    await atomicWriteText(fs, "/notes/meta.json", "{}");

    expect(await fs.readTextFile("/notes/meta.json")).toBe("{}");
    expect(await fs.exists("/notes/meta.json.tmp")).toBe(false);
    // tmp write was attempted (and failed); destination write was the fallback.
    expect(fs.callCount("writeTextFile", "/notes/meta.json.tmp")).toBe(1);
    expect(fs.callCount("writeTextFile", "/notes/meta.json")).toBe(1);

    const logger = await getMockedLogger();
    expect(logger).toHaveBeenCalledTimes(1);
    const reported = logger.mock.calls[0][0] as NotenError;
    expect(reported.code).toBe("META_WRITE_FAILED");
    expect(reported.severity).toBe("recoverable");
    expect(reported.context).toMatchObject({ filePath: "/notes/meta.json", stage: "tmp" });
  });

  it("does not report META_WRITE_FAILED on the canonical tmp-then-rename happy path", async () => {
    // Sanity check the inverse: a successful atomic write must NOT emit the
    // degradation signal, otherwise the report is meaningless.
    await atomicWriteText(fs, "/notes/meta.json", "{}");

    const logger = await getMockedLogger();
    expect(logger).not.toHaveBeenCalled();
  });

  it("recovers when rename fails transiently then succeeds; reports once for the degraded call", async () => {
    fs.injectFault({
      op: "rename",
      path: "/notes/meta.json.tmp",
      times: 1,
      throwError: new Error("EBUSY"),
    });

    // First atomicWriteText hits the rename failure and falls back to direct write.
    await atomicWriteText(fs, "/notes/meta.json", "v1");
    expect(await fs.readTextFile("/notes/meta.json")).toBe("v1");

    // Second call: rule retired, the canonical tmp-then-rename path runs.
    await atomicWriteText(fs, "/notes/meta.json", "v2");
    expect(await fs.readTextFile("/notes/meta.json")).toBe("v2");
    expect(await fs.exists("/notes/meta.json.tmp")).toBe(false);

    // Exactly one degradation: the first call. The recovered call is clean.
    const logger = await getMockedLogger();
    expect(logger).toHaveBeenCalledTimes(1);
    expect((logger.mock.calls[0][0] as NotenError).code).toBe("META_WRITE_FAILED");
  });
});
