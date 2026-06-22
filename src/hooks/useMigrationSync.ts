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
  /**
   * Whether this window fully drained its pending saves before blocking. When
   * false, the migrating window must NOT proceed: this window may still hold
   * unsaved edits bound to the old directory that the copy/clear would drop.
   * Optional for back-compat with an older window that acks without it
   * (treated as a successful drain).
   */
  ok?: boolean;
}

/** Outcome of announcing a migration to the other windows. */
export interface MigrationStartResult {
  migrationId: string;
  /**
   * True only when every other window acked in time AND each reported a
   * successful drain. A timeout, a missing ack, or any `ok: false` leaves
   * this false so the caller aborts before the destructive copy/clear.
   */
  allDrained: boolean;
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
 *
 * Returns `allDrained` so the caller can refuse to start the destructive
 * copy/clear unless every other window confirmed it persisted its pending
 * edits. The `timeoutMs` bound still prevents waiting forever, but a timeout
 * now resolves to `allDrained: false` (abort) rather than proceeding blindly:
 * a window that never acked may still be writing into the old directory.
 */
export async function broadcastMigrationStarted(timeoutMs = 5000): Promise<MigrationStartResult> {
  const migrationId = crypto.randomUUID();
  let otherLabels: string[] = [];
  try {
    otherLabels = (await getAllWebviewWindows())
      .map((w) => w.label)
      .filter((label) => label !== WINDOW_LABEL);
  } catch { /* enumeration failed — cannot confirm other windows drained */ }

  const payload = { sourceWindow: WINDOW_LABEL, migrationId } satisfies MigrationStartedPayload;
  if (otherLabels.length === 0) {
    await emit("notes-migration-started", payload).catch(() => {});
    return { migrationId, allDrained: true };
  }

  const pendingAcks = new Set(otherLabels);
  let drainFailed = false;
  let settleAcked: () => void = () => {};
  const allAcked = new Promise<void>((resolve) => { settleAcked = resolve; });
  // Register the ack listener BEFORE emitting so a fast responder can't ack
  // into the void.
  let unlistenAck: (() => void) | null = null;
  try {
    unlistenAck = await listen<MigrationAckPayload>("notes-migration-flush-ack", (event) => {
      if (event.payload.migrationId !== migrationId) return;
      if (event.payload.ok === false) drainFailed = true;
      pendingAcks.delete(event.payload.sourceWindow);
      if (pendingAcks.size === 0) settleAcked();
    });
  } catch { /* listener failed — cannot confirm other windows drained */ }

  await emit("notes-migration-started", payload).catch(() => {});

  // Without the ack listener we can't confirm anything drained, so abort.
  if (!unlistenAck) return { migrationId, allDrained: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    allAcked,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
  unlistenAck();

  const allDrained = pendingAcks.size === 0 && !drainFailed;
  return { migrationId, allDrained };
}

export function broadcastMigrationFinished(migrationId: string, success: boolean, newDir: string): void {
  emit("notes-migration-finished", {
    sourceWindow: WINDOW_LABEL, migrationId, success, newDir,
  } satisfies MigrationFinishedPayload).catch(() => {});
}

export interface MigrationSyncParams {
  flushAutoSaveRef: React.RefObject<(() => Promise<boolean>) | null>;
  hasUnsavedChangesRef: React.RefObject<(() => boolean) | null>;
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
          // Report whether the drain actually persisted everything. If a
          // backup/write error stranded edits, ok:false tells the migrating
          // window to abort rather than clear the old dir out from under us.
          const ok = !(p.hasUnsavedChangesRef.current?.() ?? false);
          await emit("notes-migration-flush-ack", {
            sourceWindow: WINDOW_LABEL, migrationId, ok,
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
