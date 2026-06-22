import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createReconcileState } from "../utils/reconcileFolder";

// In-process event bus standing in for Tauri's emit/listen: `emit` dispatches
// synchronously to every registered handler, so one test can play both the
// migrating window and a listener window. `callLog` records the cross-module
// side effects in invocation order so listener-ordering invariants (flush
// before flag before ack) are assertable.
const refs = vi.hoisted(() => ({
  listeners: new Map<string, ((event: { payload: unknown }) => void)[]>(),
  callLog: [] as string[],
  windowLabels: ["main", "second"],
  currentDir: "/old/notes",
  hasUnsaved: false,
  enumerateThrows: false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const arr = refs.listeners.get(event) ?? [];
    arr.push(handler);
    refs.listeners.set(event, arr);
    return () => {
      refs.listeners.set(event, (refs.listeners.get(event) ?? []).filter((h) => h !== handler));
    };
  }),
  emit: vi.fn(async (event: string, payload: Record<string, unknown>) => {
    refs.callLog.push(`emit:${event}`);
    for (const handler of [...(refs.listeners.get(event) ?? [])]) {
      handler({ payload });
    }
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => {
    if (refs.enumerateThrows) throw new Error("enumeration failed");
    return refs.windowLabels.map((label) => ({ label }));
  }),
}));

vi.mock("./useNotesLoader", () => ({
  getNotesDir: vi.fn(async () => refs.currentDir),
  setNotesDir: vi.fn((dir: string) => {
    refs.callLog.push(`setNotesDir:${dir}`);
    refs.currentDir = dir;
  }),
  resetNotesDir: vi.fn(() => {
    refs.callLog.push("resetNotesDir");
    refs.currentDir = "/default/notes";
  }),
  setMigrationInProgress: vi.fn((v: boolean) => {
    refs.callLog.push(`flag:${v}`);
  }),
}));

import { useMigrationSync, broadcastMigrationStarted, broadcastMigrationFinished } from "./useMigrationSync";
import { emit, listen } from "@tauri-apps/api/event";
import * as loaderModule from "./useNotesLoader";

const setNotesDirMock = loaderModule.setNotesDir as ReturnType<typeof vi.fn>;
const resetNotesDirMock = loaderModule.resetNotesDir as ReturnType<typeof vi.fn>;

function renderMigrationSync() {
  const reconcileState = createReconcileState();
  const setReloadKey = vi.fn();
  const setCurrentNotesDir = vi.fn((dir: string) => { refs.callLog.push(`currentDir:${dir}`); });
  const applyExternalSettingsChange = vi.fn();
  const params = {
    flushAutoSaveRef: { current: vi.fn(async () => { refs.callLog.push("flushAutoSave"); return true; }) },
    hasUnsavedChangesRef: { current: vi.fn(() => refs.hasUnsaved) },
    awaitInFlightSavesRef: { current: vi.fn(async () => { refs.callLog.push("awaitInFlightSaves"); }) },
    flushPendingSnapshotsRef: { current: vi.fn(async () => { refs.callLog.push("flushPendingSnapshots"); }) },
    reconcileState,
    setReloadKey,
    setCurrentNotesDir,
    applyExternalSettingsChange,
  };
  const view = renderHook(() => useMigrationSync(params));
  return { ...view, reconcileState, setReloadKey, setCurrentNotesDir, applyExternalSettingsChange };
}

