import { describe, it, expect, beforeEach, vi } from "vitest";
import { createInMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults } from "./fs.fault.test-utils";
import type { TrashedNote } from "./noteTypes";

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

vi.mock("./imageAssetUtils", () => ({
  removeNoteAssetDir: vi.fn(async () => {}),
}));

import { purgeTrashedNoteFiles } from "./trashPurge";
import { logNotenError } from "./crashLog";
import { removeNoteAssetDir } from "./imageAssetUtils";

const logMock = logNotenError as ReturnType<typeof vi.fn>;
const removeAssetsMock = removeNoteAssetDir as ReturnType<typeof vi.fn>;

const NOTES = "/notes";
const BODY = "/notes/.trash/t1.md";
const META = "/notes/.meta/t1.json";

const trashed: TrashedNote = {
  id: "t1",
  fileName: "Note",
  originalFilePath: "/notes/t1.md",
  trashFilePath: BODY,
  trashedAt: 2000,
  groupId: null,
  createdAt: 1000,
  updatedAt: 1500,
};

function setup() {
  const fs = wrapWithFaults(createInMemoryFileSystem());
  fs.seedDir(NOTES);
  fs.seedDir("/notes/.trash");
  fs.seedDir("/notes/.meta");
  fs.seedTextFile(BODY, "body");
  fs.seedTextFile(META, "{}");
  return fs;
}

describe("purgeTrashedNoteFiles", () => {
  beforeEach(() => {
    logMock.mockClear();
    removeAssetsMock.mockClear();
  });

  it("removes the body, assets and sidecar", async () => {
    const fs = setup();
    expect(await purgeTrashedNoteFiles(fs, NOTES, trashed)).toBe(true);
    expect(await fs.exists(BODY)).toBe(false);
    expect(await fs.exists(META)).toBe(false);
    expect(removeAssetsMock).toHaveBeenCalledWith(NOTES, "t1");
  });

  // A cloud sync client or another process holding the body makes remove()
  // throw. Dropping the sidecar anyway left the body in .trash with nothing
  // listing it and nothing ever deleting it.
  it("keeps the sidecar and assets when the body cannot be removed", async () => {
    const fs = setup();
    fs.injectFault({ op: "remove", path: BODY, throwError: new Error("os error 32") });

    expect(await purgeTrashedNoteFiles(fs, NOTES, trashed)).toBe(false);
    expect(await fs.exists(BODY)).toBe(true);
    expect(await fs.exists(META)).toBe(true);
    expect(removeAssetsMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ code: "TRASH_PURGE_FAILED" }));
  });

  it("treats a body that is already gone as purged", async () => {
    const fs = setup();
    await fs.remove(BODY);

    expect(await purgeTrashedNoteFiles(fs, NOTES, trashed)).toBe(true);
    expect(await fs.exists(META)).toBe(false);
    expect(logMock).not.toHaveBeenCalled();
  });

  it("fails closed when the existence check itself fails", async () => {
    const fs = setup();
    fs.injectFault({ op: "remove", path: BODY, throwError: new Error("network") });
    fs.injectFault({ op: "exists", path: BODY, throwError: new Error("network") });

    expect(await purgeTrashedNoteFiles(fs, NOTES, trashed)).toBe(false);
    expect(fs.callCount("remove", META)).toBe(0);
  });

  it("still removes the body when the notes dir is unknown", async () => {
    const fs = setup();
    expect(await purgeTrashedNoteFiles(fs, null, trashed)).toBe(true);
    expect(await fs.exists(BODY)).toBe(false);
    expect(removeAssetsMock).not.toHaveBeenCalled();
  });
});
