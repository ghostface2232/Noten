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
   * Whether this window fully drained its pending saves before blocking. The
   * migrating window proceeds only on an explicit `ok: true`; anything else
   * (false, or a missing field from an older window that can't report flush
   * success) aborts the migration, since that window may still hold unsaved
   * edits bound to the old directory that the copy/clear would drop.
   */
  ok?: boolean;
}

/**
 * How thoroughly the other windows confirmed they stopped writing to the old
 * directory before the destructive step:
 * - `all-drained`: every other window acked ok in time → safe to clear the old
 *   dir immediately.
 * - `unconfirmed`: a timeout, missing/invalid ack, or failed enumeration — no
 *   window reported an explicit failure, but we could not confirm all of them.
 *   Safe to migrate with DEFERRED cleanup (keep the old dir; clean it later).
 * - `save-failed`: a window explicitly reported it could not persist its edits
 *   (ok:false). Migrate with deferred cleanup too; that window keeps its
 *   in-memory edits and self-heals on the finished event.
 */
export type DrainOutcome = "all-drained" | "unconfirmed" | "save-failed";

/** Outcome of announcing a migration to the other windows. */
export interface MigrationStartResult {
  migrationId: string;
  outcome: DrainOutcome;
}

interface MigrationFinishedPayload {
  sourceWindow: string;
  migrationId: string;
  success: boolean;
  /** New notes directory; "" means the app-data default. */
  newDir: string;
  /**
   * True when the old dir was NOT cleared (deferred cleanup). A receiving
   * window may then safely flush any edits it still holds to the old dir
   * before following to the new one; when false the old dir is already gone,
   * so it must not write there.
   */
  sourceRetained: boolean;
}

const WINDOW_LABEL = getCurrentWindow().label;

/**
 * Announce a migration and wait until every other window has flushed its
 * autosave state and blocked further saves (each acks after doing so).
 *
 * Returns a {@link DrainOutcome} so the caller can decide between clearing the
 * old directory immediately (`all-drained`) and migrating with deferred
 * cleanup (`unconfirmed` / `save-failed`). The `timeoutMs` bound prevents
 * waiting forever; a timeout resolves to `unconfirmed`, never a blind clear.
 */
