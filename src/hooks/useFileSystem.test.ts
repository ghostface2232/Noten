import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { NotenError } from "../utils/notenError";
import { libraryStore, type LibrarySnapshot, type LibraryUpdater } from "../utils/libraryStore";
import type { NoteMeta } from "../utils/metadataIO";

// Shared mock state hoisted so any test can flip a fault without re-registering mocks.
const refs = vi.hoisted(() => ({
  writeShouldThrow: null as Error | null,
  // Per-path write fault — lets importFiles fail one source while others succeed.
  writeFaultByPath: new Map<string, Error>(),
  readShouldThrow: null as Error | null,
  // Per-path read fault for the same reason.
  readFaultByPath: new Map<string, Error>(),
  copyFileShouldThrow: null as Error | null,
  editorContent: "",
  editorReads: 0,
  uuidCounter: 0,
  librarySnapshot: null as LibrarySnapshot | null,
  beforeTransactionPublish: null as (() => void | Promise<void>) | null,
  afterTransactionPublish: null as (() => void | Promise<void>) | null,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  readTextFile: vi.fn(async (path: string) => {
    const perPath = refs.readFaultByPath.get(path);
    if (perPath) throw perPath;
    if (refs.readShouldThrow) throw refs.readShouldThrow;
    return "";
  }),
  writeTextFile: vi.fn(async (path: string) => {
    const perPath = refs.writeFaultByPath.get(path);
    if (perPath) throw perPath;
    if (refs.writeShouldThrow) throw refs.writeShouldThrow;
  }),
  remove: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {
    if (refs.copyFileShouldThrow) throw refs.copyFileShouldThrow;
  }),
  exists: vi.fn(async () => false),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

vi.mock("./useNotesLoader", () => ({
  saveManifest: vi.fn(async () => {}),
  deriveTitle: (s: string) => s.split("\n")[0]?.replace(/^#+\s*/, "") || "",
  sortNotes: <T,>(docs: T[]) => docs,
  getNotesDir: vi.fn(async () => "/notes"),
  getFileBaseName: (p: string) => p.split(/[\\/]/).pop() || "",
  ensureTrashDir: vi.fn(async () => "/notes/.trash"),
  getTrashedNotesCache: vi.fn(() => []),
  markGroupAsDeleted: vi.fn(),
  markNoteTitleChanged: vi.fn(),
  markNotesPinnedChanged: vi.fn(),
  markNotesColorChanged: vi.fn(),
  runPersistenceTransaction: vi.fn(async (
    _source: string,
    _targetIds: readonly string[],
    operation: (context: unknown) => Promise<unknown>,
    publish: (result: unknown, generation: number) => Promise<LibrarySnapshot | null> | LibrarySnapshot | null,
    afterCommit?: (result: unknown, committed: LibrarySnapshot) => undefined,
  ) => {
    const snapshot = refs.librarySnapshot;
    if (!snapshot) return { status: "invalidated" };
    const metadata = await import("../utils/metadataIO");
    // Like the real coordinator, an operation failure rejects the transaction;
    // callers must fail closed themselves.
    const result = await operation({
      notesDirectory: "/notes",
      directoryGeneration: snapshot.directoryGeneration,
      snapshot,
      assertCurrent: () => {},
      readNoteMeta: (noteId: string) => metadata.readMeta({} as never, "/notes", noteId),
      mergeNoteMeta: (_noteId: string, canonical: object, disk: object | null) => ({
        ...(disk ?? {}),
        ...canonical,
      }),
      writeNoteMeta: (meta: unknown) => metadata.writeMeta({} as never, "/notes", meta as never, "test-machine"),
      removeNoteMeta: (noteId: string) => metadata.removeMeta({} as never, "/notes", noteId, { strict: true }),
      finalizeNoteMeta: () => {},
      discardNoteIntents: () => {},
    });
    await refs.beforeTransactionPublish?.();
    if (refs.librarySnapshot) {
      const { libraryStore } = await import("../utils/libraryStore");
      const latest = refs.librarySnapshot;
      libraryStore.commit(() => ({
        docs: latest.docs,
        groups: latest.groups,
        trashedNotes: latest.trashedNotes,
        activeNoteId: latest.activeNoteId,
      }), "local");
    }
    const committed = await publish(result, snapshot.directoryGeneration);
    if (committed) {
      try { afterCommit?.(result, committed); } catch { /* post-commit failures do not roll back */ }
    }
    await refs.afterTransactionPublish?.();
    if (refs.librarySnapshot) {
      const { libraryStore } = await import("../utils/libraryStore");
      const latest = refs.librarySnapshot;
      libraryStore.commit(() => ({
        docs: latest.docs,
        groups: latest.groups,
        trashedNotes: latest.trashedNotes,
        activeNoteId: latest.activeNoteId,
      }), "local");
    }
    return committed
      ? { status: "committed", value: result, followupPersisted: true }
      : { status: "invalidated" };
  }),
}));

// remove/exists delegate to the plugin-fs mocks so trash purges (which go
// through tauriFileSystem) see the same per-test faults as direct removes.
vi.mock("../utils/fs", () => ({
  tauriFileSystem: {
    writeTextFile: vi.fn(async () => {}),
    remove: vi.fn(async (path: string, options?: unknown) => {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await (remove as (p: string, o?: unknown) => Promise<void>)(path, options);
    }),
    exists: vi.fn(async (path: string) => {
      const { exists } = await import("@tauri-apps/plugin-fs");
      return exists(path);
    }),
  },
}));

// Body writes (provisionNoteFile / rewriteNoteFile / saveFile) route through
// atomicWriteText (temp+rename). Delegate to the plugin-fs writeTextFile mock
// so the existing writeMock assertions and per-path fault injection still
// observe body writes on their final paths.
vi.mock("../utils/atomicWrite", () => ({
  atomicWriteText: vi.fn(async (_fs: unknown, path: string, content: string) => {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, content);
  }),
}));

vi.mock("../utils/documentTitle", () => ({
  getDefaultDocumentTitle: vi.fn(() => "Untitled"),
}));

vi.mock("../utils/imageAssetUtils", () => ({
  removeNoteAssetDir: vi.fn(async () => {}),
  // Passthrough: return the source content unchanged so duplicateNote tests
  // exercise the note-creation path, not the asset-copy path (covered in
  // imageAssetUtils.test.ts).
  duplicateNoteAssets: vi.fn(async (_dir: string, _src: string, _dst: string, content: string) => content),
}));

vi.mock("./useWindowSync", () => ({
  emitDocCreated: vi.fn(),
  emitDocDeleted: vi.fn(),
  emitDocRenamed: vi.fn(),
  emitGroupsDelta: vi.fn(),
  emitNoteColorUpdated: vi.fn(),
  emitNotePinnedUpdated: vi.fn(),
  emitTrashUpdated: vi.fn(),
}));

vi.mock("./ownWriteTracker", () => ({
  markOwnWrite: vi.fn(),
}));

vi.mock("../utils/conflictBackup", () => ({
  setKnownDiskContent: vi.fn(),
}));

vi.mock("../utils/metadataIO", () => ({
  removeMeta: vi.fn(async () => {}),
  readMeta: vi.fn(async () => null),
  writeMeta: vi.fn(async () => ""),
}));

vi.mock("../utils/crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

vi.mock("../i18n", () => ({
  t: (key: string) => key,
}));

// crypto.randomUUID is needed by newNote / duplicateNote / deleteNote replacement.
// Deterministic IDs make assertions on isDirty/filePath easier to read.
Object.defineProperty(globalThis, "crypto", {
  value: {
    randomUUID: () => `uuid-${++refs.uuidCounter}`,
  },
  configurable: true,
});

// Imports must come AFTER vi.mock() registrations.
import { useFileSystem } from "./useFileSystem";
import * as fsPlugin from "@tauri-apps/plugin-fs";
import * as crashLogModule from "../utils/crashLog";
import * as ownWriteModule from "./ownWriteTracker";
import * as metadataIOModule from "../utils/metadataIO";
import * as conflictBackupModule from "../utils/conflictBackup";
import * as notesLoaderModule from "./useNotesLoader";
import * as windowSyncModule from "./useWindowSync";
import type { FlushResult } from "./useAutoSave";

const writeMock = fsPlugin.writeTextFile as ReturnType<typeof vi.fn>;
const readMock = fsPlugin.readTextFile as ReturnType<typeof vi.fn>;
const copyFileMock = fsPlugin.copyFile as ReturnType<typeof vi.fn>;
const logMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;
const markOwnWriteMock = ownWriteModule.markOwnWrite as ReturnType<typeof vi.fn>;
const markGroupAsDeletedMock = notesLoaderModule.markGroupAsDeleted as ReturnType<typeof vi.fn>;
const saveManifestMock = notesLoaderModule.saveManifest as ReturnType<typeof vi.fn>;
const emitDocCreatedMock = windowSyncModule.emitDocCreated as ReturnType<typeof vi.fn>;
const emitTrashUpdatedMock = windowSyncModule.emitTrashUpdated as ReturnType<typeof vi.fn>;

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

function makeState(overrides: Partial<MarkdownState> = {}): MarkdownState {
  return {
    isDirty: false,
    setIsDirty: vi.fn(),
    primeMarkdown: vi.fn(),
    setFilePath: vi.fn(),
    getCachedMarkdown: vi.fn(() => ""),
    filePath: null,
    ...overrides,
  } as unknown as MarkdownState;
}

interface RenderOpts {
  docs?: NoteDoc[];
  activeIndex?: number;
  state?: MarkdownState;
  groups?: NoteGroup[];
  trashedNotes?: TrashedNote[];
  // Stub editor handle — openDocument tracking lets us assert against the editor.
  openDocument?: ReturnType<typeof vi.fn>;
  invalidateDocumentSession?: ReturnType<typeof vi.fn>;
  focusEditor?: ReturnType<typeof vi.fn>;
  flushDocSave?: (docId: string) => Promise<boolean>;
}

function renderFs(opts: RenderOpts = {}) {
  const docs = opts.docs ?? [makeDoc("a")];
  const state = opts.state ?? makeState();
  // Store-backed, mirroring the production commitDocsUpdate adapter: resolve a
  // functional updater against the canonical store docs and commit the result,
  // so tests observe what actually lands in libraryStore (the sites under test
  // commit functional deltas, not absolute arrays).
  const setDocs = vi.fn((updater: React.SetStateAction<NoteDoc[]>) => {
    const prev = [...libraryStore.getSnapshot().docs];
    const next = typeof updater === "function" ? updater(prev) : updater;
    const unchanged = next.length === prev.length && next.every((d, i) => d === prev[i]);
    if (unchanged) return;
    refs.librarySnapshot = libraryStore.commit({ docs: next }, "local");
  });
  const setActiveIndex = vi.fn();
  // Store-backed like setDocs above, mirroring the production
  // commitGroupsUpdate adapter: clone prev, run the updater, commit unless the
  // updater returned prev itself.
  const setGroups = vi.fn((updater: React.SetStateAction<NoteGroup[]>) => {
    const prev = libraryStore.getSnapshot().groups.map((group) => ({
      ...group,
      noteIds: [...group.noteIds],
    }));
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    refs.librarySnapshot = libraryStore.commit({ groups: next }, "local");
  });
  // Store-backed like setDocs/setGroups, mirroring commitTrashedNotesUpdate.
  const setTrashedNotes = vi.fn((
    updater: TrashedNote[] | ((prev: TrashedNote[]) => TrashedNote[]),
  ) => {
    const prev = [...libraryStore.getSnapshot().trashedNotes];
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    refs.librarySnapshot = libraryStore.commit({ trashedNotes: next }, "local");
  });
  const initialSnapshot = libraryStore.seedDirectory("/notes", {
    docs,
    groups: opts.groups ?? [],
    trashedNotes: opts.trashedNotes ?? [],
    activeNoteId: docs[opts.activeIndex ?? 0]?.id ?? null,
  }, "hydrate");
  refs.librarySnapshot = initialSnapshot;
  const commitLibraryForGeneration = vi.fn((
    directoryGeneration: number,
    update: LibraryUpdater,
  ): LibrarySnapshot | null => {
    const current = refs.librarySnapshot!;
    if (current.directoryGeneration !== directoryGeneration) return null;
    const patch = update(current);
    if (!patch) return current;
    const nextDocs = patch.docs ?? current.docs;
    const nextGroups = patch.groups ?? current.groups;
    const nextTrash = patch.trashedNotes ?? current.trashedNotes;
    const activeNoteId = patch.activeNoteId === undefined ? current.activeNoteId : patch.activeNoteId;
    const committed = libraryStore.commit(() => ({
      docs: nextDocs,
      groups: nextGroups,
      trashedNotes: nextTrash,
      activeNoteId,
    }), "local");
    refs.librarySnapshot = committed;
    setDocs([...committed.docs]);
    setGroups(committed.groups.map((group) => ({ ...group, noteIds: [...group.noteIds] })));
    setTrashedNotes([...committed.trashedNotes]);
    setActiveIndex(committed.activeNoteId ? Math.max(committed.docs.findIndex((doc) => doc.id === committed.activeNoteId), 0) : 0);
    return committed;
  });
  // Mirrors the real contract: a dirty editor that nothing here saved reports
  // failure, an already-clean one reports "clean".
  const flushAutoSave = vi.fn(async (): Promise<FlushResult> => (
    state.isDirty ? { status: "failed", reason: "save-failed" } : { status: "clean" }
  ));
  const flushAutoSaveRef = { current: flushAutoSave };
  const notifyActiveDoc = vi.fn();
  const notifyActiveDocRef = { current: notifyActiveDoc };
  const cancelDocSave = vi.fn();
  const cancelDocSaveRef = { current: cancelDocSave };
  const flushDocSave = opts.flushDocSave ?? vi.fn(async (_docId: string) => true);
  const flushDocSaveRef: React.RefObject<((docId: string) => Promise<boolean>) | null> = { current: flushDocSave };

  const openDocument = opts.openDocument ?? vi.fn();
  const invalidateDocumentSession = opts.invalidateDocumentSession ?? vi.fn();
  const focusEditor = opts.focusEditor ?? vi.fn();
  const tiptapRef = {
    current: {
      getEditor: () => ({ getMarkdown: () => { refs.editorReads += 1; return refs.editorContent; } }),
      openDocument,
      invalidateDocumentSession,
      focus: focusEditor,
    } as unknown as TiptapEditorHandle,
  };

  const { result } = renderHook(() =>
    useFileSystem(
      state,
      tiptapRef,
      docs,
      setDocs,
      opts.activeIndex ?? 0,
      setActiveIndex,
      "en",
      "updated-desc",
      opts.groups ?? [],
      setGroups,
      undefined,
      opts.trashedNotes ?? [],
      setTrashedNotes,
      flushAutoSaveRef,
      notifyActiveDocRef,
      cancelDocSaveRef,
      undefined,
      flushDocSaveRef,
      commitLibraryForGeneration,
    ),
  );

  return {
    result,
    setDocs,
    setActiveIndex,
    setGroups,
    setTrashedNotes,
    flushAutoSave,
    notifyActiveDoc,
    cancelDocSave,
    flushDocSave,
    commitLibraryForGeneration,
    openDocument,
    invalidateDocumentSession,
    focusEditor,
    state,
  };
}

beforeEach(() => {
  refs.writeShouldThrow = null;
  refs.writeFaultByPath = new Map();
  refs.readShouldThrow = null;
  refs.readFaultByPath = new Map();
  refs.copyFileShouldThrow = null;
  refs.editorContent = "";
  refs.editorReads = 0;
  refs.uuidCounter = 0;
  refs.beforeTransactionPublish = null;
  refs.afterTransactionPublish = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// importFiles — batch resilience: one bad file must not abort the whole import.

describe("useFileSystem — importFiles batch resilience", () => {
  it("skips a single read-failure source, logs BODY_READ_FAILED, and imports the rest", async () => {
    refs.readFaultByPath.set("/src/bad.md", new Error("EACCES"));
    readMock.mockImplementation(async (path: string) => {
      const fault = refs.readFaultByPath.get(path);
      if (fault) throw fault;
      return `body of ${path}`;
    });

    const { result, setDocs } = renderFs();
    await act(async () => {
      await result.current.importFiles(["/src/a.md", "/src/bad.md", "/src/c.md"]);
    });

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "BODY_READ_FAILED",
    );
    expect(logged).toBeDefined();
    expect((logged![0] as NotenError).context).toMatchObject({ sourcePath: "/src/bad.md" });

    // setDocs is called by sortAndPersistDocs with the two surviving imports.
    expect(setDocs).toHaveBeenCalled();
    const lastDocs = [...libraryStore.getSnapshot().docs];
    const importedNames = lastDocs.map((d) => d.fileName).filter((n) => n === "a" || n === "c");
    expect(importedNames.sort()).toEqual(["a", "c"]);
  });

  it("skips a single write-failure source, logs SAVE_FAILED, and imports the rest", async () => {
    readMock.mockImplementation(async (path: string) => `body of ${path}`);
    // The provisioned write path is `/notes/<uuid>.md`. Since UUIDs are
    // deterministic in tests (uuid-1, uuid-2, ...), fail the second one.
    refs.writeFaultByPath.set("/notes/uuid-2.md", new Error("ENOSPC"));

    const { result } = renderFs();
    await act(async () => {
      await result.current.importFiles(["/src/a.md", "/src/b.md", "/src/c.md"]);
    });

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(logged).toBeDefined();
    expect((logged![0] as NotenError).context).toMatchObject({ stage: "importFiles" });

    const lastDocs = [...libraryStore.getSnapshot().docs];
    const imported = lastDocs.filter((d) => d.filePath.startsWith("/notes/uuid-"));
    expect(imported.length).toBe(2);
    // None of the committed docs should point at the failed-write path.
    expect(imported.some((d) => d.filePath === "/notes/uuid-2.md")).toBe(false);
  });

  it("when every source fails, does not call setDocs or emit any creation events", async () => {
    readMock.mockImplementation(async () => { throw new Error("EACCES"); });

    const { result, setDocs } = renderFs();
    await act(async () => {
      await result.current.importFiles(["/src/a.md", "/src/b.md"]);
    });

    expect(setDocs).not.toHaveBeenCalled();
  });

  it("adds imported docs to the group the active doc belongs to", async () => {
    readMock.mockImplementation(async (path: string) => `body of ${path}`);
    const active = makeDoc("a", { content: "real note" });
    const groups: NoteGroup[] = [
      { id: "g1", name: "G1", noteIds: ["a"], collapsed: false, createdAt: 1000 },
    ];
    const { result, setGroups } = renderFs({ docs: [active], activeIndex: 0, groups });

    await act(async () => {
      await result.current.importFiles(["/src/b.md", "/src/c.md"]);
    });

    expect(setGroups).toHaveBeenCalled();
    const nextGroups = [...libraryStore.getSnapshot().groups];
    const g1 = nextGroups.find((g) => g.id === "g1")!;
    // The active doc keeps its place; both imports join its group.
    expect(g1.noteIds).toEqual(["a", "uuid-1", "uuid-2"]);
  });

  it("keeps the inherited group when the active doc is an empty placeholder pruned during import", async () => {
    readMock.mockImplementation(async (path: string) => `body of ${path}`);
    // Empty, auto-titled placeholder that is the only member of g1, plus a
    // second note so pruneEmptyCurrentDoc actually prunes the placeholder.
    const placeholder = makeDoc("a", { content: "" });
    const other = makeDoc("b", { content: "real note" });
    const groups: NoteGroup[] = [
      { id: "g1", name: "G1", noteIds: ["a"], collapsed: false, createdAt: 1000 },
    ];
    const { result, setGroups } = renderFs({ docs: [placeholder, other], activeIndex: 0, groups });

    await act(async () => {
      await result.current.importFiles(["/src/c.md"]);
    });

    expect(setGroups).toHaveBeenCalled();
    const nextGroups = [...libraryStore.getSnapshot().groups];
    const g1 = nextGroups.find((g) => g.id === "g1");
    // The group survives the prune and the import lands in it (placeholder gone).
    expect(g1).toBeDefined();
    expect(g1!.noteIds).toEqual(["uuid-1"]);
    // The group must not be tombstoned.
    expect(markGroupAsDeletedMock).not.toHaveBeenCalledWith("g1");
  });

  it("leaves imports ungrouped when the active doc is in no group", async () => {
    readMock.mockImplementation(async (path: string) => `body of ${path}`);
    const active = makeDoc("a", { content: "real note" });
    const groups: NoteGroup[] = [
      { id: "g1", name: "G1", noteIds: ["other"], collapsed: false, createdAt: 1000 },
    ];
    const { result, setGroups } = renderFs({ docs: [active], activeIndex: 0, groups });

    await act(async () => {
      await result.current.importFiles(["/src/b.md"]);
    });

    expect(setGroups).not.toHaveBeenCalled();
  });
});

// newNote — disk-first invariant: if the body write fails, the previous doc
// must be left exactly as it was. No setDocs, no destructive group prune.

describe("useFileSystem — newNote disk-first invariant", () => {
  it("aborts without touching state when provisionNoteFile fails", async () => {
    refs.writeShouldThrow = new Error("ENOSPC");
    const existingDoc = makeDoc("existing", { content: "preserved" });
    const { result, setDocs, setActiveIndex, notifyActiveDoc } = renderFs({
      docs: [existingDoc],
    });

    await act(async () => {
      await result.current.newNote();
    });

    // The write fault fires inside provisionNoteFile, before any state mutation.
    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(logged).toBeDefined();
    expect((logged![0] as NotenError).context).toMatchObject({ stage: "newNote" });

    expect(setDocs).not.toHaveBeenCalled();
    expect(setActiveIndex).not.toHaveBeenCalled();
    expect(notifyActiveDoc).not.toHaveBeenCalled();
  });

  it("focuses the editor after creating a new note", async () => {
    const existingDoc = makeDoc("existing", { content: "Keep me" });
    const { result, focusEditor } = renderFs({ docs: [existingDoc] });

    await act(async () => {
      await result.current.newNote();
    });

    expect(focusEditor).toHaveBeenCalledTimes(1);
  });

  it("replaces an empty auto-titled note in one state commit without an intermediate empty list", async () => {
    const emptyDoc = makeDoc("empty", { content: "", customName: false });
    const { result, setDocs, notifyActiveDoc } = renderFs({ docs: [emptyDoc] });

    await act(async () => {
      await result.current.newNote();
    });

    expect(setDocs).toHaveBeenCalledTimes(1);
    const nextDocs = [...libraryStore.getSnapshot().docs];
    expect(nextDocs).toHaveLength(1);
    expect(nextDocs[0].id).toBe("uuid-1");
    expect(nextDocs[0].fileName).toBe("Untitled");
    expect(notifyActiveDoc).toHaveBeenCalledWith("uuid-1", "/notes/uuid-1.md");
  });

  it("ignores overlapping newNote calls so an empty note cannot spawn duplicates", async () => {
    const emptyDoc = makeDoc("empty", { content: "", customName: false });
    const { result, setDocs } = renderFs({ docs: [emptyDoc] });

    await act(async () => {
      const first = result.current.newNote();
      const second = result.current.newNote();
      await Promise.all([first, second]);
    });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(setDocs).toHaveBeenCalledTimes(1);
    const nextDocs = [...libraryStore.getSnapshot().docs];
    expect(nextDocs).toHaveLength(1);
    expect(nextDocs[0].id).toBe("uuid-1");
  });
});

// duplicateNote — disk-first invariant: source doc untouched on write failure.

describe("useFileSystem — duplicateNote disk-first invariant", () => {
  it("aborts without committing the duplicate when provisionNoteFile fails", async () => {
    refs.writeShouldThrow = new Error("ENOSPC");
    const source = makeDoc("source", { content: "important body" });
    const { result, setDocs, notifyActiveDoc } = renderFs({ docs: [source] });

    await act(async () => {
      await result.current.duplicateNote(0);
    });

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(logged).toBeDefined();
    expect((logged![0] as NotenError).context).toMatchObject({
      stage: "duplicateNote",
      sourceId: "source",
    });

    expect(setDocs).not.toHaveBeenCalled();
    expect(notifyActiveDoc).not.toHaveBeenCalled();
  });
});

// deleteNote — three distinct safety nets:
//   1. trash copyFile failure → deletion aborted (no orphan removal).
//   2. cancelDocSave runs before disk work → no stale autosave.
//   3. last-note replacement write failure → replacement isDirty=true.

describe("useFileSystem — deleteNote trash-copy guard", () => {
  it("aborts deletion when copyFile to .trash fails (no setDocs, no remove)", async () => {
    refs.copyFileShouldThrow = new Error("EACCES");
    // Silence the DEV-only warn so the intentional fault doesn't pollute test output.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const doc = makeDoc("a", { content: "important" });
    const { result, setDocs } = renderFs({ docs: [doc] });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(copyFileMock).toHaveBeenCalledTimes(1);
    expect(setDocs).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("useFileSystem — active-target flush verdicts", () => {
  // A provisioning flush writes the body but changes the doc's filePath, so it
  // reports "provisioned" rather than "saved": destructive callers may proceed,
  // snapshot-holding callers must not mark their stale entry clean. Only
  // "failed" means nothing reached disk.
  it("still deletes an active doc that flushAutoSave provisioned", async () => {
    const pathless = makeDoc("a", { filePath: "", content: "typed", isDirty: true });
    const state = makeState({ isDirty: true });
    const { result, flushAutoSave, flushDocSave } = renderFs({ docs: [pathless, makeDoc("b")], activeIndex: 0, state });
    flushAutoSave.mockImplementation(async () => {
      // Provisioning adopts the path in the store synchronously.
      libraryStore.commit((current) => ({
        docs: current.docs.map((doc) => (doc.id === "a" ? { ...doc, filePath: "/notes/a.md" } : doc)),
      }), "local");
      refs.librarySnapshot = libraryStore.getSnapshot();
      return { status: "provisioned", filePath: "/notes/a.md" };
    });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNote(0);
    });

    expect(deleted).toEqual(["a"]);
    expect(flushDocSave).toHaveBeenCalledWith("a");
    expect(copyFileMock).toHaveBeenCalledWith("/notes/a.md", "/notes/.trash/a.md");
  });

  it("skips a provisioned active doc whose post-provision save is still failing", async () => {
    const pathless = makeDoc("a", { filePath: "", content: "typed", isDirty: true });
    const state = makeState({ isDirty: true });
    const { result, flushAutoSave } = renderFs({
      docs: [pathless, makeDoc("b")],
      activeIndex: 0,
      state,
    });
    // The path was adopted but the body write that followed it failed, so the
    // flush reports failure — the doc is not safe to trash.
    flushAutoSave.mockImplementation(async () => {
      libraryStore.commit((current) => ({
        docs: current.docs.map((doc) => (doc.id === "a" ? { ...doc, filePath: "/notes/a.md" } : doc)),
      }), "local");
      refs.librarySnapshot = libraryStore.getSnapshot();
      return { status: "failed", reason: "save-failed" };
    });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNote(0);
    });

    expect(deleted).toEqual([]);
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it("skips an active doc whose body write genuinely failed", async () => {
    const state = makeState({ isDirty: true });
    const flushDocSave = vi.fn(async (docId: string) => docId !== "a");
    const { result, flushAutoSave } = renderFs({
      docs: [makeDoc("a", { content: "typed", isDirty: true }), makeDoc("b")],
      activeIndex: 0,
      state,
      flushDocSave,
    });
    flushAutoSave.mockResolvedValue({ status: "failed", reason: "save-failed" });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNote(0);
    });

    expect(deleted).toEqual([]);
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it("restores even when flushing the leaving doc reports failure", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      pinned: false,
    };
    const state = makeState({ isDirty: true });
    const { result, flushAutoSave } = renderFs({
      docs: [makeDoc("a", { content: "typed", isDirty: true })],
      state,
      trashedNotes: [trashed],
    });
    flushAutoSave.mockResolvedValue({ status: "failed", reason: "save-failed" });

    await act(async () => {
      await result.current.restoreNote("t1");
    });

    expect(copyFileMock).toHaveBeenCalledWith("/notes/.trash/t1.md", "/notes/t1.md");
    expect(refs.librarySnapshot?.docs.map((doc) => doc.id).sort()).toEqual(["a", "t1"]);
    expect(refs.librarySnapshot?.activeNoteId).toBe("t1");
    // The leaving doc stays dirty; its edits are captured, not marked clean.
    expect(refs.librarySnapshot?.docs.find((doc) => doc.id === "a")?.isDirty).toBe(true);
  });
});

describe("useFileSystem — deleteNotes meta-first ordering", () => {
  const writeMetaMock = metadataIOModule.writeMeta as ReturnType<typeof vi.fn>;
  const readMetaMock = metadataIOModule.readMeta as ReturnType<typeof vi.fn>;
  const removeMetaMock = metadataIOModule.removeMeta as ReturnType<typeof vi.fn>;

  it("persists trashedAt to the sidecar before the body moves to trash", async () => {
    const { result } = renderFs({ docs: [makeDoc("a"), makeDoc("b")], activeIndex: 1 });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    // A crash after the body move but before the sidecar write would leave a
    // live meta whose only body is in .trash — invisible in both the list and
    // the trash UI. The sidecar must flip first.
    expect(writeMetaMock).toHaveBeenCalled();
    expect(copyFileMock).toHaveBeenCalled();
    expect(writeMetaMock.mock.invocationCallOrder[0]).toBeLessThan(copyFileMock.mock.invocationCallOrder[0]);

    const writtenMeta = writeMetaMock.mock.calls[0][2] as { trashedAt: number | null; trashedFromPath: string | null };
    expect(writtenMeta.trashedAt).not.toBeNull();
    expect(writtenMeta.trashedFromPath).toBe("/notes/a.md");
  });

  it("rolls the sidecar back to the previous meta when the trash copy fails", async () => {
    refs.copyFileShouldThrow = new Error("EACCES");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    readMetaMock.mockResolvedValueOnce({
      version: 2, id: "a", fileName: "prev name", createdAt: 1, updatedAt: 1,
      groupId: null, trashedAt: null,
    });

    const { result, setDocs } = renderFs({ docs: [makeDoc("a"), makeDoc("b")], activeIndex: 1 });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    const metas = writeMetaMock.mock.calls.map((c) => c[2] as { fileName: string; trashedAt: number | null });
    expect(metas[0].trashedAt).not.toBeNull();
    expect(metas[1]).toMatchObject({ fileName: "prev name", trashedAt: null });
    expect(setDocs).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("removes the sidecar it created when rollback finds none existed", async () => {
    refs.copyFileShouldThrow = new Error("EACCES");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // readMeta default resolves null → the sidecar did not exist beforehand.

    const { result } = renderFs({ docs: [makeDoc("a"), makeDoc("b")], activeIndex: 1 });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(removeMetaMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), "a", { strict: true });
    warnSpy.mockRestore();
  });

  it("still trashes a note whose sidecar exists but cannot be read, rebuilding it from the doc", async () => {
    readMetaMock.mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input"));

    const { result, setDocs } = renderFs({ docs: [makeDoc("a", { fileName: "Kept title" }), makeDoc("b")], activeIndex: 1 });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNote(0);
    });

    expect(deleted).toEqual(["a"]);
    expect(copyFileMock).toHaveBeenCalledWith("/notes/a.md", "/notes/.trash/a.md");
    const written = writeMetaMock.mock.calls[0][2] as { fileName: string; trashedAt: number | null };
    expect(written).toMatchObject({ fileName: "Kept title" });
    expect(written.trashedAt).not.toBeNull();
    expect(setDocs).toHaveBeenCalledWith([expect.objectContaining({ id: "b" })]);
    expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ code: "META_READ_FAILED" }));
  });

  it("repairs an unreadable sidecar from canonical state on rollback instead of removing it", async () => {
    refs.copyFileShouldThrow = new Error("EACCES");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    readMetaMock.mockRejectedValueOnce(new Error("EBUSY: cloud placeholder"));

    const { result } = renderFs({ docs: [makeDoc("a", { fileName: "Kept title" }), makeDoc("b")], activeIndex: 1 });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(removeMetaMock).not.toHaveBeenCalled();
    const metas = writeMetaMock.mock.calls.map((c) => c[2] as { fileName: string; trashedAt: number | null });
    expect(metas).toHaveLength(2);
    expect(metas[0].trashedAt).not.toBeNull();
    expect(metas[1]).toMatchObject({ fileName: "Kept title", trashedAt: null });
    warnSpy.mockRestore();
  });

  it("keeps the root body and commits deletion-wins when meta rollback fails", async () => {
    refs.copyFileShouldThrow = new Error("EACCES");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    readMetaMock.mockResolvedValueOnce({
      version: 2, id: "a", fileName: "previous", createdAt: 1, updatedAt: 1,
      groupId: null, trashedAt: null,
    });
    writeMetaMock
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("rollback EPERM"));
    const removeBodyMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const { result, setDocs } = renderFs({ docs: [makeDoc("a"), makeDoc("b")], activeIndex: 1 });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNote(0);
    });

    expect(deleted).toEqual(["a"]);
    expect(removeBodyMock).not.toHaveBeenCalledWith("/notes/a.md");
    expect(setDocs).toHaveBeenCalledWith([expect.objectContaining({ id: "b" })]);
    expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ code: "PERSIST_FAILED" }));
    warnSpy.mockRestore();
  });
});