async function waitForListeners() {
  await vi.waitFor(() => {
    expect(refs.listeners.get("notes-migration-started")?.length ?? 0).toBeGreaterThan(0);
    expect(refs.listeners.get("notes-migration-finished")?.length ?? 0).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  refs.listeners.clear();
  refs.callLog = [];
  refs.windowLabels = ["main", "second"];
  refs.currentDir = "/old/notes";
  refs.hasUnsaved = false;
  refs.enumerateThrows = false;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("broadcastMigrationStarted", () => {
  it("resolves with allDrained once every other window acks ok", async () => {
    // Simulated second window: ack as soon as it sees the started event.
    await listen("notes-migration-started", (event) => {
      const { migrationId } = event.payload as { migrationId: string };
      void emit("notes-migration-flush-ack", { sourceWindow: "second", migrationId, ok: true });
    });

    // A generous timeout: if the ack did not resolve the wait, the test
    // itself would time out long before this fires.
    const { migrationId, allDrained } = await broadcastMigrationStarted(60_000);
    expect(typeof migrationId).toBe("string");
    expect(allDrained).toBe(true);
    expect(refs.callLog).toContain("emit:notes-migration-started");
  });

  it("aborts (allDrained:false) when an ack omits the ok field", async () => {
    // An older window that can't report flush success acks without ok. Treating
    // that as drained would reopen the loss path, so it must abort.
    await listen("notes-migration-started", (event) => {
      const { migrationId } = event.payload as { migrationId: string };
      void emit("notes-migration-flush-ack", { sourceWindow: "second", migrationId });
    });

    const { allDrained } = await broadcastMigrationStarted(60_000);
    expect(allDrained).toBe(false);
  });

  it("aborts (allDrained:false) when window enumeration fails", async () => {
    refs.enumerateThrows = true;
    const { migrationId, allDrained } = await broadcastMigrationStarted(60_000);
    expect(typeof migrationId).toBe("string");
    expect(allDrained).toBe(false);
    // The started event is still emitted so any live window flushes and blocks.
    expect(refs.callLog).toContain("emit:notes-migration-started");
  });

  it("reports allDrained:false when a window acks ok:false", async () => {
    await listen("notes-migration-started", (event) => {
      const { migrationId } = event.payload as { migrationId: string };
      void emit("notes-migration-flush-ack", { sourceWindow: "second", migrationId, ok: false });
    });

    const { allDrained } = await broadcastMigrationStarted(60_000);
    expect(allDrained).toBe(false);
  });

  it("ignores acks for a different migrationId until the right one arrives", async () => {
    await listen("notes-migration-started", (event) => {
      const { migrationId } = event.payload as { migrationId: string };
      void emit("notes-migration-flush-ack", { sourceWindow: "second", migrationId: "stale-id", ok: true });
      void emit("notes-migration-flush-ack", { sourceWindow: "second", migrationId, ok: true });
    });

    const { migrationId, allDrained } = await broadcastMigrationStarted(60_000);
    expect(typeof migrationId).toBe("string");
    expect(allDrained).toBe(true);
  });

  it("aborts (allDrained:false) after the timeout when a window never acks", async () => {
    vi.useFakeTimers();

    let resolved = false;
    const pending = broadcastMigrationStarted(5_000).then((r) => { resolved = true; return r; });
    // Let the enumeration + emit settle, then confirm it is still waiting.
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    const { migrationId, allDrained } = await pending;
    expect(typeof migrationId).toBe("string");
    expect(allDrained).toBe(false);
  });

  it("does not wait at all when this is the only window", async () => {
    refs.windowLabels = ["main"];
    const { migrationId, allDrained } = await broadcastMigrationStarted(60_000);
    expect(typeof migrationId).toBe("string");
    expect(allDrained).toBe(true);
    expect(refs.listeners.get("notes-migration-flush-ack") ?? []).toHaveLength(0);
  });
});

describe("useMigrationSync — started listener", () => {
  it("flushes its own saves BEFORE raising the migration flag, then acks", async () => {
    renderMigrationSync();
    await waitForListeners();

    await emit("notes-migration-started", { sourceWindow: "second", migrationId: "m1" });
    await vi.waitFor(() => expect(refs.callLog).toContain("emit:notes-migration-flush-ack"));

    // doSave bails at entry once migrationInProgress is set, so the flag
    // must come strictly after every flush — and the ack strictly after the
    // flag, since the migrating window starts copying on the ack.
    const order = [
      refs.callLog.indexOf("flushAutoSave"),
      refs.callLog.indexOf("awaitInFlightSaves"),
      refs.callLog.indexOf("flushPendingSnapshots"),
      refs.callLog.indexOf("flag:true"),
      refs.callLog.indexOf("emit:notes-migration-flush-ack"),
    ];
    for (const idx of order) expect(idx).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]).toBeLessThan(order[i]);
  });

  it("ignores its own started event", async () => {
    renderMigrationSync();
    await waitForListeners();

    await emit("notes-migration-started", { sourceWindow: "main", migrationId: "m1" });
    // Give any (incorrect) async listener work a chance to run.
    await Promise.resolve();
    expect(refs.callLog).not.toContain("flushAutoSave");
    expect(refs.callLog).not.toContain("flag:true");
  });

  it("acks ok:true when its drain leaves nothing unsaved", async () => {
    const acks: { ok?: boolean }[] = [];
    await listen("notes-migration-flush-ack", (event) => {
      acks.push(event.payload as { ok?: boolean });
    });

    refs.hasUnsaved = false;
    renderMigrationSync();
    await waitForListeners();
    await emit("notes-migration-started", { sourceWindow: "second", migrationId: "drained" });
    await vi.waitFor(() => expect(acks).toHaveLength(1));
    expect(acks[0].ok).toBe(true);
  });

  it("acks ok:false when edits could not be drained", async () => {
    const acks: { ok?: boolean }[] = [];
    await listen("notes-migration-flush-ack", (event) => {
      acks.push(event.payload as { ok?: boolean });
    });

    refs.hasUnsaved = true;
    renderMigrationSync();
    await waitForListeners();
    await emit("notes-migration-started", { sourceWindow: "second", migrationId: "stranded" });
    await vi.waitFor(() => expect(acks).toHaveLength(1));
    expect(acks[0].ok).toBe(false);
  });
});

describe("useMigrationSync — finished listener", () => {
  it("on success repoints the loader, adopts the setting locally, and reloads — without touching the flag", async () => {
    const { reconcileState, setReloadKey, setCurrentNotesDir, applyExternalSettingsChange } = renderMigrationSync();
    await waitForListeners();

    await emit("notes-migration-finished", {
      sourceWindow: "second", migrationId: "m1", success: true, newDir: "/new/notes",
    });

    expect(setNotesDirMock).toHaveBeenCalledWith("/new/notes", reconcileState);
    expect(applyExternalSettingsChange).toHaveBeenCalledWith("notesDirectory", "/new/notes");
    expect(setReloadKey).toHaveBeenCalledTimes(1);
    const bump = setReloadKey.mock.calls[0][0] as (k: number) => number;
    expect(bump(3)).toBe(4);
    await vi.waitFor(() => expect(setCurrentNotesDir).toHaveBeenCalledWith("/new/notes"));

    // The reload owns releasing migrationInProgress; the listener must not.
    expect(refs.callLog).not.toContain("flag:false");
  });

  it("routes an empty newDir to resetNotesDir (default directory)", async () => {
    const { reconcileState, applyExternalSettingsChange } = renderMigrationSync();
    await waitForListeners();

    await emit("notes-migration-finished", {
      sourceWindow: "second", migrationId: "m1", success: true, newDir: "",
    });

    expect(resetNotesDirMock).toHaveBeenCalledWith(reconcileState);
    expect(setNotesDirMock).not.toHaveBeenCalled();
    expect(applyExternalSettingsChange).toHaveBeenCalledWith("notesDirectory", "");
  });

  it("on failure only releases the flag", async () => {
    const { setReloadKey, applyExternalSettingsChange } = renderMigrationSync();
    await waitForListeners();

    await emit("notes-migration-finished", {
      sourceWindow: "second", migrationId: "m1", success: false, newDir: "",
    });

    expect(refs.callLog).toContain("flag:false");
    expect(setReloadKey).not.toHaveBeenCalled();
    expect(applyExternalSettingsChange).not.toHaveBeenCalled();
    expect(setNotesDirMock).not.toHaveBeenCalled();
    expect(resetNotesDirMock).not.toHaveBeenCalled();
  });

  it("ignores its own finished event", async () => {
    const { setReloadKey } = renderMigrationSync();
    await waitForListeners();

    await emit("notes-migration-finished", {
      sourceWindow: "main", migrationId: "m1", success: true, newDir: "/new/notes",
    });

    expect(setReloadKey).not.toHaveBeenCalled();
    expect(setNotesDirMock).not.toHaveBeenCalled();
  });
});

describe("broadcastMigrationFinished", () => {
  it("emits the finished event with this window as the source", async () => {
    let seen: Record<string, unknown> | null = null;
    await listen("notes-migration-finished", (event) => {
      seen = event.payload as Record<string, unknown>;
    });

    broadcastMigrationFinished("m9", true, "/new/notes");
    await vi.waitFor(() => expect(seen).not.toBeNull());
    expect(seen).toMatchObject({
      sourceWindow: "main", migrationId: "m9", success: true, newDir: "/new/notes",
    });
  });
});
