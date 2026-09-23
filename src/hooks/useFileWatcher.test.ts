import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { WatchEvent } from "@tauri-apps/plugin-fs";
import type { NoteDoc, NoteGroup } from "../utils/noteTypes";
import type { NoteMeta } from "../utils/metadataIO";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { ReconcileState } from "../utils/reconcileFolder";

// Shared mock state. Mocks read these fields at call time so each test can
// swap inputs (watcher callbacks captured, body content returned, own-write
// match result, readMeta payload) without re-registering the mocks.
const refs = vi.hoisted(() => ({
  rootHandler: null as ((e: WatchEvent) => void | Promise<void>) | null,
  metaHandler: null as ((e: WatchEvent) => void | Promise<void>) | null,
  // Per-path readTextFile content returned by the watcher's own read.
  bodyByPath: new Map<string, string>(),
  // Per-path readTextFile fault, if set.
  bodyFaultByPath: new Map<string, Error>(),
  // What isOwnWriteContentMatch should return for the next call.
  ownWriteMatch: false,
  // readMeta result for applyMetaChange tests.
  metaById: new Map<string, NoteMeta>(),
  // Capture for assertions.
  reconcileCalls: 0,
  // Unwritten local membership intents (persistState.pendingGroupMembership).
  pendingMembership: new Map<string, { groupId: string | null; updatedAt: number }>(),
  // What readDiskGroupsSnapshot returns for the watcher's group reload merge.
  diskGroupsSnapshot: {
    entries: {} as Record<string, unknown>,
    metaById: new Map<string, unknown>(),
    collapsedByGroup: {} as Record<string, boolean>,
  },
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  readTextFile: vi.fn(async (p: string) => {
    const fault = refs.bodyFaultByPath.get(p);
    if (fault) throw fault;
    return refs.bodyByPath.get(p) ?? "";
  }),
  watch: vi.fn(async (dir: string, handler: (e: WatchEvent) => void | Promise<void>) => {
    if (dir.endsWith("/.meta")) refs.metaHandler = handler;
    else refs.rootHandler = handler;
    return () => {};
  }),
}));

