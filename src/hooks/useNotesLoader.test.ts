import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "../utils/fs.test-utils";
import { createReconcileState, type ReconcileState } from "../utils/reconcileFolder";
import type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
import type { DecomposedState, LocalCache } from "../utils/decomposedState";

// Module-mock refs that survive hoist. The mocks below capture `refs` by
// reference and read its fields at call time, so beforeEach can swap the
// in-memory FS and the per-test "should reconcile throw?" flag without
// having to re-register mocks.
const refs = vi.hoisted(() => ({
  fs: null as InMemoryFileSystem | null,
  readFaultByPath: new Map<string, Error>(),
  reconcileThrow: null as Error | null,
  decomposedDocs: [] as NoteDoc[],
  decomposedGroups: [] as NoteGroup[],
  decomposedTrashed: [] as TrashedNote[],
  localCache: null as LocalCache | null,
  writtenLocalCache: null as LocalCache | null,
  reconcileGate: null as Promise<void> | null,
  writeGate: null as Promise<void> | null,
  onWriteStart: null as ((path: string) => void) | null,
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
    readTextFile: (p: string) => {
      const fault = refs.readFaultByPath.get(p);
      if (fault) throw fault;
      return get().readTextFile(p);
    },
    writeTextFile: async (p: string, c: string) => {
      refs.onWriteStart?.(p);
      if (refs.writeGate) await refs.writeGate;
      return get().writeTextFile(p, c);
    },
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

// useAutoSave (rendered alongside the loader in the re-sort regression below)
// pulls in useWindowSync's cross-window event plumbing; stub the Tauri side.
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

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
    readLocalCache: vi.fn(async () => refs.localCache),
    writeLocalCache: vi.fn(async (_fs: unknown, _path: string, cache: LocalCache) => {
      refs.writtenLocalCache = cache;
    }),
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
      const gate = refs.reconcileGate;
      if (gate) {
        const capturedDocs = args[3];
        const capturedGroups = args[4];
        await gate;
        return { docs: capturedDocs, groups: capturedGroups, changed: false };
      }
      if (refs.reconcileThrow) throw refs.reconcileThrow;
      return actual.reconcileFolder(...args);
    }),
    clearReconcileState: vi.fn((s: ReconcileState) => actual.clearReconcileState(s)),
  };
});

// Loader is imported AFTER all mocks. Tests then drive it with renderHook.
import { useNotesLoader, resetNotesDir, restoreNotesDir, setNotesDir, getDefaultNotesDir, saveManifest, saveNoteMetadata, flushPersistence, runPersistenceTransaction, markGroupAsDeleted, markGroupMembershipChanged, markNotesPinnedChanged, purgeExpiredTrash } from "./useNotesLoader";
import * as reconcileFolderModule from "../utils/reconcileFolder";
import * as decomposedStateModule from "../utils/decomposedState";
import * as crashLogModule from "../utils/crashLog";
import { readMeta, writeMeta, type NoteMeta } from "../utils/metadataIO";
import { libraryStore } from "../utils/libraryStore";
import { useAutoSave } from "./useAutoSave";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";

const clearReconcileSpy = reconcileFolderModule.clearReconcileState as unknown as ReturnType<typeof vi.fn>;
const persistMock = decomposedStateModule.persistDecomposedState as ReturnType<typeof vi.fn>;
const logNotenErrorMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;

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
  refs.readFaultByPath = new Map();
  refs.reconcileThrow = null;
  refs.decomposedDocs = [];
  refs.decomposedGroups = [];
  refs.decomposedTrashed = [];
  refs.localCache = null;
  refs.writtenLocalCache = null;
  refs.reconcileGate = null;
  refs.writeGate = null;
  refs.onWriteStart = null;
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
    // (empty filePath). The fix preserves the safeDocs snapshot.
    expect(result.current.docs).toHaveLength(5);
    expect(result.current.docs.map((d) => d.id).sort()).toEqual(seeded.map((d) => d.id).sort());
    // None of the preserved docs should be the synthetic stub.
    expect(result.current.docs.some((d) => d.filePath === "")).toBe(false);
  });

  it("falls back to the synthetic stub only when no docs were ever loaded", async () => {
    // No seeded docs, then force a throw before any checkpoint is reached.
    refs.decomposedDocs = [];
    refs.reconcileThrow = new Error("reconcile blew up");

    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    expect(result.current.docs).toHaveLength(1);
    expect(result.current.docs[0].filePath).toBe("");
    expect(result.current.docs[0].content).toBe("");
  });
});

describe("useNotesLoader — all body reads fail closed", () => {
  it("does not create a new blank note when persisted docs exist but every body read fails", async () => {
    const doc = makeDoc("id-0");
    refs.fs!.seedTextFile(doc.filePath, "real body");
    refs.decomposedDocs = [doc];
    refs.readFaultByPath.set(doc.filePath, new Error("EBUSY: cloud hydration"));

    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    expect(result.current.docs).toHaveLength(1);
    expect(result.current.docs[0].filePath).toBe("");

    const rootMarkdownFiles = Array.from(refs.fs!.snapshot().keys())
      .filter((path) => path.startsWith("/test-appdata/notes/") && path.endsWith(".md"));
    expect(rootMarkdownFiles).toEqual([doc.filePath]);
    expect(await refs.fs!.readTextFile(doc.filePath)).toBe("real body");
  });
});

