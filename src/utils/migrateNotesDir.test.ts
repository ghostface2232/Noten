import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";
import type { InMemoryFileSystem } from "./fs.test-utils";

const refs = vi.hoisted(() => ({
  fs: null as (InMemoryFileSystem & FaultInjectingFileSystem) | null,
}));

vi.mock("@tauri-apps/plugin-fs", () => {
  const get = () => {
    if (!refs.fs) throw new Error("test fs not initialized");
    return refs.fs;
  };
  return {
    mkdir: (p: string, o?: { recursive?: boolean }) => get().mkdir(p, o),
    readTextFile: (p: string) => get().readTextFile(p),
    writeTextFile: (p: string, c: string) => get().writeTextFile(p, c),
    readFile: (p: string) => get().readFile(p),
    writeFile: (p: string, d: Uint8Array) => get().writeFile(p, d),
    remove: (p: string, o?: { recursive?: boolean }) => get().remove(p, o),
    copyFile: (a: string, b: string) => get().copyFile(a, b),
    rename: (a: string, b: string) => get().rename(a, b),
    readDir: (p: string) => get().readDir(p),
    exists: (p: string) => get().exists(p),
    stat: (p: string) => get().stat(p),
  };
});

vi.mock("./machineId", () => ({
  getMachineId: vi.fn(async () => "test-machine"),
}));

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

import { migrateNotesDir } from "./migrateNotesDir";
import * as crashLogModule from "./crashLog";
import { NotenError } from "./notenError";

const logMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;

beforeEach(() => {
  refs.fs = wrapWithFaults(createInMemoryFileSystem());
  refs.fs.seedDir("/from");
  refs.fs.seedDir("/to");
  vi.clearAllMocks();
});

describe("migrateNotesDir — overwrite source preflight", () => {
  it("does not clear destination data when the source root cannot be read", async () => {
    refs.fs!.seedTextFile("/from/a.md", "source body");
    refs.fs!.seedTextFile("/to/old.md", "destination body");
    refs.fs!.injectFault({
      op: "readDir",
      path: "/from",
      throwError: new Error("EBUSY: source folder unavailable"),
    });

    const result = await migrateNotesDir("/from", "/to", "overwrite");

    expect(result.success).toBe(false);
    expect(await refs.fs!.readTextFile("/to/old.md")).toBe("destination body");
    expect(await refs.fs!.exists("/to/a.md")).toBe(false);

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "MIGRATION_FAILED",
    );
    expect(logged).toBeDefined();
  });

  it("does not clear destination data when a source note body cannot be read", async () => {
    refs.fs!.seedTextFile("/from/a.md", "source body");
    refs.fs!.seedTextFile("/to/old.md", "destination body");
    refs.fs!.injectFault({
      op: "readTextFile",
      path: "/from/a.md",
      throwError: new Error("EBUSY: source body unavailable"),
    });

    const result = await migrateNotesDir("/from", "/to", "overwrite");

    expect(result.success).toBe(false);
    expect(await refs.fs!.readTextFile("/to/old.md")).toBe("destination body");
    expect(await refs.fs!.exists("/to/a.md")).toBe(false);
  });

  it("does not clear destination data when source metadata cannot be read", async () => {
    refs.fs!.seedTextFile("/from/a.md", "source body");
    refs.fs!.seedTextFile("/from/.meta/a.json", JSON.stringify({
      version: 2,
      id: "a",
      fileName: "A",
      createdAt: 1000,
      updatedAt: 1000,
      groupId: null,
      trashedAt: null,
    }));
    refs.fs!.seedTextFile("/to/old.md", "destination body");
    refs.fs!.injectFault({
      op: "readFile",
      path: "/from/.meta/a.json",
      throwError: new Error("EBUSY: metadata unavailable"),
    });

    const result = await migrateNotesDir("/from", "/to", "overwrite");

    expect(result.success).toBe(false);
    expect(await refs.fs!.readTextFile("/to/old.md")).toBe("destination body");
    expect(await refs.fs!.exists("/to/a.md")).toBe(false);
  });
});