describe("useFileSystem — deleteNote cancels pending autosave", () => {
  it("calls cancelDocSave for the deleted doc id so an in-flight timer cannot orphan-write", async () => {
    const doc = makeDoc("a");
    const { result, cancelDocSave } = renderFs({ docs: [doc] });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    // This is the first thing deleteNote does — protects against the autosave
    // timer firing into a file we're about to move to .trash.
    expect(cancelDocSave).toHaveBeenCalledWith("a");
  });
});

describe("useFileSystem — deleteNote flushes in-flight save", () => {
  it("skips an active target when its final editor flush fails", async () => {
    const state = makeState({ isDirty: true });
    const { result } = renderFs({
      docs: [makeDoc("a"), makeDoc("b")],
      activeIndex: 0,
      state,
      flushDocSave: vi.fn(async () => true),
    });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNote(0);
    });

    expect(deleted).toEqual([]);
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it("flushes the deleted doc's background save before copying it to trash", async () => {
    let releaseSave: (saved: boolean) => void = () => {};
    const flushDocSave = vi.fn(() => {
      if (flushDocSave.mock.calls.length > 1) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        releaseSave = resolve;
      });
    });
    const docA = makeDoc("a", { content: "new body" });
    const docB = makeDoc("b");
    const { result } = renderFs({
      docs: [docA, docB],
      activeIndex: 1,
      flushDocSave,
    });

    let finished = false;
    const deletePromise = act(async () => {
      await result.current.deleteNote(0);
      finished = true;
    });

    await Promise.resolve();
    expect(flushDocSave).toHaveBeenCalledWith("a");
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(finished).toBe(false);

    releaseSave(true);
    await deletePromise;

    expect(copyFileMock).toHaveBeenCalledWith("/notes/a.md", "/notes/.trash/a.md");
    expect(finished).toBe(true);
  });

  it("aborts deletion when the deleted doc cannot be flushed", async () => {
    const flushDocSave = vi.fn(async () => false);
    const docA = makeDoc("a", { content: "new body" });
    const docB = makeDoc("b");
    const { result, cancelDocSave } = renderFs({
      docs: [docA, docB],
      activeIndex: 1,
      flushDocSave,
    });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(flushDocSave).toHaveBeenCalledWith("a");
    expect(cancelDocSave).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
  });
});

