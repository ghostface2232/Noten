import { describe, it, expect, beforeEach, vi } from "vitest";

const removeMock = vi.fn(async (_path: string, _opts?: { recursive?: boolean }) => {});
const mkdirMock = vi.fn(async (_path: string, _opts?: { recursive?: boolean }) => {});
const readDirMock = vi.fn(async (_path: string): Promise<Array<{ name: string; isFile: boolean }>> => []);
const readFileMock = vi.fn(async (_path: string): Promise<Uint8Array> => new Uint8Array());
const writeFileMock = vi.fn(async (_path: string, _bytes: Uint8Array) => {});

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: (path: string, opts?: { recursive?: boolean }) => mkdirMock(path, opts),
  readDir: (path: string) => readDirMock(path),
  readFile: (path: string) => readFileMock(path),
  writeFile: (path: string, bytes: Uint8Array) => writeFileMock(path, bytes),
  remove: (path: string, opts?: { recursive?: boolean }) => removeMock(path, opts),
}));

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

import { duplicateNoteAssets, removeNoteAssetDir } from "./imageAssetUtils";

async function getMockedLogger() {
  const { logNotenError } = await import("./crashLog");
  return logNotenError as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(async () => {
  removeMock.mockClear();
  mkdirMock.mockClear();
  readDirMock.mockClear();
  readDirMock.mockResolvedValue([]);
  readFileMock.mockClear();
  readFileMock.mockResolvedValue(new Uint8Array());
  writeFileMock.mockClear();
  writeFileMock.mockResolvedValue(undefined);
  (await getMockedLogger()).mockClear();
});

describe("removeNoteAssetDir", () => {
  it("recursively removes the note's own asset dir for a valid id", async () => {
    await removeNoteAssetDir("/notes", "abc-123");
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith("/notes/.assets/abc-123", { recursive: true });
  });

  it("REFUSES to delete when id is `..` (would wipe the whole notes folder)", async () => {
    await removeNoteAssetDir("/notes", "..");
    expect(removeMock).not.toHaveBeenCalled();
    expect((await getMockedLogger()).mock.calls.length).toBeGreaterThan(0);
  });

  it("refuses ids containing path separators", async () => {
    await removeNoteAssetDir("/notes", "../sibling");
    await removeNoteAssetDir("/notes", "a/b");
    await removeNoteAssetDir("/notes", "a\\b");
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("refuses ids Win32 would alias by trimming trailing dots/spaces", async () => {
    // `.assets/...` and `.assets/ ` -> `.assets` (mass image delete);
    // `.assets/.. ` -> `.assets/..` = notes root (total wipe).
    for (const id of ["...", "....", " ", ".. ", ". ", "note.", "note "]) {
      await removeNoteAssetDir("/notes", id);
    }
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("refuses Windows reserved device names", async () => {
    await removeNoteAssetDir("/notes", "NUL");
    await removeNoteAssetDir("/notes", "con");
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("is a no-op when notesDir or noteId is empty", async () => {
    await removeNoteAssetDir("", "abc");
    await removeNoteAssetDir("/notes", "");
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe("duplicateNoteAssets", () => {
  const SRC = "11111111-1111-1111-1111-111111111111";
  const DST = "22222222-2222-2222-2222-222222222222";

  it("copies each source asset file and rewrites references to the new id", async () => {
    readDirMock.mockResolvedValue([
      { name: "aaa.png", isFile: true },
      { name: "bbb.jpg", isFile: true },
    ]);
    const content = `![x](.assets/${SRC}/aaa.png)\n<img src=".assets/${SRC}/bbb.jpg" width="100">`;

    const out = await duplicateNoteAssets("/notes", SRC, DST, content);

    expect(readDirMock).toHaveBeenCalledWith(`/notes/.assets/${SRC}`);
    expect(writeFileMock).toHaveBeenCalledWith(`/notes/.assets/${DST}/aaa.png`, expect.any(Uint8Array));
    expect(writeFileMock).toHaveBeenCalledWith(`/notes/.assets/${DST}/bbb.jpg`, expect.any(Uint8Array));
    expect(out).toBe(`![x](.assets/${DST}/aaa.png)\n<img src=".assets/${DST}/bbb.jpg" width="100">`);
    // No lingering references to the source id.
    expect(out).not.toContain(SRC);
  });

  it("rewrites a `./`-prefixed reference too", async () => {
    readDirMock.mockResolvedValue([{ name: "aaa.png", isFile: true }]);
    const out = await duplicateNoteAssets("/notes", SRC, DST, `![x](./.assets/${SRC}/aaa.png)`);
    expect(out).toBe(`![x](./.assets/${DST}/aaa.png)`);
  });

  it("returns content unchanged when the source has no asset dir", async () => {
    readDirMock.mockRejectedValue(new Error("ENOENT"));
    const content = `plain note, no images`;
    const out = await duplicateNoteAssets("/notes", SRC, DST, content);
    expect(out).toBe(content);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("rewrites only the copied asset and keeps a failed copy pointing at the source", async () => {
    readDirMock.mockResolvedValue([
      { name: "good.png", isFile: true },
      { name: "bad.png", isFile: true },
    ]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("bad.png")) throw new Error("locked");
      return new Uint8Array([1, 2, 3]);
    });
    const content = `![a](.assets/${SRC}/good.png) ![b](.assets/${SRC}/bad.png)`;

    const out = await duplicateNoteAssets("/notes", SRC, DST, content);

    expect(writeFileMock).toHaveBeenCalledWith(`/notes/.assets/${DST}/good.png`, expect.any(Uint8Array));
    // good.png copied -> rewritten to the new id; bad.png failed -> reference
    // stays at the source dir (which still exists) so it renders now instead
    // of pointing at a file that was never created.
    expect(out).toBe(`![a](.assets/${DST}/good.png) ![b](.assets/${SRC}/bad.png)`);
    expect((await getMockedLogger()).mock.calls.length).toBeGreaterThan(0);
  });

  it("leaves ALL references at the source when every copy fails", async () => {
    readDirMock.mockResolvedValue([
      { name: "a.png", isFile: true },
      { name: "b.png", isFile: true },
    ]);
    writeFileMock.mockRejectedValue(new Error("disk full"));
    const content = `![a](.assets/${SRC}/a.png) ![b](.assets/${SRC}/b.png)`;

    const out = await duplicateNoteAssets("/notes", SRC, DST, content);

    // No copy landed, so no reference is rewritten — the duplicate resolves
    // against the still-present source assets rather than breaking immediately.
    expect(out).toBe(content);
  });

  it("ignores non-file directory entries", async () => {
    readDirMock.mockResolvedValue([
      { name: "nested", isFile: false },
      { name: "aaa.png", isFile: true },
    ]);
    await duplicateNoteAssets("/notes", SRC, DST, `![x](.assets/${SRC}/aaa.png)`);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith(`/notes/.assets/${DST}/aaa.png`, expect.any(Uint8Array));
  });

  it("REFUSES to copy for an unsafe source id and leaves content unchanged", async () => {
    const content = `![x](.assets/../aaa.png)`;
    const out = await duplicateNoteAssets("/notes", "..", DST, content);
    expect(out).toBe(content);
    expect(readDirMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect((await getMockedLogger()).mock.calls.length).toBeGreaterThan(0);
  });

  it("is a no-op when source and target ids are equal", async () => {
    const content = `![x](.assets/${SRC}/aaa.png)`;
    const out = await duplicateNoteAssets("/notes", SRC, SRC, content);
    expect(out).toBe(content);
    expect(readDirMock).not.toHaveBeenCalled();
  });
});
