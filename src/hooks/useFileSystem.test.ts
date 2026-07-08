import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { NotenError } from "../utils/notenError";

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
  uuidCounter: 0,
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
}));

vi.mock("../utils/fs", () => ({
  tauriFileSystem: { writeTextFile: vi.fn(async () => {}) },
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
  emitGroupsUpdated: vi.fn(),
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

const writeMock = fsPlugin.writeTextFile as ReturnType<typeof vi.fn>;
const readMock = fsPlugin.readTextFile as ReturnType<typeof vi.fn>;
const copyFileMock = fsPlugin.copyFile as ReturnType<typeof vi.fn>;
const logMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;
const markOwnWriteMock = ownWriteModule.markOwnWrite as ReturnType<typeof vi.fn>;
const markGroupAsDeletedMock = notesLoaderModule.markGroupAsDeleted as ReturnType<typeof vi.fn>;
const saveManifestMock = notesLoaderModule.saveManifest as ReturnType<typeof vi.fn>;

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
  const setDocs = vi.fn();
  const setActiveIndex = vi.fn();
  const setGroups = vi.fn();
  const setTrashedNotes = vi.fn();
  const flushAutoSave = vi.fn(async () => !state.isDirty);
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
      getEditor: () => ({ getMarkdown: () => refs.editorContent }),
      openDocument,
      invalidateDocumentSession,
      setDocumentContext: vi.fn(),
      setContent: vi.fn(),
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
  refs.uuidCounter = 0;
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
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
    const importedNames = lastDocs.map((d) => d.fileName).filter((n) => n === "a" || n === "c");
    expect(importedNames.sort()).toEqual(["a", "c"]);
  });

  it("skips a single write-failure source, logs SAVE_FAILED, and imports the rest", async () => {
    readMock.mockImplementation(async (path: string) => `body of ${path}`);
    // The provisioned write path is `/notes/<uuid>.md`. Since UUIDs are
    // deterministic in tests (uuid-1, uuid-2, ...), fail the second one.
    refs.writeFaultByPath.set("/notes/uuid-2.md", new Error("ENOSPC"));

    const { result, setDocs } = renderFs();
    await act(async () => {
      await result.current.importFiles(["/src/a.md", "/src/b.md", "/src/c.md"]);
    });

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(logged).toBeDefined();
    expect((logged![0] as NotenError).context).toMatchObject({ stage: "importFiles" });

    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
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
    const nextGroups = setGroups.mock.calls[setGroups.mock.calls.length - 1][0] as NoteGroup[];
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
    const nextGroups = setGroups.mock.calls[setGroups.mock.calls.length - 1][0] as NoteGroup[];
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
    const nextDocs = setDocs.mock.calls[0][0] as NoteDoc[];
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
    const nextDocs = setDocs.mock.calls[0][0] as NoteDoc[];
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
  it("flushes the deleted doc's background save before copying it to trash", async () => {
    let releaseSave: (saved: boolean) => void = () => {};
    const flushDocSave = vi.fn(
      () => new Promise<boolean>((resolve) => {
        releaseSave = resolve;
      }),
    );
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

describe("useFileSystem — deleteNote last-note replacement", () => {
  it("flags the replacement doc as dirty when its body write fails so autosave will retry", async () => {
    // Trash copy must succeed so we reach the empty-list branch.
    refs.copyFileShouldThrow = null;
    // The replacement is provisioned at /notes/<new-uuid>.md. First UUID
    // consumed is uuid-1 for the replacement.
    refs.writeFaultByPath.set("/notes/uuid-1.md", new Error("EACCES"));

    const doc = makeDoc("a", { content: "to delete" });
    const { result, setDocs } = renderFs({ docs: [doc] });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    expect(setDocs).toHaveBeenCalled();
    // The last setDocs call replaces the array with [replacement].
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
    expect(lastDocs).toHaveLength(1);
    // Critical invariant: write failed, so the manifest entry MUST advertise
    // the doc as dirty — autosave will then retry rather than the user
    // believing they have a clean note that's actually missing on disk.
    expect(lastDocs[0].isDirty).toBe(true);

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
    const { result, setDocs } = renderFs({ docs: [doc] });

    await act(async () => {
      await result.current.deleteNote(0);
    });

    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
    expect(lastDocs).toHaveLength(1);
    expect(lastDocs[0].isDirty).toBe(false);
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
    const committed = setDocs.mock.calls[0][0] as NoteDoc[];
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
      const { result, setDocs } = renderFs({ docs, activeIndex: 0 });

      let deleted: string[] = [];
      await act(async () => {
        deleted = await result.current.deleteNotes(["b", "c"]);
      });

      // b's copy failed → b stays in the list untouched; c is gone.
      expect(deleted).toEqual(["c"]);
      const committed = setDocs.mock.calls[0][0] as NoteDoc[];
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
      const { result, setDocs, notifyActiveDoc } = renderFs({ docs: [empty, other], activeIndex: 0 });

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
      const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
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
    // The pruner now commits the post-delete array synchronously (a plain value,
    // not a prev => ... updater) so callers can persist it consistently.
    const next = setGroups.mock.calls[setGroups.mock.calls.length - 1][0] as NoteGroup[];
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
    const { result, setDocs } = renderFs({ docs: [filled, other], activeIndex: 0 });

    await act(async () => {
      await result.current.switchDocument(1);
    });

    expect(removeMock).not.toHaveBeenCalledWith("/notes/a.md");
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
    expect(lastDocs.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("does not prune an empty doc the user explicitly named (customName)", async () => {
    const named = makeDoc("a", { content: "", customName: true });
    const other = makeDoc("b", { content: "x" });
    const { result, setDocs } = renderFs({ docs: [named, other], activeIndex: 0 });

    await act(async () => {
      await result.current.switchDocument(1);
    });

    expect(removeMock).not.toHaveBeenCalledWith("/notes/a.md");
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
    expect(lastDocs.map((d) => d.id).sort()).toEqual(["a", "b"]);
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

    const { result } = renderFs({ docs: [makeDoc("a")], trashedNotes: [trashed] });
    await act(async () => {
      await result.current.restoreNote("t1");
    });

    const metaIdx = callOrder.indexOf("writeMeta:null");
    const copyIdx = callOrder.indexOf("copyFile");
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeLessThan(copyIdx);
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
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
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
    const { result, setDocs } = renderFs({
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
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
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

    const { result, setDocs } = renderFs({ docs: [target, linker] });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    const rewriteCall = writeMock.mock.calls.find((c) => c[0] === "/notes/linker.md");
    expect(rewriteCall).toBeDefined();
    expect(rewriteCall![1]).toBe("edited [[New]] tail");

    // The disk-derived rewrite also refreshes the lagging in-memory copy and
    // the conflict-backup baseline.
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
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

    const { result, setDocs } = renderFs({ docs: [target, linker] });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    // Rewriting from the stale in-memory copy could regress the doc's latest
    // save, so the doc must be left untouched on disk AND in memory.
    expect(writeMock.mock.calls.some((c) => c[0] === "/notes/linker.md")).toBe(false);
    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
    expect(lastDocs.find((d) => d.id === "linker")!.content).toBe("see [[Old]]");
    // The rename itself still commits.
    expect(lastDocs.find((d) => d.id === "target")!.fileName).toBe("New");
  });
});

// createNoteWithTitle — wiki-link note creation must route through the same
// atomic provisioning path as every other managed-note body write.

describe("useFileSystem — createNoteWithTitle provisioning", () => {
  it("provisions the empty note atomically with markOwnWrite before the write", async () => {
    const { result, setDocs } = renderFs();

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

    const lastDocs = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as NoteDoc[];
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