describe("useFileSystem — deleteNotes publish-time state", () => {
  it("hands off the editor when the active note changes to a target during I/O", async () => {
    const a = makeDoc("a");
    const b = makeDoc("b");
    const { result, openDocument, notifyActiveDoc } = renderFs({
      docs: [a, b],
      activeIndex: 1,
    });
    refs.beforeTransactionPublish = () => {
      refs.librarySnapshot = { ...refs.librarySnapshot!, activeNoteId: "a", revision: 2 };
    };

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(openDocument).toHaveBeenCalledWith(expect.objectContaining({ noteId: "b" }));
    expect(notifyActiveDoc).toHaveBeenCalledWith("b", "/notes/b.md");
  });

  it("keeps a prepared replacement managed if another note appears before publish", async () => {
    const a = makeDoc("a");
    const remote = makeDoc("remote");
    const { result, setDocs } = renderFs({ docs: [a] });
    refs.beforeTransactionPublish = () => {
      refs.librarySnapshot = {
        ...refs.librarySnapshot!,
        docs: [a, remote],
        activeNoteId: "remote",
        revision: 2,
      };
    };

    await act(async () => {
      await result.current.deleteNote(0);
    });

    const committed = setDocs.mock.calls[setDocs.mock.calls.length - 1]?.[0] as NoteDoc[];
    expect(committed.map((doc) => doc.id).sort()).toEqual(["remote", "uuid-1"]);
  });

  it("drops a failed replacement if another managed note appears before publish", async () => {
    const a = makeDoc("a");
    const remote = makeDoc("remote");
    refs.writeFaultByPath.set("/notes/uuid-1.md", new Error("EACCES"));
    const { result, setDocs } = renderFs({ docs: [a] });
    refs.beforeTransactionPublish = () => {
      refs.librarySnapshot = {
        ...refs.librarySnapshot!,
        docs: [a, remote],
        activeNoteId: "remote",
        revision: 2,
      };
    };

    await act(async () => {
      await result.current.deleteNote(0);
    });

    const committed = setDocs.mock.calls[setDocs.mock.calls.length - 1]?.[0] as NoteDoc[];
    expect(committed.map((doc) => doc.id)).toEqual(["remote"]);
  });

  it("atomically reserves a pathless replacement if the last survivor disappears before publish", async () => {
    const a = makeDoc("a");
    const b = makeDoc("b");
    const { result, setDocs, commitLibraryForGeneration } = renderFs({ docs: [a, b], activeIndex: 0 });
    refs.beforeTransactionPublish = () => {
      refs.librarySnapshot = {
        ...refs.librarySnapshot!,
        docs: [a],
        activeNoteId: "a",
        revision: refs.librarySnapshot!.revision + 1,
      };
    };

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(commitLibraryForGeneration).toHaveBeenCalledTimes(1);
    const committed = setDocs.mock.calls[setDocs.mock.calls.length - 1]?.[0] as NoteDoc[];
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ id: "uuid-1", filePath: "", isDirty: true });
  });

  it("hands off before follow-up persistence and does not rewind after a later active change", async () => {
    const a = makeDoc("a");
    const b = makeDoc("b");
    const c = makeDoc("c");
    const { result, openDocument, notifyActiveDoc } = renderFs({ docs: [a, b, c], activeIndex: 0 });
    refs.afterTransactionPublish = () => {
      expect(openDocument).toHaveBeenCalledWith(expect.objectContaining({ noteId: "b" }));
      expect(notifyActiveDoc).toHaveBeenCalledWith("b", "/notes/b.md");
      refs.librarySnapshot = { ...refs.librarySnapshot!, activeNoteId: "c", revision: 3 };
    };

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(openDocument).toHaveBeenCalledTimes(1);
    expect(notifyActiveDoc).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast a replacement removed during follow-up persistence", async () => {
    const a = makeDoc("a");
    const { result } = renderFs({ docs: [a] });
    refs.afterTransactionPublish = () => {
      refs.librarySnapshot = {
        ...refs.librarySnapshot!,
        docs: [],
        activeNoteId: null,
        revision: refs.librarySnapshot!.revision + 1,
      };
    };

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(emitDocCreatedMock).not.toHaveBeenCalled();
  });

  it("rechecks each target after quarantine and preserves one with crossed save work", async () => {
    const calls = new Map<string, number>();
    const flushDocSave = vi.fn(async (id: string) => {
      const count = (calls.get(id) ?? 0) + 1;
      calls.set(id, count);
      return !(id === "a" && count === 2);
    });
    const { result } = renderFs({
      docs: [makeDoc("a"), makeDoc("b"), makeDoc("c")],
      activeIndex: 2,
      flushDocSave,
    });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNotes(["a", "b"]);
    });

    expect(deleted).toEqual(["b"]);
    expect(copyFileMock).toHaveBeenCalledWith("/notes/b.md", "/notes/.trash/b.md");
    expect(copyFileMock).not.toHaveBeenCalledWith("/notes/a.md", expect.any(String));
    expect(flushDocSave).toHaveBeenCalledTimes(5);
  });

  it("normalizes a trash-directory failure to an empty delete result", async () => {
    const mkdirMock = fsPlugin.mkdir as ReturnType<typeof vi.fn>;
    mkdirMock.mockRejectedValueOnce(new Error("EPERM"));
    const { result } = renderFs({ docs: [makeDoc("a"), makeDoc("b")], activeIndex: 1 });

    await expect(result.current.deleteNote(0)).resolves.toEqual([]);
  });
});

