import { describe, it, expect, beforeEach, vi } from "vitest";

const removeMock = vi.fn(async (_path: string, _opts?: { recursive?: boolean }) => {});

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => {}),
  remove: (path: string, opts?: { recursive?: boolean }) => removeMock(path, opts),
}));

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

import { removeNoteAssetDir } from "./imageAssetUtils";

async function getMockedLogger() {
  const { logNotenError } = await import("./crashLog");
  return logNotenError as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(async () => {
  removeMock.mockClear();
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
