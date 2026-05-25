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
import * as conflictBackupModule from "../utils/conflictBackup";
import * as fsModule from "../utils/fs";
import * as crashLogModule from "../utils/crashLog";

const saveManifestMock = useNotesLoaderModule.saveManifest as ReturnType<typeof vi.fn>;
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
  return {
    isDirty: false,
    setIsDirty: vi.fn(),
    primeMarkdown: vi.fn(),
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

    // Positive AND negative assertion: doSave must actually have advanced past
    // backup and through writeTextFile (otherwise we'd be confirming nothing —
    // a backup that never resolves would also leave saveManifest uncalled).
    // The revision guard then blocks the manifest commit.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveManifestMock).not.toHaveBeenCalled();
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

describe("useAutoSave — savedDocStillExists race", () => {
  // The user deletes the active note while its autosave is in flight. doSave
  // has captured a snapshot, but by the time it reaches the post-write commit,
  // stateRef.current.docs no longer contains the doc. The map() loop never
  // sets savedDocStillExists, so doSave bails before saveManifest — the
  // delete must not be partially undone by a stale autosave.
  it("does not commit a manifest entry for a doc that was removed mid-save", async () => {
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

    // Body write happens (it's idempotent — the deleted doc's file may even
    // get rewritten before delete's `remove` lands), but the manifest commit
    // path must bail at savedDocStillExists=false.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(saveManifestMock).not.toHaveBeenCalled();
    expect(setDocs).not.toHaveBeenCalled();
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
