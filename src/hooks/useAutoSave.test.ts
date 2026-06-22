import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { NoteDoc, NoteGroup } from "../utils/noteTypes";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { Locale, NotesSortOrder } from "./useSettings";
import { NotenError } from "../utils/notenError";

// Shared module-state hoisted so tests can mutate without re-registering mocks.
const refs = vi.hoisted(() => ({
  migrationInProgress: false,
  backupShouldThrow: null as Error | null,
  writeShouldThrow: null as Error | null,
  editorContent: "",
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/test-appdata"),
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
  saveManifest: vi.fn(async () => {}),
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
}));

vi.mock("../utils/conflictBackup", () => ({
  backupIfRemoteWroteFirst: vi.fn(async () => {
    if (refs.backupShouldThrow) throw refs.backupShouldThrow;
    return false;
  }),
  setKnownDiskContent: vi.fn(),
}));

vi.mock("../utils/fs", () => ({
  tauriFileSystem: {
    writeTextFile: vi.fn(async () => {
      if (refs.writeShouldThrow) throw refs.writeShouldThrow;
    }),
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
import { useAutoSave } from "./useAutoSave";
import * as useNotesLoaderModule from "./useNotesLoader";
import * as useFileSystemModule from "./useFileSystem";
import * as conflictBackupModule from "../utils/conflictBackup";
import * as fsModule from "../utils/fs";
import * as crashLogModule from "../utils/crashLog";

const saveManifestMock = useNotesLoaderModule.saveManifest as ReturnType<typeof vi.fn>;
const getCurrentMarkdownMock = useFileSystemModule.getCurrentMarkdown as ReturnType<typeof vi.fn>;
const backupMock = conflictBackupModule.backupIfRemoteWroteFirst as ReturnType<typeof vi.fn>;
const writeMock = fsModule.tauriFileSystem.writeTextFile as ReturnType<typeof vi.fn>;
const logMock = crashLogModule.logNotenError as ReturnType<typeof vi.fn>;

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

function renderAutoSave(opts: {
  docs?: NoteDoc[];
  activeIndex?: number;
  state?: MarkdownState;
}) {
  const docs = opts.docs ?? [makeDoc("a")];
  const setDocs = vi.fn();
  const setActiveIndex = vi.fn();
  const state = opts.state ?? makeState({ isDirty: true });
  const tiptapRef = makeTiptapRef();
  const groups: NoteGroup[] = [];
  const activeIndex = opts.activeIndex ?? 0;

  const { result } = renderHook(() =>
    useAutoSave(
      state,
      tiptapRef,
      docs,
      setDocs,
      activeIndex,
      setActiveIndex,
      "en",
      "updated-desc",
      groups,
    ),
  );
  return { result, setDocs, setActiveIndex, state, tiptapRef, docs };
}

beforeEach(() => {
  refs.migrationInProgress = false;
  refs.backupShouldThrow = null;
  refs.writeShouldThrow = null;
  refs.editorContent = "hello world";
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});


describe("useAutoSave — doSave golden path", () => {
  it("writes the body, calls saveManifest, and clears isDirty when the editor still matches", async () => {
    refs.editorContent = "# Title\nbody";
    const setIsDirty = vi.fn();
    const state = makeState({ isDirty: true, setIsDirty });
    const { result } = renderAutoSave({ state });

    await act(async () => {
      const ok = await result.current.flushAutoSave();
      expect(ok).toBe(true);
    });

    expect(backupMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "# Title\nbody");
    expect(saveManifestMock).toHaveBeenCalledTimes(1);
    expect(setIsDirty).toHaveBeenCalledWith(false);
  });
});

describe("useAutoSave — backup-failure defers save", () => {
  it("returns false, skips writeTextFile, leaves isDirty alone, and logs the BACKUP_FAILED", async () => {
    refs.backupShouldThrow = new NotenError(
      "BACKUP_FAILED",
      "fatal",
      "test: backup unwritable",
    );
    const setIsDirty = vi.fn();
    const state = makeState({ isDirty: true, setIsDirty });
    const { result } = renderAutoSave({ state });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
    expect(saveManifestMock).not.toHaveBeenCalled();
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

describe("useAutoSave — debounce queue", () => {
  it("defers Markdown serialization until the debounce fires", async () => {
    vi.useFakeTimers();
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());

    expect(getCurrentMarkdownMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(getCurrentMarkdownMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getCurrentMarkdownMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "hello world");
  });

  it("does not fire doSave until DEBOUNCE_MS has elapsed since the last schedule", async () => {
    vi.useFakeTimers();
    const { result } = renderAutoSave({ state: makeState({ isDirty: true }) });

    act(() => result.current.scheduleAutoSave());

    // Just under debounce — no write yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(writeMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(writeMock).toHaveBeenCalledTimes(1);
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
    expect(saveManifestMock).not.toHaveBeenCalled();
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
      expect(ok).toBe(true);
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
  it("resolves true without calling doSave when nothing is pending and the editor is clean", async () => {
    const { result } = renderAutoSave({ state: makeState({ isDirty: false }) });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toBe(true);
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
    const setActiveIndex = vi.fn();
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
          setActiveIndex,
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
      expect(ok).toBe(true);
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
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toBe(false);
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
});

describe("useAutoSave — writeTextFile failure logs SAVE_FAILED", () => {
  it("logs SAVE_FAILED (fatal) and skips saveManifest when the body write throws", async () => {
    // doSave's outer catch warns in DEV ([SAVE_FAILED] ...); silence it so the
    // intentional fault doesn't pollute test output.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    refs.writeShouldThrow = new Error("EACCES: file locked by antivirus");
    const setIsDirty = vi.fn();
    const { result } = renderAutoSave({ state: makeState({ isDirty: true, setIsDirty }) });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.flushAutoSave();
    });

    expect(ok).toBe(false);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveManifestMock).not.toHaveBeenCalled();
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

describe("useAutoSave — manifest failure remains retryable", () => {
  it("returns false and leaves the editor dirty so a later flush retries saveManifest", async () => {
    saveManifestMock.mockRejectedValueOnce(new Error("EPERM: meta sidecar locked"));
    const setIsDirty = vi.fn();
    const { result } = renderAutoSave({
      state: makeState({ isDirty: true, setIsDirty }),
    });

    let first: boolean | undefined;
    await act(async () => {
      first = await result.current.flushAutoSave();
    });

    expect(first).toBe(false);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveManifestMock).toHaveBeenCalledTimes(1);
    expect(setIsDirty).not.toHaveBeenCalledWith(false);

    let second: boolean | undefined;
    await act(async () => {
      second = await result.current.flushAutoSave();
    });

    expect(second).toBe(true);
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(saveManifestMock).toHaveBeenCalledTimes(2);
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
  it("skips both the body write and manifest commit for a doc removed mid-save", async () => {
    vi.useFakeTimers();
    let releaseBackup: () => void = () => {};
    backupMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseBackup = () => resolve(false);
      }),
    );

    const setDocs = vi.fn();
    const setActiveIndex = vi.fn();
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
          setActiveIndex,
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
    expect(saveManifestMock).not.toHaveBeenCalled();
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
    const setActiveIndex = vi.fn();
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
          setActiveIndex,
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
    // saveManifest hasn't been called.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveManifestMock).not.toHaveBeenCalled();

    // Clear the throw and run the close-time retry.
    refs.writeShouldThrow = null;
    await act(async () => { await result.current.flushPendingSnapshots(); });

    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(saveManifestMock).toHaveBeenCalledTimes(1);
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
  // codex review noted that doSave reads stateRef.current AFTER its await.
  // If a fast-path switchDocument has already called notifyActiveDoc("b", ...)
  // but the corresponding setDocs/setActiveIndex render hasn't committed yet,
  // stateRef still reports "a" as active. Using that stale id would let the
  // background save's setActiveIndex pin the leaving doc as active again.
  // Fix: derive currentActiveId from activeDocRef.current (sync) first.
  it("does not re-pin the leaving doc as active when the switch hasn't committed yet", async () => {
    refs.editorContent = "leaving content";
    const docs = [makeDoc("a"), makeDoc("b")];
    const setDocs = vi.fn();
    const setActiveIndex = vi.fn();
    const tiptapRef = makeTiptapRef();
    const groups: NoteGroup[] = [];
    const state = makeState({ isDirty: true });

    const { result } = renderHook(() =>
      useAutoSave(state, tiptapRef, docs, setDocs, 0, setActiveIndex,
        "en" as Locale, "updated-desc" as NotesSortOrder, groups),
    );

    // Simulate switchDocument fast path: captureAndQueueSave then notifyActiveDoc
    // (the React render that would update stateRef has NOT happened yet —
    // renderHook doesn't rerender automatically with new props).
    act(() => result.current.captureAndQueueSave());
    act(() => result.current.notifyActiveDoc("b", "/notes/b.md"));

    await act(async () => { await result.current.awaitInFlightSaves(); });

    // Body for the LEAVING doc still gets written (snapshot was captured
    // before the switch), but the post-save setActiveIndex must NOT reselect
    // the leaving doc — that would yank focus back from B to A.
    expect(writeMock).toHaveBeenCalledWith("/notes/a.md", "leaving content");
    // setActiveIndex may be called with B's position (1) or skipped, but never
    // with A's position (0) in a way that would override the switch.
    const calls = setActiveIndex.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain(0);
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