describe("useFileSystem — deleteNote last-note replacement", () => {
  it("flags the replacement doc as dirty when its body write fails so autosave will retry", async () => {
    // Trash copy must succeed so we reach the empty-list branch.
    refs.copyFileShouldThrow = null;
    // The replacement is provisioned at /notes/<new-uuid>.md. First UUID
    // consumed is uuid-1 for the replacement.
    refs.writeFaultByPath.set("/notes/uuid-1.md", new Error("EACCES"));

    const doc = makeDoc("a", { content: "to delete" });
    const { result, setDocs, state } = renderFs({ docs: [doc] });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(setDocs).toHaveBeenCalled();
    // The last setDocs call replaces the array with [replacement].
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs).toHaveLength(1);
    // Critical invariant: write failed, so the manifest entry MUST advertise
    // the doc as dirty — autosave will then retry rather than the user
    // believing they have a clean note that's actually missing on disk.
    expect(lastDocs[0].isDirty).toBe(true);
    expect(state.setIsDirty).toHaveBeenLastCalledWith(true);
    expect(emitDocCreatedMock).not.toHaveBeenCalled();

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(logged).toBeDefined();
    expect((logged![0] as NotenError).context).toMatchObject({
      stage: "deleteNote.replacement",
    });
  });

  it("creates a clean replacement (isDirty=false) when the body write succeeds", async () => {
    const doc = makeDoc("a", { content: "to delete" });
    const { result } = renderFs({ docs: [doc] });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs).toHaveLength(1);
    expect(lastDocs[0].isDirty).toBe(false);
    expect(emitDocCreatedMock).toHaveBeenCalledOnce();
    expect(emitDocCreatedMock).toHaveBeenCalledWith(lastDocs[0]);
  });
});

// deleteNotes — batch deletion must commit the doc list exactly once. The old
// bulk path fired N un-awaited deleteNote calls that each snapshotted the same
// stale docs array; last-writer-wins setDocs then left N-1 ghost rows whose
// files were already in .trash.

describe("useFileSystem — deleteNotes batch", () => {
  it("deletes multiple notes in one commit with no ghost rows and returns the trashed ids", async () => {
    const docs = [makeDoc("a"), makeDoc("b"), makeDoc("c"), makeDoc("d")];
    const { result, setDocs, setTrashedNotes } = renderFs({ docs, activeIndex: 0 });

    let deleted: string[] = [];
    await act(async () => {
      deleted = await result.current.deleteNotes(["b", "c"]);
    });

    expect(deleted.sort()).toEqual(["b", "c"]);
    // Exactly one doc-list commit (sortAndPersistDocs), containing neither
    // deleted note — the ghost-row symptom was a commit still containing one.
    expect(setDocs).toHaveBeenCalledTimes(1);
    const committed = [...libraryStore.getSnapshot().docs];
    expect(committed.map((d) => d.id).sort()).toEqual(["a", "d"]);
    // Single batched trash-list update with both entries.
    expect(setTrashedNotes).toHaveBeenCalledTimes(1);
  });

  it("a failed trash copy skips that note but the rest of the batch still lands", async () => {
    const docs = [makeDoc("a"), makeDoc("b"), makeDoc("c")];
    // vi.clearAllMocks (afterEach) clears calls but NOT implementations, so
    // restore the module-mock implementation after this test.
    copyFileMock.mockImplementation(async (from: string) => {
      if (from === "/notes/b.md") throw new Error("EBUSY");
    });
    try {
      const { result } = renderFs({ docs, activeIndex: 0 });

      let deleted: string[] = [];
      await act(async () => {
        deleted = await result.current.deleteNotes(["b", "c"]);
      });

      // b's copy failed → b stays in the list untouched; c is gone.
      expect(deleted).toEqual(["c"]);
      const committed = [...libraryStore.getSnapshot().docs];
      expect(committed.map((d) => d.id).sort()).toEqual(["a", "b"]);
    } finally {
      copyFileMock.mockImplementation(async () => {
        if (refs.copyFileShouldThrow) throw refs.copyFileShouldThrow;
      });
    }
  });

  it("hands the active doc off to the nearest survivor when it is in the batch", async () => {
    const docs = [makeDoc("a"), makeDoc("b"), makeDoc("c")];
    const { result, notifyActiveDoc } = renderFs({ docs, activeIndex: 0 });

    await act(async () => {
      await result.current.deleteNotes(["a", "b"]);
    });

    expect(notifyActiveDoc).toHaveBeenCalledWith("c", "/notes/c.md");
  });
});

// switchDocument + pruneEmptyCurrentDoc — the deletion path that runs on every
// switch/new/import/restore. Two invariants:
//   1. An empty, auto-titled leaving doc is pruned (file + meta + group refs).
//   2. The body .md is removed BEFORE the .meta sidecar. The reverse order is
//      the dangerous one — a body without a sidecar gets re-ingested by the
//      watcher's reconcile as a fresh unmanaged doc with groupId: null ("the
//      deleted note reappeared outside its group").

