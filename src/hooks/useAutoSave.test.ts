import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { NoteDoc, NoteGroup } from "../utils/noteTypes";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { Locale, NotesSortOrder } from "./useSettings";
import { NotenError } from "../utils/notenError";
import { blockNoteLifecycle } from "./noteLifecycleGate";

// Shared module-state hoisted so tests can mutate without re-registering mocks.
const refs = vi.hoisted(() => ({
  migrationInProgress: false,
  backupShouldThrow: null as Error | null,
  remoteBackupShouldThrow: null as Error | null,
  writeShouldThrow: null as Error | null,
  provisionShouldFail: false,
  editorContent: "",
  files: new Map<string, string>(),
  journalled: [] as { docId: string; content: string; baseContent: string | null }[],
  journalShouldThrow: null as Error | null,
  knownDiskContent: new Map<string, string>(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/test-appdata"),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ label: "main" })),
}));

// The journal's storage is covered by recoveryJournal.test.ts; here we only
// need to see WHICH edits the hook decides to record.
vi.mock("../utils/recoveryJournal", () => ({
  writeRecoveryRecord: vi.fn(async (_fs: unknown, _dir: string, _label: string, rec: unknown) => {
    if (refs.journalShouldThrow) throw refs.journalShouldThrow;
    refs.journalled.push(rec as { docId: string; content: string; baseContent: string | null });
  }),
  clearRecoveryRecord: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  readTextFile: vi.fn(async () => ""),
  writeTextFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
  exists: vi.fn(async () => false),
  stat: vi.fn(async () => ({ mtime: new Date(), birthtime: new Date() })),
  watch: vi.fn(async () => () => {}),
}));

vi.mock("./useNotesLoader", () => ({
  saveNoteMetadata: vi.fn(async (
    doc: NoteDoc,
    fallbackGroupId: string | null,
    _source?: string,
    publish?: (meta: unknown, executionBase: NoteDoc) => void,
  ) => {
    const meta = {
      version: 2 as const,
      id: doc.id,
      fileName: doc.fileName,
      customName: doc.customName,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      pinned: doc.pinned,
      color: doc.color,
      groupId: fallbackGroupId,
      groupUpdatedAt: doc.updatedAt,
      trashedAt: null,
      trashedFromPath: null,
    };
    void publish;
    return meta;
  }),
  deriveTitle: (s: string) => s.split("\n")[0]?.replace(/^#+\s*/, "") || "",
  sortNotes: <T,>(docs: T[]) => docs,
  getNotesDir: vi.fn(async () => "/notes"),
  // Exposed via a getter so tests can flip the value between render and a
  // later doSave/scheduleAutoSave call. The real export is a `let` binding;
  // ES module live bindings re-read on each access, and a getter preserves
  // that semantic through vi.mock so the hook sees the current `refs` value.
  get migrationInProgress() { return refs.migrationInProgress; },
}));

vi.mock("./useFileSystem", () => ({
  getCurrentMarkdown: vi.fn(() => refs.editorContent),
  provisionNoteFile: vi.fn(async (id: string, content: string) => {
    if (refs.provisionShouldFail) return { filePath: "", ok: false };
    const filePath = `/notes/${id}.md`;
    refs.files.set(filePath, content);
    return { filePath, ok: true };
  }),
}));

vi.mock("../utils/conflictBackup", () => ({
  backupIfRemoteWroteFirst: vi.fn(async () => {
    if (refs.backupShouldThrow) throw refs.backupShouldThrow;
    return false;
  }),
  backupLocalDeletionVersion: vi.fn(async (_fs: unknown, _dir: string, _id: string, _body: string) => {
    if (refs.remoteBackupShouldThrow) throw refs.remoteBackupShouldThrow;
    return "/notes/.conflicts/a-1.md";
  }),
  setKnownDiskContent: vi.fn(),
  getKnownDiskContent: vi.fn((filePath: string) => refs.knownDiskContent.get(filePath)),
}));

vi.mock("../utils/fs", () => ({
  tauriFileSystem: {
    writeTextFile: vi.fn(async () => {
      if (refs.writeShouldThrow) throw refs.writeShouldThrow;
    }),
    readTextFile: vi.fn(async (path: string) => {
      if (!refs.files.has(path)) throw new Error("ENOENT");
      return refs.files.get(path)!;
    }),
    exists: vi.fn(async (path: string) => refs.files.has(path)),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async (path: string) => { refs.files.delete(path); }),
  },
}));

// doSave routes the body write through atomicWriteText (temp+rename).
// Delegate straight to fs.writeTextFile so existing writeMock assertions
// (final path, content, fault injection) keep observing the body write.
vi.mock("../utils/atomicWrite", () => ({
  atomicWriteText: vi.fn(async (fs: { writeTextFile: (p: string, c: string) => Promise<void> }, path: string, content: string) => {
    await fs.writeTextFile(path, content);
  }),
}));

vi.mock("./useWindowSync", () => ({
  emitDocUpdated: vi.fn(),
}));

vi.mock("./ownWriteTracker", () => ({
  markOwnWrite: vi.fn(),
}));

vi.mock("../utils/crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/documentTitle", () => ({
  getDefaultDocumentTitle: vi.fn(() => "Untitled"),
}));

// Imports must come AFTER vi.mock() registrations.
import { useAutoSave, type FlushResult } from "./useAutoSave";
import * as useNotesLoaderModule from "./useNotesLoader";
import * as useFileSystemModule from "./useFileSystem";
import * as conflictBackupModule from "../utils/conflictBackup";
import * as fsModule from "../utils/fs";
import * as crashLogModule from "../utils/crashLog";
import * as windowSyncModule from "./useWindowSync";

const saveNoteMetadataMock = useNotesLoaderModule.saveNoteMetadata as ReturnType<typeof vi.fn>;
const getCurrentMarkdownMock = useFileSystemModule.getCurrentMarkdown as ReturnType<typeof vi.fn>;
const backupMock = conflictBackupModule.backupIfRemoteWroteFirst as ReturnType<typeof vi.fn>;
const localDeletionBackupMock = conflictBackupModule.backupLocalDeletionVersion as ReturnType<typeof vi.fn>;
const writeMock = fsModule.tauriFileSystem.writeTextFile as ReturnType<typeof vi.fn>;
const logMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;
const emitDocUpdatedMock = windowSyncModule.emitDocUpdated as ReturnType<typeof vi.fn>;

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
  let cachedMarkdown = refs.editorContent;
  return {
    isDirty: false,
    setIsDirty: vi.fn(),
    primeMarkdown: vi.fn((value: string) => { cachedMarkdown = value; }),
    getCachedMarkdown: vi.fn(() => cachedMarkdown),
    setFilePath: vi.fn(),
    filePath: null,
    ...overrides,
  } as unknown as MarkdownState;
}

function makeTiptapRef(): React.RefObject<TiptapEditorHandle | null> {
  return {
    current: {
      getEditor: () => ({
        getMarkdown: () => refs.editorContent,
      }),
    } as unknown as TiptapEditorHandle,
  };
}

interface AutoSaveProps {
  docs: NoteDoc[];
  activeIndex: number;
  state: MarkdownState;
}

function renderAutoSave(opts: {
  docs?: NoteDoc[];
  activeIndex?: number;
  state?: MarkdownState;
}) {
  const docs = opts.docs ?? [makeDoc("a")];
  const setDocs = vi.fn();
  const state = opts.state ?? makeState({ isDirty: true });
  const tiptapRef = makeTiptapRef();
  const groups: NoteGroup[] = [];
  const activeIndex = opts.activeIndex ?? 0;

  let props: AutoSaveProps = { docs, activeIndex, state };
  const { result, rerender } = renderHook(
    (next: AutoSaveProps) =>
      useAutoSave(
        next.state,
        tiptapRef,
        next.docs,
        setDocs,
        next.activeIndex,
        "en",
        "updated-desc",
        groups,
      ),
    { initialProps: props },
  );
  // Stand-in for an App re-render: window-sync, restoreNote, and reconcile all
  // reach useAutoSave by replacing the docs array it is called with.
  const rerenderWith = (patch: Partial<AutoSaveProps>) => {
    props = { ...props, ...patch };
    rerender(props);
  };
  return { result, rerenderWith, setDocs, state, tiptapRef, docs };
}

