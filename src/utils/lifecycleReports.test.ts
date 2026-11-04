import { describe, it, expect, vi, beforeEach } from "vitest";

const refs = vi.hoisted(() => ({
  docs: [] as { id: string }[],
  trashedNotes: [] as { id: string }[],
  logged: vi.fn(async () => {}),
}));

vi.mock("./crashLog", () => ({ logNotenError: refs.logged }));
vi.mock("./libraryStore", () => ({
  libraryStore: { getSnapshot: () => ({ docs: refs.docs, trashedNotes: refs.trashedNotes }) },
}));

import { reportNoteNotRestored, reportNotesNotDeleted, reportNotesNotPurged } from "./lifecycleReports";

const reported = () => refs.logged.mock.calls.map(([error]: unknown[]) => {
  const { code, severity, context } = error as { code: string; severity: string; context: unknown };
  return { code, severity, context };
});

beforeEach(() => {
  refs.docs = [];
  refs.trashedNotes = [];
  refs.logged.mockClear();
});

describe("reportNotesNotDeleted", () => {
  it("names the notes still live", () => {
    refs.docs = [{ id: "kept" }];

    reportNotesNotDeleted(["gone", "kept"], ["gone"]);

    expect(reported()).toEqual([{ code: "DELETE_FAILED", severity: "fatal", context: { noteIds: ["kept"] } }]);
  });

  it("says nothing when every note went", () => {
    reportNotesNotDeleted(["a", "b"], ["a", "b"]);

    expect(reported()).toEqual([]);
  });

  it("does not blame a delete for a note another window already removed", () => {
    reportNotesNotDeleted(["a"], []);

    expect(reported()).toEqual([]);
  });
});

describe("reportNotesNotPurged", () => {
  it("names the notes still in the trash", () => {
    refs.trashedNotes = [{ id: "locked" }];

    reportNotesNotPurged(["purged", "locked"]);

    expect(reported()).toEqual([{ code: "TRASH_PURGE_FAILED", severity: "fatal", context: { noteIds: ["locked"] } }]);
  });

  it("ignores a note trashed since the purge began", () => {
    refs.trashedNotes = [{ id: "new" }];

    reportNotesNotPurged(["purged"]);

    expect(reported()).toEqual([]);
  });
});

describe("reportNoteNotRestored", () => {
  it("reports a note still in the trash, and not one that left it", () => {
    refs.trashedNotes = [{ id: "a" }];

    reportNoteNotRestored("b");
    expect(reported()).toEqual([]);

    reportNoteNotRestored("a");
    expect(reported()).toEqual([{ code: "RESTORE_FAILED", severity: "fatal", context: { noteId: "a" } }]);
  });
});
