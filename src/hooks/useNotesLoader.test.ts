import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "../utils/fs.test-utils";
import { createReconcileState, type ReconcileState } from "../utils/reconcileFolder";
import type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
import type { DecomposedState } from "../utils/decomposedState";

// Module-mock refs that survive hoist. The mocks below capture `refs` by
// reference and read its fields at call time, so beforeEach can swap the
// in-memory FS and the per-test "should reconcile throw?" flag without
// having to re-register mocks.
const refs = vi.hoisted(() => ({
  fs: null as InMemoryFileSystem | null,
  reconcileThrow: null as Error | null,
  decomposedDocs: [] as NoteDoc[],
  decomposedGroups: [] as NoteGroup[],
  decomposedTrashed: [] as TrashedNote[],
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/test-appdata"),
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

vi.mock("../utils/machineId", () => ({
  getMachineId: vi.fn(async () => "test-machine"),
  getMachineIdCached: vi.fn(() => "test-machine"),
}));

vi.mock("../utils/crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

vi.mock("./useUiState", () => ({
  loadUiState: vi.fn(async () => {}),
  getUiStateCached: vi.fn(() => ({ activeNoteId: null, groupCollapsed: new Map<string, boolean>() })),
  setActiveNoteIdPersisted: vi.fn(),
  setGroupCollapsedPersisted: vi.fn(),
}));

vi.mock("../utils/conflictFileDetector", () => ({
  ensureSharedDirs: vi.fn(async () => {}),
  retireLegacyManifest: vi.fn(async () => {}),
  scanAndAbsorbConflicts: vi.fn(async () => {}),
}));

vi.mock("../utils/migrateImageAssets", () => ({
  migrateDataUrlImagesToAssets: vi.fn(async () => ({ changedFiles: 0 })),
}));

// `decomposedState` is mocked partially: we keep the type-only exports and
// the persist-state helpers that the hook uses for its internal bundle, but
// stub out the disk-touching readers/writers so the test FS is in full control.
vi.mock("../utils/decomposedState", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../utils/decomposedState");
  return {
    ...actual,
    loadDecomposedState: vi.fn(async (): Promise<DecomposedState> => ({
      docs: refs.decomposedDocs,
      groups: refs.decomposedGroups,
      activeNoteId: null,
      trashedNotes: refs.decomposedTrashed,
    })),
    readLocalCache: vi.fn(async () => null),
    writeLocalCache: vi.fn(async () => {}),
    seedWriteSnapshots: vi.fn(async () => {}),
    persistDecomposedState: vi.fn(async () => {}),
    syncGroupsSnapshotFromDisk: vi.fn(async () => {}),
  };
});

// reconcileFolder is conditionally redirected: when refs.reconcileThrow is
// set, the mock throws; otherwise the real implementation runs against the
// in-memory FS so its real behavior still gets exercised. clearReconcileState
// is replaced with a spy wrapper so reload-time invocations are observable.
vi.mock("../utils/reconcileFolder", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../utils/reconcileFolder");
  return {
    ...actual,
    reconcileFolder: vi.fn(async (...args: Parameters<typeof actual.reconcileFolder>) => {
      if (refs.reconcileThrow) throw refs.reconcileThrow;
      return actual.reconcileFolder(...args);
    }),
    clearReconcileState: vi.fn((s: ReconcileState) => actual.clearReconcileState(s)),
  };
});

// Loader is imported AFTER all mocks. Tests then drive it with renderHook.
import { useNotesLoader, resetNotesDir } from "./useNotesLoader";
import * as reconcileFolderModule from "../utils/reconcileFolder";

const clearReconcileSpy = reconcileFolderModule.clearReconcileState as unknown as ReturnType<typeof vi.fn>;

function makeDoc(id: string): NoteDoc {
  return {
    id,
    filePath: `/test-appdata/notes/${id}.md`,
    fileName: `Note ${id}`,
    isDirty: false,
    content: "",
    createdAt: 1000,
    updatedAt: 1000,
  };
}

beforeEach(() => {
  refs.fs = createInMemoryFileSystem();
  refs.fs.seedDir("/test-appdata");
  refs.fs.seedDir("/test-appdata/notes");
  refs.reconcileThrow = null;
  refs.decomposedDocs = [];
  refs.decomposedGroups = [];
  refs.decomposedTrashed = [];
  // Reset the hook's module-level dir cache so each test starts clean.
  resetNotesDir();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useNotesLoader — outer catch preserves already-loaded docs (bug 3 regression)", () => {
  it("keeps the docs loaded by loadDecomposedState when reconcileFolder throws", async () => {
    // Seed 5 docs into both the test FS and the loadDecomposedState mock so
    // attachDocContents finds bodies and the loader reaches the reconcile step
    // with a fully-populated docs array.
    const seeded: NoteDoc[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = `id-${i}`;
      const doc = makeDoc(id);
      refs.fs!.seedTextFile(doc.filePath, `body-${i}`);
      seeded.push(doc);
    }
    refs.decomposedDocs = seeded;
    refs.reconcileThrow = new Error("reconcile blew up");

    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    // Pre-fix behavior would have replaced everything with a single blank stub
    // ("local" id, empty filePath). The fix preserves the safeDocs snapshot.
    expect(result.current.docs).toHaveLength(5);
    expect(result.current.docs.map((d) => d.id).sort()).toEqual(seeded.map((d) => d.id).sort());
    // None of the preserved docs should be the synthetic stub.
    expect(result.current.docs.some((d) => d.id === "local")).toBe(false);
  });

  it("falls back to the synthetic stub only when no docs were ever loaded", async () => {
    // No seeded docs, then force a throw before any checkpoint is reached.
    refs.decomposedDocs = [];
    refs.reconcileThrow = new Error("reconcile blew up");

    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    expect(result.current.docs).toHaveLength(1);
    expect(result.current.docs[0].id).toBe("local");
    expect(result.current.docs[0].filePath).toBe("");
  });
});

describe("useNotesLoader — reload clears reconcile state (bug 4 regression)", () => {
  it("invokes clearReconcileState on the injected state when reloadKey bumps", async () => {
    const externalState: ReconcileState = createReconcileState();
    externalState.bodyMissing.set("ghost-a", 1);

    const { rerender, result } = renderHook(
      ({ reloadKey }) => useNotesLoader("en", "updated-desc", true, reloadKey, externalState),
      { initialProps: { reloadKey: 0 } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    // Baseline: the reload-clear path must not have run yet. Reconcile's own
    // internal cleanup may have already drained the map, so we can't assert
    // counter survival — but we can assert the dedicated clearReconcileState
    // call wasn't issued by the reload effect.
    expect(clearReconcileSpy).not.toHaveBeenCalled();

    act(() => {
      rerender({ reloadKey: 1 });
    });

    // The reload effect must call clearReconcileState exactly once, with the
    // exact state instance the caller passed in. Without the fix, only
    // resetWriteSnapshots fires and this spy is never called.
    expect(clearReconcileSpy).toHaveBeenCalledTimes(1);
    expect(clearReconcileSpy).toHaveBeenCalledWith(externalState);
  });
});