beforeEach(() => {
  refs.migrationInProgress = false;
  refs.journalled = [];
  refs.journalShouldThrow = null;
  refs.knownDiskContent = new Map();
  refs.backupShouldThrow = null;
  refs.remoteBackupShouldThrow = null;
  refs.writeShouldThrow = null;
  refs.provisionShouldFail = false;
  refs.editorContent = "hello world";
  refs.files.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useAutoSave — remote deletion race", () => {
  it("quarantines new saves and removes a crossed older in-flight body", async () => {
    let releaseOlderWrite!: () => void;
    refs.editorContent = "older local edit";
    refs.files.set("/notes/.trash/a.md", "base");
    writeMock.mockImplementationOnce(
      (path: string, content: string) => new Promise<void>((resolve) => {
        releaseOlderWrite = () => {
          refs.files.set(path, content);
          resolve();
        };
      }),
    );
    const { result } = renderAutoSave({
      docs: [makeDoc("a", { content: "base", isDirty: true })],
      state: makeState({ isDirty: true }),
    });

    act(() => result.current.captureAndQueueSave());
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "older local edit");
    });

    // A newer snapshot replaces pendingSnapshotsRef while the older body is
    // already inside atomicWriteText. Both must remain known to deletion
    // cleanup, and nothing scheduled after quarantine may re-enter doSave.
    refs.editorContent = "newer local edit";
    act(() => result.current.captureAndQueueSave());
    const settlement = result.current.settleRemoteDeletedDoc("a");
    refs.editorContent = "edit after delete event";
    act(() => result.current.scheduleAutoSave());

    await act(async () => {
      releaseOlderWrite();
      expect(await settlement).toBe(true);
    });

    const liveWrites = writeMock.mock.calls.filter(([path]) => path === "/notes/a.md");
    expect(liveWrites).toEqual([["/notes/a.md", "older local edit"]]);
    expect(refs.files.has("/notes/a.md")).toBe(false);
    expect(writeMock).toHaveBeenCalledWith("/notes/.trash/a.md", "newer local edit");
  });

  it("keeps deletion authoritative while folding dirty editor Markdown into trash", async () => {
    vi.useFakeTimers();
    refs.editorContent = "base plus local edit";
    refs.files.set("/notes/.trash/a.md", "base");
    const { result } = renderAutoSave({
      docs: [makeDoc("a", { content: "base", isDirty: true })],
      state: makeState({ isDirty: true }),
    });

    act(() => result.current.scheduleAutoSave());
    await act(async () => {
      expect(await result.current.settleRemoteDeletedDoc("a")).toBe(true);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(writeMock).toHaveBeenCalledWith("/notes/.trash/a.md", "base plus local edit");
    expect(writeMock).not.toHaveBeenCalledWith("/notes/a.md", expect.anything());
    expect(localDeletionBackupMock).not.toHaveBeenCalled();
  });

  it("uses a conflict backup only when the trash body also diverged", async () => {
    refs.editorContent = "local edit";
    refs.files.set("/notes/.trash/a.md", "other-window edit");
    const { result } = renderAutoSave({
      docs: [makeDoc("a", { content: "base", isDirty: true })],
      state: makeState({ isDirty: true }),
    });

    await act(async () => {
      expect(await result.current.settleRemoteDeletedDoc("a")).toBe(true);
    });

    expect(localDeletionBackupMock).toHaveBeenCalledWith(
      fsModule.tauriFileSystem,
      "/notes",
      "a",
      "local edit",
    );
    expect(writeMock).not.toHaveBeenCalledWith("/notes/.trash/a.md", expect.anything());
  });

  it("falls back to a conflict artifact when the trash body cannot be updated", async () => {
    refs.editorContent = "local edit";
    refs.files.set("/notes/.trash/a.md", "base");
    refs.writeShouldThrow = new Error("trash locked");
    const { result } = renderAutoSave({
      docs: [makeDoc("a", { content: "base", isDirty: true })],
      state: makeState({ isDirty: true }),
    });

    await act(async () => {
      expect(await result.current.settleRemoteDeletedDoc("a")).toBe(true);
    });

    expect(localDeletionBackupMock).toHaveBeenCalledWith(
      fsModule.tauriFileSystem,
      "/notes",
      "a",
      "local edit",
    );
  });
});

describe("useAutoSave — remote deletion tombstone lifecycle", () => {
  it("saves again after the deleted id is restored under a new entry", async () => {
    vi.useFakeTimers();
    const deletedEntry = makeDoc("a", { content: "base" });
    const { result, rerenderWith } = renderAutoSave({
      docs: [deletedEntry],
      state: makeState({ isDirty: false }),
    });

    await act(async () => {
      expect(await result.current.settleRemoteDeletedDoc("a")).toBe(true);
    });

    // useWindowSync drops the deleted doc from state, then restoreNote (or the
    // doc-created broadcast from the window that restored it) reintroduces the
    // SAME id as a fresh entry. Autosave must come back to life for it.
    act(() => rerenderWith({ docs: [] }));
    act(() => rerenderWith({
      docs: [makeDoc("a", { content: "base" })],
      state: makeState({ isDirty: true }),
    }));

    refs.editorContent = "edit after restore";
    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "edit after restore");
  });

  it("keeps blocking saves while the entry the deletion removed is still present", async () => {
    vi.useFakeTimers();
    const deletedEntry = makeDoc("a", { content: "base" });
    const { result, rerenderWith } = renderAutoSave({
      docs: [deletedEntry],
      state: makeState({ isDirty: false }),
    });

    await act(async () => {
      expect(await result.current.settleRemoteDeletedDoc("a")).toBe(true);
    });

    // A render still carrying the very entry the deletion targeted is not a
    // restore, so the tombstone must survive it.
    act(() => rerenderWith({ docs: [deletedEntry], state: makeState({ isDirty: true }) }));

    refs.editorContent = "edit after delete event";
    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(writeMock).not.toHaveBeenCalledWith("/notes/a.md", expect.anything());
  });

  it("does not tombstone a note this window never held", async () => {
    vi.useFakeTimers();
    const { result, rerenderWith } = renderAutoSave({
      docs: [makeDoc("b")],
      state: makeState({ isDirty: false }),
    });

    // The deletion broadcast reaches every window, including ones with no entry
    // for that id. Such a window has nothing to preserve and must not carry the
    // id into the future.
    await act(async () => {
      expect(await result.current.settleRemoteDeletedDoc("a")).toBe(true);
    });

    act(() => rerenderWith({
      docs: [makeDoc("a")],
      state: makeState({ isDirty: true }),
    }));

    refs.editorContent = "edit on the restored note";
    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "edit on the restored note");
  });

  it("flushes a restored note's pending edit at close", async () => {
    const deletedEntry = makeDoc("a", { content: "base" });
    const { result, rerenderWith } = renderAutoSave({
      docs: [deletedEntry],
      state: makeState({ isDirty: false }),
    });

    await act(async () => {
      expect(await result.current.settleRemoteDeletedDoc("a")).toBe(true);
    });
    act(() => rerenderWith({ docs: [] }));
    act(() => rerenderWith({
      docs: [makeDoc("a", { content: "base" })],
      state: makeState({ isDirty: true }),
    }));

    refs.editorContent = "unsaved edit at close";
    await act(async () => {
      expect(await result.current.flushAutoSave()).toEqual({ status: "saved" });
    });

    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "unsaved edit at close");
  });
});