describe("useNotesLoader — reload clears reconcile state (bug 4 regression)", () => {
  it("invokes clearReconcileState on the injected state when reloadKey bumps", async () => {
    const externalState: ReconcileState = createReconcileState();
    externalState.bodyMissing.set("ghost-a", { firstSeenAt: Date.now(), passes: 1 });

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

describe("useNotesLoader — canonical library store adapter", () => {
  it("seeds the loaded library and routes every public state setter through revisions", async () => {
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    const loaded = libraryStore.getSnapshot();
    expect(loaded.notesDirectory).toBe("/test-appdata/notes");
    expect(loaded.docs.map((doc) => doc.id)).toEqual(["a"]);
    expect(loaded.activeNoteId).toBe("a");
    const loadedRevision = loaded.revision;
    const b = makeDoc("b");
    const trashed: TrashedNote = {
      id: "trash",
      fileName: "Trash",
      originalFilePath: "/test-appdata/notes/trash.md",
      trashFilePath: "/test-appdata/notes/.trash/trash.md",
      trashedAt: 5000,
      groupId: null,
      createdAt: 1,
      updatedAt: 1,
    };

    act(() => {
      result.current.setDocs((prev) => [...prev, b]);
      result.current.setGroups([{
        id: "g",
        name: "Group",
        noteIds: ["b"],
        collapsed: false,
        createdAt: 1,
      }]);
      result.current.setTrashedNotes([trashed]);
      result.current.setActiveIndex(1);
    });

    expect(libraryStore.getSnapshot()).toMatchObject({
      revision: loadedRevision + 4,
      activeNoteId: "b",
    });
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id)).toEqual(["a", "b"]);
    expect(libraryStore.getSnapshot().groups[0].noteIds).toEqual(["b"]);
    expect(libraryStore.getSnapshot().trashedNotes.map((note) => note.id)).toEqual(["trash"]);
    expect(result.current.activeIndex).toBe(1);
  });

  it("does not create a revision when a functional setter returns its previous value", async () => {
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    const before = libraryStore.getSnapshot();

    act(() => result.current.setDocs((prev) => prev));

    expect(libraryStore.getSnapshot()).toBe(before);
  });

  it("commits a generation-bound whole-library transition in one revision", async () => {
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    const before = libraryStore.getSnapshot();
    const trashed: TrashedNote = {
      id: "a",
      fileName: "Note a",
      originalFilePath: a.filePath,
      trashFilePath: "/test-appdata/notes/.trash/a.md",
      trashedAt: 5000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1000,
    };

    act(() => {
      result.current.commitLibraryForGeneration(before.directoryGeneration, () => ({
        docs: [],
        groups: [],
        trashedNotes: [trashed],
        activeNoteId: null,
      }));
    });

    expect(libraryStore.getSnapshot().revision).toBe(before.revision + 1);
    expect(result.current.docs).toEqual([]);
    expect(result.current.groups).toEqual([]);
    expect(result.current.trashedNotes.map((entry) => entry.id)).toEqual(["a"]);
    expect(result.current.activeIndex).toBe(0);
  });

  it("keeps active identity by id across a docs-only commit and commits docs+active atomically", async () => {
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    const b = makeDoc("b");
    const c = makeDoc("c");
    act(() => {
      result.current.setDocs([a, b, c]);
      result.current.setActiveIndex(2);
    });

    // Removing a doc before the active one needs no index bookkeeping.
    act(() => result.current.setDocs((prev) => prev.filter((doc) => doc.id !== "a")));
    expect(result.current.docs.map((doc) => doc.id)).toEqual(["b", "c"]);
    expect(result.current.activeIndex).toBe(1);
    expect(libraryStore.getSnapshot().activeNoteId).toBe("c");

    // Removing the active doc and handing off happens in one revision.
    const before = libraryStore.getSnapshot().revision;
    act(() => {
      result.current.commitLibraryFromRemote((current) => ({
        docs: current.docs.filter((doc) => doc.id !== "c"),
        activeNoteId: "b",
      }));
    });
    expect(libraryStore.getSnapshot().revision).toBe(before + 1);
    expect(libraryStore.getSnapshot()).toMatchObject({ activeNoteId: "b", origin: "remote" });
    expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]);
    expect(result.current.activeIndex).toBe(0);
    // A no-op updater reports null and leaves the revision alone.
    let committed: unknown = "unset";
    act(() => { committed = result.current.commitLibraryFromRemote(() => null); });
    expect(committed).toBeNull();
    expect(libraryStore.getSnapshot().revision).toBe(before + 1);
  });

  it("records window-sync and watcher mutations with their real origins", async () => {
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    act(() => result.current.commitLibraryFromRemote((current) => ({
      docs: [...current.docs, makeDoc("remote")],
    })));
    expect(libraryStore.getSnapshot().origin).toBe("remote");

    act(() => result.current.setGroupsFromReconcile([{
      id: "g",
      name: "Reconciled",
      noteIds: ["remote"],
      collapsed: false,
      createdAt: 1,
    }]));
    expect(libraryStore.getSnapshot().origin).toBe("reconcile");
  });

  it("rejects a late loader result from the previous hydration generation", async () => {
    let releaseOld!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result, rerender } = renderHook(
      ({ reloadKey }) => useNotesLoader("en", "updated-desc", true, reloadKey),
      { initialProps: { reloadKey: 0 } },
    );
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));

    const b = makeDoc("b");
    refs.fs!.seedTextFile(b.filePath, "body-b");
    await refs.fs!.remove(a.filePath);
    refs.decomposedDocs = [b];
    refs.reconcileGate = null;
    act(() => rerender({ reloadKey: 1 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id)).toEqual(["b"]);
    const currentGeneration = libraryStore.getSnapshot().directoryGeneration;

    await act(async () => {
      releaseOld();
      await Promise.resolve();
    });

    expect(libraryStore.getSnapshot().directoryGeneration).toBe(currentGeneration);
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id)).toEqual(["b"]);
  });

  it("rebases final hydration onto remote state committed in the same generation", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));
    const generation = libraryStore.getSnapshot().directoryGeneration;
    const remote = { ...makeDoc("remote"), content: "peer body" };

    // A peer created a note and pushed a body for "a" newer than our disk read
    // while we loaded (no cache projection here, so "a" arrives via the peer).
    act(() => result.current.commitLibraryFromRemote((current) => ({
      docs: [
        ...current.docs,
        { ...a, content: "peer-a", updatedAt: a.updatedAt + 5000 },
        remote,
      ],
    })));
    expect(libraryStore.getSnapshot()).toMatchObject({ origin: "remote", directoryGeneration: generation });

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    // Hydration still lands (the store must not be left at the projection),
    // the peer-created note survives, and the peer's newer body wins.
    const snapshot = libraryStore.getSnapshot();
    expect(snapshot.origin).toBe("hydrate");
    expect(snapshot.directoryGeneration).toBe(generation);
    expect(snapshot.docs.map((doc) => doc.id).sort()).toEqual(["a", "remote"]);
    expect(snapshot.docs.find((doc) => doc.id === "a")?.content).toBe("peer-a");
    expect(snapshot.docs.find((doc) => doc.id === "remote")?.content).toBe("peer body");
    expect(result.current.docs.map((doc) => doc.id).sort()).toEqual(["a", "remote"]);
  });

  it("keeps the trash entry a peer created while the disk read was in flight", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    const b = makeDoc("b");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.fs!.seedTextFile(b.filePath, "body-b");
    refs.decomposedDocs = [a, b];
    refs.decomposedTrashed = [];
    refs.localCache = {
      version: 2,
      notesDirectory: "/test-appdata/notes",
      notes: [a, b].map(({ id, filePath, fileName, createdAt, updatedAt }) => ({
        id, filePath, fileName, createdAt, updatedAt,
      })),
    };
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));

    // A peer trashed "a": doc-deleted removes the live doc, trash-updated adds
    // the entry. Our disk read predates both and still reports an empty trash.
    act(() => result.current.commitLibraryFromRemote((current) => ({
      docs: current.docs.filter((doc) => doc.id !== "a"),
      trashedNotes: [{
        id: "a",
        fileName: "Note a",
        originalFilePath: a.filePath,
        trashFilePath: "/test-appdata/notes/.trash/a.md",
        trashedAt: 7000,
        groupId: null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }],
      activeNoteId: "b",
    })));

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    // Pre-fix the doc stayed deleted but the stale empty trash won, so the note
    // existed neither in the library nor in Recently Deleted.
    const snapshot = libraryStore.getSnapshot();
    expect(snapshot.docs.map((doc) => doc.id)).toEqual(["b"]);
    expect(snapshot.trashedNotes.map((note) => note.id)).toEqual(["a"]);
    expect(result.current.trashedNotes.map((note) => note.id)).toEqual(["a"]);
  });

  it("does not resurrect a trash entry a peer restored while the disk read was in flight", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const trashed = {
      id: "t1",
      fileName: "Note t1",
      originalFilePath: "/test-appdata/notes/t1.md",
      trashFilePath: "/test-appdata/notes/.trash/t1.md",
      // Recent enough that purgeExpiredTrash keeps it.
      trashedAt: Date.now(),
      groupId: null,
      createdAt: 1000,
      updatedAt: 1000,
    };
    // The disk read still sees the tombstone the peer is about to clear.
    refs.decomposedTrashed = [trashed];
    refs.localCache = {
      version: 2,
      notesDirectory: "/test-appdata/notes",
      notes: [{ id: a.id, filePath: a.filePath, fileName: a.fileName, createdAt: a.createdAt, updatedAt: a.updatedAt }],
      trashedNotes: [trashed],
    };
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));
    expect(libraryStore.getSnapshot().trashedNotes.map((note) => note.id)).toEqual(["t1"]);

    act(() => result.current.commitLibraryFromRemote((current) => ({
      trashedNotes: current.trashedNotes.filter((note) => note.id !== "t1"),
    })));

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    expect(libraryStore.getSnapshot().trashedNotes).toEqual([]);
  });

  it("keeps a group change a peer committed while the disk read was in flight", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    refs.decomposedGroups = [{ id: "g1", name: "Disk name", noteIds: ["a"], collapsed: false, createdAt: 1 }];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));

    // groups-updated from a peer that renamed g1 and added g2.
    act(() => result.current.commitLibraryFromRemote(() => ({
      groups: [
        { id: "g1", name: "Peer name", noteIds: ["a"], collapsed: false, createdAt: 1 },
        { id: "g2", name: "Peer group", noteIds: [], collapsed: false, createdAt: 2 },
      ],
    })));

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    // Pre-fix the stale disk groups overwrote both changes.
    const snapshot = libraryStore.getSnapshot();
    expect(snapshot.groups.map((group) => ({ id: group.id, name: group.name }))).toEqual([
      { id: "g1", name: "Peer name" },
      { id: "g2", name: "Peer group" },
    ]);
  });

  it("keeps a note a peer deleted between reconcile and the final commit deleted", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    const b = makeDoc("b");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.fs!.seedTextFile(b.filePath, "body-b");
    refs.decomposedDocs = [a, b];
    // The cache projection puts both ids in the store before the disk read
    // finishes, so the deletion has something to remove.
    refs.localCache = {
      version: 2,
      notesDirectory: "/test-appdata/notes",
      notes: [a, b].map(({ id, filePath, fileName, createdAt, updatedAt }) => ({
        id, filePath, fileName, createdAt, updatedAt,
      })),
    };
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id).sort()).toEqual(["a", "b"]);

    // useWindowSync's doc-deleted handler for a peer's delete of "a". The
    // loader already holds a disk result that still contains it.
    act(() => result.current.commitLibraryFromRemote((current) => ({
      docs: current.docs.filter((doc) => doc.id !== "a"),
      activeNoteId: "b",
    })));

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    // Pre-fix the stale hydration resurrected "a" because merge could not tell
    // "deleted by a peer" from "not projected yet".
    const snapshot = libraryStore.getSnapshot();
    expect(snapshot.docs.map((doc) => doc.id)).toEqual(["b"]);
    expect(snapshot.docs[0].content).toBe("body-b");
    expect(result.current.docs.map((doc) => doc.id)).toEqual(["b"]);
  });

  it("keeps a body a peer cleared between reconcile and the final commit empty", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    refs.localCache = {
      version: 2,
      notesDirectory: "/test-appdata/notes",
      notes: [{
        id: a.id,
        filePath: a.filePath,
        fileName: a.fileName,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }],
    };
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));
    // The projection is in the store, bodies still blank.
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.content)).toEqual([""]);

    // The peer selected all and deleted: an empty body is a legitimate newer
    // state, not the projection placeholder it happens to look like.
    act(() => result.current.commitLibraryFromRemote((current) => ({
      docs: current.docs.map((doc) => (
        doc.id === "a" ? { ...doc, content: "", updatedAt: doc.updatedAt + 5000 } : doc
      )),
    })));

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    const snapshot = libraryStore.getSnapshot();
    expect(snapshot.docs.map((doc) => doc.id)).toEqual(["a"]);
    // Pre-fix the disk read's stale "body-a" won back.
    expect(snapshot.docs[0].content).toBe("");
    expect(snapshot.docs[0].updatedAt).toBe(a.updatedAt + 5000);
  });

  it("does not persist or flush the cache projection while hydration is in flight", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));
    const persistCallsBefore = persistMock.mock.calls.length;

    // A close-time flush (or a peer migration barrier) mid-hydration must not
    // rewrite sidecars from the projection, and must not hang on the load.
    await act(async () => {
      await flushPersistence("close");
    });
    expect(persistMock.mock.calls.length).toBe(persistCallsBefore);

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    act(() => result.current.setDocs((prev) => prev.map((doc) => ({ ...doc, pinned: true }))));
    await act(async () => {
      await flushPersistence("after-load");
    });
    expect(persistMock.mock.calls.length).toBeGreaterThan(persistCallsBefore);
  });

  it("parks a lifecycle transaction requested mid-hydration until the load settles", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));

    // The sidebar already shows cached notes here; a delete/restore must not
    // be dropped as "invalidated" just because the loader holds the guard.
    let executedAgainst: string[] | null = null;
    const transaction = runPersistenceTransaction("mid-load", ["a"], async ({ snapshot }) => {
      executedAgainst = snapshot.docs.map((doc) => `${doc.id}:${doc.content}`);
      return true;
    }, () => libraryStore.getSnapshot());
    // Drain the microtask queue and a macrotask: the chain job has had every
    // chance to run and must still be parked behind the gated reconcile.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executedAgainst).toBeNull();

    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    const outcome = await transaction;
    expect(outcome.status).toBe("committed");
    // It ran against the hydrated library, not the pre-load projection.
    expect(executedAgainst).toEqual(["a:body-a"]);
  });

  it("restarts a load torn down mid-flight instead of leaving isLoading stuck", async () => {
    let releaseReconcile!: () => void;
    refs.reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const { result, rerender } = renderHook(
      ({ locale }: { locale: "en" | "ko" }) => useNotesLoader(locale, "updated-desc"),
      { initialProps: { locale: "en" as "en" | "ko" } },
    );
    await waitFor(() => expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1));

    // A locale change during the load must not tear the load down.
    act(() => rerender({ locale: "ko" }));
    await act(async () => {
      releaseReconcile();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    expect(reconcileFolderModule.reconcileFolder).toHaveBeenCalledTimes(1);
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id)).toEqual(["a"]);
  });

  it("preserves canonical state when a directory migration rolls back without reload", async () => {
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const reconcileState = createReconcileState();
    const { result } = renderHook(() => useNotesLoader(
      "en",
      "updated-desc",
      true,
      0,
      reconcileState,
    ));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    const generation = libraryStore.getSnapshot().directoryGeneration;
    const preserved = libraryStore.getSnapshot();

    libraryStore.clearDirectory("hydrate");
    act(() => restoreNotesDir("/test-appdata/notes", preserved, reconcileState));
    // Persisting the old setting triggers the settings effect afterwards.
    // Its equivalent-directory call must not clear the restored snapshot.
    act(() => setNotesDir("/test-appdata/notes/", reconcileState));

    expect(libraryStore.getSnapshot().directoryGeneration).toBe(generation + 2);
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id)).toEqual(["a"]);
    act(() => result.current.setDocs((prev) => [...prev, makeDoc("b")]));
    expect(result.current.docs.map((doc) => doc.id)).toEqual(["a", "b"]);
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id)).toEqual(["a", "b"]);
  });

  it("does not clear a library restored under the default directory when the setting reverts to ''", async () => {
    const a = makeDoc("a");
    refs.fs!.seedTextFile(a.filePath, "body-a");
    refs.decomposedDocs = [a];
    const reconcileState = createReconcileState();
    const { result } = renderHook(() => useNotesLoader("en", "updated-desc", true, 0, reconcileState));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });
    const preserved = libraryStore.getSnapshot();
    // The loader resolved the default dir at startup, so the default-dir cache
    // is primed exactly as it is when a use-selected-only migration reverts.
    const defaultDir = await getDefaultNotesDir();
    expect(preserved.notesDirectory?.replace(/\/+$/, "")).toBe(defaultDir.replace(/\/+$/, ""));

    // Persisting the new custom dir ran the settings effect once (store cleared),
    // then the failed clear reverts by re-seeding under the old default dir and
    // persisting "" — which runs the effect's resetNotesDir branch.
    act(() => setNotesDir("/elsewhere/notes", reconcileState));
    act(() => restoreNotesDir(defaultDir, preserved, reconcileState));
    const restoredGeneration = libraryStore.getSnapshot().directoryGeneration;
    act(() => resetNotesDir(reconcileState));

    expect(libraryStore.getSnapshot().directoryGeneration).toBe(restoredGeneration);
    expect(libraryStore.getSnapshot().notesDirectory).toBe(defaultDir);
    expect(libraryStore.getSnapshot().docs.map((doc) => doc.id)).toEqual(["a"]);

    // A genuine reset (cache on a custom dir) still clears.
    act(() => setNotesDir("/elsewhere/notes", reconcileState));
    act(() => resetNotesDir(reconcileState));
    expect(libraryStore.getSnapshot().notesDirectory).toBeNull();
    expect(libraryStore.getSnapshot().docs).toEqual([]);
  });
});

