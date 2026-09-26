import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";

let inner: InMemoryFileSystem;
let fs: InMemoryFileSystem & FaultInjectingFileSystem;

beforeEach(() => {
  inner = createInMemoryFileSystem();
  inner.seedDir("/notes");
  fs = wrapWithFaults(inner);
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