describe("useFileSystem — switchDocument prunes an empty leaving doc", () => {
  const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
  const removeMetaMock = metadataIOModule.removeMeta as ReturnType<typeof vi.fn>;

  it("removes the empty doc's body BEFORE its meta sidecar", async () => {
    const empty = makeDoc("a", { content: "" });
    const other = makeDoc("b", { content: "real note" });
    const callOrder: string[] = [];
    removeMock.mockImplementation(async (path: string) => { callOrder.push(`remove:${path}`); });
    removeMetaMock.mockImplementation(async (_fs: unknown, _dir: string, id: string) => { callOrder.push(`removeMeta:${id}`); });
    try {
      const { result, notifyActiveDoc } = renderFs({ docs: [empty, other], activeIndex: 0 });

      await act(async () => {
        await result.current.switchDocument(1);
      });

      const bodyIdx = callOrder.indexOf("remove:/notes/a.md");
      const metaIdx = callOrder.indexOf("removeMeta:a");
      expect(bodyIdx).toBeGreaterThanOrEqual(0);
      expect(metaIdx).toBeGreaterThanOrEqual(0);
      expect(bodyIdx).toBeLessThan(metaIdx);

      // The pruned doc is gone from the committed list and the target doc
      // becomes active.
      const lastDocs = [...libraryStore.getSnapshot().docs];
      expect(lastDocs.map((d) => d.id)).toEqual(["b"]);
      expect(notifyActiveDoc).toHaveBeenCalledWith("b", "/notes/b.md");
    } finally {
      removeMock.mockImplementation(async () => {});
      removeMetaMock.mockImplementation(async () => {});
    }
  });

  it("drops the pruned id from groups and deletes the emptied group", async () => {
    const empty = makeDoc("a", { content: "" });
    const other = makeDoc("b", { content: "real note" });
    const groups: NoteGroup[] = [
      { id: "g1", name: "G1", noteIds: ["a"], collapsed: false, createdAt: 1000 },
      { id: "g2", name: "G2", noteIds: ["b"], collapsed: false, createdAt: 1000 },
    ];
    const { result, setGroups } = renderFs({ docs: [empty, other], activeIndex: 0, groups });

    await act(async () => {
      await result.current.switchDocument(1);
    });

    expect(setGroups).toHaveBeenCalled();
    // The pruner commits a functional delta; the committed store array is what
    // callers persist and broadcast.
    const next = [...libraryStore.getSnapshot().groups];
    // g1 lost its only note and is dropped entirely; g2 is untouched.
    expect(next.map((g) => g.id)).toEqual(["g2"]);
    expect(next[0].noteIds).toEqual(["b"]);
    expect(markGroupAsDeletedMock).toHaveBeenCalledWith("g1");
  });

  it("persists groups WITHOUT the tombstoned group so the delete is not cancelled", async () => {
    // Regression for the P0-4 follow-up: markGroupAsDeleted runs while pruning,
    // but switchDocument used to hand saveManifest groupsRef.current — a
    // pre-delete array still containing g1. persistDecomposedState then read
    // g1's presence as a resurrection and cancelled the fresh tombstone, so
    // deletedAt was never written and g1 reappeared on reload. The pruner now
    // returns the post-delete array and switchDocument persists THAT.
    const empty = makeDoc("a", { content: "" });
    const other = makeDoc("b", { content: "real note" });
    const groups: NoteGroup[] = [
      { id: "g1", name: "G1", noteIds: ["a"], collapsed: false, createdAt: 1000 },
      { id: "g2", name: "G2", noteIds: ["b"], collapsed: false, createdAt: 1000 },
    ];
    const { result } = renderFs({ docs: [empty, other], activeIndex: 0, groups });

    await act(async () => {
      await result.current.switchDocument(1);
    });

    expect(markGroupAsDeletedMock).toHaveBeenCalledWith("g1");
    // The last saveManifest call must carry the pruned groups (g1 gone), not the
    // stale array — otherwise the tombstone gets cancelled downstream.
    const lastPersist = saveManifestMock.mock.calls[saveManifestMock.mock.calls.length - 1];
    const persistedGroups = lastPersist?.[2] as NoteGroup[] | undefined;
    expect(persistedGroups).toBeDefined();
    expect(persistedGroups!.map((g) => g.id)).toEqual(["g2"]);
  });

  it("does not prune a non-empty leaving doc", async () => {
    const filled = makeDoc("a", { content: "has content" });
    const other = makeDoc("b", { content: "x" });
    const { result } = renderFs({ docs: [filled, other], activeIndex: 0 });

    await act(async () => {
      await result.current.switchDocument(1);
    });

    expect(removeMock).not.toHaveBeenCalledWith("/notes/a.md");
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("does not prune an empty doc the user explicitly named (customName)", async () => {
    const named = makeDoc("a", { content: "", customName: true });
    const other = makeDoc("b", { content: "x" });
    const { result } = renderFs({ docs: [named, other], activeIndex: 0 });

    await act(async () => {
      await result.current.switchDocument(1);
    });

    expect(removeMock).not.toHaveBeenCalledWith("/notes/a.md");
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("never serializes the editor when the leaving doc is non-empty or custom-named", async () => {
    // getCurrentMarkdown is a full-document serialization. The prune consults
    // the live editor only for the docs-lag race (empty in the list, typed-in
    // editor); on the common non-empty switch that read is discarded work, so
    // it must not run at all — a large note would pay it on every switch.
    const filled = makeDoc("a", { content: "has content" });
    const named = makeDoc("b", { content: "", customName: true });
    const other = makeDoc("c", { content: "x" });
    const { result } = renderFs({ docs: [filled, named, other], activeIndex: 0 });

    await act(async () => {
      await result.current.switchDocument(1);
    });
    await act(async () => {
      await result.current.switchDocument(2);
    });

    expect(refs.editorReads).toBe(0);
  });

  it("treats unsaved editor content as content (no prune) even when docs lag", async () => {
    // leaving.content in the docs list can lag the live editor: autosave just
    // committed (isDirty false) but the user typed one more char before
    // clicking. Pruning based on the stale list would delete a non-empty note.
    const lagging = makeDoc("a", { content: "" });
    const other = makeDoc("b", { content: "x" });
    refs.editorContent = "typed after last autosave";
    const { result } = renderFs({ docs: [lagging, other], activeIndex: 0 });

    await act(async () => {
      await result.current.switchDocument(1);
    });

    expect(removeMock).not.toHaveBeenCalledWith("/notes/a.md");
  });
});

// restoreNote — the un-trashed sidecar must hit the disk BEFORE the body copy.
// Windows copyFile preserves the source mtime, so the restored root body stays
// older than meta.trashedAt; if the watcher's reconcile (~1.5s after the copy)
// still reads trashedAt != null, its root-vs-trash arbitration moves the body
// straight back to .trash and the restore silently undoes itself.

describe("useFileSystem — restoreNote meta-first ordering", () => {
  it("writes trashedAt:null meta to disk before copying the body back", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      customName: true,
      pinned: false,
      color: undefined,
    };
    const callOrder: string[] = [];
    const writeMetaMock = metadataIOModule.writeMeta as ReturnType<typeof vi.fn>;
    writeMetaMock.mockImplementation(async (_fs: unknown, _dir: string, meta: { trashedAt: number | null }) => {
      callOrder.push(`writeMeta:${meta.trashedAt === null ? "null" : meta.trashedAt}`);
      return "";
    });
    copyFileMock.mockImplementationOnce(async () => { callOrder.push("copyFile"); });

    const { result, setDocs } = renderFs({ docs: [makeDoc("a")], trashedNotes: [trashed] });
    await act(async () => {
      await result.current.restoreNote("t1");
    });

    const metaIdx = callOrder.indexOf("writeMeta:null");
    const copyIdx = callOrder.indexOf("copyFile");
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeLessThan(copyIdx);
    const restoredDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1]?.[0] as NoteDoc[];
    expect(restoredDocs.find((doc) => doc.id === "t1")?.customName).toBe(true);
  });

  it("fails closed before copying the body when live metadata cannot be written", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      pinned: false,
    };
    const writeMetaMock = metadataIOModule.writeMeta as ReturnType<typeof vi.fn>;
    writeMetaMock.mockRejectedValueOnce(new Error("EPERM"));
    const { result, commitLibraryForGeneration } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashed],
    });

    await act(async () => {
      await result.current.restoreNote("t1");
    });

    expect(copyFileMock).not.toHaveBeenCalled();
    expect(commitLibraryForGeneration).not.toHaveBeenCalled();
    expect(refs.librarySnapshot?.trashedNotes.map((note) => note.id)).toEqual(["t1"]);
  });

  it("rolls metadata back and keeps trash canonical when the body copy fails", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      pinned: false,
    };
    const previousMeta: NoteMeta = {
      version: 2,
      id: "t1",
      fileName: "Trashed",
      createdAt: 1000,
      updatedAt: 1500,
      groupId: null,
      trashedAt: 2000,
    };
    const readMetaMock = metadataIOModule.readMeta as ReturnType<typeof vi.fn>;
    const writeMetaMock = metadataIOModule.writeMeta as ReturnType<typeof vi.fn>;
    readMetaMock.mockResolvedValueOnce(previousMeta);
    refs.copyFileShouldThrow = new Error("EACCES");
    const { result } = renderFs({ docs: [makeDoc("a")], trashedNotes: [trashed] });

    await act(async () => {
      await result.current.restoreNote("t1");
    });

    expect(writeMetaMock).toHaveBeenCalledTimes(2);
    expect(writeMetaMock.mock.calls[0]?.[2]).toMatchObject({ trashedAt: null });
    expect(writeMetaMock.mock.calls[1]?.[2]).toEqual(previousMeta);
    expect(refs.librarySnapshot?.docs.some((doc) => doc.id === "t1")).toBe(false);
    expect(refs.librarySnapshot?.trashedNotes.some((note) => note.id === "t1")).toBe(true);
  });

  it("publishes restored docs, groups, trash, and active identity in one commit", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: "g1",
      createdAt: 1000,
      updatedAt: 1500,
      customName: true,
      pinned: true,
    };
    const groups: NoteGroup[] = [{
      id: "g1",
      name: "Group",
      noteIds: [],
      collapsed: false,
      createdAt: 1000,
    }];
    const { result, commitLibraryForGeneration } = renderFs({
      docs: [makeDoc("a")],
      groups,
      trashedNotes: [trashed],
    });

    await act(async () => {
      await result.current.restoreNote("t1");
    });

    expect(commitLibraryForGeneration).toHaveBeenCalledTimes(1);
    expect(refs.librarySnapshot).toMatchObject({ activeNoteId: "t1" });
    expect(refs.librarySnapshot?.docs.find((doc) => doc.id === "t1")).toMatchObject({
      customName: true,
      pinned: true,
    });
    expect(refs.librarySnapshot?.groups[0]?.noteIds).toEqual(["t1"]);
    expect(refs.librarySnapshot?.trashedNotes).toEqual([]);
  });

  it("still restores when a peer window rebuilt the trash entry objects mid-transaction", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      pinned: false,
    };
    const writeMetaMock = metadataIOModule.writeMeta as ReturnType<typeof vi.fn>;
    // The live-sidecar write is the first await inside the transaction; a
    // trash-updated event from another window lands during it and commits a
    // fresh copy of the same entry (new identity, same id/trashedAt).
    writeMetaMock.mockImplementationOnce(async () => {
      libraryStore.commit((current) => ({
        trashedNotes: current.trashedNotes.map((note) => ({ ...note })),
      }), "remote");
      refs.librarySnapshot = libraryStore.getSnapshot();
      return "";
    });
    const { result } = renderFs({ docs: [makeDoc("a")], trashedNotes: [trashed] });

    await act(async () => {
      await result.current.restoreNote("t1");
    });

    expect(copyFileMock).toHaveBeenCalledWith("/notes/.trash/t1.md", "/notes/t1.md");
    expect(refs.librarySnapshot?.docs.some((doc) => doc.id === "t1")).toBe(true);
    expect(refs.librarySnapshot?.trashedNotes).toEqual([]);

    // A re-trash with a newer trashedAt still aborts before the copy.
    copyFileMock.mockClear();
    writeMetaMock.mockImplementationOnce(async () => {
      libraryStore.commit((current) => ({
        trashedNotes: current.trashedNotes.map((note) => (note.id === "t2" ? { ...note, trashedAt: 9000 } : note)),
      }), "remote");
      refs.librarySnapshot = libraryStore.getSnapshot();
      return "";
    });
    const second = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [{ ...trashed, id: "t2", originalFilePath: "/notes/t2.md", trashFilePath: "/notes/.trash/t2.md" }],
    });
    await act(async () => {
      await second.result.current.restoreNote("t2");
    });
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(refs.librarySnapshot?.trashedNotes.map((note) => note.id)).toEqual(["t2"]);
  });

  it("restores a note whose sidecar cannot be read, rebuilding it from the trash entry", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      customName: true,
      pinned: false,
    };
    const readMetaMock = metadataIOModule.readMeta as ReturnType<typeof vi.fn>;
    const writeMetaMock = metadataIOModule.writeMeta as ReturnType<typeof vi.fn>;
    readMetaMock.mockRejectedValueOnce(new SyntaxError("Unexpected token"));
    const { result } = renderFs({ docs: [makeDoc("a")], trashedNotes: [trashed] });

    await act(async () => {
      await result.current.restoreNote("t1");
    });

    expect(writeMetaMock.mock.calls[0]?.[2]).toMatchObject({ fileName: "Trashed", customName: true, trashedAt: null });
    expect(refs.librarySnapshot?.docs.some((doc) => doc.id === "t1")).toBe(true);
    expect(refs.librarySnapshot?.trashedNotes).toEqual([]);
    expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ code: "META_READ_FAILED" }));
  });

  it("removes the trash copy only after the restored body read back", async () => {
    const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      pinned: false,
    };
    const callOrder: string[] = [];
    readMock.mockImplementation(async (path: string) => {
      const fault = refs.readFaultByPath.get(path);
      if (fault) throw fault;
      callOrder.push(`read:${path}`);
      return "body";
    });
    removeMock.mockImplementation(async (path: string) => { callOrder.push(`remove:${path}`); });
    try {
      const { result } = renderFs({ docs: [makeDoc("a")], trashedNotes: [trashed] });
      await act(async () => {
        await result.current.restoreNote("t1");
      });
      expect(callOrder.indexOf("read:/notes/t1.md")).toBeLessThan(callOrder.indexOf("remove:/notes/.trash/t1.md"));

      // A failed read-back keeps the trash copy: it is still the only body.
      callOrder.length = 0;
      refs.readFaultByPath.set("/notes/t2.md", new Error("EBUSY"));
      const second = renderFs({
        docs: [makeDoc("a")],
        trashedNotes: [{ ...trashed, id: "t2", originalFilePath: "/notes/t2.md", trashFilePath: "/notes/.trash/t2.md" }],
      });
      await act(async () => {
        await second.result.current.restoreNote("t2");
      });
      expect(callOrder).toContain("remove:/notes/t2.md");
      expect(callOrder).not.toContain("remove:/notes/.trash/t2.md");
    } finally {
      readMock.mockImplementation(async (path: string) => {
        const perPath = refs.readFaultByPath.get(path);
        if (perPath) throw perPath;
        if (refs.readShouldThrow) throw refs.readShouldThrow;
        return "";
      });
      removeMock.mockImplementation(async () => {});
    }
  });

  it("prunes an empty auto-titled leaving doc in the same commit and tombstones its emptied group", async () => {
    const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const removeMetaMock = metadataIOModule.removeMeta as ReturnType<typeof vi.fn>;
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: "g1",
      createdAt: 1000,
      updatedAt: 1500,
      pinned: false,
    };
    const groups: NoteGroup[] = [
      { id: "g1", name: "Target", noteIds: [], collapsed: false, createdAt: 1000 },
      { id: "g2", name: "Emptied", noteIds: ["empty"], collapsed: false, createdAt: 1000 },
    ];
    const callOrder: string[] = [];
    removeMock.mockImplementation(async (path: string) => { callOrder.push(`remove:${path}`); });
    removeMetaMock.mockImplementation(async (_fs: unknown, _dir: string, id: string) => { callOrder.push(`removeMeta:${id}`); });
    try {
      const { result, commitLibraryForGeneration, cancelDocSave, invalidateDocumentSession } = renderFs({
        docs: [makeDoc("empty", { content: "" }), makeDoc("b", { content: "real" })],
        activeIndex: 0,
        groups,
        trashedNotes: [trashed],
      });

      await act(async () => {
        await result.current.restoreNote("t1");
      });

      const bodyIdx = callOrder.indexOf("remove:/notes/empty.md");
      const metaIdx = callOrder.indexOf("removeMeta:empty");
      expect(bodyIdx).toBeGreaterThanOrEqual(0);
      expect(metaIdx).toBeGreaterThan(bodyIdx);
      expect(cancelDocSave).toHaveBeenCalledWith("empty");
      expect(invalidateDocumentSession).toHaveBeenCalledWith("empty", "/notes/empty.md");

      expect(commitLibraryForGeneration).toHaveBeenCalledTimes(1);
      expect(refs.librarySnapshot?.docs.map((doc) => doc.id).sort()).toEqual(["b", "t1"]);
      expect(refs.librarySnapshot?.activeNoteId).toBe("t1");
      expect(refs.librarySnapshot?.groups.map((group) => group.id)).toEqual(["g1"]);
      expect(refs.librarySnapshot?.groups[0]?.noteIds).toEqual(["t1"]);
      expect(markGroupAsDeletedMock).toHaveBeenCalledWith("g2");
      expect(markGroupAsDeletedMock).not.toHaveBeenCalledWith("g1");
    } finally {
      removeMock.mockImplementation(async () => {});
      removeMetaMock.mockImplementation(async () => {});
    }
  });

  it("keeps the leaving doc when the editor holds unsaved input, and when it is the only doc", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Trashed",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1500,
      pinned: false,
    };
    refs.editorContent = "typed after autosave";
    const typed = renderFs({
      docs: [makeDoc("empty", { content: "" }), makeDoc("b", { content: "real" })],
      activeIndex: 0,
      trashedNotes: [trashed],
    });
    await act(async () => {
      await typed.result.current.restoreNote("t1");
    });
    expect(refs.librarySnapshot?.docs.map((doc) => doc.id).sort()).toEqual(["b", "empty", "t1"]);

    refs.editorContent = "";
    const only = renderFs({
      docs: [makeDoc("empty", { content: "" })],
      trashedNotes: [trashed],
    });
    await act(async () => {
      await only.result.current.restoreNote("t1");
    });
    expect(refs.librarySnapshot?.docs.map((doc) => doc.id).sort()).toEqual(["empty", "t1"]);
  });
});