export async function broadcastMigrationStarted(timeoutMs = 5000): Promise<MigrationStartResult> {
  const migrationId = crypto.randomUUID();
  const payload = { sourceWindow: WINDOW_LABEL, migrationId } satisfies MigrationStartedPayload;

  let otherLabels: string[] = [];
  let enumerated = false;
  try {
    otherLabels = (await getAllWebviewWindows())
      .map((w) => w.label)
      .filter((label) => label !== WINDOW_LABEL);
    enumerated = true;
  } catch { /* enumeration failed — cannot tell which windows are open */ }

  // Couldn't list windows: another may be open and still writing to the old
  // dir. Announce anyway (so any live listener flushes and blocks), but report
  // unconfirmed so the caller keeps the old dir and cleans up later.
  if (!enumerated) {
    await emit("notes-migration-started", payload).catch(() => {});
    return { migrationId, outcome: "unconfirmed" };
  }

  if (otherLabels.length === 0) {
    await emit("notes-migration-started", payload).catch(() => {});
    return { migrationId, outcome: "all-drained" };
  }

  const pendingAcks = new Set(otherLabels);
  let saveFailed = false;
  let unconfirmedAck = false;
  let settleAcked: () => void = () => {};
  const allAcked = new Promise<void>((resolve) => { settleAcked = resolve; });
  // Register the ack listener BEFORE emitting so a fast responder can't ack
  // into the void.
  let unlistenAck: (() => void) | null = null;
  try {
    unlistenAck = await listen<MigrationAckPayload>("notes-migration-flush-ack", (event) => {
      if (event.payload.migrationId !== migrationId) return;
      const ok = event.payload.ok;
      // ok:true → drained. ok:false → a known save failure. Anything else (an
      // older window that can't report status) is unconfirmable, not "drained".
      if (ok === false) saveFailed = true;
      else if (ok !== true) unconfirmedAck = true;
      pendingAcks.delete(event.payload.sourceWindow);
      if (pendingAcks.size === 0) settleAcked();
    });
  } catch { /* listener failed — cannot confirm other windows drained */ }

  await emit("notes-migration-started", payload).catch(() => {});

  // Without the ack listener we can't confirm anything drained.
  if (!unlistenAck) return { migrationId, outcome: "unconfirmed" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    allAcked,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
  unlistenAck();

  const timedOut = pendingAcks.size > 0;
  const outcome: DrainOutcome = saveFailed
    ? "save-failed"
    : (timedOut || unconfirmedAck) ? "unconfirmed" : "all-drained";
  return { migrationId, outcome };
}

export function broadcastMigrationFinished(
  migrationId: string,
  success: boolean,
  newDir: string,
  sourceRetained = false,
): void {
  emit("notes-migration-finished", {
    sourceWindow: WINDOW_LABEL, migrationId, success, newDir, sourceRetained,
  } satisfies MigrationFinishedPayload).catch(() => {});
}

export interface MigrationSyncParams {
  flushAutoSaveRef: React.RefObject<(() => Promise<boolean>) | null>;
  hasUnsavedChangesRef: React.RefObject<(() => boolean) | null>;
  flushManifestRef: React.RefObject<(() => Promise<boolean>) | null>;
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
    // A failed/aborted migration can finish while this window is still
    // draining slow cloud-backed saves. Remember that terminal event so the
    // late drain cannot re-enable the global migration guard after it was
    // already released.
    const finishedMigrationIds = new Set<string>();

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
          if (finishedMigrationIds.has(migrationId)) return;
          // Body autosave tracking does not include group/pin/color/order
          // writes. Queue a current full-state manifest write, then raise the
          // guard synchronously before awaiting it: the queued write still
          // runs, while later UI actions cannot enqueue another old-dir write
          // behind the drain barrier.
          const manifestSave = p.flushManifestRef.current?.().catch(() => false);
          setMigrationInProgress(true);
          const manifestSaved = (await manifestSave) === true;
          if (finishedMigrationIds.has(migrationId)) return;
          // Report whether the drain actually persisted everything. If a
          // backup/write error stranded edits, ok:false tells the migrating
          // window to abort rather than clear the old dir out from under us.
          const ok = manifestSaved && !(p.hasUnsavedChangesRef.current?.() ?? false);
          await emit("notes-migration-flush-ack", {
            sourceWindow: WINDOW_LABEL, migrationId, ok,
          } satisfies MigrationAckPayload).catch(() => {});
        })();
      }),

      listen<MigrationFinishedPayload>("notes-migration-finished", (event) => {
        const { sourceWindow, migrationId, success, newDir, sourceRetained } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;
        finishedMigrationIds.add(migrationId);
        const p = paramsRef.current;
        if (!success) {
          setMigrationInProgress(false);
          return;
        }
        const followToNewDir = () => {
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
        };

        if (!sourceRetained) {
          // Old dir already cleared (all-drained): every window drained before
          // the clear, so there is nothing left to flush — just follow.
          followToNewDir();
          return;
        }

        // Deferred cleanup: the old dir survives. Drop the guard this window
        // raised on `started` so any edit it could not save earlier can finally
        // land in the (retained) old dir, then drain. The cleanup pass merges
        // those late writes into the new dir.
        void (async () => {
          setMigrationInProgress(false);
          await p.flushAutoSaveRef.current?.().catch(() => {});
          await p.awaitInFlightSavesRef.current?.().catch(() => {});
          await p.flushPendingSnapshotsRef.current?.().catch(() => {});
          if (p.hasUnsavedChangesRef.current?.()) {
            // Still can't persist. Stay on the old dir — it is retained, so this
            // window keeps working losslessly there and follows on next launch;
            // the deferred cleanup defers again while a window still uses it.
            return;
          }
          followToNewDir();
        })();
      }),
    ]).then((fns) => {
      if (!mounted) { fns.forEach((fn) => fn()); return; }
      unlisteners = fns;
    });

    return () => { mounted = false; unlisteners.forEach((fn) => fn()); };
  }, []);
}