// The chain inside saveManifest (commit f3c70b5) serializes every manifest
// write within a window — two rapid sidebar actions (delete + new note) used
// to fire saveManifest in parallel; the later call could finish first and the
// earlier one would then overwrite disk with its stale snapshot. These tests
// pin the two guarantees the chain provides: ordering and failure isolation.
describe("useNotesLoader — saveManifest persistChain", () => {
  // Flush all pending microtasks and any setTimeout-deferred work the wrapper
  // might queue. Plain `await Promise.resolve()` loops aren't enough because
  // the wrapper has multiple `await` hops (getNotesDir / getLocalCachePath)
  // before it reaches the mocked persistDecomposedStateImpl.
  const flushAll = () => new Promise<void>((r) => setTimeout(r, 0));

  // Prior hook tests in this file leave one in-flight persistDecomposedState
  // call queued (the loader's post-reconcile checkpoint). Without resetting,
  // it consumes the first mockImplementationOnce here and skews the call
  // sequence. mockReset wipes the impl queue and the call history at once.
  beforeEach(async () => {
    await flushAll();
    persistMock.mockReset();
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [],
      groups: [],
      trashedNotes: [],
      activeNoteId: null,
    });
  });

  it("invokes persistDecomposedState in call-time order even when the first call resolves last", async () => {
    const docsA = [makeDoc("a")];
    const docsB = [makeDoc("a"), makeDoc("b")];
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: docsA,
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let bStarted = false;
    // Both promises are constructed up-front so the resolvers exist before any
    // impl runs. Otherwise calling resolveB() before B's mock impl evaluates
    // its `new Promise()` is a no-op (the resolver only gets assigned when the
    // impl body executes), which leaves B's await hanging.
    let resolveA: () => void = () => {};
    let resolveB: () => void = () => {};
    const aGate = new Promise<void>((r) => { resolveA = r; });
    const bGate = new Promise<void>((r) => { resolveB = r; });

    persistMock.mockImplementationOnce(async () => { await aGate; });
    persistMock.mockImplementationOnce(async () => { bStarted = true; await bGate; });

    const p1 = saveManifest(docsA, null, undefined, "A");
    p1.catch(() => {});

    await flushAll();
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(bStarted).toBe(false);

    libraryStore.commit({ docs: docsB }, "local");
    // The legacy array argument is deliberately stale. Execution must read B
    // from the canonical store after A drains.
    const p2 = saveManifest(docsA, null, undefined, "B");
    p2.catch(() => {});

    // Resolve B's gate prematurely. The chain must still hold B back until A
    // finishes — even though B's await will be immediately satisfied once it
    // gets to run, the gate-before-start check proves the chain ordering.
    resolveB();
    await flushAll();
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(bStarted).toBe(false);

    // Resolving A lets the chain advance to B's wrap, which then starts the
    // already-resolved B impl.
    resolveA();
    await p1;
    await p2;
    expect(bStarted).toBe(true);
    expect(persistMock).toHaveBeenCalledTimes(2);

    // Order assertion: first impl call got docsA, second got docsB.
    const firstCallDocs = persistMock.mock.calls[0][3] as NoteDoc[];
    const secondCallDocs = persistMock.mock.calls[1][3] as NoteDoc[];
    expect(firstCallDocs.map((d) => d.id)).toEqual(["a"]);
    expect(secondCallDocs.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("isolates a rejected entry so the next enqueue still runs", async () => {
    const docsA = [makeDoc("a")];
    const docsB = [makeDoc("a"), makeDoc("b")];
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: docsB,
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    persistMock.mockRejectedValueOnce(new Error("EPERM: cache locked"));
    persistMock.mockResolvedValueOnce(undefined);

    // Attach rejection handlers immediately to avoid unhandled-rejection
    // bookkeeping inside vitest while p1 is still pending. allSettled
    // captures both outcomes after the chain has fully drained.
    const settled = Promise.allSettled([
      saveManifest(docsA, null, undefined, "A"),
      saveManifest(docsB, null, undefined, "B"),
    ]);

    const [r1, r2] = await settled;

    // Without the chain's .catch(() => undefined) bridge, p2 would never
    // execute its impl — the dead promise would block every subsequent
    // saveManifest for the lifetime of the window, silently losing every
    // future save.
    expect(r1.status).toBe("rejected");
    expect((r1 as PromiseRejectedResult).reason.message).toMatch(/EPERM/);
    expect(r2.status).toBe("fulfilled");
    expect(persistMock).toHaveBeenCalledTimes(2);

    // PERSIST_FAILED is emitted by the wrapper before rethrow, so the
    // crashLog trail survives even when the throw is swallowed by the chain.
    const logged = logNotenErrorMock.mock.calls.find(
      (c) => (c[0] as { code: string }).code === "PERSIST_FAILED",
    );
    expect(logged).toBeDefined();
  });

  it("repeats when a revision commits during the barrier's own persistence pass", async () => {
    const docsA = [makeDoc("a")];
    const docsB = [makeDoc("a"), makeDoc("b")];
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: docsA,
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    persistMock.mockImplementationOnce(async () => { await olderGate; });
    persistMock.mockResolvedValueOnce(undefined);

    const barrier = flushPersistence("test-barrier");
    barrier.catch(() => {});
    await flushAll();
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect((persistMock.mock.calls[0][3] as NoteDoc[]).map((doc) => doc.id)).toEqual(["a"]);

    // Commit while the barrier's own first write is suspended. A one-shot
    // implementation would return after that write and lose B.
    libraryStore.commit({ docs: docsB }, "local");
    releaseOlder();
    await barrier;

    expect(persistMock).toHaveBeenCalledTimes(2);
    const barrierDocs = persistMock.mock.calls[1][3] as NoteDoc[];
    expect(barrierDocs.map((doc) => doc.id)).toEqual(["a", "b"]);
  });

  it("re-checks an unbound snapshot after the prior chain drains", async () => {
    const docsA = [makeDoc("a")];
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: docsA,
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    persistMock.mockImplementationOnce(async () => { await oldGate; });
    persistMock.mockResolvedValueOnce(undefined);
    const oldWrite = saveManifest(docsA, "a", [], "old-directory");
    oldWrite.catch(() => {});
    await flushAll();

    libraryStore.clearDirectory("hydrate");
    const barrier = flushPersistence("unbound-transition");
    barrier.catch(() => {});
    const docB = { ...makeDoc("b"), filePath: "D:/next/b.md" };
    libraryStore.seedDirectory("D:/next", {
      docs: [docB],
      groups: [],
      trashedNotes: [],
      activeNoteId: "b",
    });
    releaseOld();
    await oldWrite;
    await barrier;

    expect(persistMock).toHaveBeenCalledTimes(2);
    expect((persistMock.mock.calls[1][3] as NoteDoc[]).map((doc) => doc.id)).toEqual(["b"]);
  });

  it("persists trash from the canonical snapshot rather than the module cache", async () => {
    const trashed: TrashedNote = {
      id: "trash",
      fileName: "Trash",
      originalFilePath: "/test-appdata/notes/trash.md",
      trashFilePath: "/test-appdata/notes/.trash/trash.md",
      trashedAt: 5000,
      groupId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [],
      groups: [],
      trashedNotes: [trashed],
      activeNoteId: null,
    });
    persistMock.mockResolvedValueOnce(undefined);

    await flushPersistence("trash-source-test");

    const options = persistMock.mock.calls[0][6] as { trashedNotes: TrashedNote[] };
    expect(options.trashedNotes.map((note) => note.id)).toEqual(["trash"]);
  });

  it("does not dedupe a new group tombstone intent at the same library revision", async () => {
    persistMock.mockResolvedValue(undefined);
    await flushPersistence("group-baseline");
    const callsAfterBaseline = persistMock.mock.calls.length;

    markGroupAsDeleted("removed-group");
    await flushPersistence("group-tombstone");

    expect(persistMock).toHaveBeenCalledTimes(callsAfterBaseline + 1);
    const options = persistMock.mock.calls[persistMock.mock.calls.length - 1][6] as {
      groupsSnapshotSeq: number;
    };
    expect(options.groupsSnapshotSeq).toBeGreaterThan(0);
  });

  it("serializes lifecycle transactions behind older full persistence", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseFull!: () => void;
    const fullGate = new Promise<void>((resolve) => { releaseFull = resolve; });
    persistMock.mockImplementationOnce(async () => { await fullGate; });
    const full = saveManifest([doc], "a", [], "older-full");
    full.catch(() => {});
    await flushAll();
    let transactionStarted = false;
    const transaction = runPersistenceTransaction("delete-a", ["a"], async ({ notesDirectory }) => {
      transactionStarted = true;
      expect(notesDirectory).toBe("/test-appdata/notes");
      return "done";
    }, () => libraryStore.getSnapshot());
    transaction.catch(() => {});

    await flushAll();
    expect(transactionStarted).toBe(false);
    releaseFull();
    await full;
    await expect(transaction).resolves.toEqual({
      status: "committed",
      value: "done",
      followupPersisted: true,
    });
    expect(transactionStarted).toBe(true);
    expect(persistMock).toHaveBeenCalledTimes(2);
  });

  it("holds a later full persist until a lifecycle transaction publishes", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseTransaction!: () => void;
    const transactionGate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const transaction = runPersistenceTransaction("trash-a", ["a"], async ({ writeNoteMeta }) => {
      await writeNoteMeta({
        version: 2,
        id: "a",
        fileName: "Note a",
        createdAt: 1000,
        updatedAt: 1000,
        groupId: null,
        groupUpdatedAt: 1000,
        trashedAt: 9000,
      });
      await transactionGate;
      return true;
    }, () => libraryStore.commit({ docs: [], activeNoteId: null }, "local"));
    transaction.catch(() => {});
    await flushAll();
    persistMock.mockResolvedValueOnce(undefined);
    const full = saveManifest([doc], "a", [], "behind-lifecycle");
    full.catch(() => {});

    await flushAll();
    expect(persistMock).not.toHaveBeenCalled();
    releaseTransaction();
    await transaction;
    await full;

    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock.mock.calls[0][3]).toEqual([]);
  });

  it("drops a transaction result when the directory changes during metadata I/O", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseWrite!: () => void;
    refs.writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    refs.onWriteStart = (path) => {
      if (path.includes("/.meta/") || path.includes("\\.meta\\")) markWriteStarted();
    };
    const publish = vi.fn(() => libraryStore.getSnapshot());
    const transaction = runPersistenceTransaction("generation-switch", ["a"], async ({ writeNoteMeta }) => {
      await writeNoteMeta({
        version: 2,
        id: "a",
        fileName: "Note a",
        createdAt: 1000,
        updatedAt: 1000,
        groupId: null,
        groupUpdatedAt: 1000,
        trashedAt: 9000,
      });
      return true;
    }, publish);
    transaction.catch(() => {});

    await writeStarted;
    refs.fs!.seedDir("D:/other-notes");
    libraryStore.seedDirectory("D:/other-notes", {
      docs: [makeDoc("other")],
      groups: [],
      trashedNotes: [],
      activeNoteId: "other",
    });
    releaseWrite();

    await expect(transaction).resolves.toEqual({ status: "invalidated" });
    expect(publish).not.toHaveBeenCalled();
    expect(libraryStore.getSnapshot().docs.map((entry) => entry.id)).toEqual(["other"]);
    expect(await readMeta(refs.fs!, "D:/other-notes", "a")).toBeNull();
  });

  it("awaits canonical publish before forcing the follow-up projection", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    const transaction = runPersistenceTransaction("async-publish", ["a"], async () => true, async () => {
      await publishGate;
      return libraryStore.commit({ docs: [], activeNoteId: null }, "local");
    });
    transaction.catch(() => {});

    await flushAll();
    expect(persistMock).not.toHaveBeenCalled();
    releasePublish();
    await expect(transaction).resolves.toEqual({
      status: "committed",
      value: true,
      followupPersisted: true,
    });
    expect(persistMock.mock.calls[0][3]).toEqual([]);
  });

  it("runs synchronous post-commit handoff before the forced follow-up write", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    const order: string[] = [];
    persistMock.mockImplementationOnce(async () => { order.push("followup"); });

    const transaction = runPersistenceTransaction(
      "post-commit-order",
      ["a"],
      async () => true,
      () => {
        order.push("publish");
        return libraryStore.commit({ docs: [], activeNoteId: null }, "local");
      },
      () => {
        order.push("afterCommit");
        return undefined;
      },
    );

    await expect(transaction).resolves.toMatchObject({ status: "committed" });
    expect(order).toEqual(["publish", "afterCommit", "followup"]);
  });

  it("keeps a lifecycle committed when the post-commit handoff throws", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });

    const transaction = runPersistenceTransaction(
      "post-commit-error",
      ["a"],
      async () => true,
      () => libraryStore.commit({ docs: [], activeNoteId: null }, "local"),
      () => { throw new Error("editor handoff failed"); },
    );

    await expect(transaction).resolves.toEqual({
      status: "committed",
      value: true,
      followupPersisted: true,
    });
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(libraryStore.getSnapshot().docs).toEqual([]);
  });

  it("invalidates when the directory changes while async publish is pending", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    let markPublished!: () => void;
    const published = new Promise<void>((resolve) => { markPublished = resolve; });
    const transaction = runPersistenceTransaction("publish-generation", ["a"], async () => true, async () => {
      const committed = libraryStore.commit({ docs: [], activeNoteId: null }, "local");
      markPublished();
      await publishGate;
      return committed;
    });
    transaction.catch(() => {});

    await published;
    refs.fs!.seedDir("D:/other-notes");
    libraryStore.seedDirectory("D:/other-notes", {
      docs: [makeDoc("other")],
      groups: [],
      trashedNotes: [],
      activeNoteId: "other",
    });
    releasePublish();

    await expect(transaction).resolves.toEqual({ status: "invalidated" });
    expect(persistMock).not.toHaveBeenCalled();
    expect(libraryStore.getSnapshot().docs.map((entry) => entry.id)).toEqual(["other"]);
  });

  it("does not finalize an intent created after the execution snapshot", async () => {
    const doc = makeDoc("a");
    const group: NoteGroup = {
      id: "g-new",
      name: "New",
      noteIds: ["a"],
      collapsed: false,
      createdAt: 1000,
    };
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [group],
      trashedNotes: [],
      activeNoteId: "a",
    });
    markGroupMembershipChanged("a", "g-old", 5000);
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
    let markOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => { markOperationStarted = resolve; });
    const transaction = runPersistenceTransaction(
      "intent-baseline",
      ["a"],
      async ({ writeNoteMeta, finalizeNoteMeta }) => {
        markOperationStarted();
        await operationGate;
        await writeNoteMeta({
          version: 2,
          id: "a",
          fileName: "Note a",
          createdAt: 1000,
          updatedAt: 1000,
          groupId: "g-old",
          groupUpdatedAt: 5000,
          trashedAt: null,
        });
        finalizeNoteMeta("a", { acknowledgeGroupMembership: true });
        return true;
      },
      () => libraryStore.getSnapshot(),
    );
    transaction.catch(() => {});

    await operationStarted;
    markGroupMembershipChanged("a", "g-new", 6000);
    releaseOperation();
    await expect(transaction).resolves.toMatchObject({ status: "committed" });

    libraryStore.commit((current) => ({
      docs: current.docs.map((entry) => ({ ...entry, content: "changed" })),
    }), "local");
    const actual = await vi.importActual<typeof import("../utils/decomposedState")>("../utils/decomposedState");
    persistMock.mockImplementationOnce(actual.persistDecomposedState);
    await saveManifest([], null, [], "intent-baseline-followup");

    expect((await readMeta(refs.fs!, "/test-appdata/notes", "a"))?.groupId).toBe("g-new");
  });

  it("merges an unacknowledged canonical field into lifecycle metadata", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [{ ...doc, pinned: true }],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    await writeMeta(refs.fs!, "/test-appdata/notes", {
      version: 2,
      id: "a",
      fileName: "Note a",
      createdAt: 1000,
      updatedAt: 1000,
      groupId: null,
      groupUpdatedAt: 1000,
      pinned: false,
      trashedAt: null,
    }, "test-machine");
    markNotesPinnedChanged(["a"]);

    const transaction = runPersistenceTransaction(
      "lifecycle-field-merge",
      ["a"],
      async ({ snapshot, readNoteMeta, mergeNoteMeta, writeNoteMeta, finalizeNoteMeta }) => {
        const current = snapshot.docs[0];
        const merged = mergeNoteMeta("a", {
          version: 2,
          id: "a",
          fileName: current.fileName,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
          groupId: null,
          groupUpdatedAt: current.updatedAt,
          pinned: current.pinned === true,
          trashedAt: 9000,
        }, await readNoteMeta("a"));
        await writeNoteMeta(merged);
        finalizeNoteMeta("a", { acknowledgeFields: { pinned: true } });
        return merged;
      },
      () => libraryStore.getSnapshot(),
    );

    await expect(transaction).resolves.toMatchObject({
      status: "committed",
      value: { pinned: true },
    });
    expect((await readMeta(refs.fs!, "/test-appdata/notes", "a"))?.pinned).toBe(true);
  });

  it("preserves a disk-owned optional field clear during lifecycle merge", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [{ ...doc, color: "red" }],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    await writeMeta(refs.fs!, "/test-appdata/notes", {
      version: 2,
      id: "a",
      fileName: "Note a",
      createdAt: 1000,
      updatedAt: 1000,
      groupId: null,
      groupUpdatedAt: 1000,
      trashedAt: null,
    }, "remote-machine");

    const transaction = runPersistenceTransaction(
      "lifecycle-color-clear",
      ["a"],
      async ({ snapshot, readNoteMeta, mergeNoteMeta }) => mergeNoteMeta("a", {
        version: 2,
        id: "a",
        fileName: "Note a",
        createdAt: 1000,
        updatedAt: 1000,
        groupId: null,
        groupUpdatedAt: 1000,
        color: snapshot.docs[0].color,
        trashedAt: 9000,
      }, await readNoteMeta("a")),
      () => libraryStore.getSnapshot(),
    );

    await expect(transaction).resolves.toMatchObject({
      status: "committed",
      value: { color: undefined },
    });
  });

  it("reports follow-up persistence debt without undoing a committed lifecycle", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    persistMock.mockRejectedValueOnce(new Error("groups EPERM"));
    const transaction = runPersistenceTransaction("followup-failure", ["a"], async () => true, () => (
      libraryStore.commit({ docs: [], activeNoteId: null }, "local")
    ));

    await expect(transaction).resolves.toEqual({
      status: "committed",
      value: true,
      followupPersisted: false,
    });
    expect(libraryStore.getSnapshot().docs).toEqual([]);

    persistMock.mockResolvedValueOnce(undefined);
    await expect(flushPersistence("retry-followup")).resolves.toBeUndefined();
    expect(persistMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe note ids and lets the next persistence job recover", async () => {
    const doc = makeDoc("a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [doc],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    const transaction = runPersistenceTransaction("unsafe-id", [".."], async ({ writeNoteMeta }) => {
      await writeNoteMeta({
        version: 2,
        id: "..",
        fileName: "Unsafe",
        createdAt: 1000,
        updatedAt: 1000,
        groupId: null,
        groupUpdatedAt: 1000,
        trashedAt: null,
      });
      return true;
    }, () => libraryStore.getSnapshot());
    transaction.catch(() => {});

    await expect(transaction).rejects.toThrow(/Unsafe note id/);
    persistMock.mockResolvedValueOnce(undefined);
    await expect(saveManifest([doc], "a", [], "after-failed-transaction")).resolves.toBeUndefined();
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(logNotenErrorMock).toHaveBeenCalledWith(expect.objectContaining({ code: "PERSIST_FAILED" }));
  });
});