// renameNote — back-link rewrite invariant: in-memory body only updates if the
// disk write lands. A failed rewrite must leave that doc's content at the old
// value so memory matches disk and autosave can retry from a coherent state.

describe("useFileSystem — renameNote partial-failure", () => {
  it("when one back-link rewrite fails, only the successful docs' bodies update in memory", async () => {
    const target = makeDoc("target", { fileName: "Old", customName: true });
    const linkerOk = makeDoc("linker-ok", { content: "see [[Old]]" });
    const linkerFail = makeDoc("linker-fail", { content: "ref [[Old]]" });
    refs.writeFaultByPath.set("/notes/linker-fail.md", new Error("EACCES"));
    // Non-active rewrites are computed from the on-disk body, not entry.content.
    readMock.mockImplementation(async (path: string) => {
      const fault = refs.readFaultByPath.get(path);
      if (fault) throw fault;
      if (path === "/notes/linker-ok.md") return "see [[Old]]";
      if (path === "/notes/linker-fail.md") return "ref [[Old]]";
      return "";
    });

    const { result, setDocs } = renderFs({
      docs: [target, linkerOk, linkerFail],
    });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    expect(setDocs).toHaveBeenCalled();
    const lastDocs = [...libraryStore.getSnapshot().docs];
    const ok = lastDocs.find((d) => d.id === "linker-ok")!;
    const fail = lastDocs.find((d) => d.id === "linker-fail")!;

    // The successful rewrite committed the new body in memory.
    expect(ok.content).toBe("see [[New]]");
    // The failed rewrite is left at the ORIGINAL body — memory tracks disk.
    expect(fail.content).toBe("ref [[Old]]");

    // The target doc itself got the new fileName.
    const renamed = lastDocs.find((d) => d.id === "target")!;
    expect(renamed.fileName).toBe("New");

    const saveFailed = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(saveFailed).toBeDefined();
  });

  it("when the active doc's rewrite fails, isDirty stays true and openDocument is NOT called", async () => {
    const target = makeDoc("target", { fileName: "Old", customName: true });
    const activeWithLink = makeDoc("active", { content: "see [[Old]]" });
    refs.writeFaultByPath.set("/notes/active.md", new Error("EACCES"));

    const setIsDirty = vi.fn();
    const state = makeState({ isDirty: true, setIsDirty });

    const { result, openDocument } = renderFs({
      // active doc must be at activeIndex so renameNote routes it through
      // the activeRewrite branch.
      docs: [target, activeWithLink],
      activeIndex: 1,
      state,
    });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    // The active rewrite failed — masking the loss by flipping the editor
    // would silently lose the user's content. Both side effects must be skipped.
    expect(openDocument).not.toHaveBeenCalled();
    expect(setIsDirty).not.toHaveBeenCalledWith(false);
  });
});

// renameNote — duplicate titles: `[[Old]]` names its target by title alone, so
// when two notes share the old title no link can be attributed to one of them.
// Rewriting anyway would re-point links that belonged to the other note.

describe("useFileSystem — renameNote with a duplicated title", () => {
  it("leaves every back-link untouched and reports the skip", async () => {
    const target = makeDoc("target", { fileName: "Dup", customName: true });
    const twin = makeDoc("twin", { fileName: "Dup", customName: true });
    const linker = makeDoc("linker", { content: "see [[Dup]]" });
    readMock.mockImplementation(async (path: string) => (
      path === "/notes/linker.md" ? "see [[Dup]]" : ""
    ));

    const { result } = renderFs({ docs: [target, twin, linker] });

    let outcome: Awaited<ReturnType<typeof result.current.renameNote>> | undefined;
    await act(async () => {
      outcome = await result.current.renameNote(0, "New");
    });

    expect(outcome).toEqual({ renamed: true, linkRewriteSkipped: true });

    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.find((d) => d.id === "target")!.fileName).toBe("New");
    // The link still reads [[Dup]] — it may well have meant the twin.
    expect(lastDocs.find((d) => d.id === "linker")!.content).toBe("see [[Dup]]");
    expect(writeMock).not.toHaveBeenCalledWith("/notes/linker.md", expect.anything());
  });

  it("still rewrites back-links when the old title is unique", async () => {
    const target = makeDoc("target", { fileName: "Unique", customName: true });
    const other = makeDoc("other", { fileName: "Something else", customName: true });
    const linker = makeDoc("linker", { content: "see [[Unique]]" });
    readMock.mockImplementation(async (path: string) => (
      path === "/notes/linker.md" ? "see [[Unique]]" : ""
    ));

    const { result } = renderFs({ docs: [target, other, linker] });

    let outcome: Awaited<ReturnType<typeof result.current.renameNote>> | undefined;
    await act(async () => {
      outcome = await result.current.renameNote(0, "New");
    });

    expect(outcome).toEqual({ renamed: true, linkRewriteSkipped: false });
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.find((d) => d.id === "linker")!.content).toBe("see [[New]]");
  });

  it("compares titles case- and whitespace-insensitively when detecting duplicates", async () => {
    const target = makeDoc("target", { fileName: "Dup", customName: true });
    const twin = makeDoc("twin", { fileName: "  dup ", customName: true });
    const linker = makeDoc("linker", { content: "see [[Dup]]" });
    readMock.mockImplementation(async (path: string) => (
      path === "/notes/linker.md" ? "see [[Dup]]" : ""
    ));

    const { result } = renderFs({ docs: [target, twin, linker] });

    let outcome: Awaited<ReturnType<typeof result.current.renameNote>> | undefined;
    await act(async () => {
      outcome = await result.current.renameNote(0, "New");
    });

    expect(outcome?.linkRewriteSkipped).toBe(true);
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.find((d) => d.id === "linker")!.content).toBe("see [[Dup]]");
  });
});

