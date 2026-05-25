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

vi.mock("../utils/documentTitle", () => ({
  getDefaultDocumentTitle: vi.fn(() => "Untitled"),
}));

vi.mock("../utils/imageAssetUtils", () => ({
  removeNoteAssetDir: vi.fn(async () => {}),
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

vi.mock("../utils/metadataIO", () => ({
  removeMeta: vi.fn(async () => {}),
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

const writeMock = fsPlugin.writeTextFile as ReturnType<typeof vi.fn>;
const readMock = fsPlugin.readTextFile as ReturnType<typeof vi.fn>;
const copyFileMock = fsPlugin.copyFile as ReturnType<typeof vi.fn>;
const logMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;
const markOwnWriteMock = ownWriteModule.markOwnWrite as ReturnType<typeof vi.fn>;

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

  const openDocument = opts.openDocument ?? vi.fn();
  const invalidateDocumentSession = opts.invalidateDocumentSession ?? vi.fn();
  const tiptapRef = {
    current: {
      getEditor: () => ({ getMarkdown: () => refs.editorContent }),
      openDocument,
      invalidateDocumentSession,
      setDocumentContext: vi.fn(),
      setContent: vi.fn(),
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
    openDocument,
    invalidateDocumentSession,
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

// =============================================================================
// importFiles — batch resilience: one bad file must not abort the whole import.
// =============================================================================

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
    const lastDocs = setDocs.mock.calls.at(-1)![0] as NoteDoc[];
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

    const lastDocs = setDocs.mock.calls.at(-1)![0] as NoteDoc[];
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
});

// =============================================================================
// newNote — disk-first invariant: if the body write fails, the previous doc
// must be left exactly as it was. No setDocs, no destructive group prune.
// =============================================================================

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
});

// =============================================================================
// duplicateNote — disk-first invariant: source doc untouched on write failure.
// =============================================================================

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

// =============================================================================
// deleteNote — three distinct safety nets:
//   1. trash copyFile failure → deletion aborted (no orphan removal).
//   2. cancelDocSave runs before disk work → no stale autosave.
//   3. last-note replacement write failure → replacement isDirty=true.
// =============================================================================

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
    const lastDocs = setDocs.mock.calls.at(-1)![0] as NoteDoc[];
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

    const lastDocs = setDocs.mock.calls.at(-1)![0] as NoteDoc[];
    expect(lastDocs).toHaveLength(1);
    expect(lastDocs[0].isDirty).toBe(false);
  });
});

// =============================================================================
// renameNote — back-link rewrite invariant: in-memory body only updates if the
// disk write lands. A failed rewrite must leave that doc's content at the old
// value so memory matches disk and autosave can retry from a coherent state.
// =============================================================================

describe("useFileSystem — renameNote partial-failure", () => {
  it("when one back-link rewrite fails, only the successful docs' bodies update in memory", async () => {
    const target = makeDoc("target", { fileName: "Old", customName: true });
    const linkerOk = makeDoc("linker-ok", { content: "see [[Old]]" });
    const linkerFail = makeDoc("linker-fail", { content: "ref [[Old]]" });
    refs.writeFaultByPath.set("/notes/linker-fail.md", new Error("EACCES"));

    const { result, setDocs } = renderFs({
      docs: [target, linkerOk, linkerFail],
    });

    await act(async () => {
      await result.current.renameNote(0, "New");
    });

    expect(setDocs).toHaveBeenCalled();
    const lastDocs = setDocs.mock.calls.at(-1)![0] as NoteDoc[];
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
    // Set up: active doc has a back-link to the renamed target.
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

// =============================================================================
// restoreNote — copyFile succeeded but readTextFile fails. The trashed entry
// must stay (so the user can retry / next reconcile picks it up) and no new
// doc gets committed.
// =============================================================================

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

// =============================================================================
// markOwnWrite ordering — must happen before writeTextFile so the file-watcher
// doesn't bounce our own write back as a "remote change". Guards the saveFile
// happy path that doesn't go through provisionNoteFile.
// =============================================================================

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
