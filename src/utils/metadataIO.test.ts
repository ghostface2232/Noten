import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { readAllMeta, readMeta, writeMeta, removeMeta, type NoteMeta } from "./metadataIO";

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

async function getMockedLogger() {
  const { logNotenError } = await import("./crashLog");
  return logNotenError as unknown as ReturnType<typeof vi.fn>;
}

const DIR = "/notes";

let fs: InMemoryFileSystem;

function meta(id: string, extra: Partial<NoteMeta> = {}): NoteMeta {
  return {
    version: 2,
    id,
    fileName: "Note",
    createdAt: 1,
    updatedAt: 1,
    groupId: null,
    trashedAt: null,
    ...extra,
  };
}

beforeEach(async () => {
  fs = createInMemoryFileSystem();
  fs.seedDir(DIR);
  (await getMockedLogger()).mockClear();
});

describe("readAllMeta — unsafe id quarantine", () => {
  it("skips a `.meta/...json` sidecar whose stem resolves to `..` (the exploit input)", async () => {
    // Stem of `...json` is `..` — a crafted sidecar that, if accepted, would
    // drive `.assets/..` recursive deletion of the whole notes folder.
    fs.seedTextFile(`${DIR}/.meta/...json`, JSON.stringify(meta("..", { trashedAt: 1 })));
    // A legitimate note alongside it must still load.
    await writeMeta(fs, DIR, meta("good-id"), "m1");

    const all = await readAllMeta(fs, DIR);

    expect(all.has("..")).toBe(false);
    expect(all.has("good-id")).toBe(true);
    expect((await getMockedLogger()).mock.calls.length).toBeGreaterThan(0);
  });

  it("skips sidecars whose stem contains separators", async () => {
    fs.seedTextFile(`${DIR}/.meta/a:b.json`, JSON.stringify(meta("a:b")));
    const all = await readAllMeta(fs, DIR);
    expect(all.size).toBe(0);
  });
});

describe("readMeta / writeMeta / removeMeta — content id validation", () => {
  it("rejects a sidecar whose content id is a traversal segment", async () => {
    // Filename is benign, but the JSON body claims `id: ".."`.
    fs.seedTextFile(`${DIR}/.meta/benign.json`, JSON.stringify(meta("..")));
    await expect(readMeta(fs, DIR, "benign")).rejects.toThrow();
  });

  it("removeMeta refuses to touch the filesystem for an unsafe id", async () => {
    const removeSpy = vi.spyOn(fs, "remove");
    await removeMeta(fs, DIR, "..");
    expect(removeSpy).not.toHaveBeenCalled();
    expect((await getMockedLogger()).mock.calls.length).toBeGreaterThan(0);
  });
});