// renameNote — autosave coordination: every doc we may rewrite gets its
// pending/in-flight save flushed BEFORE the rewrite write, so a late doSave
// can never land after the rewrite and revert it on disk.

describe("useFileSystem — renameNote autosave coordination", () => {
  it("flushes back-link docs before rewriting and skips docs whose flush failed", async () => {
    const target = makeDoc("target", { fileName: "Old", customName: true });
    const linkerA = makeDoc("linker-a", { content: "see [[Old]]" });
    const linkerB = makeDoc("linker-b", { content: "ref [[Old]]" });
    readMock.mockImplementation(async (path: string) => {
      const fault = refs.readFaultByPath.get(path);
      if (fault) throw fault;
      if (path === "/notes/linker-a.md") return "see [[Old]]";
      if (path === "/notes/linker-b.md") return "ref [[Old]]";
      return "";
    });

    const flushDocSave = vi.fn(async (docId: string) => docId !== "linker-b");
    const { result } = renderFs({
      docs: [target, linkerA, linkerB],
      flushDocSave,
    });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    expect(flushDocSave).toHaveBeenCalledWith("linker-a");
    expect(flushDocSave).toHaveBeenCalledWith("linker-b");

    // Every flush happens before the first rewrite write.
    const rewriteIdx = writeMock.mock.calls.findIndex((c) => c[0] === "/notes/linker-a.md");
    expect(rewriteIdx).toBeGreaterThanOrEqual(0);
    const rewriteOrder = writeMock.mock.invocationCallOrder[rewriteIdx];
    expect(Math.max(...flushDocSave.mock.invocationCallOrder)).toBeLessThan(rewriteOrder);

    // linker-b's flush failed: its unsaved content could not land, so neither
    // its file nor its in-memory body is rewritten.
    expect(writeMock.mock.calls.some((c) => c[0] === "/notes/linker-b.md")).toBe(false);
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.find((d) => d.id === "linker-a")!.content).toBe("see [[New]]");
    expect(lastDocs.find((d) => d.id === "linker-b")!.content).toBe("ref [[Old]]");
  });

  it("rewrites the on-disk body when it is newer than the in-memory copy", async () => {
    const target = makeDoc("target", { fileName: "Old", customName: true });
    // entry.content lags a background save that already landed on disk.
    const linker = makeDoc("linker", { content: "see [[Old]]" });
    readMock.mockImplementation(async (path: string) => {
      const fault = refs.readFaultByPath.get(path);
      if (fault) throw fault;
      return path === "/notes/linker.md" ? "edited [[Old]] tail" : "";
    });

    const { result } = renderFs({ docs: [target, linker] });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    const rewriteCall = writeMock.mock.calls.find((c) => c[0] === "/notes/linker.md");
    expect(rewriteCall).toBeDefined();
    expect(rewriteCall![1]).toBe("edited [[New]] tail");

    // The disk-derived rewrite also refreshes the lagging in-memory copy and
    // the conflict-backup baseline.
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.find((d) => d.id === "linker")!.content).toBe("edited [[New]] tail");
    expect(conflictBackupModule.setKnownDiskContent).toHaveBeenCalledWith(
      "/notes/linker.md",
      "edited [[New]] tail",
    );
  });

  it("skips a back-link doc whose body cannot be read back after the flush", async () => {
    const target = makeDoc("target", { fileName: "Old", customName: true });
    const linker = makeDoc("linker", { content: "see [[Old]]" });
    refs.readFaultByPath.set("/notes/linker.md", new Error("EBUSY: placeholder hydration"));

    const { result } = renderFs({ docs: [target, linker] });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    // Rewriting from the stale in-memory copy could regress the doc's latest
    // save, so the doc must be left untouched on disk AND in memory.
    expect(writeMock.mock.calls.some((c) => c[0] === "/notes/linker.md")).toBe(false);
    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.find((d) => d.id === "linker")!.content).toBe("see [[Old]]");
    // The rename itself still commits.
    expect(lastDocs.find((d) => d.id === "target")!.fileName).toBe("New");
  });
});

// createNoteWithTitle — wiki-link note creation must route through the same
// atomic provisioning path as every other managed-note body write.

describe("useFileSystem — createNoteWithTitle provisioning", () => {
  it("provisions the empty note atomically with markOwnWrite before the write", async () => {
    const { result } = renderFs();

    let id: string | null = null;
    await act(async () => {
      id = await result.current.createNoteWithTitle("Linked");
    });

    expect(id).toBe("uuid-1");
    const writeIdx = writeMock.mock.calls.findIndex((c) => c[0] === "/notes/uuid-1.md");
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(writeMock.mock.calls[writeIdx][1]).toBe("");

    const markIdx = markOwnWriteMock.mock.calls.findIndex((c) => c[0] === "/notes/uuid-1.md");
    expect(markIdx).toBeGreaterThanOrEqual(0);
    expect(markOwnWriteMock.mock.invocationCallOrder[markIdx])
      .toBeLessThan(writeMock.mock.invocationCallOrder[writeIdx]);

    const lastDocs = [...libraryStore.getSnapshot().docs];
    expect(lastDocs.find((d) => d.id === "uuid-1")!.fileName).toBe("Linked");
  });

  it("returns null and logs SAVE_FAILED when the provisioning write fails", async () => {
    refs.writeShouldThrow = new Error("ENOSPC");
    const { result, setDocs } = renderFs();

    let id: string | null = "sentinel";
    await act(async () => {
      id = await result.current.createNoteWithTitle("Linked");
    });

    expect(id).toBeNull();
    expect(setDocs).not.toHaveBeenCalled();
    const saveFailed = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(saveFailed).toBeDefined();
    expect((saveFailed![0] as NotenError).context).toMatchObject({
      stage: "createNoteWithTitle",
      noteId: "uuid-1",
    });
  });
});

// restoreNote — copyFile succeeded but readTextFile fails. The trashed entry
// must stay (so the user can retry / next reconcile picks it up) and no new
// doc gets committed.

describe("useFileSystem — restoreNote read-failure", () => {
  it("logs BODY_READ_FAILED and bails without committing the restored doc when the read after copy fails", async () => {
    const trashed: TrashedNote = {
      id: "t1",
      fileName: "Recovered",
      originalFilePath: "/notes/t1.md",
      trashFilePath: "/notes/.trash/t1.md",
      trashedAt: 2000,
      groupId: null,
      createdAt: 1000,
      updatedAt: 1000,
    };
    // copyFile succeeds (default), but the post-copy read fails — this is the
    // scenario where OneDrive marks the restored placeholder as not-yet-hydrated.
    refs.readFaultByPath.set("/notes/t1.md", new Error("EBUSY: cloud hydration"));

    const { result, setDocs, setTrashedNotes } = renderFs({
      docs: [makeDoc("existing")],
      trashedNotes: [trashed],
    });

    await act(async () => {
      await result.current.restoreNote("t1");
    });

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "BODY_READ_FAILED",
    );
    expect(logged).toBeDefined();
    expect((logged![0] as NotenError).context).toMatchObject({
      stage: "restoreNote",
      noteId: "t1",
    });

    // The doc list MUST NOT receive a phantom entry; the trash list MUST NOT be
    // emptied (the user can retry — next reload's reconcile will pick up the
    // restored file via its on-disk presence).
    expect(setDocs).not.toHaveBeenCalled();
    expect(setTrashedNotes).not.toHaveBeenCalled();
  });
});

// markOwnWrite ordering — must happen before writeTextFile so the file-watcher
// doesn't bounce our own write back as a "remote change". Guards the saveFile
// happy path that doesn't go through provisionNoteFile.

describe("useFileSystem — markOwnWrite happens before writeTextFile", () => {
  it("saveFile marks the write BEFORE writeTextFile fires (file-watcher loop guard)", async () => {
    refs.editorContent = "fresh body";
    const callOrder: string[] = [];
    markOwnWriteMock.mockImplementation(() => { callOrder.push("markOwnWrite"); });
    writeMock.mockImplementationOnce(async () => { callOrder.push("writeTextFile"); });

    const doc = makeDoc("a", { filePath: "/notes/a.md" });
    const { result } = renderFs({ docs: [doc] });

    await act(async () => {
      await result.current.saveFile();
    });

    const markIdx = callOrder.indexOf("markOwnWrite");
    const writeIdx = callOrder.indexOf("writeTextFile");
    expect(markIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeLessThan(writeIdx);
  });
});

// trash-updated carries the CHANGE this window made, never its whole trash
// array: a snapshot broadcast makes every receiver adopt the sender's view and
// silently undoes a trash/restore/purge the receiving window did concurrently.
describe("useFileSystem — trash-updated broadcasts a delta", () => {
  const trashed = (id: string): TrashedNote => ({
    id,
    fileName: `Note ${id}`,
    originalFilePath: `/notes/${id}.md`,
    trashFilePath: `/notes/.trash/${id}.md`,
    trashedAt: 2000,
    groupId: null,
    createdAt: 1000,
    updatedAt: 1500,
    pinned: false,
  });

  it("deleteNote announces only the entry it moved into trash", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a"), makeDoc("b")],
      activeIndex: 1,
      trashedNotes: [trashed("old")],
    });

    await act(async () => { await result.current.deleteNote(0); });

    expect(emitTrashUpdatedMock).toHaveBeenCalledWith({
      added: [expect.objectContaining({ id: "a" })],
    });
  });

  it("emptyTrash announces the ids it purged, not an empty list", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashed("t1"), trashed("t2")],
    });

    await act(async () => { await result.current.emptyTrash(); });

    // A note another window trashed mid-purge is still on disk in .trash, so
    // announcing "the trash is now empty" would wrongly drop it there.
    expect(emitTrashUpdatedMock).toHaveBeenCalledWith({
      removed: [{ id: "t1", trashedAt: 2000 }, { id: "t2", trashedAt: 2000 }],
    });
  });

  it("permanentlyDeleteNote announces just that id", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashed("t1"), trashed("t2")],
    });

    await act(async () => { await result.current.permanentlyDeleteNote("t2"); });

    expect(emitTrashUpdatedMock).toHaveBeenCalledWith({ removed: [{ id: "t2", trashedAt: 2000 }] });
  });

  it("restoreNote announces just the id it took out of trash", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashed("t1"), trashed("t2")],
    });

    await act(async () => { await result.current.restoreNote("t1"); });

    expect(emitTrashUpdatedMock).toHaveBeenCalledWith({ removed: [{ id: "t1", trashedAt: 2000 }] });
  });
});

