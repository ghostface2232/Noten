import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults } from "./fs.fault.test-utils";
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

    const { byId: all } = await readAllMeta(fs, DIR);

    expect(all.has("..")).toBe(false);
    expect(all.has("good-id")).toBe(true);
    expect((await getMockedLogger()).mock.calls.length).toBeGreaterThan(0);
  });

  it("skips sidecars whose stem contains separators", async () => {
    fs.seedTextFile(`${DIR}/.meta/a:b.json`, JSON.stringify(meta("a:b")));
    const { byId: all } = await readAllMeta(fs, DIR);
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

  it("strict removal propagates errors that leave the sidecar in place", async () => {
    fs.seedTextFile(`${DIR}/.meta/safe.json`, JSON.stringify(meta("safe")));
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "remove",
      path: `${DIR}/.meta/safe.json`,
      times: 1,
      throwError: new Error("EPERM"),
    });

    await expect(removeMeta(faultFs, DIR, "safe", { strict: true })).rejects.toThrow(/EPERM/);
    expect(await fs.exists(`${DIR}/.meta/safe.json`)).toBe(true);
  });
});

describe("readAllMeta — one unreadable sidecar does not fail the library", () => {
  // Regression: readAllMeta rethrew whenever a sidecar existed but could not
  // be read, which failed the whole aggregate. One OneDrive placeholder that
  // had not hydrated was enough, and it took loading, saving and folder
  // resync down together — the close gate then refused to quit, with no way
  // out. Fail-closed is right for that ONE note; the blast radius was not.
  it("returns the readable notes and quarantines the unreadable one", async () => {
    await writeMeta(fs, DIR, meta("good-1"), "m1");
    await writeMeta(fs, DIR, meta("good-2"), "m1");
    await writeMeta(fs, DIR, meta("locked"), "m1");
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: /locked\.json$/,
      throwError: new Error("EBUSY: cloud-sync hydration"),
    });

    const { byId, unreadableIds } = await readAllMeta(faultFs, DIR);

    expect([...byId.keys()].sort()).toEqual(["good-1", "good-2"]);
    expect([...unreadableIds]).toEqual(["locked"]);
  });

  it("does not quarantine a sidecar that was deleted mid-read", async () => {
    // The TOCTOU case: listMetaFiles snapshotted the name, then a sibling
    // window's removeMeta landed before the read. Gone is not unreadable —
    // quarantining it would pin a note that no longer exists.
    await writeMeta(fs, DIR, meta("good-1"), "m1");
    await writeMeta(fs, DIR, meta("racing"), "m1");
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: /racing\.json$/,
      throwError: new Error("os error 2"),
    });
    await fs.remove(`${DIR}/.meta/racing.json`);

    const { byId, unreadableIds } = await readAllMeta(faultFs, DIR);

    expect([...byId.keys()]).toEqual(["good-1"]);
    expect(unreadableIds.size).toBe(0);
  });
});

describe("readAllMeta — an existing sidecar is never reported as absent", () => {
  it("quarantines a sidecar whose id disagrees with its filename", async () => {
    // A hand-copied sidecar or a cloud client's conflict copy. Reporting it as
    // absent makes reconcile ingest the body as unmanaged and write a fresh
    // sidecar over the real one — the loss the quarantine exists to prevent.
    await writeMeta(fs, DIR, meta("good-1"), "m1");
    fs.seedTextFile(
      `${DIR}/.meta/mismatched.json`,
      JSON.stringify(meta("some-other-id")),
    );

    const { byId, unreadableIds } = await readAllMeta(fs, DIR);

    expect([...byId.keys()]).toEqual(["good-1"]);
    expect([...unreadableIds]).toEqual(["mismatched"]);
  });

  it("quarantines when the existence re-check itself fails", async () => {
    // Read failed and we cannot even stat the file, so we cannot tell a
    // deletion that raced the read from a file we simply cannot reach.
    await writeMeta(fs, DIR, meta("unreachable"), "m1");
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: /unreachable\.json$/,
      throwError: new Error("EBUSY"),
    });
    faultFs.injectFault({
      op: "exists",
      path: /unreachable\.json$/,
      throwError: new Error("EBUSY"),
    });

    const { byId, unreadableIds } = await readAllMeta(faultFs, DIR);

    expect(byId.size).toBe(0);
    expect([...unreadableIds]).toEqual(["unreachable"]);
  });
});
