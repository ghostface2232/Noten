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
  readFaultByPath: new Map<string, Error>(),
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
    readTextFile: (p: string) => {
      const fault = refs.readFaultByPath.get(p);
      if (fault) throw fault;
      return get().readTextFile(p);
    },
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
import { useNotesLoader, resetNotesDir, saveManifest, purgeExpiredTrash } from "./useNotesLoader";
import * as reconcileFolderModule from "../utils/reconcileFolder";
import * as decomposedStateModule from "../utils/decomposedState";
import * as crashLogModule from "../utils/crashLog";

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

describe("useNotesLoader — all body reads fail closed", () => {
  it("does not create a new blank note when persisted docs exist but every body read fails", async () => {
    const doc = makeDoc("id-0");
    refs.fs!.seedTextFile(doc.filePath, "real body");
    refs.decomposedDocs = [doc];
    refs.readFaultByPath.set(doc.filePath, new Error("EBUSY: cloud hydration"));

    const { result } = renderHook(() => useNotesLoader("en", "updated-desc"));
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 });

    expect(result.current.docs).toHaveLength(1);
    expect(result.current.docs[0].id).toBe("local");

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
  });

  it("invokes persistDecomposedState in call-time order even when the first call resolves last", async () => {
    const docsA = [makeDoc("a")];
    const docsB = [makeDoc("a"), makeDoc("b")];
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
    const p2 = saveManifest(docsB, null, undefined, "B");
    p1.catch(() => {});
    p2.catch(() => {});

    await flushAll();
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(bStarted).toBe(false);

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
});
