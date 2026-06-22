import { describe, it, expect, beforeEach, vi } from "vitest";

const refs = vi.hoisted(() => ({
  windowLabels: ["main"] as string[],
  enumerateThrows: false,
  oldDirExists: true,
  journal: null as unknown,
  migrateResult: { success: true } as { success: boolean; error?: string },
  clearManagedResult: { success: true } as { success: boolean; error?: string },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => {
    if (refs.enumerateThrows) throw new Error("enumeration failed");
    return refs.windowLabels.map((label) => ({ label }));
  }),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async () => refs.oldDirExists),
}));

vi.mock("./migrateNotesDir", () => ({
  migrateNotesDir: vi.fn(async () => refs.migrateResult),
  clearManagedNotesData: vi.fn(async () => refs.clearManagedResult),
}));

vi.mock("./migrationJournal", () => ({
  readMigrationJournal: vi.fn(async () => refs.journal),
  clearMigrationJournal: vi.fn(async () => {}),
}));

import { runDeferredCleanup, recoverPendingMigration } from "./migrationCleanup";
import { migrateNotesDir, clearManagedNotesData } from "./migrateNotesDir";
import { clearMigrationJournal } from "./migrationJournal";

const migrateMock = migrateNotesDir as unknown as ReturnType<typeof vi.fn>;
const clearManagedMock = clearManagedNotesData as unknown as ReturnType<typeof vi.fn>;
const clearJournalMock = clearMigrationJournal as unknown as ReturnType<typeof vi.fn>;

const mergeJournal = {
  migrationId: "m1", oldDir: "/old", newDir: "/new", cleanupMode: "merge" as const, startedAt: 1000,
};
const backupJournal = {
  migrationId: "m2", oldDir: "/old", newDir: "/new", cleanupMode: "backup-only" as const, startedAt: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  refs.windowLabels = ["main"];
  refs.enumerateThrows = false;
  refs.oldDirExists = true;
  refs.journal = null;
  refs.migrateResult = { success: true };
  refs.clearManagedResult = { success: true };
});

describe("runDeferredCleanup", () => {
  it("defers (no destructive call) when more than one window is open", async () => {
    refs.windowLabels = ["main", "second"];
    const done = await runDeferredCleanup(mergeJournal);
    expect(done).toBe(false);
    expect(migrateMock).not.toHaveBeenCalled();
    expect(clearManagedMock).not.toHaveBeenCalled();
    expect(clearJournalMock).not.toHaveBeenCalled();
  });

  it("defers when window enumeration fails", async () => {
    refs.enumerateThrows = true;
    const done = await runDeferredCleanup(mergeJournal);
    expect(done).toBe(false);
    expect(migrateMock).not.toHaveBeenCalled();
    expect(clearJournalMock).not.toHaveBeenCalled();
  });

  it("clears the journal without merging when the old dir is already gone", async () => {
    refs.oldDirExists = false;
    const done = await runDeferredCleanup(mergeJournal);
    expect(done).toBe(true);
    expect(migrateMock).not.toHaveBeenCalled();
    expect(clearManagedMock).not.toHaveBeenCalled();
    expect(clearJournalMock).toHaveBeenCalledTimes(1);
  });

  it("merge mode: final newer-wins merge then clears the journal", async () => {
    const done = await runDeferredCleanup(mergeJournal);
    expect(done).toBe(true);
    expect(migrateMock).toHaveBeenCalledWith("/old", "/new", "merge", { clearSource: true });
    expect(clearManagedMock).not.toHaveBeenCalled();
    expect(clearJournalMock).toHaveBeenCalledTimes(1);
  });

  it("merge mode: keeps the journal when the final merge fails", async () => {
    refs.migrateResult = { success: false, error: "read error" };
    const done = await runDeferredCleanup(mergeJournal);
    expect(done).toBe(false);
    expect(migrateMock).toHaveBeenCalled();
    expect(clearJournalMock).not.toHaveBeenCalled();
  });

  it("backup-only mode: deletes managed data without merging, then clears journal", async () => {
    const done = await runDeferredCleanup(backupJournal);
    expect(done).toBe(true);
    expect(clearManagedMock).toHaveBeenCalledWith("/old", "/new");
    expect(migrateMock).not.toHaveBeenCalled();
    expect(clearJournalMock).toHaveBeenCalledTimes(1);
  });

  it("backup-only mode: keeps the journal when deletion fails", async () => {
    refs.clearManagedResult = { success: false, error: "locked" };
    const done = await runDeferredCleanup(backupJournal);
    expect(done).toBe(false);
    expect(clearJournalMock).not.toHaveBeenCalled();
  });
});

describe("recoverPendingMigration", () => {
  it("does nothing when there is no journal", async () => {
    refs.journal = null;
    await recoverPendingMigration();
    expect(migrateMock).not.toHaveBeenCalled();
    expect(clearManagedMock).not.toHaveBeenCalled();
  });

  it("runs the pending cleanup when a journal exists", async () => {
    refs.journal = mergeJournal;
    await recoverPendingMigration();
    expect(migrateMock).toHaveBeenCalledWith("/old", "/new", "merge", { clearSource: true });
    expect(clearJournalMock).toHaveBeenCalledTimes(1);
  });
});
