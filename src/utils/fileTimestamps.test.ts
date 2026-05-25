import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";
import { getFileTimestamps } from "./fileTimestamps";

// These tests pin the fallback contract that the rest of the system relies on:
// getFileTimestamps NEVER throws — it returns Date.now() for both timestamps
// whenever the underlying stat fails or omits mtime/birthtime. Several call
// sites depend on that invariant (e.g., reconcileFolder's trash-restore path
// stats directly because it specifically needs to distinguish "unknown" from
// "now"; that decision only makes sense as long as getFileTimestamps keeps
// returning a definite value here).

const FILE = "/notes/sample.md";

let inner: InMemoryFileSystem;
let fs: InMemoryFileSystem & FaultInjectingFileSystem;

beforeEach(() => {
  inner = createInMemoryFileSystem();
  inner.seedDir("/notes");
  fs = wrapWithFaults(inner);
});

describe("getFileTimestamps", () => {
  it("returns the file's birthtime and mtime when stat succeeds", async () => {
    fs.seedTextFile(FILE, "body");
    const stat = await fs.stat(FILE);
    const expectedBirth = stat.birthtime!.getTime();
    const expectedMtime = stat.mtime!.getTime();

    const ts = await getFileTimestamps(fs, FILE);

    expect(ts.createdAt).toBe(expectedBirth);
    expect(ts.updatedAt).toBe(expectedMtime);
  });

  it("falls back to Date.now() for both timestamps when stat throws", async () => {
    // Path was never seeded — stat will reject with ENOENT. Use a fault rule
    // to additionally model a transient EBUSY in case implementation ever
    // distinguishes "missing" from "transient failure".
    fs.injectFault({
      op: "stat",
      path: FILE,
      throwError: new Error("EBUSY: stat locked"),
    });

    const before = Date.now();
    const ts = await getFileTimestamps(fs, FILE);
    const after = Date.now();

    // Use a window rather than equality: Date.now() inside the function may
    // tick once relative to the call site.
    expect(ts.createdAt).toBeGreaterThanOrEqual(before);
    expect(ts.createdAt).toBeLessThanOrEqual(after);
    expect(ts.updatedAt).toBeGreaterThanOrEqual(before);
    expect(ts.updatedAt).toBeLessThanOrEqual(after);
  });

  it("falls back to Date.now() when stat returns null mtime and null birthtime", async () => {
    fs.seedTextFile(FILE, "body");
    fs.injectFault({
      op: "stat",
      path: FILE,
      transformResult: (s) => ({ ...(s as object), mtime: null, birthtime: null }),
    });

    const before = Date.now();
    const ts = await getFileTimestamps(fs, FILE);
    const after = Date.now();

    expect(ts.createdAt).toBeGreaterThanOrEqual(before);
    expect(ts.createdAt).toBeLessThanOrEqual(after);
    expect(ts.updatedAt).toBeGreaterThanOrEqual(before);
    expect(ts.updatedAt).toBeLessThanOrEqual(after);
  });

  it("uses mtime for createdAt when birthtime is null but mtime is present", async () => {
    // Some platforms (notably ext4 without statx, or older Tauri builds) can
    // report null birthtime even when mtime is concrete. The implementation
    // prefers birthtime → mtime → now in that order; this fixes that order.
    fs.seedTextFile(FILE, "body");
    const stat = await fs.stat(FILE);
    const realMtime = stat.mtime!.getTime();

    fs.injectFault({
      op: "stat",
      path: FILE,
      transformResult: (s) => ({ ...(s as object), birthtime: null }),
    });

    const ts = await getFileTimestamps(fs, FILE);
    expect(ts.createdAt).toBe(realMtime);
    expect(ts.updatedAt).toBe(realMtime);
  });
});