describe("useAutoSave — doSave golden path", () => {
  it("writes the body, persists only that note's metadata, and clears isDirty when the editor still matches", async () => {
    refs.editorContent = "# Title\nbody";
    const setIsDirty = vi.fn();
    const state = makeState({ isDirty: true, setIsDirty });
    const { result } = renderAutoSave({ state });

    await act(async () => {
      const ok = await result.current.flushAutoSave();
      expect(ok).toEqual({ status: "saved" });
    });

    expect(backupMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "# Title\nbody");
    expect(saveNoteMetadataMock).toHaveBeenCalledTimes(1);
    expect(saveNoteMetadataMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", content: "# Title\nbody" }),
      null,
      "autosave",
      expect.any(Function),
    );
    expect(setIsDirty).toHaveBeenCalledWith(false);
  });

  it("commits and broadcasts the effective metadata returned by the writer", async () => {
    refs.editorContent = "# Stale derived title\nbody";
    saveNoteMetadataMock.mockResolvedValueOnce({
      version: 2,
      id: "a",
      fileName: "Peer manual title",
      customName: true,
      createdAt: 250,
      updatedAt: 7000,
      pinned: true,
      color: "purple",
      groupId: null,
      groupUpdatedAt: 6000,
      trashedAt: null,
      trashedFromPath: null,
    });
    const { result, setDocs } = renderAutoSave({
      docs: [makeDoc("a", { fileName: "Old auto title", createdAt: 1000 })],
      state: makeState({ isDirty: true }),
    });

    await act(async () => {
      expect(await result.current.flushAutoSave()).toEqual({ status: "saved" });
    });

    const updater = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as (prev: NoteDoc[]) => NoteDoc[];
    expect(updater([makeDoc("a", { fileName: "Old auto title", createdAt: 1000 })])[0]).toMatchObject({
      fileName: "Peer manual title",
      customName: true,
      createdAt: 250,
      updatedAt: 7000,
      pinned: true,
      color: "purple",
    });
    expect(emitDocUpdatedMock).toHaveBeenCalledWith("a", "/notes/a.md", "# Stale derived title\nbody", 7000);
  });

  it("does not overwrite metadata changed locally while the writer is pending", async () => {
    const initial = makeDoc("a", {
      fileName: "Initial title",
      pinned: false,
      color: "blue",
      updatedAt: 1000,
    });
    let releaseWriter!: () => void;
    saveNoteMetadataMock.mockImplementationOnce((
      _doc: NoteDoc,
      _groupId: string | null,
      _source: string,
      publish: (
        meta: unknown,
        executionBase: NoteDoc,
        changed: { title: boolean; pinned: boolean; color: boolean },
      ) => void,
    ) => new Promise((resolve) => {
      const effective = {
        version: 2,
        id: "a",
        fileName: "Disk title before local action",
        createdAt: 1000,
        updatedAt: 7000,
        pinned: false,
        color: "purple",
        groupId: null,
        groupUpdatedAt: 1000,
        trashedAt: null,
      };
      releaseWriter = () => {
        publish(effective, initial, { title: true, pinned: true, color: true });
        resolve(effective);
      };
    }));
    const { result, setDocs, rerenderWith } = renderAutoSave({
      docs: [initial],
      state: makeState({ isDirty: true }),
    });

    let save!: Promise<FlushResult>;
    act(() => { save = result.current.flushAutoSave(); });
    await waitFor(() => expect(saveNoteMetadataMock).toHaveBeenCalledTimes(1));
    const locallyChanged = makeDoc("a", {
      fileName: "Newest local rename",
      customName: true,
      pinned: true,
      color: "red",
      updatedAt: 8000,
    });
    act(() => rerenderWith({ docs: [locallyChanged] }));

    await act(async () => {
      releaseWriter();
      expect(await save).toEqual({ status: "saved" });
    });

    let committed = [locallyChanged];
    for (const [action] of setDocs.mock.calls) {
      committed = typeof action === "function" ? action(committed) : action;
    }
    expect(committed[0]).toMatchObject({
      fileName: "Newest local rename",
      customName: true,
      pinned: true,
      color: "red",
      updatedAt: 8000,
      content: "hello world",
    });
    expect(emitDocUpdatedMock).toHaveBeenCalledWith("a", "/notes/a.md", "hello world", 7000);
  });

  it("lets a later autosave advance metadata published before React renders it", async () => {
    const initial = makeDoc("a", { fileName: "Initial title", isDirty: true });
    let canonicalDocs = [initial];
    const persistAgainstCanonical = async (
      doc: NoteDoc,
      fallbackGroupId: string | null,
      _source: string,
      publish: (
        meta: unknown,
        executionBase: NoteDoc,
        changed: { title: boolean; pinned: boolean; color: boolean },
      ) => void,
    ) => {
      const executionBase = canonicalDocs.find((entry) => entry.id === doc.id)!;
      const meta = {
        version: 2 as const,
        id: doc.id,
        fileName: executionBase.customName ? executionBase.fileName : doc.fileName,
        customName: executionBase.customName,
        createdAt: executionBase.createdAt,
        updatedAt: doc.updatedAt,
        pinned: executionBase.pinned,
        color: executionBase.color,
        groupId: fallbackGroupId,
        groupUpdatedAt: doc.updatedAt,
        trashedAt: null,
        trashedFromPath: null,
      };
      publish(meta, executionBase, { title: false, pinned: false, color: false });
      return meta;
    };
    saveNoteMetadataMock
      .mockImplementationOnce(persistAgainstCanonical)
      .mockImplementationOnce(persistAgainstCanonical);
    const setDocs = vi.fn((action: React.SetStateAction<NoteDoc[]>) => {
      canonicalDocs = typeof action === "function" ? action(canonicalDocs) : action;
    });
    const state = makeState({ isDirty: true });
    const { result } = renderHook(() => useAutoSave(
      state,
      makeTiptapRef(),
      [initial],
      setDocs,
      0,
      "en",
      "updated-desc",
      [],
    ));

    refs.editorContent = "# First title\nbody";
    await act(async () => {
      expect(await result.current.flushAutoSave()).toEqual({ status: "saved" });
    });
    expect(canonicalDocs[0].fileName).toBe("First title");

    // Keep the hook's docs prop at the old baseline to model React not having
    // rendered the first queue callback before the next snapshot is captured.
    refs.editorContent = "# Second title\nbody";
    await act(async () => {
      expect(await result.current.flushAutoSave()).toEqual({ status: "saved" });
    });

    expect(canonicalDocs[0].fileName).toBe("Second title");
    expect(canonicalDocs[0].content).toBe("# Second title\nbody");
  });

  it("leaves state dirty and emits nothing when the metadata patch is superseded", async () => {
    saveNoteMetadataMock.mockResolvedValueOnce(null);
    const setIsDirty = vi.fn();
    const { result, setDocs } = renderAutoSave({
      state: makeState({ isDirty: true, setIsDirty }),
    });

    await act(async () => {
      expect(await result.current.flushAutoSave()).toMatchObject({ status: "failed" });
    });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(setDocs).not.toHaveBeenCalled();
    expect(emitDocUpdatedMock).not.toHaveBeenCalled();
    expect(setIsDirty).not.toHaveBeenCalledWith(false);
  });
});

describe("useAutoSave — backup-failure defers save", () => {
  it("reports save-failed, skips writeTextFile, leaves isDirty alone, and logs the BACKUP_FAILED", async () => {
    refs.backupShouldThrow = new NotenError(
      "BACKUP_FAILED",
      "fatal",
      "test: backup unwritable",
    );
    const setIsDirty = vi.fn();
    const state = makeState({ isDirty: true, setIsDirty });
    const { result } = renderAutoSave({ state });

    let ok: FlushResult | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toEqual({ status: "failed", reason: "save-failed" });
    expect(writeMock).not.toHaveBeenCalled();
    expect(saveNoteMetadataMock).not.toHaveBeenCalled();
    expect(setIsDirty).not.toHaveBeenCalled();
    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "BACKUP_FAILED",
    );
    expect(logged).toBeDefined();
  });

  it("wraps a non-NotenError backup throw in BACKUP_FAILED before logging", async () => {
    refs.backupShouldThrow = new Error("EBUSY: cloud-sync hydration");
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    await act(async () => {
      await result.current.flushAutoSave();
    });

    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "BACKUP_FAILED",
    );
    expect(logged).toBeDefined();
    const ne = logged![0] as NotenError;
    expect(ne.context).toMatchObject({ noteId: "a", filePath: "/notes/a.md" });
  });
});

