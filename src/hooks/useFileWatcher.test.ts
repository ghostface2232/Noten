import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  loadGroupsFromDisk: vi.fn(async () => [] as NoteGroup[]),
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
}) {
  const setDocs = vi.fn();
  const setGroups = vi.fn();
  const setActiveIndex = vi.fn();
  const tiptapRef = makeTiptapRef();
  const reconcileState: ReconcileState = { bodyMissing: new Map() };
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
  refs.rootHandler = null;
  refs.metaHandler = null;
  refs.bodyByPath = new Map();
  refs.bodyFaultByPath = new Map();
  refs.ownWriteMatch = false;
  refs.metaById = new Map();
  refs.reconcileCalls = 0;
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
    // (reconcile may still call it, but the changed:false mock guarantees
    // reconcile doesn't trigger one.)
    expect(setDocs).not.toHaveBeenCalled();
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
