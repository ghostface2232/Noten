import { describe, it, expect, beforeEach, vi } from "vitest";

const refs = vi.hoisted(() => ({
  bodyByPath: new Map<string, string>(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  readTextFile: vi.fn(async (p: string) => refs.bodyByPath.get(p) ?? ""),
  // Binary asset writes — always succeed in these tests.
  writeFile: vi.fn(async () => {}),
}));

const fsMock = vi.hoisted(() => ({
  writeTextFile: vi.fn(async (_p: string, _c: string) => {}),
  rename: vi.fn(async (_from: string, _to: string) => {}),
  remove: vi.fn(async (_p: string) => {}),
}));

vi.mock("./fs", () => ({ tauriFileSystem: fsMock }));

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

import { migrateDataUrlImagesToAssets } from "./migrateImageAssets";

const NOTE = "/notes/abc.md";
const BODY = `# note\n\n![pic](data:image/png;base64,AAAA)\n`;

beforeEach(() => {
  refs.bodyByPath = new Map();
  fsMock.writeTextFile.mockClear();
  fsMock.writeTextFile.mockImplementation(async () => {});
  fsMock.rename.mockClear();
  fsMock.rename.mockImplementation(async () => {});
  fsMock.remove.mockClear();
});

describe("migrateDataUrlImagesToAssets — atomic body rewrite", () => {
  it("converts a base64 image and writes the body atomically (tmp + rename)", async () => {
    refs.bodyByPath.set(NOTE, BODY);

    const result = await migrateDataUrlImagesToAssets([NOTE]);

    expect(result.changedFiles).toBe(1);
    expect(result.convertedImages).toBe(1);
    // Atomic: the rewritten body goes to `${path}.tmp` first, then a rename —
    // never a direct overwrite of the live note.
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      `${NOTE}.tmp`,
      expect.stringContaining(".assets/abc/"),
    );
    expect(fsMock.rename).toHaveBeenCalledWith(`${NOTE}.tmp`, NOTE);
    // No direct write to the live path.
    const directWrites = fsMock.writeTextFile.mock.calls.filter((c) => c[0] === NOTE);
    expect(directWrites).toHaveLength(0);
  });

  it("does NOT truncate the note when the write fails (fail-closed, skipped)", async () => {
    refs.bodyByPath.set(NOTE, BODY);
    // Simulate an AV/OneDrive lock on the tmp write.
    fsMock.writeTextFile.mockRejectedValueOnce(new Error("EACCES"));

    const result = await migrateDataUrlImagesToAssets([NOTE]);

    // The file is skipped, not counted, and never retried this pass.
    expect(result.changedFiles).toBe(0);
    expect(result.convertedImages).toBe(0);
    // Fail-closed means no degraded direct overwrite of the live note, and no
    // rename off a tmp that never landed — the original body stays intact.
    const directWrites = fsMock.writeTextFile.mock.calls.filter((c) => c[0] === NOTE);
    expect(directWrites).toHaveLength(0);
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it("leaves notes without data URLs untouched", async () => {
    refs.bodyByPath.set(NOTE, "# plain note, no images\n");

    const result = await migrateDataUrlImagesToAssets([NOTE]);

    expect(result.changedFiles).toBe(0);
    expect(fsMock.writeTextFile).not.toHaveBeenCalled();
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it("continues past a failed note and still migrates the next one", async () => {
    refs.bodyByPath.set("/notes/aaa.md", BODY);
    refs.bodyByPath.set("/notes/bbb.md", BODY);
    // First note's tmp write fails; second succeeds.
    fsMock.writeTextFile.mockRejectedValueOnce(new Error("locked"));

    const result = await migrateDataUrlImagesToAssets(["/notes/aaa.md", "/notes/bbb.md"]);

    expect(result.changedFiles).toBe(1);
    expect(fsMock.rename).toHaveBeenCalledWith("/notes/bbb.md.tmp", "/notes/bbb.md");
  });
});
