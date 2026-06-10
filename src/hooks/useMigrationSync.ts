import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getNotesDir, setNotesDir, resetNotesDir, setMigrationInProgress } from "./useNotesLoader";
import type { ReconcileState } from "../utils/reconcileFolder";
import type { Settings } from "./useSettings";

// Cross-window coordination for notes-dir migrations. `migrationInProgress`
// is per-webview module state, so without these events a second window keeps
// autosaving into the old directory while the migrating window copies and
// then clears it — silently losing those writes.

interface MigrationStartedPayload {
  sourceWindow: string;
  migrationId: string;
}

interface MigrationAckPayload {
  sourceWindow: string;
  migrationId: string;
}

interface MigrationFinishedPayload {
  sourceWindow: string;
  migrationId: string;
  success: boolean;
  /** New notes directory; "" means the app-data default. */
  newDir: string;
}

const WINDOW_LABEL = getCurrentWindow().label;

/**
 * Announce a migration and wait until every other window has flushed its
 * autosave state and blocked further saves (each acks after doing so).
 * Proceeds after `timeoutMs`: a hung window's saves are still blocked the
 * moment its own listener runs, so waiting forever buys nothing.
 */
export async function broadcastMigrationStarted(timeoutMs = 5000): Promise<string> {
  const migrationId = crypto.randomUUID();
  let otherLabels: string[] = [];
  try {
    otherLabels = (await getAllWebviewWindows())
      .map((w) => w.label)
      .filter((label) => label !== WINDOW_LABEL);
  } catch { /* enumeration failed — emit and proceed without waiting */ }

  const payload = { sourceWindow: WINDOW_LABEL, migrationId } satisfies MigrationStartedPayload;
  if (otherLabels.length === 0) {
    await emit("notes-migration-started", payload).catch(() => {});
    return migrationId;
  }

  const pendingAcks = new Set(otherLabels);
  let settleAcked: () => void = () => {};
  const allAcked = new Promise<void>((resolve) => { settleAcked = resolve; });
  // Register the ack listener BEFORE emitting so a fast responder can't ack
  // into the void.
  let unlistenAck: (() => void) | null = null;
  try {
    unlistenAck = await listen<MigrationAckPayload>("notes-migration-flush-ack", (event) => {
      if (event.payload.migrationId !== migrationId) return;
      pendingAcks.delete(event.payload.sourceWindow);
      if (pendingAcks.size === 0) settleAcked();
    });
  } catch { /* listener failed — emit and proceed without waiting */ }

  await emit("notes-migration-started", payload).catch(() => {});

  if (unlistenAck) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      allAcked,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
    unlistenAck();
  }
  return migrationId;
}

export function broadcastMigrationFinished(migrationId: string, success: boolean, newDir: string): void {
  emit("notes-migration-finished", {
    sourceWindow: WINDOW_LABEL, migrationId, success, newDir,
  } satisfies MigrationFinishedPayload).catch(() => {});
}

export interface MigrationSyncParams {
  flushAutoSaveRef: React.RefObject<(() => Promise<boolean>) | null>;
  awaitInFlightSavesRef: React.RefObject<(() => Promise<void>) | null>;
  flushPendingSnapshotsRef: React.RefObject<(() => Promise<void>) | null>;
  reconcileState: ReconcileState;
  setReloadKey: React.Dispatch<React.SetStateAction<number>>;
  setCurrentNotesDir: (dir: string) => void;
  applyExternalSettingsChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export function useMigrationSync(params: MigrationSyncParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    let mounted = true;
    let unlisteners: (() => void)[] = [];

    Promise.all([
      listen<MigrationStartedPayload>("notes-migration-started", (event) => {
        const { sourceWindow, migrationId } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;
        void (async () => {
          const p = paramsRef.current;
          // Flush BEFORE raising the flag: doSave bails at entry when
          // migrationInProgress is set, so flag-first would turn the flush
          // into a no-op and strand this window's pending edits in the old
          // directory's autosave queue. A keystroke landing between flush
          // and flag is accepted (sub-second window).
          await p.flushAutoSaveRef.current?.().catch(() => {});
          await p.awaitInFlightSavesRef.current?.().catch(() => {});
          await p.flushPendingSnapshotsRef.current?.().catch(() => {});
          setMigrationInProgress(true);
          await emit("notes-migration-flush-ack", {
            sourceWindow: WINDOW_LABEL, migrationId,
          } satisfies MigrationAckPayload).catch(() => {});
        })();
      }),

      listen<MigrationFinishedPayload>("notes-migration-finished", (event) => {
        const { sourceWindow, success, newDir } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;
        const p = paramsRef.current;
        if (!success) {
          setMigrationInProgress(false);
          return;
        }
        // Repoint the loader cache synchronously; the settings update below
        // re-runs App's notes-dir effect idempotently, but that async effect
        // is not guaranteed to run before the reload starts loading.
        if (newDir) {
          setNotesDir(newDir, p.reconcileState);
        } else {
          resetNotesDir(p.reconcileState);
        }
        p.applyExternalSettingsChange("notesDirectory", newDir);
        void getNotesDir().then((dir) => p.setCurrentNotesDir(dir)).catch(() => {});
        // The reload owns releasing migrationInProgress, mirroring the
        // migrating window (useNotesLoader sets and clears it around a load).
        p.setReloadKey((k) => k + 1);
      }),
    ]).then((fns) => {
      if (!mounted) { fns.forEach((fn) => fn()); return; }
      unlisteners = fns;
    });

    return () => { mounted = false; unlisteners.forEach((fn) => fn()); };
  }, []);
}