describe("useFileSystem — functional commits survive concurrent store changes", () => {
  // The sites under test express their docs commit as a functional delta
  // against the store's `prev` (sortAndPersistDocs). An absolute array built
  // from the pre-await projection erased whatever landed during the disk I/O:
  // a peer-deleted note came back as a ghost row, a peer-created note
  // vanished, and a provision-adopted filePath reverted to "".

  it("newNote keeps a peer-created note that landed during its provision write", async () => {
    const { result } = renderFs({ docs: [makeDoc("a", { content: "keep me" })] });

    writeMock.mockImplementationOnce(async () => {
      // Peer window creates a note while provisionNoteFile awaits its write.
      libraryStore.commit((current) => ({
        docs: [...current.docs, makeDoc("peer", { fileName: "Peer note" })],
      }), "remote");
    });

    await act(async () => { await result.current.newNote(); });

    const ids = libraryStore.getSnapshot().docs.map((d) => d.id).sort();
    expect(ids).toEqual(["a", "peer", "uuid-1"]);
  });

  it("importFiles keeps a peer deletion that landed during the import writes", async () => {
    const { result } = renderFs({ docs: [makeDoc("a", { content: "keep me" }), makeDoc("b")] });

    writeMock.mockImplementationOnce(async () => {
      // Peer window deleted "b" while the import body was being provisioned.
      libraryStore.commit((current) => ({
        docs: current.docs.filter((d) => d.id !== "b"),
      }), "remote");
    });

    await act(async () => { await result.current.importFiles(["/src/x.md"]); });

    const ids = libraryStore.getSnapshot().docs.map((d) => d.id).sort();
    expect(ids).toEqual(["a", "uuid-1"]);
  });

  it("switchDocument loads the peer body that landed during the prune awaits", async () => {
    const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const openDocument = vi.fn();
    const emptyDoc = makeDoc("a", { content: "", customName: false });
    const target = makeDoc("b", { content: "old body" });
    const { result } = renderFs({ docs: [emptyDoc, target], openDocument });

    removeMock.mockImplementationOnce(async () => {
      // Peer body update for the switch target lands while the prune removes
      // the empty leaving doc's file.
      libraryStore.commit((current) => ({
        docs: current.docs.map((d) => (d.id === "b" ? { ...d, content: "peer body", updatedAt: 9999 } : d)),
      }), "remote");
    });

    await act(async () => { await result.current.switchDocument(1); });

    const b = libraryStore.getSnapshot().docs.find((d) => d.id === "b");
    expect(b?.content).toBe("peer body");
    expect(openDocument).toHaveBeenCalledWith(expect.objectContaining({ noteId: "b", markdown: "peer body" }));
  });
});

describe("useFileSystem — functional group commits survive concurrent store changes", () => {
  // Same class as the docs deltas above: groups commits are functional deltas
  // against the store's `prev`, and the groups-updated broadcast carries the
  // COMMITTED array, so a peer group commit landing during the disk awaits is
  // neither erased locally nor clobbered in the peer windows by a stale
  // snapshot.
  const emitGroupsDeltaMock = windowSyncModule.emitGroupsDelta as ReturnType<typeof vi.fn>;

  const group = (id: string, noteIds: string[]): NoteGroup =>
    ({ id, name: id.toUpperCase(), noteIds, collapsed: false, createdAt: 1000 });

  it("newNote keeps a peer-created group that landed during its provision write", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a", { content: "keep me" })],
      groups: [group("g1", ["a"])],
      activeIndex: 0,
    });

    writeMock.mockImplementationOnce(async () => {
      libraryStore.commit((current) => ({
        groups: [...current.groups, group("peer-g", ["x"])],
      }), "remote");
    });

    await act(async () => { await result.current.newNote(); });

    const ids = libraryStore.getSnapshot().groups.map((g) => g.id).sort();
    expect(ids).toEqual(["g1", "peer-g"]);
    // The broadcast is a delta naming only THIS window's change — a snapshot
    // mentioning (or omitting) peer-g would clobber the peer's own windows.
    for (const call of emitGroupsDeltaMock.mock.calls) {
      const delta = call[0] as { upserted: { id: string }[]; removedIds: string[] };
      expect(delta.upserted.some((g) => g.id === "peer-g")).toBe(false);
      expect(delta.removedIds).not.toContain("peer-g");
    }
  });

  it("newNote keeps a peer group deletion that landed during its provision write", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a", { content: "keep me" })],
      groups: [group("g1", ["a"]), group("g2", ["other"])],
      activeIndex: 0,
    });

    writeMock.mockImplementationOnce(async () => {
      libraryStore.commit((current) => ({
        groups: current.groups.filter((g) => g.id !== "g2"),
      }), "remote");
    });

    await act(async () => { await result.current.newNote(); });

    expect(libraryStore.getSnapshot().groups.some((g) => g.id === "g2")).toBe(false);
  });

  it("the prune keeps a peer group created during its file removals", async () => {
    const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const empty = makeDoc("a", { content: "" });
    const other = makeDoc("b", { content: "real" });
    const { result } = renderFs({
      docs: [empty, other],
      groups: [group("g1", ["a"])],
      activeIndex: 0,
    });

    removeMock.mockImplementationOnce(async () => {
      libraryStore.commit((current) => ({
        groups: [...current.groups, group("peer-g", ["b"])],
      }), "remote");
    });

    await act(async () => { await result.current.switchDocument(1); });

    // g1 emptied and dropped (tombstoned); the peer group survives.
    const ids = libraryStore.getSnapshot().groups.map((g) => g.id);
    expect(ids).toEqual(["peer-g"]);
    expect(markGroupAsDeletedMock).toHaveBeenCalledWith("g1");
    expect(markGroupAsDeletedMock).not.toHaveBeenCalledWith("peer-g");
  });

  it("the prune keeps a peer note-move into another group during its file removals", async () => {
    const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const empty = makeDoc("a", { content: "" });
    const other = makeDoc("b", { content: "real" });
    const { result } = renderFs({
      docs: [empty, other],
      groups: [group("g1", ["a"]), group("g2", [])],
      activeIndex: 0,
    });

    removeMock.mockImplementationOnce(async () => {
      // Peer moves b into g2 while the prune removes a's files.
      libraryStore.commit((current) => ({
        groups: current.groups.map((g) => (g.id === "g2" ? { ...g, noteIds: ["b"] } : g)),
      }), "remote");
    });

    await act(async () => { await result.current.switchDocument(1); });

    const g2 = libraryStore.getSnapshot().groups.find((g) => g.id === "g2");
    expect(g2?.noteIds).toEqual(["b"]);
  });

  it("importFiles adds membership on top of a peer group change during the import writes", async () => {
    readMock.mockImplementation(async (path: string) => `body of ${path}`);
    const active = makeDoc("a", { content: "real note" });
    const { result } = renderFs({
      docs: [active],
      groups: [group("g1", ["a"])],
      activeIndex: 0,
    });

    writeMock.mockImplementationOnce(async () => {
      libraryStore.commit((current) => ({
        groups: [...current.groups, group("peer-g", ["x"])],
      }), "remote");
    });

    await act(async () => { await result.current.importFiles(["/src/b.md"]); });

    const snapshot = libraryStore.getSnapshot().groups;
    expect(snapshot.find((g) => g.id === "g1")?.noteIds).toEqual(["a", "uuid-1"]);
    expect(snapshot.some((g) => g.id === "peer-g")).toBe(true);
    // The delta names only the import's own membership op.
    const lastEmit = emitGroupsDeltaMock.mock.calls[emitGroupsDeltaMock.mock.calls.length - 1][0] as {
      upserted: { id: string }[]; removedIds: string[]; membership: { noteId: string; groupId: string | null }[];
    };
    expect(lastEmit.membership).toEqual([{ noteId: "uuid-1", groupId: "g1", at: expect.any(Number) }]);
    expect(lastEmit.upserted).toEqual([]);
    expect(lastEmit.removedIds).toEqual([]);
  });
});

// A trash body another process holds (cloud sync, antivirus, an open
// handle) makes remove() throw. The entry must stay listed with its sidecar
// intact, or the body is orphaned in .trash with nothing ever deleting it.
describe("useFileSystem — trash purge keeps entries whose body survives", () => {
  const trashedEntry = (id: string): TrashedNote => ({
    id,
    fileName: `Note ${id}`,
    originalFilePath: `/notes/${id}.md`,
    trashFilePath: `/notes/.trash/${id}.md`,
    trashedAt: 2000,
    groupId: null,
    createdAt: 1000,
    updatedAt: 1500,
    pinned: false,
  });
  const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
  const existsMock = fsPlugin.exists as ReturnType<typeof vi.fn>;
  const removeMetaMock = metadataIOModule.removeMeta as ReturnType<typeof vi.fn>;
  const lockBody = (path: string) => {
    removeMock.mockImplementation(async (p: string) => {
      if (p === path) throw new Error("os error 32");
    });
    existsMock.mockImplementation(async (p: string) => p === path);
  };

  afterEach(() => {
    removeMock.mockImplementation(async () => {});
    existsMock.mockImplementation(async () => false);
  });

  it("permanentlyDeleteNote keeps a locked entry and its sidecar", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashedEntry("t1")],
    });
    lockBody("/notes/.trash/t1.md");
    removeMetaMock.mockClear();

    await act(async () => { await result.current.permanentlyDeleteNote("t1"); });

    expect(libraryStore.getSnapshot().trashedNotes.map((n) => n.id)).toEqual(["t1"]);
    expect(removeMetaMock).not.toHaveBeenCalled();
    expect(emitTrashUpdatedMock).not.toHaveBeenCalled();
  });

  it("permanentlyDeleteNote drops an entry whose body is already gone", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashedEntry("t1")],
    });
    removeMock.mockImplementation(async () => { throw new Error("os error 2"); });

    await act(async () => { await result.current.permanentlyDeleteNote("t1"); });

    expect(libraryStore.getSnapshot().trashedNotes).toEqual([]);
    expect(emitTrashUpdatedMock).toHaveBeenCalledWith({ removed: [{ id: "t1", trashedAt: 2000 }] });
  });

  it("emptyTrash drops and announces only the entries it purged", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashedEntry("t1"), trashedEntry("t2")],
    });
    lockBody("/notes/.trash/t1.md");
    removeMetaMock.mockClear();

    await act(async () => { await result.current.emptyTrash(); });

    expect(libraryStore.getSnapshot().trashedNotes.map((n) => n.id)).toEqual(["t1"]);
    expect(emitTrashUpdatedMock).toHaveBeenCalledWith({ removed: [{ id: "t2", trashedAt: 2000 }] });
    expect(removeMetaMock.mock.calls.map((c) => c[2])).toEqual(["t2"]);
  });

  it("emptyTrash announces nothing when every body is locked", async () => {
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashedEntry("t1")],
    });
    lockBody("/notes/.trash/t1.md");

    await act(async () => { await result.current.emptyTrash(); });

    expect(libraryStore.getSnapshot().trashedNotes.map((n) => n.id)).toEqual(["t1"]);
    expect(emitTrashUpdatedMock).not.toHaveBeenCalled();
  });
});

describe("useFileSystem — emptyTrash commits a functional delta", () => {
  const trashedEntry = (id: string, trashedAt = 2000): TrashedNote => ({
    id,
    fileName: `Note ${id}`,
    originalFilePath: `/notes/${id}.md`,
    trashFilePath: `/notes/.trash/${id}.md`,
    trashedAt,
    groupId: null,
    createdAt: 1000,
    updatedAt: 1500,
    pinned: false,
  });

  it("keeps a peer entry trashed during the file removals", async () => {
    const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashedEntry("t1"), trashedEntry("t2")],
    });

    removeMock.mockImplementationOnce(async () => {
      // Peer window trashes "t3" while this window is deleting t1's files.
      libraryStore.commit((current) => ({
        trashedNotes: [...current.trashedNotes, trashedEntry("t3", 5000)],
      }), "remote");
    });

    await act(async () => { await result.current.emptyTrash(); });

    // t1/t2 purged; the peer's t3 survives in the local store.
    expect(libraryStore.getSnapshot().trashedNotes.map((n) => n.id)).toEqual(["t3"]);
  });

  it("keeps a newer re-trash incarnation of a purged id", async () => {
    const removeMock = fsPlugin.remove as ReturnType<typeof vi.fn>;
    const { result } = renderFs({
      docs: [makeDoc("a")],
      trashedNotes: [trashedEntry("t1", 2000)],
    });

    removeMock.mockImplementationOnce(async () => {
      // Peer restores and re-trashes t1 (newer incarnation) mid-purge.
      libraryStore.commit((current) => ({
        trashedNotes: current.trashedNotes.map((n) =>
          n.id === "t1" ? { ...n, trashedAt: 9000 } : n,
        ),
      }), "remote");
    });

    await act(async () => { await result.current.emptyTrash(); });

    const t1 = libraryStore.getSnapshot().trashedNotes.find((n) => n.id === "t1");
    expect(t1?.trashedAt).toBe(9000);
  });
});