vi.mock("./useNotesLoader", () => ({
  getNotesDir: vi.fn(async () => "/notes"),
  deriveTitle: (s: string) => s.split("\n")[0]?.replace(/^#+\s*/, "") || "",
  saveManifest: vi.fn(async () => {}),
  // ES module live binding stand-in.
  get migrationInProgress() { return false; },
  metaDirFor: (dir: string) => `${dir}/.meta`,
  groupsPathFor: (dir: string) => `${dir}/.groups.json`,
  syncGroupsSnapshotFromDisk: vi.fn(async () => {}),
  readDiskGroupsSnapshot: vi.fn(async () => refs.diskGroupsSnapshot),
  getPendingGroupSyncSnapshot: vi.fn(() => ({
    tombstoneIds: new Set<string>(),
    membership: refs.pendingMembership,
  })),
  getPendingGroupMembership: vi.fn(() => refs.pendingMembership),
}));

// Plain factory (no importOriginal): the real module calls getCurrentWindow()
// at module scope, which throws outside Tauri.
vi.mock("./useWindowSync", () => ({
  getRetiredGroupIds: vi.fn(() => new Set<string>()),
}));

vi.mock("../utils/reconcileFolder", () => ({
  reconcileFolder: vi.fn(async (
    _fs: unknown,
    _state: unknown,
    _dir: string,
    docs: NoteDoc[],
    groups: NoteGroup[],
  ) => {
    refs.reconcileCalls += 1;
    return { docs, groups, changed: false };
  }),
}));

vi.mock("../utils/fs", () => ({
  tauriFileSystem: {
    readTextFile: vi.fn(async (p: string) => refs.bodyByPath.get(p) ?? ""),
  },
}));

vi.mock("./ownWriteTracker", () => ({
  isOwnWrite: vi.fn(() => false),
  isOwnWriteContentMatch: vi.fn(async () => refs.ownWriteMatch),
  pruneOwnWrites: vi.fn(),
  markOwnWrite: vi.fn(),
  pathKey: (p: string) => p.replace(/\\/g, "/").toLowerCase(),
}));

vi.mock("../utils/fileTimestamps", () => ({
  getFileTimestamps: vi.fn(async () => ({ updatedAt: 2000, createdAt: 1000 })),
}));

vi.mock("../utils/metadataIO", () => ({
  readMeta: vi.fn(async (_fs: unknown, _dir: string, id: string) => refs.metaById.get(id) ?? null),
  invalidateReadAllMetaCache: vi.fn(),
}));

vi.mock("../utils/conflictFileDetector", () => ({
  scanAndAbsorbConflicts: vi.fn(async () => ({ rootCount: 0, trashCount: 0 })),
}));

vi.mock("../utils/conflictBackup", () => ({
  setKnownDiskContent: vi.fn(),
}));

vi.mock("../utils/crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

import { useFileWatcher } from "./useFileWatcher";
import { reconcileFolder } from "../utils/reconcileFolder";
import { invalidateReadAllMetaCache } from "../utils/metadataIO";
import { readDiskGroupsSnapshot } from "./useNotesLoader";
import { libraryStore } from "../utils/libraryStore";
import { setKnownDiskContent } from "../utils/conflictBackup";

const reconcileFolderMock = vi.mocked(reconcileFolder);
const invalidateReadAllMetaCacheMock = vi.mocked(invalidateReadAllMetaCache);
const readDiskGroupsSnapshotMock = vi.mocked(readDiskGroupsSnapshot);

function makeDoc(id: string, overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    id,
    filePath: `/notes/${id}.md`,
    fileName: `Note ${id}`,
    isDirty: false,
    content: "",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeGroup(id: string, noteIds: string[]): NoteGroup {
  return {
    id,
    name: `Group ${id}`,
    noteIds,
    collapsed: false,
  } as NoteGroup;
}

function makeMeta(id: string, overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    version: 2,
    id,
    fileName: `Note ${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    groupId: null,
    trashedAt: null,
    ...overrides,
  };
}

function makeTiptapRef(): React.RefObject<TiptapEditorHandle | null> {
  return {
    current: {
      getEditor: () => ({
        storage: { documentContext: { noteId: null } },
      }),
      openDocument: vi.fn(),
      invalidateDocumentSession: vi.fn(),
    } as unknown as TiptapEditorHandle,
  };
}

function renderWatcher(opts: {
  docs: NoteDoc[];
  groups?: NoteGroup[];
  activeIndex?: number;
  activeDocId?: string | null;
  // Most tests only inspect the queued updaters, so the default setDocs
  // discards them. Pass one that APPLIES them when the test needs the hook to
  // observe whether a commit actually landed.
  setDocs?: React.Dispatch<React.SetStateAction<NoteDoc[]>> & ReturnType<typeof vi.fn>;
}) {
  const setDocs = opts.setDocs
    ?? (vi.fn() as unknown as React.Dispatch<React.SetStateAction<NoteDoc[]>> & ReturnType<typeof vi.fn>);
  const setGroups = vi.fn();
  const setActiveIndex = vi.fn();
  const tiptapRef = makeTiptapRef();
  const reconcileState: ReconcileState = { bodyMissing: new Map(), trashOnlyLiveMeta: new Map(), trashedMetaWithRoot: new Map() };
  const docs = opts.docs;
  const groups = opts.groups ?? [];
  const activeIndex = opts.activeIndex ?? 0;
  const activeDocId = opts.activeDocId ?? docs[activeIndex]?.id ?? null;

  renderHook(() =>
    useFileWatcher(
      docs,
      setDocs,
      groups,
      setGroups,
      activeIndex,
      activeDocId,
      setActiveIndex,
      tiptapRef,
      "en",
      true,
      reconcileState,
    ),
  );
  return { setDocs, setGroups, setActiveIndex, tiptapRef };
}

async function waitForRootHandler() {
  await waitFor(() => expect(refs.rootHandler).not.toBeNull(), { timeout: 1000 });
}

async function waitForMetaHandler() {
  await waitFor(() => expect(refs.metaHandler).not.toBeNull(), { timeout: 1000 });
}

beforeEach(() => {
  // performReconcile baselines against the canonical store, not React props;
  // give each test a fresh, empty directory state so tokens don't leak across.
  libraryStore.clearDirectory();
  refs.rootHandler = null;
  refs.metaHandler = null;
  refs.bodyByPath = new Map();
  refs.bodyFaultByPath = new Map();
  refs.ownWriteMatch = false;
  refs.metaById = new Map();
  refs.reconcileCalls = 0;
  refs.diskGroupsSnapshot = { entries: {}, metaById: new Map(), collapsedByGroup: {} };
  refs.pendingMembership = new Map();
});

afterEach(() => {
  vi.clearAllMocks();
});


describe("useFileWatcher — isDirty protection", () => {
  // The most important invariant in the watcher: if the user is mid-edit on
  // a note and a cloud-sync write arrives for the same file, the watcher must
  // NOT overwrite the dirty in-memory content. Losing this guard silently
  // discards whatever the user has typed since their last save.
  it("does not update setDocs when a watcher event arrives for a doc with isDirty=true", async () => {
    const dirtyDoc = makeDoc("a", { isDirty: true, content: "user-edits-in-progress" });
    refs.bodyByPath.set(dirtyDoc.filePath, "remote-content-that-must-not-overwrite");
    const { setDocs } = renderWatcher({ docs: [dirtyDoc] });
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: [dirtyDoc.filePath],
        attrs: {},
      } as unknown as WatchEvent);
    });

    // setDocs may be called for the unrelated reconcile pass; what matters
    // is that no updater wrote remote content over the dirty in-memory body.
    for (const call of setDocs.mock.calls) {
      const updater = call[0];
      if (typeof updater !== "function") continue;
      const result = updater([dirtyDoc]);
      // Either the updater returns the same array (unchanged) or, if it does
      // produce a new array, the dirty doc's content must not be the remote.
      const stillDirty = result.find((d: NoteDoc) => d.id === "a");
      expect(stillDirty?.content).not.toBe("remote-content-that-must-not-overwrite");
    }
  });
});

describe("useFileWatcher — isDirty race protection (dirty during await)", () => {
  // Regression for the TOCTOU gap: the top-of-loop isDirty check runs on a
  // pre-await snapshot. If the user starts typing while readTextFile /
  // getFileTimestamps are in flight (a slow OneDrive placeholder hydration can
  // take seconds), the setDocs updater must STILL refuse to overwrite the
  // now-dirty body. Without the in-updater re-check the keystrokes are lost.
  it("does not overwrite content when the doc becomes dirty during the async read", async () => {
    // Doc starts clean, so it passes the top-of-loop guard and reaches setDocs.
    const cleanDoc = makeDoc("a", { isDirty: false, content: "old-body" });
    refs.bodyByPath.set(cleanDoc.filePath, "genuine-remote-body");
    const { setDocs } = renderWatcher({ docs: [cleanDoc] });
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: [cleanDoc.filePath],
        attrs: {},
      } as unknown as WatchEvent);
    });

    // The body updater was queued. Simulate the user having typed during the
    // await by applying it against a now-dirty prev — it must return prev
    // unchanged rather than clobbering the in-progress edits.
    const bodyUpdaters = setDocs.mock.calls
      .map((c) => c[0])
      .filter((u): u is (prev: NoteDoc[]) => NoteDoc[] => typeof u === "function");
    expect(bodyUpdaters.length).toBeGreaterThan(0);

    const dirtyPrev = [makeDoc("a", { isDirty: true, content: "user-edits" })];
    for (const updater of bodyUpdaters) {
      const result = updater(dirtyPrev);
      const a = result.find((d) => d.id === "a");
      expect(a?.content).toBe("user-edits");
      expect(a?.isDirty).toBe(true);
    }
  });
});

describe("useFileWatcher — conflict baseline follows the commit, not the read", () => {
  // The conflict baseline is what backupIfRemoteWroteFirst compares the disk
  // against to decide whether a save would destroy an unseen remote version.
  // Recording the incoming remote body as the baseline BEFORE the in-updater
  // dirty re-check meant that when the user started typing during the awaits,
  // the watcher kept their body (correctly) but still moved the baseline onto
  // the remote body it had just declined. The next autosave then found
  // disk === lastKnown, skipped the .conflicts copy, and overwrote the remote
  // version with nothing kept anywhere.
  const setKnownDiskContentMock = setKnownDiskContent as ReturnType<typeof vi.fn>;

  /** A setDocs that actually applies updaters against a controlled prev. */
  function applyingSetDocs(prev: NoteDoc[]) {
    const state = { docs: prev };
    const fn = vi.fn((update: React.SetStateAction<NoteDoc[]>) => {
      state.docs = typeof update === "function" ? update(state.docs) : update;
    }) as unknown as React.Dispatch<React.SetStateAction<NoteDoc[]>> & ReturnType<typeof vi.fn>;
    return { fn, state };
  }

  async function fireModify(path: string) {
    await act(async () => {
      await refs.rootHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: [path],
        attrs: {},
      } as unknown as WatchEvent);
    });
  }

  it("does not move the baseline when the doc turned dirty during the await", async () => {
    const doc = makeDoc("a", { isDirty: false, content: "old-body" });
    refs.bodyByPath.set(doc.filePath, "genuine-remote-body");
    // The hook sees a clean doc at the top of the loop; by the time its
    // updater runs the user has typed, so the store holds a dirty body.
    const { fn } = applyingSetDocs([makeDoc("a", { isDirty: true, content: "user-edits" })]);
    setKnownDiskContentMock.mockClear();
    renderWatcher({ docs: [doc], setDocs: fn });
    await waitForRootHandler();

    await fireModify(doc.filePath);

    expect(setKnownDiskContentMock).not.toHaveBeenCalledWith(doc.filePath, "genuine-remote-body");
  });

  it("moves the baseline once the remote body is actually adopted", async () => {
    const doc = makeDoc("a", { isDirty: false, content: "old-body" });
    refs.bodyByPath.set(doc.filePath, "genuine-remote-body");
    const { fn } = applyingSetDocs([makeDoc("a", { isDirty: false, content: "old-body" })]);
    setKnownDiskContentMock.mockClear();
    renderWatcher({ docs: [doc], setDocs: fn });
    await waitForRootHandler();

    await fireModify(doc.filePath);

    expect(setKnownDiskContentMock).toHaveBeenCalledWith(doc.filePath, "genuine-remote-body");
  });
});

describe("useFileWatcher — own-write echo skip", () => {
  // markOwnWrite + isOwnWriteContentMatch is the mechanism that prevents
  // every autosave write from triggering a watcher loop. If broken, each
  // local save fires a watcher event whose body hash matches our last
  // write, and we'd push the same content through setDocs — possibly with
  // a different updatedAt — every keystroke's save would cascade.
  it("does not update setDocs when isOwnWriteContentMatch returns true", async () => {
    const doc = makeDoc("a", { content: "current-body" });
    refs.bodyByPath.set(doc.filePath, "current-body-echoed-back");
    refs.ownWriteMatch = true; // critical: simulates "this is our own write"
    const { setDocs } = renderWatcher({ docs: [doc] });
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: [doc.filePath],
        attrs: {},
      } as unknown as WatchEvent);
    });

    // setDocs must not have been called with a body update for this doc.
    // A content-hash-confirmed echo is also the one safe case where the full
    // folder reconcile can be skipped entirely.
    expect(setDocs).not.toHaveBeenCalled();
    expect(reconcileFolderMock).not.toHaveBeenCalled();
  });

  it("updates setDocs when isOwnWriteContentMatch returns false (sanity check)", async () => {
    // Mirror test: without the own-write match, a real remote change DOES
    // reach setDocs. This proves the "skip" assertion above isn't a false
    // positive from some other guard.
    const doc = makeDoc("a", { content: "old-body" });
    refs.bodyByPath.set(doc.filePath, "genuine-remote-body");
    refs.ownWriteMatch = false;
    const { setDocs } = renderWatcher({ docs: [doc] });
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: [doc.filePath],
        attrs: {},
      } as unknown as WatchEvent);
    });

    expect(setDocs).toHaveBeenCalled();
    expect(reconcileFolderMock).toHaveBeenCalledTimes(1);
  });

  it("ignores atomic body temp-file events", async () => {
    renderWatcher({ docs: [makeDoc("a")] });
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: ["/notes/a.md.tmp"],
        attrs: {},
      } as unknown as WatchEvent);
    });

    expect(reconcileFolderMock).not.toHaveBeenCalled();
  });
});

describe("useFileWatcher — own meta echo skip", () => {
  it("skips both the partial apply and full reconcile for an exact own-write hash", async () => {
    const doc = makeDoc("a");
    const metaPath = "/notes/.meta/a.json";
    refs.bodyByPath.set(metaPath, JSON.stringify(makeMeta("a")));
    refs.ownWriteMatch = true;
    const { setDocs, setGroups } = renderWatcher({ docs: [doc] });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: [metaPath],
        attrs: {},
      } as unknown as WatchEvent);
    });

    expect(setDocs).not.toHaveBeenCalled();
    expect(setGroups).not.toHaveBeenCalled();
    expect(reconcileFolderMock).not.toHaveBeenCalled();
  });

  it("keeps the full reconcile for an unreadable own-timestamp event", async () => {
    const { isOwnWrite } = await import("./ownWriteTracker");
    vi.mocked(isOwnWrite).mockReturnValueOnce(true);
    const doc = makeDoc("a");
    const metaPath = "/notes/.meta/a.json";
    refs.bodyFaultByPath.set(metaPath, new Error("locked"));
    renderWatcher({ docs: [doc] });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!({
        type: { remove: { kind: "file" } },
        paths: [metaPath],
        attrs: {},
      } as unknown as WatchEvent);
    });

    expect(reconcileFolderMock).toHaveBeenCalledTimes(1);
  });

  it("ignores atomic metadata temp-file events", async () => {
    renderWatcher({ docs: [makeDoc("a")] });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: ["/notes/.meta/a.json.tmp"],
        attrs: {},
      } as unknown as WatchEvent);
    });

    expect(reconcileFolderMock).not.toHaveBeenCalled();
  });
});

describe("useFileWatcher — meta trashed propagates to group removal", () => {
  // Multi-device flow: another machine moves a note to trash. The remote
  // writes the doc's .meta sidecar with trashedAt != null. This window's
  // meta watcher fires applyMetaChange, which must derive targetGroupId =
  // null (because trashedAt != null) and remove the id from any group's
  // noteIds. If broken, the sidebar shows a zombie entry that is also in
  // trash — clicking it leads to an empty pane.
  it("removes the doc from its group when applyMetaChange sees trashedAt set", async () => {
    const doc = makeDoc("a");
    const groupA = makeGroup("g1", ["a", "b"]);
    const metaPath = "/notes/.meta/a.json";
    // readTextFile in handleMetaEvent dedupes against own writes; return a
    // raw JSON body. isOwnWriteContentMatch is forced to false (default).
    refs.bodyByPath.set(metaPath, JSON.stringify({
      version: 2,
      id: "a",
      fileName: "Note a",
      createdAt: 1000,
      updatedAt: 3000,
      groupId: "g1",
      trashedAt: 3000,
    }));
    refs.metaById.set("a", makeMeta("a", { groupId: "g1", trashedAt: 3000, updatedAt: 3000 }));
    const { setGroups } = renderWatcher({ docs: [doc], groups: [groupA] });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: [metaPath],
        attrs: {},
      } as unknown as WatchEvent);
    });

    // applyMetaChange calls setGroups with an updater. Apply it manually to
    // confirm the result drops "a" from g1's noteIds.
    const setGroupsUpdaters = setGroups.mock.calls
      .map((c) => c[0])
      .filter((u): u is (prev: NoteGroup[]) => NoteGroup[] => typeof u === "function");
    expect(setGroupsUpdaters.length).toBeGreaterThan(0);

    const after = setGroupsUpdaters.reduce<NoteGroup[]>(
      (acc, updater) => updater(acc),
      [groupA],
    );
    const g1 = after.find((g) => g.id === "g1");
    expect(g1).toBeDefined();
    expect(g1!.noteIds).toEqual(["b"]);
  });
});

describe("useFileWatcher — applyMetaChange respects unwritten local moves", () => {
  const metaEvent = (path: string) => ({
    type: { modify: { kind: "data", mode: "any" } },
    paths: [path],
    attrs: {},
  } as unknown as WatchEvent);

  // Regression: a peer rewriting this note's sidecar for an unrelated reason
  // (rename/pin/color) carries the note's OLD groupId — its own persist reads
  // groupId from disk, not from the membership delta it just received. The
  // watcher adopted it and yanked the note back to its pre-move group until
  // the next periodic reconcile (up to 60s). An unwritten local intent wins.
  it("keeps a pending local move when a peer sidecar carries the stale groupId", async () => {
    refs.metaById.set("a", makeMeta("a", { groupId: "g1" }));
    refs.pendingMembership.set("a", { groupId: "g2", updatedAt: 5000 });
    const { setGroups } = renderWatcher({
      docs: [makeDoc("a")],
      groups: [makeGroup("g1", []), makeGroup("g2", ["a"])],
    });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!(metaEvent("/notes/.meta/a.json"));
    });

    const updaters = setGroups.mock.calls
      .map((c) => c[0])
      .filter((u): u is (prev: NoteGroup[]) => NoteGroup[] => typeof u === "function");
    // The membership branch must actually have run: the seed below equals the
    // expected result, so without this the test would also pass on an early
    // return or a throw before setGroups.
    expect(updaters.length).toBeGreaterThan(0);
    const after = updaters.reduce<NoteGroup[]>(
      (acc, u) => u(acc),
      [makeGroup("g1", []), makeGroup("g2", ["a"])],
    );
    expect(after.find((g) => g.id === "g2")!.noteIds).toEqual(["a"]);
    expect(after.find((g) => g.id === "g1")!.noteIds).toEqual([]);
  });

  it("still adopts the sidecar group when there is no pending local move", async () => {
    refs.metaById.set("a", makeMeta("a", { groupId: "g1" }));
    const { setGroups } = renderWatcher({
      docs: [makeDoc("a")],
      groups: [makeGroup("g1", []), makeGroup("g2", ["a"])],
    });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!(metaEvent("/notes/.meta/a.json"));
    });

    const updaters = setGroups.mock.calls
      .map((c) => c[0])
      .filter((u): u is (prev: NoteGroup[]) => NoteGroup[] => typeof u === "function");
    const after = updaters.reduce<NoteGroup[]>(
      (acc, u) => u(acc),
      [makeGroup("g1", []), makeGroup("g2", ["a"])],
    );
    expect(after.find((g) => g.id === "g1")!.noteIds).toEqual(["a"]);
    expect(after.find((g) => g.id === "g2")!.noteIds).toEqual([]);
  });

  it("a remote trash still ungroups the note, outranking the pending move", async () => {
    refs.metaById.set("a", makeMeta("a", { groupId: "g1", trashedAt: 9000 }));
    refs.pendingMembership.set("a", { groupId: "g2", updatedAt: 5000 });
    const { setGroups } = renderWatcher({
      docs: [makeDoc("a")],
      groups: [makeGroup("g2", ["a"])],
    });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!(metaEvent("/notes/.meta/a.json"));
    });

    const updaters = setGroups.mock.calls
      .map((c) => c[0])
      .filter((u): u is (prev: NoteGroup[]) => NoteGroup[] => typeof u === "function");
    const after = updaters.reduce<NoteGroup[]>((acc, u) => u(acc), [makeGroup("g2", ["a"])]);
    expect(after.find((g) => g.id === "g2")!.noteIds).toEqual([]);
  });
});

describe("useFileWatcher — group reload merges instead of overwriting", () => {
  const GROUPS_EVENT = {
    type: { modify: { kind: "data", mode: "any" } },
    paths: ["/notes/.groups.json"],
    attrs: {},
  } as unknown as WatchEvent;

  // Regression: reloadGroupsFromDisk used to call setGroups(next) with the
  // absolute disk-derived array. Its reads take seconds on a cloud folder;
  // a local persist or peer groups-updated delta committing to the store in
  // that window was erased — and because syncGroupsSnapshotFromDisk had just
  // reset the write snapshot to disk state, the reverted store looked
  // snapshot-equal at persist time and the change was never written (silent,
  // durable loss). The reload must commit a functional clock merge instead.
  it("commits the disk reload as a functional clock merge, not an absolute array", async () => {
    refs.diskGroupsSnapshot = {
      entries: {
        g1: { id: "g1", name: "Stale disk", orderKey: "a", orderUpdatedAt: 1000, updatedAt: 1000, createdAt: 1000, deletedAt: null },
        "g-disk": { id: "g-disk", name: "From peer", orderKey: "b", orderUpdatedAt: 1000, updatedAt: 1000, createdAt: 1000, deletedAt: null },
      },
      metaById: new Map(),
      collapsedByGroup: {},
    };
    const { setGroups } = renderWatcher({ docs: [] });
    await waitForRootHandler();
    await act(async () => {
      await refs.rootHandler!(GROUPS_EVENT);
    });

    // The old code passed an absolute array here.
    expect(setGroups.mock.calls.some((c) => Array.isArray(c[0]))).toBe(false);
    const updater = setGroups.mock.calls
      .map((c) => c[0])
      .find((u): u is (prev: NoteGroup[]) => NoteGroup[] => typeof u === "function");
    expect(updater).toBeDefined();

    // Run the committed updater against a prev that moved during the reads:
    // a concurrent local rename (newer clock) and a locally created group
    // absent from disk must BOTH survive, while the disk-only group lands.
    const prev: NoteGroup[] = [
      { id: "g1", name: "Local newer", noteIds: [], collapsed: true, createdAt: 1000, orderKey: "a", orderUpdatedAt: 1000, updatedAt: 2000 },
      { id: "g-local", name: "Fresh create", noteIds: [], collapsed: false, createdAt: 3000, orderKey: "z", orderUpdatedAt: 3000, updatedAt: 3000 },
    ];
    const merged = updater!(prev);
    expect(merged.map((g) => g.id)).toEqual(["g1", "g-disk", "g-local"]);
    expect(merged.find((g) => g.id === "g1")!.name).toBe("Local newer");
    expect(merged.find((g) => g.id === "g1")!.collapsed).toBe(true);
  });
});

describe("useFileWatcher — reconcile drift barrier (P0-5)", () => {
  // A cloud reconcile awaits multi-second disk reads on a stale docs snapshot.
  // If the user creates/deletes a note during that window, the full-folder
  // result no longer matches current state. Force-replacing via setDocs would
  // drop the freshly created note (and, symmetrically, resurrect a deleted one
  // while racing its meta write). The watcher must detect the drift and abandon
  // the stale commit instead.
  function renderWatcherWithRerender(initialDocs: NoteDoc[]) {
    const setDocs = vi.fn();
    const setGroups = vi.fn();
    const setActiveIndex = vi.fn();
    const tiptapRef = makeTiptapRef();
    const reconcileState: ReconcileState = { bodyMissing: new Map(), trashOnlyLiveMeta: new Map(), trashedMetaWithRoot: new Map() };
    const { rerender, unmount } = renderHook(
      (p: { docs: NoteDoc[]; groups: NoteGroup[]; activeIndex: number; activeDocId: string | null }) =>
        useFileWatcher(
          p.docs, setDocs, p.groups, setGroups,
          p.activeIndex, p.activeDocId, setActiveIndex,
          tiptapRef, "en", true, reconcileState,
        ),
      { initialProps: { docs: initialDocs, groups: [], activeIndex: 0, activeDocId: initialDocs[0]?.id ?? null } },
    );
    return { setDocs, setGroups, setActiveIndex, rerender, unmount };
  }

  // A non-.md path drives handleRootEvent straight to runReconcile with no
  // body-loop side effects, isolating the reconcile commit path.
  const IDLE_EVENT = {
    type: { modify: { kind: "data", mode: "any" } },
    paths: ["/notes/unrelated.txt"],
    attrs: {},
  } as unknown as WatchEvent;

  it("abandons the stale result when docs changed during the reconcile await", async () => {
    let releaseReconcile: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const docsA = [makeDoc("a")];
    // Result derived from the pre-mutation snapshot: it drops the not-yet-known
    // "b-new" and (as a stale full-folder view would) reintroduces a ghost.
    reconcileFolderMock.mockImplementationOnce(async () => {
      await gate;
      return { docs: [makeDoc("a"), makeDoc("ghost")], groups: [], changed: true };
    });

    libraryStore.seedDirectory("/notes", {
      docs: docsA, groups: [], trashedNotes: [], activeNoteId: "a",
    });
    const { setDocs, setGroups, rerender, unmount } = renderWatcherWithRerender(docsA);
    await waitForRootHandler();

    // Start the reconcile and let handleRootEvent progress through its awaits
    // (getNotesDir, scanAndAbsorbConflicts) until reconcileFolder is actually
    // invoked — at which point runReconcile has already captured its baseline
    // and is now parked on the gate. This ordering is what the test hinges on.
    let handlerDone: Promise<unknown> = Promise.resolve();
    await act(async () => {
      handlerDone = Promise.resolve(refs.rootHandler!(IDLE_EVENT));
      for (let i = 0; i < 20 && reconcileFolderMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
    });
    expect(reconcileFolderMock).toHaveBeenCalledTimes(1);

    // Concurrent local mutation mid-await: the user creates "b-new" (Ctrl+N).
    // Every local mutation commits to the canonical store first (bumping its
    // revision token) and only then re-renders the projections.
    await act(async () => {
      libraryStore.commit({ docs: [makeDoc("a"), makeDoc("b-new")] }, "local");
      rerender({ docs: [makeDoc("a"), makeDoc("b-new")], groups: [], activeIndex: 1, activeDocId: "b-new" });
    });

    // Release the gate; the reconcile now tries to commit its stale result.
    await act(async () => {
      releaseReconcile!();
      await handlerDone;
    });

    // The barrier must have fired: no full-array replace (that is the only path
    // that would drop "b-new" / resurrect "ghost"). Body-loop updaters are
    // functions; a stale commit is a plain array argument.
    const arrayReplace = setDocs.mock.calls.find((c) => Array.isArray(c[0]));
    expect(arrayReplace).toBeUndefined();
    const groupsReplace = setGroups.mock.calls.find((c) => Array.isArray(c[0]));
    expect(groupsReplace).toBeUndefined();

    unmount();
  });

  // Regression for the commit-to-render gap: a peer-window commit lands in the
  // canonical store synchronously (Tauri listener → commitLibraryFromRemote),
  // but the docsRef projection only refreshes on the NEXT render. If the
  // reconcile await resolves before that render, a ref-identity drift check
  // sees nothing and the absolute setDocs(reconciledDocs) erases the peer's
  // note from the store. The guard must watch the store token, not React refs.
  it("abandons the stale result when the store moved but React has not re-rendered", async () => {
    let releaseReconcile: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const docsA = [makeDoc("a")];
    libraryStore.seedDirectory("/notes", {
      docs: docsA, groups: [], trashedNotes: [], activeNoteId: "a",
    });
    // Full-folder view derived from the pre-peer-commit baseline: no "peer-new".
    reconcileFolderMock.mockImplementationOnce(async () => {
      await gate;
      return { docs: [makeDoc("a")], groups: [], changed: true };
    });

    const { setDocs, setGroups, unmount } = renderWatcherWithRerender(docsA);
    await waitForRootHandler();

    let handlerDone: Promise<unknown> = Promise.resolve();
    await act(async () => {
      handlerDone = Promise.resolve(refs.rootHandler!(IDLE_EVENT));
      for (let i = 0; i < 20 && reconcileFolderMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
    });
    expect(reconcileFolderMock).toHaveBeenCalledTimes(1);

    // Peer-window commit mid-await: the store gains "peer-new" synchronously.
    // Deliberately NO rerender — the render that would refresh docsRef has not
    // flushed yet, which is exactly the window a ref-identity check misses.
    libraryStore.commit({ docs: [makeDoc("a"), makeDoc("peer-new")] }, "remote");

    await act(async () => {
      releaseReconcile!();
      await handlerDone;
    });

    // The stale full-array replace must be abandoned — committing it would
    // have erased "peer-new" from the canonical store.
    expect(setDocs.mock.calls.find((c) => Array.isArray(c[0]))).toBeUndefined();
    expect(setGroups.mock.calls.find((c) => Array.isArray(c[0]))).toBeUndefined();

    unmount();
  });

  it("abandons the stale result when a groups-only store commit races the await", async () => {
    let releaseReconcile: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const docsA = [makeDoc("a")];
    libraryStore.seedDirectory("/notes", {
      docs: docsA, groups: [], trashedNotes: [], activeNoteId: "a",
    });
    reconcileFolderMock.mockImplementationOnce(async () => {
      await gate;
      return { docs: [makeDoc("a")], groups: [], changed: true };
    });

    const { setDocs, setGroups, unmount } = renderWatcherWithRerender(docsA);
    await waitForRootHandler();

    let handlerDone: Promise<unknown> = Promise.resolve();
    await act(async () => {
      handlerDone = Promise.resolve(refs.rootHandler!(IDLE_EVENT));
      for (let i = 0; i < 20 && reconcileFolderMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
    });
    expect(reconcileFolderMock).toHaveBeenCalledTimes(1);

    // A peer group commit also bumps the revision; the stale reconcile result
    // (derived from a zero-group baseline) would erase it.
    libraryStore.commit({ groups: [makeGroup("g-peer", [])] }, "remote");

    await act(async () => {
      releaseReconcile!();
      await handlerDone;
    });

    expect(setDocs.mock.calls.find((c) => Array.isArray(c[0]))).toBeUndefined();
    expect(setGroups.mock.calls.find((c) => Array.isArray(c[0]))).toBeUndefined();
    unmount();
  });

  it("abandons the stale result when the directory generation moves mid-await", async () => {
    let releaseReconcile: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const docsA = [makeDoc("a")];
    libraryStore.seedDirectory("/notes", {
      docs: docsA, groups: [], trashedNotes: [], activeNoteId: "a",
    });
    reconcileFolderMock.mockImplementationOnce(async () => {
      await gate;
      return { docs: [makeDoc("a")], groups: [], changed: true };
    });

    const { setDocs, unmount } = renderWatcherWithRerender(docsA);
    await waitForRootHandler();

    let handlerDone: Promise<unknown> = Promise.resolve();
    await act(async () => {
      handlerDone = Promise.resolve(refs.rootHandler!(IDLE_EVENT));
      for (let i = 0; i < 20 && reconcileFolderMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
    });
    expect(reconcileFolderMock).toHaveBeenCalledTimes(1);

    // Directory switch mid-await: the store now describes a different folder.
    // The generation half of the token must abandon the pass.
    libraryStore.seedDirectory("/other", {
      docs: [makeDoc("z")], groups: [], trashedNotes: [], activeNoteId: "z",
    });

    await act(async () => {
      releaseReconcile!();
      await handlerDone;
    });

    expect(setDocs.mock.calls.find((c) => Array.isArray(c[0]))).toBeUndefined();
    unmount();
  });

  it("commits the reconcile result when no local mutation races the await", async () => {
    const docsA = [makeDoc("a")];
    libraryStore.seedDirectory("/notes", {
      docs: docsA, groups: [], trashedNotes: [], activeNoteId: "a",
    });
    const reconciled = [makeDoc("a"), makeDoc("remote-new")];
    reconcileFolderMock.mockImplementationOnce(async () => ({
      docs: reconciled, groups: [], changed: true,
    }));

    const { setDocs, unmount } = renderWatcherWithRerender(docsA);
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!(IDLE_EVENT);
    });

    // No drift: the reconciled full-folder array is committed as-is.
    const arrayReplace = setDocs.mock.calls.find((c) => Array.isArray(c[0]));
    expect(arrayReplace).toBeDefined();
    expect((arrayReplace![0] as NoteDoc[]).map((d) => d.id)).toEqual(["a", "remote-new"]);

    unmount();
  });

  it("serializes overlapping requests and coalesces them into one follow-up pass", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let activePasses = 0;
    let maxActivePasses = 0;
    const docsA = [makeDoc("a")];

    reconcileFolderMock
      .mockImplementationOnce(async (_fs, _state, _dir, docs, groups) => {
        activePasses += 1;
        maxActivePasses = Math.max(maxActivePasses, activePasses);
        await firstGate;
        activePasses -= 1;
        return { docs, groups, changed: false };
      })
      .mockImplementationOnce(async (_fs, _state, _dir, docs, groups) => {
        activePasses += 1;
        maxActivePasses = Math.max(maxActivePasses, activePasses);
        activePasses -= 1;
        return { docs, groups, changed: false };
      });

    const { unmount } = renderWatcherWithRerender(docsA);
    await waitForRootHandler();

    let requests: Promise<unknown>[] = [];
    await act(async () => {
      requests = [
        Promise.resolve(refs.rootHandler!(IDLE_EVENT)),
        Promise.resolve(refs.rootHandler!(IDLE_EVENT)),
        Promise.resolve(refs.rootHandler!(IDLE_EVENT)),
      ];
      for (let i = 0; i < 20 && reconcileFolderMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
    });
    expect(reconcileFolderMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst!();
      await Promise.all(requests);
    });

    expect(reconcileFolderMock).toHaveBeenCalledTimes(2);
    expect(maxActivePasses).toBe(1);
    unmount();
  });
});

describe("useFileWatcher — convergence flows drop the readAllMeta cache first", () => {
  // Regression for the within-TTL clobber: a reconcile fired by a foreign
  // event used to consume sidecars cached by an autosave up to 500ms earlier,
  // miss a cloud peer's just-synced sidecar, and re-ingest its body — rewriting
  // the peer's sidecar with stat-derived timestamps and no group. The smoke
  // suite's adoption test pins the disk-level outcome; these pin the
  // production call sites the smoke harness mirrors: the invalidation must
  // land before the flow's sidecar read, not merely somewhere in the pass.
  it("invalidates before reconcileFolder reads sidecars", async () => {
    renderWatcher({ docs: [makeDoc("a")] });
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!({
        type: { create: { kind: "file" } },
        paths: ["/notes/new-peer-note.md"],
        attrs: {},
      } as unknown as WatchEvent);
    });

    expect(invalidateReadAllMetaCacheMock).toHaveBeenCalledWith(expect.anything(), "/notes");
    expect(reconcileFolderMock).toHaveBeenCalled();
    expect(invalidateReadAllMetaCacheMock.mock.invocationCallOrder[0])
      .toBeLessThan(reconcileFolderMock.mock.invocationCallOrder[0]);
  });

  it("invalidates before the group reload reads sidecars", async () => {
    renderWatcher({ docs: [], groups: [makeGroup("g1", [])] });
    await waitForRootHandler();

    await act(async () => {
      await refs.rootHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: ["/notes/.groups.json"],
        attrs: {},
      } as unknown as WatchEvent);
    });

    expect(readDiskGroupsSnapshotMock).toHaveBeenCalled();
    expect(invalidateReadAllMetaCacheMock.mock.invocationCallOrder[0])
      .toBeLessThan(readDiskGroupsSnapshotMock.mock.invocationCallOrder[0]);
  });
});

describe("useFileWatcher — applyMetaChange keeps a manual title a stale sidecar lacks", () => {
  // doc-renamed reaches this window before the peer's sidecar write does, so
  // the watcher can read the pre-rename sidecar (e.g. an event from the peer's
  // earlier pin write). Adopting it cleared customName on a named note, and
  // the empty-note prunes read customName and delete permanently.
  const applyDocUpdaters = (setDocs: ReturnType<typeof vi.fn>, seed: NoteDoc[]) =>
    setDocs.mock.calls
      .map((c) => c[0])
      .filter((u): u is (prev: NoteDoc[]) => NoteDoc[] => typeof u === "function")
      .reduce<NoteDoc[]>((acc, u) => u(acc), seed);

  it("does not let a sidecar without customName clear it", async () => {
    const live = makeDoc("a", { fileName: "Named", customName: true });
    refs.metaById.set("a", makeMeta("a", { fileName: "Note a", pinned: true, updatedAt: 2000 }));
    const { setDocs } = renderWatcher({ docs: [live] });
    await waitForMetaHandler();

    await act(async () => {
      await refs.metaHandler!({
        type: { modify: { kind: "data", mode: "any" } },
        paths: ["/notes/.meta/a.json"],
        attrs: {},
      } as unknown as WatchEvent);
    });

    const [after] = applyDocUpdaters(setDocs, [live]);
    expect(after).toMatchObject({ fileName: "Named", customName: true, pinned: true, updatedAt: 2000 });
  });
});
