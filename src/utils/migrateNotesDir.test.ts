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
import { invalidateReadAllMetaCache, type NoteMeta } from "./metadataIO";
import { tauriFileSystem } from "./fs";

const logMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;

beforeEach(() => {
  refs.fs = wrapWithFaults(createInMemoryFileSystem());
  refs.fs.seedDir("/from");
  refs.fs.seedDir("/to");
  // readAllMeta caches per FileSystem instance with a 500ms TTL. migrateNotesDir
  // goes through the module-singleton tauriFileSystem (delegating to the mocked
  // plugin fns), so a previous test's meta snapshot would leak into this one.
  invalidateReadAllMetaCache(tauriFileSystem);
  vi.clearAllMocks();
});

function seedMeta(dir: string, meta: Partial<NoteMeta> & { id: string }): void {
  refs.fs!.seedTextFile(`${dir}/.meta/${meta.id}.json`, JSON.stringify({
    version: 2,
    fileName: meta.id,
    createdAt: 1000,
    updatedAt: 1000,
    groupId: null,
    trashedAt: null,
    ...meta,
  }));
}

async function readMetaRaw(dir: string, id: string): Promise<NoteMeta> {
  return JSON.parse(await refs.fs!.readTextFile(`${dir}/.meta/${id}.json`)) as NoteMeta;
}

/** Pin a file's mtime as seen by migrateNotesDir's newer-wins comparison. */
function pinMtime(path: string, ms: number): void {
  refs.fs!.injectFault({
    op: "stat",
    path,
    transformResult: (r) => ({ ...(r as object), mtime: new Date(ms) }),
  });
}

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

describe("migrateNotesDir — overwrite happy path", () => {
  it("replaces destination managed data, preserves unmanaged files, clears the source", async () => {
    refs.fs!.seedTextFile("/from/a.md", "source body");
    seedMeta("/from", { id: "a", fileName: "A" });
    refs.fs!.seedTextFile("/from/.trash/t.md", "trashed body");
    refs.fs!.seedTextFile("/from/.assets/a/img.png", "png-bytes");
    // Destination has its own managed data plus a file Noten does not own.
    refs.fs!.seedTextFile("/to/old.md", "old destination body");
    seedMeta("/to", { id: "old", fileName: "Old" });
    refs.fs!.seedTextFile("/to/user-document.txt", "not ours");

    const result = await migrateNotesDir("/from", "/to", "overwrite");
    expect(result).toEqual({ success: true });

    // Source tree copied wholesale.
    expect(await refs.fs!.readTextFile("/to/a.md")).toBe("source body");
    expect((await readMetaRaw("/to", "a")).fileName).toBe("A");
    expect(await refs.fs!.readTextFile("/to/.trash/t.md")).toBe("trashed body");
    expect(await refs.fs!.readTextFile("/to/.assets/a/img.png")).toBe("png-bytes");

    // Previous destination managed data is gone; unmanaged files survive.
    expect(await refs.fs!.exists("/to/old.md")).toBe(false);
    expect(await refs.fs!.readTextFile("/to/user-document.txt")).toBe("not ours");

    // The source's managed entries are cleared after a successful move.
    expect(await refs.fs!.exists("/from/a.md")).toBe(false);
    expect(await refs.fs!.exists("/from/.meta")).toBe(false);
  });
});

describe("migrateNotesDir — merge newer-wins bodies", () => {
  it("a newer source body overwrites the destination and backs the old body up to .conflicts", async () => {
    refs.fs!.seedTextFile("/from/a.md", "newer source body");
    refs.fs!.seedTextFile("/to/a.md", "older destination body");
    seedMeta("/from", { id: "a" });
    pinMtime("/from/a.md", 5000);
    pinMtime("/to/a.md", 3000);

    const result = await migrateNotesDir("/from", "/to", "merge");
    expect(result).toEqual({ success: true });

    expect(await refs.fs!.readTextFile("/to/a.md")).toBe("newer source body");

    // The overwritten destination body is preserved under .conflicts/.
    const backups = [...refs.fs!.snapshot().keys()]
      .filter((p) => /^\/to\/\.conflicts\/a-\d+\.md$/.test(p));
    expect(backups).toHaveLength(1);
    expect(await refs.fs!.readTextFile(backups[0])).toBe("older destination body");
  });

  it("an older source body never clobbers a newer destination; one-sided notes are unioned", async () => {
    refs.fs!.seedTextFile("/from/a.md", "older source body");
    refs.fs!.seedTextFile("/from/only-in-source.md", "source-only");
    refs.fs!.seedTextFile("/to/a.md", "newer destination body");
    refs.fs!.seedTextFile("/to/only-in-dest.md", "dest-only");
    pinMtime("/from/a.md", 3000);
    pinMtime("/to/a.md", 5000);

    const result = await migrateNotesDir("/from", "/to", "merge");
    expect(result).toEqual({ success: true });

    expect(await refs.fs!.readTextFile("/to/a.md")).toBe("newer destination body");
    expect(await refs.fs!.readTextFile("/to/only-in-source.md")).toBe("source-only");
    expect(await refs.fs!.readTextFile("/to/only-in-dest.md")).toBe("dest-only");
    // Nothing was overwritten, so no conflict backup is written.
    const backups = [...refs.fs!.snapshot().keys()].filter((p) => p.startsWith("/to/.conflicts/"));
    expect(backups).toHaveLength(0);
  });
});

describe("migrateNotesDir — merge meta clocks", () => {
  it("title follows updatedAt LWW while the fresher group move survives independently; pinned ORs", async () => {
    refs.fs!.seedTextFile("/from/a.md", "body");
    pinMtime("/from/a.md", 5000);
    seedMeta("/from", {
      id: "a",
      fileName: "Source Title",
      updatedAt: 3000,
      pinned: true,
      groupId: null,
      groupUpdatedAt: 1000,
    });
    seedMeta("/to", {
      id: "a",
      fileName: "Dest Title",
      updatedAt: 2000,
      pinned: false,
      groupId: "g-dest",
      groupUpdatedAt: 5000,
    });

    const result = await migrateNotesDir("/from", "/to", "merge");
    expect(result).toEqual({ success: true });

    const merged = await readMetaRaw("/to", "a");
    // Body/title clock: source is newer.
    expect(merged.fileName).toBe("Source Title");
    expect(merged.updatedAt).toBe(3000);
    // Pinned survives from either side.
    expect(merged.pinned).toBe(true);
    // Group membership keeps its own clock: the destination's fresher group
    // move must not be erased by the source winning the title.
    expect(merged.groupId).toBe("g-dest");
    expect(merged.groupUpdatedAt).toBe(5000);
  });

  it("leaves destination-only meta untouched", async () => {
    refs.fs!.seedTextFile("/from/a.md", "body");
    pinMtime("/from/a.md", 5000);
    seedMeta("/from", { id: "a" });
    seedMeta("/to", { id: "dest-only", fileName: "Keep Me", updatedAt: 9000 });

    const result = await migrateNotesDir("/from", "/to", "merge");
    expect(result).toEqual({ success: true });

    const kept = await readMetaRaw("/to", "dest-only");
    expect(kept.fileName).toBe("Keep Me");
    expect(kept.updatedAt).toBe(9000);
  });
});