describe("useAutoSave — pathless fallback doc (loader failure stub)", () => {
  const provisionMock = useFileSystemModule.provisionNoteFile as ReturnType<typeof vi.fn>;

  it("hasUnsaveableChanges reports a dirty pathless doc; hasUnsavedChanges stays pending-only", () => {
    refs.provisionShouldFail = true;
    const { result } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    act(() => result.current.scheduleAutoSave());
    // Never folded into hasUnsavedChanges: its consumers treat `true` as
    // "drain and retry", which a structurally unsaveable doc cannot satisfy.
    expect(result.current.hasUnsavedChanges()).toBe(false);
    expect(result.current.hasUnsaveableChanges()).toBe(true);
  });

  it("hasUnsaveableChanges stays false for a clean pathless doc and clears when the doc leaves", () => {
    const { result, rerenderWith } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: false })],
      state: makeState({ isDirty: false }),
    });
    expect(result.current.hasUnsaveableChanges()).toBe(false);

    rerenderWith({ docs: [makeDoc("local", { filePath: "", isDirty: true })] });
    expect(result.current.hasUnsaveableChanges()).toBe(true);

    rerenderWith({ docs: [makeDoc("a", { isDirty: true })] });
    expect(result.current.hasUnsaveableChanges()).toBe(false);
  });

  it("an edit provisions a real file with the live editor content", async () => {
    const { result, setDocs } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    await act(async () => {
      result.current.scheduleAutoSave();
      await Promise.resolve();
    });

    expect(provisionMock).toHaveBeenCalledWith("local", "hello world", "autosave-provision-pathless");
    expect(refs.files.get("/notes/local.md")).toBe("hello world");
    // The docs commit adopts the provisioned path.
    const updater = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as (prev: NoteDoc[]) => NoteDoc[];
    const next = updater([makeDoc("local", { filePath: "", isDirty: true })]);
    expect(next[0].filePath).toBe("/notes/local.md");
  });

  it("after provisioning, the next edit arms a normal debounced save", async () => {
    vi.useFakeTimers();
    const { result } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    await act(async () => {
      result.current.scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.hasUnsaveableChanges()).toBe(false);

    refs.editorContent = "typed after provisioning";
    act(() => result.current.scheduleAutoSave());
    expect(result.current.hasUnsavedChanges()).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(writeMock).toHaveBeenCalledWith("/notes/local.md", "typed after provisioning");
  });

  it("flushAutoSave provisions and re-snapshots, and reports \"provisioned\" so stale-snapshot callers don't mark the doc clean", async () => {
    const { result } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    let flushed: FlushResult | undefined;
    await act(async () => {
      flushed = await result.current.flushAutoSave();
    });

    // The content IS persisted...
    expect(refs.files.get("/notes/local.md")).toBe("hello world");
    // ...through the normal pipeline via the post-provision re-snapshot...
    expect(writeMock).toHaveBeenCalledWith("/notes/local.md", "hello world");
    // ...but callers that snapshotted docs before the flush would commit a
    // clean-but-pathless entry if this read as a plain save, so the adopted
    // path is reported instead of a bare success.
    expect(flushed).toEqual({ status: "provisioned", filePath: "/notes/local.md" });
  });

  it("flushAutoSave does not provision while a migration is in progress", async () => {
    refs.migrationInProgress = true;
    const { result } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    let flushed: FlushResult | undefined;
    await act(async () => {
      flushed = await result.current.flushAutoSave();
    });

    expect(flushed).toEqual({ status: "failed", reason: "provision-failed" });
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("a remote deletion arriving mid-provision wins: the provisioned file is removed, nothing adopted", async () => {
    const removeMock = fsModule.tauriFileSystem.remove as ReturnType<typeof vi.fn>;
    let release!: (value: { filePath: string; ok: boolean }) => void;
    provisionMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const { result, setDocs } = renderAutoSave({
      docs: [makeDoc("stub", { filePath: "", isDirty: true })],
    });

    act(() => result.current.scheduleAutoSave());

    let settled!: Promise<boolean>;
    act(() => { settled = result.current.settleRemoteDeletedDoc("stub"); });

    await act(async () => {
      refs.files.set("/notes/stub.md", "hello world");
      release({ filePath: "/notes/stub.md", ok: true });
      await settled;
    });

    expect(removeMock).toHaveBeenCalledWith("/notes/stub.md");
    expect(setDocs).not.toHaveBeenCalled();
  });

  it("flushAutoSave reports provision-failed and hasUnsaveableChanges stays true while provisioning fails", async () => {
    refs.provisionShouldFail = true;
    const { result } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    let flushed: FlushResult | undefined;
    await act(async () => {
      flushed = await result.current.flushAutoSave();
    });

    expect(flushed).toEqual({ status: "failed", reason: "provision-failed" });
    expect(writeMock).not.toHaveBeenCalled();
    expect(result.current.hasUnsaveableChanges()).toBe(true);
  });

  it("failed provisioning retries are throttled for edits but not for an explicit flush", async () => {
    vi.useFakeTimers();
    refs.provisionShouldFail = true;
    const { result } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    await act(async () => {
      result.current.scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(provisionMock).toHaveBeenCalledTimes(1);

    // A keystroke right after the failure does not hammer the dead dir...
    await act(async () => {
      result.current.scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(provisionMock).toHaveBeenCalledTimes(1);

    // ...but the close-time flush always makes a fresh attempt.
    refs.provisionShouldFail = false;
    await act(async () => {
      await result.current.flushAutoSave();
    });
    expect(provisionMock).toHaveBeenCalledTimes(2);
    expect(refs.files.get("/notes/local.md")).toBe("hello world");
  });

  it("the doc-switch capture path bypasses the retry throttle", async () => {
    vi.useFakeTimers();
    refs.provisionShouldFail = true;
    const { result } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    await act(async () => {
      result.current.scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(provisionMock).toHaveBeenCalledTimes(1);

    // A doc switch inside the throttle window must still capture the content.
    await act(async () => {
      result.current.captureAndQueueSave();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(provisionMock).toHaveBeenCalledTimes(2);
  });

  it("a failed provision stashes the captured text into the doc so a switch can't strand it", async () => {
    refs.provisionShouldFail = true;
    refs.editorContent = "typed into the stub";
    const { result, setDocs } = renderAutoSave({
      docs: [makeDoc("local", { filePath: "", isDirty: true })],
    });

    await act(async () => {
      await result.current.flushAutoSave();
    });

    const updater = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as (prev: NoteDoc[]) => NoteDoc[];
    const next = updater([makeDoc("local", { filePath: "", isDirty: true })]);
    expect(next[0].content).toBe("typed into the stub");
    expect(next[0].filePath).toBe("");
  });

  it("a doc switch that joins an in-flight provision still captures the newer text and saves it", async () => {
    let release!: (value: { filePath: string; ok: boolean }) => void;
    provisionMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    refs.editorContent = "E1";
    const { result, setDocs } = renderAutoSave({
      docs: [makeDoc("stub", { filePath: "", isDirty: true }), makeDoc("other")],
    });

    // First edit starts the provision with E1 and awaits real I/O.
    act(() => result.current.scheduleAutoSave());
    expect(provisionMock).toHaveBeenCalledWith("stub", "E1", "autosave-provision-pathless");

    // More typing, then a fast-path doc switch: the capture joins the in-flight
    // attempt (no second provision) and the editor is repointed at another doc.
    refs.editorContent = "E2";
    act(() => result.current.captureAndQueueSave());
    act(() => result.current.notifyActiveDoc("other", "/notes/other.md"));
    refs.editorContent = "other body";
    expect(provisionMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      refs.files.set("/notes/stub.md", "E1");
      release({ filePath: "/notes/stub.md", ok: true });
      await result.current.awaitInFlightSaves();
    });

    // The newer text is what reaches disk and the store — not the E1 the
    // attempt started with, and never the other doc's body.
    expect(writeMock).toHaveBeenCalledWith("/notes/stub.md", "E2");
    expect(writeMock).not.toHaveBeenCalledWith("/notes/stub.md", "other body");
    const adopt = setDocs.mock.calls
      .map((call) => call[0] as (prev: NoteDoc[]) => NoteDoc[])
      .map((updater) => updater([makeDoc("stub", { filePath: "", isDirty: true }), makeDoc("other")]))
      .find((next) => next[0].filePath === "/notes/stub.md");
    expect(adopt?.[0].content).toBe("E2");
    expect(result.current.hasUnsavedChanges()).toBe(false);
  });

  it("keystrokes that join an in-flight provision are saved once it lands, with the doc still active", async () => {
    let release!: (value: { filePath: string; ok: boolean }) => void;
    provisionMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    refs.editorContent = "E1";
    const { result } = renderAutoSave({
      docs: [makeDoc("stub", { filePath: "", isDirty: true })],
    });

    act(() => result.current.scheduleAutoSave());
    refs.editorContent = "E2";
    act(() => result.current.scheduleAutoSave());
    expect(provisionMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      refs.files.set("/notes/stub.md", "E1");
      release({ filePath: "/notes/stub.md", ok: true });
      await result.current.awaitInFlightSaves();
    });

    expect(writeMock).toHaveBeenCalledWith("/notes/stub.md", "E2");
    expect(result.current.hasUnsavedChanges()).toBe(false);
    expect(result.current.hasUnsaveableChanges()).toBe(false);
  });

  it("a failed provision stashes the newest joined capture, not the text it started with", async () => {
    let release!: (value: { filePath: string; ok: boolean }) => void;
    provisionMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    refs.editorContent = "E1";
    const { result, setDocs } = renderAutoSave({
      docs: [makeDoc("stub", { filePath: "", isDirty: true })],
    });

    act(() => result.current.scheduleAutoSave());
    refs.editorContent = "E2";
    act(() => result.current.captureAndQueueSave());

    await act(async () => {
      release({ filePath: "", ok: false });
      await result.current.awaitInFlightSaves();
    });

    const updater = setDocs.mock.calls[setDocs.mock.calls.length - 1][0] as (prev: NoteDoc[]) => NoteDoc[];
    const next = updater([makeDoc("stub", { filePath: "", isDirty: true })]);
    expect(next[0].content).toBe("E2");
    expect(next[0].filePath).toBe("");
  });
});

describe("useAutoSave — doSave functional commit", () => {
  it("recomputes against prev so a concurrently deleted doc is not resurrected", async () => {
    const { result, setDocs } = renderAutoSave({
      docs: [makeDoc("a", { isDirty: true }), makeDoc("b")],
    });

    await act(async () => {
      await result.current.flushAutoSave();
    });

    const lastArg = setDocs.mock.calls[setDocs.mock.calls.length - 1][0];
    expect(typeof lastArg).toBe("function");
    const updater = lastArg as (prev: NoteDoc[]) => NoteDoc[];

    // deleteNotes removed "b" while the save was in flight: prev no longer
    // contains it, and the commit must not bring it back.
    const next = updater([makeDoc("a", { isDirty: true })]);
    expect(next.some((d) => d.id === "b")).toBe(false);
    expect(next.find((d) => d.id === "a")?.content).toBe("hello world");

    // The saved doc itself was concurrently deleted: prev stays untouched.
    const prevWithoutSaved = [makeDoc("b")];
    expect(updater(prevWithoutSaved)).toBe(prevWithoutSaved);
  });
});

describe("useAutoSave — debounce queue", () => {
  it("defers Markdown serialization and the write until DEBOUNCE_MS has elapsed", async () => {
    vi.useFakeTimers();
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());

    expect(getCurrentMarkdownMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(getCurrentMarkdownMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getCurrentMarkdownMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "hello world");
  });

  it("rapid scheduleAutoSave for the same doc cancels the prior timer (one fire, not two)", async () => {
    vi.useFakeTimers();
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    // Second schedule should replace the first timer.
    refs.editorContent = "second snapshot";
    act(() => result.current.scheduleAutoSave());
    // Original timer would have fired at t=1000; assert it did NOT.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(writeMock).not.toHaveBeenCalled();

    // Second timer fires at t=1000 from second schedule (t=1500 absolute).
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "second snapshot");
  });
});

describe("useAutoSave — revision-mismatch guard", () => {
  it("a stale snapshot whose revision was bumped by a later schedule does not commit a write", async () => {
    vi.useFakeTimers();
    // Hold the backup call so we can interleave a second schedule before doSave proceeds.
    let releaseBackup: () => void = () => {};
    backupMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseBackup = () => resolve(false);
      }),
    );
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    // doSave is now suspended inside backupIfRemoteWroteFirst.

    // A new schedule fires while doSave is in flight — this bumps the revision.
    refs.editorContent = "newer content";
    act(() => result.current.scheduleAutoSave());

    // Release the original backup; the in-flight doSave should see the
    // revision mismatch and bail BEFORE the second snapshot's timer fires.
    await act(async () => {
      releaseBackup();
      await Promise.resolve();
    });

    // The stale snapshot must bail before body write; protecting only the
    // manifest would still allow old content to land on disk.
    expect(writeMock).not.toHaveBeenCalled();
    expect(saveNoteMetadataMock).not.toHaveBeenCalled();
  });

  it("an older in-flight save cannot overwrite a newer flushed body", async () => {
    vi.useFakeTimers();
    let releaseFirstBackup: () => void = () => {};
    backupMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseFirstBackup = () => resolve(false);
      }),
    );
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    refs.editorContent = "older content";
    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    refs.editorContent = "newer content";
    act(() => result.current.scheduleAutoSave());
    await act(async () => {
      const ok = await result.current.flushAutoSave();
      expect(ok).toEqual({ status: "saved" });
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenLastCalledWith("/notes/a.md", "newer content");

    await act(async () => {
      releaseFirstBackup();
      await Promise.resolve();
    });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).not.toHaveBeenCalledWith("/notes/a.md", "older content");
  });
});

describe("useAutoSave — flushAutoSave behavior", () => {
  it("resolves clean without calling doSave when nothing is pending and the editor is clean", async () => {
    const { result } = renderAutoSave({ state: makeState({ isDirty: false }) });

    let ok: FlushResult | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toEqual({ status: "clean" });
    expect(backupMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("fires pending saves immediately, bypassing the debounce delay", async () => {
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());
    // Without advancing timers, the debounce hasn't fired yet.
    expect(writeMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.flushAutoSave();
    });

    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("drops a pending target that can no longer be snapshotted", async () => {
    vi.useFakeTimers();
    const docs = [makeDoc("a"), makeDoc("b")];
    const setDocs = vi.fn();
    const tiptapRef = makeTiptapRef();
    const groups: NoteGroup[] = [];

    const { result, rerender } = renderHook(
      ({ activeIndex, state }: { activeIndex: number; state: MarkdownState }) =>
        useAutoSave(
          state,
          tiptapRef,
          docs,
          setDocs,
          activeIndex,
          "en" as Locale,
          "updated-desc" as NotesSortOrder,
          groups,
        ),
      { initialProps: { activeIndex: 0, state: makeState({ isDirty: true }) } },
    );

    act(() => result.current.scheduleAutoSave());
    rerender({ activeIndex: 1, state: makeState({ isDirty: false }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    await act(async () => {
      const ok = await result.current.flushAutoSave();
      expect(ok).toEqual({ status: "clean" });
    });

    expect(getCurrentMarkdownMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe("useAutoSave — migration short-circuit", () => {
  it("scheduleAutoSave is a no-op while a notes-dir migration is in progress", async () => {
    vi.useFakeTimers();
    refs.migrationInProgress = true;
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(writeMock).not.toHaveBeenCalled();
    expect(backupMock).not.toHaveBeenCalled();
  });

  it("doSave returns false without touching disk if migration starts before it runs", async () => {
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    refs.migrationInProgress = true;
    let ok: FlushResult | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toEqual({ status: "failed", reason: "save-failed" });
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe("useAutoSave — cancelDocSave", () => {
  it("drops a pending timer + snapshot so the doSave never fires", async () => {
    vi.useFakeTimers();
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());
    act(() => result.current.cancelDocSave("a"));

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("does not write a body while a lifecycle transaction quarantines the note", async () => {
    const release = blockNoteLifecycle(["a"]);
    try {
      const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });
      let ok: FlushResult | undefined;
      await act(async () => {
        ok = await result.current.flushAutoSave();
      });

      expect(ok).toEqual({ status: "failed", reason: "save-failed" });
      expect(writeMock).not.toHaveBeenCalled();
      expect(saveNoteMetadataMock).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("does not provision a pathless body while lifecycle is quarantined", async () => {
    const provisionMock = useFileSystemModule.provisionNoteFile as ReturnType<typeof vi.fn>;
    const release = blockNoteLifecycle(["a"]);
    try {
      refs.editorContent = "edit captured during delete";
      const initial = makeDoc("a", { filePath: "", content: "older", isDirty: true });
      const { result, setDocs } = renderAutoSave({
        docs: [initial],
        state: makeState({ isDirty: true }),
      });

      let ok: FlushResult | undefined;
      await act(async () => {
        ok = await result.current.flushAutoSave();
      });

      expect(ok).toEqual({ status: "failed", reason: "provision-failed" });
      expect(provisionMock).not.toHaveBeenCalled();
      const update = setDocs.mock.calls[0]?.[0] as (docs: NoteDoc[]) => NoteDoc[];
      expect(update([initial])[0]).toMatchObject({
        content: "edit captured during delete",
        isDirty: true,
        filePath: "",
      });
    } finally {
      release();
    }
  });
});

describe("useAutoSave — writeTextFile failure logs SAVE_FAILED", () => {
  it("logs SAVE_FAILED (fatal) and skips metadata persistence when the body write throws", async () => {
    // doSave's outer catch warns in DEV ([SAVE_FAILED] ...); silence it so the
    // intentional fault doesn't pollute test output.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    refs.writeShouldThrow = new Error("EACCES: file locked by antivirus");
    const setIsDirty = vi.fn();
    const { result } = renderAutoSave({ state: makeState({ isDirty: true, setIsDirty }) });

    let ok: FlushResult | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toEqual({ status: "failed", reason: "save-failed" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveNoteMetadataMock).not.toHaveBeenCalled();
    expect(setIsDirty).not.toHaveBeenCalled();
    const logged = logMock.mock.calls.find(
      (c) => (c[0] as NotenError).code === "SAVE_FAILED",
    );
    expect(logged).toBeDefined();
    const ne = logged![0] as NotenError;
    expect(ne.severity).toBe("fatal");
    expect(ne.context).toMatchObject({ noteId: "a", filePath: "/notes/a.md" });
    warnSpy.mockRestore();
  });
});

describe("useAutoSave — metadata failure remains retryable", () => {
  it("reports failure and leaves the editor dirty so a later flush retries note metadata", async () => {
    saveNoteMetadataMock.mockRejectedValueOnce(new Error("EPERM: meta sidecar locked"));
    const setIsDirty = vi.fn();
    const { result } = renderAutoSave({
      state: makeState({ isDirty: true, setIsDirty }),
    });

    let first: FlushResult | undefined;
    await act(async () => {
      first = await result.current.flushAutoSave();
    });

    expect(first).toMatchObject({ status: "failed" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveNoteMetadataMock).toHaveBeenCalledTimes(1);
    expect(setIsDirty).not.toHaveBeenCalledWith(false);

    let second: FlushResult | undefined;
    await act(async () => {
      second = await result.current.flushAutoSave();
    });

    expect(second).toEqual({ status: "saved" });
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(saveNoteMetadataMock).toHaveBeenCalledTimes(2);
    expect(setIsDirty).toHaveBeenCalledWith(false);
  });
});

describe("useAutoSave — savedDocStillExists race", () => {
  // The user deletes the active note while its autosave is in flight. doSave
  // has captured a snapshot, but by the time backupIfRemoteWroteFirst resolves
  // the doc is gone from stateRef.current.docs. The pre-write existence check
  // skips writeTextFile entirely so the deleted file is not resurrected at its
  // old path. The post-write savedDocStillExists guard remains as a second
  // line of defense against a doc removed between write and commit.
  it("skips both the body write and metadata commit for a doc removed mid-save", async () => {
    vi.useFakeTimers();
    let releaseBackup: () => void = () => {};
    backupMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseBackup = () => resolve(false);
      }),
    );

    const setDocs = vi.fn();
    const state = makeState({ isDirty: true });
    const tiptapRef = makeTiptapRef();
    const groups: NoteGroup[] = [];

    const { result, rerender } = renderHook(
      ({ docs }: { docs: NoteDoc[] }) =>
        useAutoSave(
          state,
          tiptapRef,
          docs,
          setDocs,
          0,
          "en" as Locale,
          "updated-desc" as NotesSortOrder,
          groups,
        ),
      { initialProps: { docs: [makeDoc("a")] } },
    );

    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    // doSave suspended inside backupIfRemoteWroteFirst.

    // Simulate the user deleting the note: re-render with docs=[]. The hook's
    // top-level reassignment of stateRef.current picks this up so the in-flight
    // doSave sees the new docs list when it reads stateRef.current after the
    // backup resolves.
    rerender({ docs: [] });

    await act(async () => {
      releaseBackup();
      await Promise.resolve();
    });

    // Pre-write existence check fires before writeTextFile, so neither the
    // body nor the manifest is touched. Without this guard the file would
    // reappear on disk right after delete moved it to .trash.
    expect(writeMock).not.toHaveBeenCalled();
    expect(saveNoteMetadataMock).not.toHaveBeenCalled();
    expect(setDocs).not.toHaveBeenCalled();
  });
});

describe("useAutoSave — captureAndQueueSave (doc-switch fast path)", () => {
  it("captures the snapshot synchronously and lets doSave run in the background", async () => {
    refs.editorContent = "queued at capture time";
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    // Capture must be synchronous so the editor can repoint to a new doc
    // immediately after; the snapshot taken here is what doSave commits.
    act(() => result.current.captureAndQueueSave());

    // getCurrentMarkdown was called inline (sync snapshot), even though the
    // disk write below hasn't been awaited yet.
    expect(getCurrentMarkdownMock).toHaveBeenCalledTimes(1);

    // Drain background work: the save must land with the captured content.
    await act(async () => { await result.current.awaitInFlightSaves(); });
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "queued at capture time");
  });

  it("is a no-op when there are no pending changes and the editor is clean", () => {
    const { result } = renderAutoSave({ state: makeState({ isDirty: false }) });
    act(() => result.current.captureAndQueueSave());
    expect(writeMock).not.toHaveBeenCalled();
    expect(getCurrentMarkdownMock).not.toHaveBeenCalled();
  });

  it("does not snapshot a clean active doc because another doc has a stranded snapshot", async () => {
    refs.writeShouldThrow = new Error("EBUSY");
    const docs = [makeDoc("a"), makeDoc("b")];
    const setDocs = vi.fn();
    const tiptapRef = makeTiptapRef();
    const groups: NoteGroup[] = [];

    const { result, rerender } = renderHook(
      ({ activeIndex, state }: { activeIndex: number; state: MarkdownState }) =>
        useAutoSave(
          state,
          tiptapRef,
          docs,
          setDocs,
          activeIndex,
          "en" as Locale,
          "updated-desc" as NotesSortOrder,
          groups,
        ),
      { initialProps: { activeIndex: 0, state: makeState({ isDirty: true }) } },
    );

    refs.editorContent = "dirty A";
    act(() => result.current.captureAndQueueSave());
    await act(async () => { await result.current.awaitInFlightSaves(); });
    expect(writeMock).toHaveBeenCalledTimes(1);

    refs.writeShouldThrow = null;
    refs.editorContent = "clean B";
    rerender({ activeIndex: 1, state: makeState({ isDirty: false }) });
    getCurrentMarkdownMock.mockClear();
    writeMock.mockClear();

    act(() => result.current.captureAndQueueSave());
    await act(async () => { await result.current.awaitInFlightSaves(); });

    expect(getCurrentMarkdownMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("clears any pending debounce timer so the save runs once, not twice", async () => {
    vi.useFakeTimers();
    refs.editorContent = "captured";
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());
    act(() => result.current.captureAndQueueSave());

    // Background save resolves; the debounce that captureAndQueueSave cleared
    // must not also fire when its 1s window elapses.
    await act(async () => { await result.current.awaitInFlightSaves(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});

describe("useAutoSave — awaitInFlightSaves (close-handler guarantee)", () => {
  it("blocks until a background save kicked off by captureAndQueueSave finishes", async () => {
    let releaseBackup: () => void = () => {};
    backupMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseBackup = () => resolve(false);
      }),
    );
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.captureAndQueueSave());

    let drained = false;
    const drain = act(async () => {
      await result.current.awaitInFlightSaves();
      drained = true;
    });

    // Microtask flush — drain must still be waiting on the suspended backup.
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseBackup();
    await drain;
    expect(drained).toBe(true);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("awaitDocSave waits only for saves belonging to the requested doc", async () => {
    let releaseBackup: () => void = () => {};
    backupMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseBackup = () => resolve(false);
      }),
    );
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.captureAndQueueSave());

    let otherDocDrained = false;
    await act(async () => {
      await result.current.awaitDocSave("b");
      otherDocDrained = true;
    });
    expect(otherDocDrained).toBe(true);

    let activeDocDrained = false;
    const drainActive = act(async () => {
      await result.current.awaitDocSave("a");
      activeDocDrained = true;
    });
    await Promise.resolve();
    expect(activeDocDrained).toBe(false);

    releaseBackup();
    await drainActive;
    expect(activeDocDrained).toBe(true);
  });
});

describe("useAutoSave — flushPendingSnapshots (orphaned-failure retry)", () => {
  // After a fire-and-forget save fails, the snapshot stays in pendingSnapshotsRef
  // without a timer attached. flushAutoSave alone would not catch it because it
  // captures the *current* active doc, which may be a different one after a
  // switch. flushPendingSnapshots is the close-time net that retries those.
  it("retries a snapshot whose background save returned false", async () => {
    // First write throws → first doSave returns false; second write succeeds.
    refs.writeShouldThrow = new Error("EBUSY: cloud-sync hydration");
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.captureAndQueueSave());
    await act(async () => { await result.current.awaitInFlightSaves(); });

    // First attempt failed (write threw). The snapshot is still pending and
    // Note metadata persistence hasn't been called.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveNoteMetadataMock).not.toHaveBeenCalled();

    // Clear the throw and run the close-time retry.
    refs.writeShouldThrow = null;
    await act(async () => { await result.current.flushPendingSnapshots(); });

    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(saveNoteMetadataMock).toHaveBeenCalledTimes(1);
  });

  it("retries a background snapshot whose metadata write failed", async () => {
    saveNoteMetadataMock.mockRejectedValueOnce(new Error("EPERM: meta sidecar locked"));
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.captureAndQueueSave());
    await act(async () => { await result.current.awaitInFlightSaves(); });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveNoteMetadataMock).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.flushPendingSnapshots(); });

    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(saveNoteMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when no snapshots are pending", async () => {
    const { result } = renderAutoSave({ state: makeState({ isDirty: false }) });
    await act(async () => { await result.current.flushPendingSnapshots(); });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("drops a stranded snapshot whose revision was bumped past it (no zombie write)", async () => {
    // First snapshot will be flushed via captureAndQueueSave and stranded by
    // a write failure. Then a second flushAutoSave commits a newer revision,
    // making the stranded one stale. flushPendingSnapshots must NOT replay it.
    refs.writeShouldThrow = new Error("EBUSY");
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    refs.editorContent = "older";
    act(() => result.current.captureAndQueueSave());
    await act(async () => { await result.current.awaitInFlightSaves(); });
    expect(writeMock).toHaveBeenCalledTimes(1); // older threw

    refs.writeShouldThrow = null;
    refs.editorContent = "newer";
    await act(async () => { await result.current.flushAutoSave(); });
    expect(writeMock).toHaveBeenLastCalledWith("/notes/a.md", "newer");

    // The older stranded snapshot must NOT be replayed — its revision is
    // behind the newer one that just landed.
    writeMock.mockClear();
    await act(async () => { await result.current.flushPendingSnapshots(); });
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe("useAutoSave — post-switch save uses activeDocRef (stale stateRef guard)", () => {
  // doSave reads stateRef.current AFTER its await. If a fast-path
  // switchDocument has already called notifyActiveDoc("b", ...) but the
  // corresponding render hasn't committed yet, stateRef still reports "a" as
  // active. currentActiveId therefore comes from activeDocRef.current (sync)
  // first, and the post-save commit must never re-pin the leaving doc.
  it("does not re-pin the leaving doc as active when the switch hasn't committed yet", async () => {
    refs.editorContent = "leaving content";
    const docs = [makeDoc("a"), makeDoc("b")];
    const setDocs = vi.fn();
    const tiptapRef = makeTiptapRef();
    const groups: NoteGroup[] = [];
    const state = makeState({ isDirty: true });

    const { result } = renderHook(() =>
      useAutoSave(state, tiptapRef, docs, setDocs, 0,
        "en" as Locale, "updated-desc" as NotesSortOrder, groups),
    );

    // Simulate switchDocument fast path: captureAndQueueSave then notifyActiveDoc
    // (the React render that would update stateRef has NOT happened yet —
    // renderHook doesn't rerender automatically with new props).
    act(() => result.current.captureAndQueueSave());
    act(() => result.current.notifyActiveDoc("b", "/notes/b.md"));

    await act(async () => { await result.current.awaitInFlightSaves(); });

    // Body for the LEAVING doc still gets written (snapshot was captured
    // before the switch), and the post-save commit must NOT reselect the
    // leaving doc — that would yank focus back from B to A. doSave no longer
    // touches active identity at all: its commit is a docs-only functional
    // updater, and the store keeps activeNoteId as an id across it.
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "leaving content");
    const lastArg = setDocs.mock.calls[setDocs.mock.calls.length - 1][0];
    expect(typeof lastArg).toBe("function");
    const updater = lastArg as (prev: NoteDoc[]) => NoteDoc[];
    const next = updater(docs);
    expect(next.find((d) => d.id === "a")?.content).toBe("leaving content");
    expect(next.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("useAutoSave — notifyActiveDoc", () => {
  // INVARIANT: this test relies on the hook NOT re-rendering between
  // notifyActiveDoc and flushAutoSave. Re-render reapplies the
  // `activeDocRef = docs[activeIndex]` override at useAutoSave.ts:65-68 and
  // would clobber notifyActiveDoc's "b" back to "a". If a future change
  // introduces a state update in this path, this test silently regresses to
  // asserting the wrong filePath — re-check the invariant before edits.
  it("synchronously updates the active-doc ref so the next snapshot writes to the new path", async () => {
    refs.editorContent = "switched-doc content";
    const { result } = renderAutoSave({
      docs: [makeDoc("a"), makeDoc("b")],
      state: makeState({ isDirty: true }),
    });

    act(() => result.current.notifyActiveDoc("b", "/notes/b.md"));

    await act(async () => {
      await result.current.flushAutoSave();
    });

    expect(writeMock).toHaveBeenCalledWith("/notes/b.md", "switched-doc content");
  });
});

describe("useAutoSave — per-doc save serialization", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  // These tests install a custom writeMock implementation. The global afterEach
  // only vi.clearAllMocks() (clears calls, NOT implementations), so restore the
  // factory default here or the blocking impl would leak into later tests.
  afterEach(() => {
    writeMock.mockImplementation(async () => {
      if (refs.writeShouldThrow) throw refs.writeShouldThrow;
    });
  });

  it("never runs two body writes for the same doc concurrently", async () => {
    // A slow cloud-sync write for the leaving doc can still be in flight when a
    // doc-switch queues the next save. Without per-doc serialization both would
    // write `${path}.tmp` at once and clobber each other. Block the first body
    // write and confirm the second does not enter the writer until it settles.
    const firstWrite = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const writtenContent: string[] = [];
    writeMock.mockImplementation(async (_path: string, content: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writtenContent.push(content);
      if (writtenContent.length === 1) await firstWrite.promise;
      active -= 1;
    });

    refs.editorContent = "v1";
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    await act(async () => {
      const p1 = result.current.flushAutoSave();
      // Wait until save #1 is actually inside the (blocked) body write.
      await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));

      // Queue save #2 for the SAME doc while #1 is mid-write.
      refs.editorContent = "v2";
      const p2 = result.current.flushAutoSave();

      // #2 must be chained behind #1, not writing concurrently.
      await Promise.resolve();
      expect(writeMock).toHaveBeenCalledTimes(1);

      firstWrite.resolve();
      await Promise.all([p1, p2]);
    });

    expect(maxActive).toBe(1);
    // Writes land in order, newest content last.
    expect(writtenContent).toEqual(["v1", "v2"]);
  });

  it("keeps saves for different docs parallel", async () => {
    // Different docs have independent tails, so a blocked write on one must not
    // hold up a write on another.
    const blockA = deferred<void>();
    let concurrent = 0;
    let maxConcurrent = 0;
    writeMock.mockImplementation(async (path: string) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (path === "/notes/a.md") await blockA.promise;
      concurrent -= 1;
    });

    refs.editorContent = "content";
    const { result } = renderAutoSave({
      docs: [makeDoc("a"), makeDoc("b")],
      state: makeState({ isDirty: true }),
    });

    await act(async () => {
      // Save doc A (blocks), then switch the active ref to B and save it.
      result.current.notifyActiveDoc("a", "/notes/a.md");
      const pa = result.current.flushAutoSave();
      await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));

      result.current.notifyActiveDoc("b", "/notes/b.md");
      const pb = result.current.flushAutoSave();
      // B's write proceeds even though A is still blocked.
      await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(2));

      blockA.resolve();
      await Promise.all([pa, pb]);
    });

    expect(maxConcurrent).toBe(2);
  });
});

describe("useAutoSave — what the recovery journal is allowed to claim", () => {
  // journalPendingEdits is read by the close gate as "is this edit safe to
  // lose the process over". It has to answer only for what it can actually
  // record, or the gate closes the window on work that was never written.
  it("records only the failed save's own body, with a null base when this session never saw the file", async () => {
    // b's save is still in flight when a's fails, so b's snapshot is pending
    // too. A folder outage fails every pending save at once, and re-recording
    // every pending body on each failure is quadratic.
    // a is the projection case: no disk baseline was ever seeded. A record with
    // no base must never be applied, and that depends entirely on this value
    // being null rather than the body the empty editor happened to hold.
    vi.useFakeTimers();
    let releaseB!: () => void;
    const bBlocked = new Promise<void>((resolve) => { releaseB = resolve; });
    writeMock.mockImplementation(async (path: string) => {
      if (path === "/notes/b.md") return bBlocked;
      throw new Error("EPERM: folder offline");
    });
    try {
      const { result } = renderAutoSave({
        docs: [makeDoc("a", { content: "" }), makeDoc("b")],
        state: makeState({ isDirty: true }),
      });

      let pendingB!: Promise<FlushResult>;
      await act(async () => {
        result.current.notifyActiveDoc("b", "/notes/b.md");
        refs.editorContent = "b's edit";
        pendingB = result.current.flushAutoSave();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(writeMock).toHaveBeenCalledWith("/notes/b.md", "b's edit");

      refs.editorContent = "typed while the folder was gone";
      act(() => {
        result.current.notifyActiveDoc("a", "/notes/a.md");
        result.current.scheduleAutoSave();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await act(async () => { await Promise.resolve(); });

      expect(refs.journalled.map((r) => r.docId)).toEqual(["a"]);
      expect(refs.journalled[0].content).toBe("typed while the folder was gone");
      expect(refs.journalled[0].baseContent).toBeNull();

      releaseB();
      await act(async () => { await pendingB; });
      expect(refs.journalled.map((r) => r.docId)).toEqual(["a"]);
    } finally {
      writeMock.mockImplementation(async () => {
        if (refs.writeShouldThrow) throw refs.writeShouldThrow;
      });
    }
  });

  it("refuses to claim coverage for keystrokes newer than the snapshot it holds", async () => {
    vi.useFakeTimers();
    refs.writeShouldThrow = new Error("EPERM: folder offline");
    refs.editorContent = "first";
    const { result } = renderAutoSave({
      docs: [makeDoc("a", { content: "old" })],
      state: makeState({ isDirty: true }),
    });

    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { await Promise.resolve(); });

    // The user keeps typing while the close drain is awaiting. That text is
    // still only in the editor, so nothing can record it — and comparing
    // pending targets to snapshots by id alone reported it as covered.
    refs.editorContent = "second";
    act(() => result.current.scheduleAutoSave());

    await act(async () => {
      expect(await result.current.journalPendingEdits()).toBe(false);
    });
  });

  it("reports failure when the record itself cannot be written", async () => {
    vi.useFakeTimers();
    refs.writeShouldThrow = new Error("EPERM: folder offline");
    refs.journalShouldThrow = new Error("EPERM: app data offline too");
    refs.editorContent = "nowhere to put this";
    const { result } = renderAutoSave({
      docs: [makeDoc("a", { content: "old" })],
      state: makeState({ isDirty: true }),
    });

    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    await act(async () => {
      expect(await result.current.journalPendingEdits()).toBe(false);
    });
  });
});

describe("useAutoSave — a record carries the body the edit was made against", () => {
  // baseContent is the single field planRecovery decides on: a record is
  // applied only when the disk still equals it, and a null one is never
  // applied at all. Recording the wrong value there reinstates the loss the
  // whole recovery design exists to prevent, so assert it directly rather
  // than only the docId and content.
  it("records the known disk body as the base, not the edit itself", async () => {
    vi.useFakeTimers();
    refs.knownDiskContent.set("/notes/a.md", "what was on disk");
    refs.writeShouldThrow = new Error("EPERM: folder offline");
    refs.editorContent = "the unsaved edit";
    const { result } = renderAutoSave({
      docs: [makeDoc("a", { content: "what was on disk" })],
      state: makeState({ isDirty: true }),
    });

    act(() => result.current.scheduleAutoSave());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { await Promise.resolve(); });

    expect(refs.journalled).toHaveLength(1);
    expect(refs.journalled[0].content).toBe("the unsaved edit");
    expect(refs.journalled[0].baseContent).toBe("what was on disk");
  });
});