describe("useNotesLoader — targeted autosave metadata", () => {
  const flushAll = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(async () => {
    await flushAll();
    persistMock.mockReset();
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [makeDoc("a")],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
  });

  const meta = (id: string, overrides: Partial<NoteMeta> = {}): NoteMeta => ({
    version: 2,
    id,
    fileName: `Note ${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    groupId: null,
    groupUpdatedAt: 1000,
    trashedAt: null,
    ...overrides,
  });

  it("updates only the saved note while preserving independently-owned metadata", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "body a");
    refs.fs!.seedTextFile("/test-appdata/notes/.trash/b.md", "body b");
    refs.localCache = {
      version: 2,
      notesDirectory: "/test-appdata/notes",
      notes: [
        { id: "a", filePath: "/test-appdata/notes/a.md", fileName: "Note a", createdAt: 1000, updatedAt: 1000 },
        { id: "c", filePath: "/test-appdata/notes/c.md", fileName: "Untouched c", createdAt: 1000, updatedAt: 1000 },
      ],
      groups: [{ id: "group-1", name: "Group", noteIds: ["a"], collapsed: false, createdAt: 1 }],
      trashedNotes: [{
        id: "b",
        fileName: "Note b",
        originalFilePath: "/test-appdata/notes/b.md",
        trashFilePath: "/test-appdata/notes/.trash/b.md",
        trashedAt: 5000,
        groupId: null,
        createdAt: 1000,
        updatedAt: 1000,
      }],
    };
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      createdAt: 250,
      pinned: true,
      color: "purple",
      groupId: "group-1",
      groupUpdatedAt: 9000,
    }), "test-machine");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("b", {
      trashedAt: 5000,
      trashedFromPath: "/test-appdata/notes/b.md",
    }), "remote-machine");

    const saved = makeDoc("a");
    saved.fileName = "Renamed from body";
    saved.updatedAt = 7000;
    saved.pinned = false;
    saved.color = undefined;

    await expect(saveNoteMetadata(saved, null)).resolves.toMatchObject({
      id: "a",
      fileName: "Renamed from body",
      createdAt: 250,
      pinned: true,
      color: "purple",
      groupId: "group-1",
      groupUpdatedAt: 9000,
      trashedAt: null,
    });

    expect(await readMeta(refs.fs!, "/test-appdata/notes", "a")).toMatchObject({
      fileName: "Renamed from body",
      createdAt: 250,
      updatedAt: 7000,
      pinned: true,
      color: "purple",
      groupId: "group-1",
      groupUpdatedAt: 9000,
      trashedAt: null,
    });
    expect(await readMeta(refs.fs!, "/test-appdata/notes", "b")).toMatchObject({
      fileName: "Note b",
      trashedAt: 5000,
      trashedFromPath: "/test-appdata/notes/b.md",
      lastWriterMachineId: "remote-machine",
    });
    expect(refs.writtenLocalCache?.notes).toEqual([
      expect.objectContaining({ id: "a", fileName: "Renamed from body", updatedAt: 7000, pinned: true, color: "purple" }),
      expect.objectContaining({ id: "c", fileName: "Untouched c" }),
    ]);
    expect(refs.writtenLocalCache?.trashedNotes?.map((entry) => entry.id)).toEqual(["b"]);
    expect(refs.writtenLocalCache?.groups?.[0]?.noteIds).toEqual(["a"]);
  });

  it("does not let a stale autosave re-enable auto-title after a manual rename", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      fileName: "Manual title",
      customName: true,
      updatedAt: 6000,
    }), "test-machine");

    await expect(saveNoteMetadata({
      ...makeDoc("a"),
      fileName: "Derived stale title",
      customName: false,
      updatedAt: 7000,
    }, null)).resolves.toMatchObject({
      fileName: "Manual title",
      customName: true,
      updatedAt: 7000,
    });

    expect(await readMeta(refs.fs!, "/test-appdata/notes", "a")).toMatchObject({
      fileName: "Manual title",
      customName: true,
      updatedAt: 7000,
    });
  });

  it("preserves an explicit ungroup instead of reviving a stale fallback group", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      groupId: null,
      groupUpdatedAt: 9000,
    }), "test-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [makeDoc("a")],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });

    await expect(saveNoteMetadata({
      ...makeDoc("a"),
      updatedAt: 7000,
    }, "stale-group")).resolves.toMatchObject({
      groupId: null,
      groupUpdatedAt: 9000,
    });
    expect(await readMeta(refs.fs!, "/test-appdata/notes", "a")).toMatchObject({
      groupId: null,
      groupUpdatedAt: 9000,
    });
  });

  it("uses execution-time canonical membership when creating a missing sidecar", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "body a");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [makeDoc("a")],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });

    await saveNoteMetadata({ ...makeDoc("a"), updatedAt: 7000 }, "stale-group");

    expect(await readMeta(refs.fs!, "/test-appdata/notes", "a")).toMatchObject({
      groupId: null,
    });
  });

  it("keeps canonical pin and color intents committed after metadata enqueue", async () => {
    const original = makeDoc("a");
    original.color = "blue";
    refs.fs!.seedTextFile(original.filePath, "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      pinned: false,
      color: "blue",
    }), "test-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [original],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    persistMock.mockImplementationOnce(async () => { await olderGate; });
    persistMock.mockResolvedValueOnce(undefined);
    const older = saveManifest([original], "a", [], "older");
    older.catch(() => {});
    await flushAll();

    const metadata = saveNoteMetadata(
      { ...original, fileName: "Autosaved", updatedAt: 7000 },
      null,
      "autosave-before-pin",
      undefined,
    );
    metadata.catch(() => {});
    libraryStore.commit((current) => ({
      docs: current.docs.map((entry) => entry.id === "a"
        ? { ...entry, pinned: true, color: "red" }
        : entry),
    }), "local");
    const newerFull = saveManifest([original], "a", [], "pin-and-color");
    newerFull.catch(() => {});
    releaseOlder();
    await older;

    await expect(metadata).resolves.toMatchObject({ pinned: true, color: "red" });
    await newerFull;
    expect(await readMeta(refs.fs!, "/test-appdata/notes", "a")).toMatchObject({
      pinned: true,
      color: "red",
    });
  });

  it("still adopts newer disk pin and color after an unrelated canonical change", async () => {
    const original = makeDoc("a");
    original.color = "blue";
    refs.fs!.seedTextFile(original.filePath, "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      pinned: false,
      color: "blue",
    }), "test-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [original],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    persistMock.mockImplementationOnce(async () => { await olderGate; });
    const older = saveManifest([original], "a", [], "older");
    older.catch(() => {});
    await flushAll();
    const metadata = saveNoteMetadata({
      ...original,
      fileName: "Autosaved",
      updatedAt: 7000,
    }, null);
    metadata.catch(() => {});

    libraryStore.commit((current) => ({
      docs: current.docs.map((entry) => entry.id === "a"
        ? { ...entry, content: "new canonical body" }
        : entry),
    }), "local");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      pinned: true,
      color: "red",
    }), "remote-machine");
    releaseOlder();
    await older;

    await expect(metadata).resolves.toMatchObject({ pinned: true, color: "red" });
  });

  it("reports a pin ABA mutation that occurs during the metadata write", async () => {
    const original = makeDoc("a");
    refs.fs!.seedTextFile(original.filePath, "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      pinned: true,
    }), "remote-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [original],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseWrite!: () => void;
    refs.writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    refs.onWriteStart = (path) => {
      if (path.includes("/.meta/") || path.includes("\\.meta\\")) markWriteStarted();
    };
    const publish = vi.fn();
    const metadata = saveNoteMetadata({
      ...original,
      fileName: "Autosaved",
      updatedAt: 7000,
    }, null, "pin-aba", publish);
    metadata.catch(() => {});
    await writeStarted;

    markNotesPinnedChanged(["a"]);
    libraryStore.commit((current) => ({
      docs: current.docs.map((entry) => entry.id === "a" ? { ...entry, pinned: true } : entry),
    }), "local");
    markNotesPinnedChanged(["a"]);
    libraryStore.commit((current) => ({
      docs: current.docs.map((entry) => entry.id === "a" ? { ...entry, pinned: undefined } : entry),
    }), "local");
    releaseWrite();
    await metadata;

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: true }),
      expect.objectContaining({ id: "a" }),
      expect.objectContaining({ pinned: true }),
    );
  });

  it("keeps an unacknowledged pin intent after an earlier full write fails", async () => {
    const original = makeDoc("a");
    refs.fs!.seedTextFile(original.filePath, "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      pinned: false,
    }), "test-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [original],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    markNotesPinnedChanged(["a"]);
    libraryStore.commit((current) => ({
      docs: current.docs.map((entry) => entry.id === "a" ? { ...entry, pinned: true } : entry),
    }), "local");
    persistMock.mockRejectedValueOnce(new Error("EPERM: full metadata write failed"));

    await expect(saveManifest([original], "a", [], "failed-pin-write")).rejects.toThrow("EPERM");
    const current = libraryStore.getSnapshot().docs[0];
    await expect(saveNoteMetadata({
      ...current,
      fileName: "Autosaved",
      updatedAt: 7000,
    }, null)).resolves.toMatchObject({ pinned: true });
    expect(await readMeta(refs.fs!, "/test-appdata/notes", "a")).toMatchObject({
      pinned: true,
    });
  });

  it("allows disk merge after a preceding full write acknowledges the local intent", async () => {
    const original = makeDoc("a");
    refs.fs!.seedTextFile(original.filePath, "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", { pinned: false }), "test-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [original],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    markNotesPinnedChanged(["a"]);
    libraryStore.commit((current) => ({
      docs: current.docs.map((entry) => entry.id === "a" ? { ...entry, pinned: true } : entry),
    }), "local");
    let releaseFull!: () => void;
    const fullGate = new Promise<void>((resolve) => { releaseFull = resolve; });
    persistMock.mockImplementationOnce(async () => { await fullGate; });
    const full = saveManifest([original], "a", [], "pin-full");
    full.catch(() => {});
    await flushAll();
    const metadata = saveNoteMetadata({
      ...libraryStore.getSnapshot().docs[0],
      fileName: "Autosaved",
      updatedAt: 7000,
    }, null);
    metadata.catch(() => {});

    // A peer update lands after the full writer's note phase. Once that writer
    // succeeds, its local pin intent is acknowledged and this newer disk value
    // must be eligible for the following autosave merge.
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", { pinned: false }), "remote-machine");
    releaseFull();
    await full;

    await expect(metadata).resolves.toMatchObject({ pinned: false });
  });

  it("publishes effective note metadata before a queued full-library job executes", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a"), "test-machine");
    persistMock.mockResolvedValueOnce(undefined);
    const saved = {
      ...makeDoc("a"),
      fileName: "Autosaved title",
      updatedAt: 7000,
    };

    const metadata = saveNoteMetadata(saved, null, "test-autosave", (effective) => {
      libraryStore.commit((current) => ({
        docs: current.docs.map((entry) => entry.id === effective.id
          ? {
              ...entry,
              fileName: effective.fileName,
              updatedAt: effective.updatedAt,
            }
          : entry),
      }), "local");
    });
    const full = saveManifest([makeDoc("a")], "a", [], "queued-behind-autosave");
    await metadata;
    await full;

    const persistedDocs = persistMock.mock.calls[0][3] as NoteDoc[];
    expect(persistedDocs[0]).toMatchObject({
      id: "a",
      fileName: "Autosaved title",
      updatedAt: 7000,
    });
  });

  it("re-checks lifecycle when the queue drains and cannot revive a trashed note", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "stale root body");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a"), "test-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [makeDoc("a")],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });

    let releaseOlderJob: () => void = () => {};
    const olderGate = new Promise<void>((resolve) => { releaseOlderJob = resolve; });
    persistMock.mockImplementationOnce(async () => { await olderGate; });

    const older = saveManifest([makeDoc("a")], "a", [], "older-full-snapshot");
    const staleAutosave = saveNoteMetadata({
      ...makeDoc("a"),
      fileName: "Stale live title",
      updatedAt: 8000,
    }, null);
    older.catch(() => {});
    staleAutosave.catch(() => {});

    await flushAll();
    expect(persistMock).toHaveBeenCalledTimes(1);

    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a", {
      trashedAt: 9000,
      trashedFromPath: "/test-appdata/notes/a.md",
    }), "test-machine");

    releaseOlderJob();
    await older;
    await expect(staleAutosave).resolves.toBeNull();
    expect(await readMeta(refs.fs!, "/test-appdata/notes", "a")).toMatchObject({
      fileName: "Note a",
      trashedAt: 9000,
    });
  });

  it("does not recreate an absent sidecar when the live body is also gone", async () => {
    await expect(saveNoteMetadata({
      ...makeDoc("gone"),
      fileName: "Stale title",
      updatedAt: 9000,
    }, null)).resolves.toBeNull();

    expect(await readMeta(refs.fs!, "/test-appdata/notes", "gone")).toBeNull();
    expect(refs.writtenLocalCache).toBeNull();
  });

  it("drops queued note metadata when the directory generation changes", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a"), "test-machine");
    libraryStore.seedDirectory("/test-appdata/notes", {
      docs: [makeDoc("a")],
      groups: [],
      trashedNotes: [],
      activeNoteId: "a",
    });
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    persistMock.mockImplementationOnce(async () => { await olderGate; });
    const older = saveManifest([makeDoc("a")], "a", [], "older-dir-job");
    older.catch(() => {});
    await flushAll();
    const metadata = saveNoteMetadata({
      ...makeDoc("a"),
      fileName: "Must not cross directories",
      updatedAt: 9000,
    }, null);
    metadata.catch(() => {});

    libraryStore.seedDirectory("D:/other-notes", {
      docs: [],
      groups: [],
      trashedNotes: [],
      activeNoteId: null,
    });
    releaseOlder();
    await older;

    await expect(metadata).resolves.toBeNull();
    expect(await readMeta(refs.fs!, "D:/other-notes", "a")).toBeNull();
  });

  it("does not publish a metadata result when the directory changes during its write", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/a.md", "body a");
    await writeMeta(refs.fs!, "/test-appdata/notes", meta("a"), "test-machine");
    let releaseWrite!: () => void;
    refs.writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    refs.onWriteStart = (path) => {
      if (path.includes("/.meta/") || path.includes("\\.meta\\")) markWriteStarted();
    };
    const publish = vi.fn();

    const metadata = saveNoteMetadata({
      ...makeDoc("a"),
      fileName: "Old directory result",
      updatedAt: 9000,
    }, null, "generation-mid-write", publish);
    metadata.catch(() => {});
    await writeStarted;
    libraryStore.seedDirectory("D:/other-notes", {
      docs: [],
      groups: [],
      trashedNotes: [],
      activeNoteId: null,
    });
    releaseWrite();

    await expect(metadata).resolves.toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(await readMeta(refs.fs!, "D:/other-notes", "a")).toBeNull();
  });
});

describe("purgeExpiredTrash — unsafe id defense-in-depth", () => {
  it("retains (never purges) a trashed note whose id is a traversal segment", async () => {
    const unsafe: TrashedNote = {
      id: "..",
      fileName: "x",
      originalFilePath: "/test-appdata/notes/x.md",
      trashFilePath: "/test-appdata/notes/.trash/...md",
      trashedAt: 1, // long expired
      groupId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const kept = await purgeExpiredTrash([unsafe]);
    expect(kept.map((n) => n.id)).toContain("..");
    const logged = logNotenErrorMock.mock.calls.find(
      (c) => (c[0] as { code: string }).code === "INVALID_NOTE_ID",
    );
    expect(logged).toBeDefined();
  });

  it("retains Win32-aliasing and reserved-name ids instead of purging them", async () => {
    // Each of these would, if purged, drive `.assets/<id>` to alias `.assets`
    // itself (or its parent) on Windows and mass-delete note images/notes.
    const unsafeIds = ["...", " ", ".. ", "note.", "NUL"];
    const trashed: TrashedNote[] = unsafeIds.map((id) => ({
      id,
      fileName: "x",
      originalFilePath: `/test-appdata/notes/${id}.md`,
      trashFilePath: `/test-appdata/notes/.trash/${id}.md`,
      trashedAt: 1, // long expired
      groupId: null,
      createdAt: 1,
      updatedAt: 1,
    }));
    const kept = await purgeExpiredTrash(trashed);
    expect(kept.map((n) => n.id).sort()).toEqual([...unsafeIds].sort());
    expect(logNotenErrorMock.mock.calls.filter(
      (c) => (c[0] as { code: string }).code === "INVALID_NOTE_ID",
    ).length).toBe(unsafeIds.length);
  });

  it("still purges a normal expired note", async () => {
    refs.fs!.seedTextFile("/test-appdata/notes/.trash/safe.md", "body");
    const safe: TrashedNote = {
      id: "safe",
      fileName: "safe",
      originalFilePath: "/test-appdata/notes/safe.md",
      trashFilePath: "/test-appdata/notes/.trash/safe.md",
      trashedAt: 1,
      groupId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const kept = await purgeExpiredTrash([safe]);
    expect(kept).toHaveLength(0);
    expect(await refs.fs!.exists("/test-appdata/notes/.trash/safe.md")).toBe(false);
  });

  // Dropping an expired entry whose body a cloud client still holds removed
  // its sidecar too, orphaning the body in .trash for good. Keeping it lets
  // the next launch retry.
  it("keeps an expired note whose body cannot be removed", async () => {
    const bodyPath = "/test-appdata/notes/.trash/locked.md";
    const metaPath = "/test-appdata/notes/.meta/locked.json";
    refs.fs!.seedTextFile(bodyPath, "body");
    refs.fs!.seedTextFile(metaPath, "{}");
    const innerRemove = refs.fs!.remove.bind(refs.fs!);
    const removeSpy = vi.spyOn(refs.fs!, "remove").mockImplementation(async (p, o) => {
      if (p === bodyPath) throw new Error("os error 32");
      return innerRemove(p, o);
    });
    const locked: TrashedNote = {
      id: "locked",
      fileName: "locked",
      originalFilePath: "/test-appdata/notes/locked.md",
      trashFilePath: bodyPath,
      trashedAt: 1,
      groupId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    try {
      const kept = await purgeExpiredTrash([locked]);
      expect(kept.map((n) => n.id)).toEqual(["locked"]);
      expect(await refs.fs!.exists(metaPath)).toBe(true);
    } finally {
      removeSpy.mockRestore();
    }
  });
});

describe("useNotesLoader + useAutoSave — autosave re-sort keeps active identity", () => {
  // Regression for the nested `setActiveIndex(nextIndex)` that doSave used to
  // dispatch from inside its setDocs updater. The index was computed against the
  // re-sorted array, but commitActiveIndexUpdate resolved it against the
  // PRE-commit store docs, so saving a non-top note under updated-desc pinned
  // activeNoteId to whichever note previously sat at the saved note's new slot
  // — and the next keystroke was written into that other note's file.
  function makeSortedDoc(id: string, updatedAt: number): NoteDoc {
    return {
      id,
      filePath: `/test-appdata/notes/${id}.md`,
      fileName: `Note ${id}`,
      isDirty: false,
      content: `body-${id}`,
      createdAt: 1000,
      updatedAt,
    };
  }

  function makeEditorStubs() {
    const editor = { content: "" };
    const cached = { md: "" };
    const state = {
      isDirty: true,
      setIsDirty: vi.fn(),
      primeMarkdown: vi.fn((md: string) => { cached.md = md; }),
      getCachedMarkdown: () => cached.md,
      setFilePath: vi.fn(),
    } as unknown as MarkdownState;
    const tiptapRef = {
      current: {
        getEditor: () => ({ getMarkdown: () => editor.content }),
      } as unknown as TiptapEditorHandle,
    };
    return { editor, state, tiptapRef };
  }

  it("saving a non-top note under updated-desc keeps activeNoteId on it and routes the next edit to its own file", async () => {
    const seeded = [makeSortedDoc("a", 3000), makeSortedDoc("b", 2000), makeSortedDoc("c", 1000)];
    for (const doc of seeded) refs.fs!.seedTextFile(doc.filePath, doc.content);
    refs.decomposedDocs = seeded;

    const { editor, state, tiptapRef } = makeEditorStubs();
    const { result } = renderHook(() => {
      const loader = useNotesLoader("en", "updated-desc");
      const autoSave = useAutoSave(
        state,
        tiptapRef,
        loader.docs,
        loader.setDocs,
        loader.activeIndex,
        "en",
        "updated-desc",
        loader.groups,
      );
      return { loader, autoSave };
    });
    await waitFor(() => expect(result.current.loader.isLoading).toBe(false), { timeout: 3000 });
    expect(result.current.loader.docs.map((d) => d.id)).toEqual(["a", "b", "c"]);

    // Switch to b (index 1) the way switchDocument does.
    editor.content = "body-b";
    act(() => {
      result.current.loader.setActiveIndex(1);
      result.current.autoSave.notifyActiveDoc("b", "/test-appdata/notes/b.md");
    });
    expect(libraryStore.getSnapshot().activeNoteId).toBe("b");

    // Type into b and save: the save bumps b's updatedAt, so it re-sorts to the top.
    editor.content = "body-b edited";
    await act(async () => {
      result.current.autoSave.scheduleAutoSave();
      expect(await result.current.autoSave.flushAutoSave()).toEqual({ status: "saved" });
    });

    const afterFirstSave = libraryStore.getSnapshot();
    expect(afterFirstSave.docs.map((d) => d.id)).toEqual(["b", "a", "c"]);
    expect(afterFirstSave.activeNoteId).toBe("b");
    expect(result.current.loader.activeIndex).toBe(0);
    expect(result.current.loader.docs[result.current.loader.activeIndex]?.id).toBe("b");

    // The next keystroke (editor still shows b) must land in b.md, not a.md.
    editor.content = "body-b edited again";
    await act(async () => {
      result.current.autoSave.scheduleAutoSave();
      expect(await result.current.autoSave.flushAutoSave()).toEqual({ status: "saved" });
    });
    expect(await refs.fs!.readTextFile("/test-appdata/notes/b.md")).toBe("body-b edited again");
    expect(await refs.fs!.readTextFile("/test-appdata/notes/a.md")).toBe("body-a");
    expect(libraryStore.getSnapshot().activeNoteId).toBe("b");
  });
});
