import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

// The installer ends the whole process, and every window keeps its own save
// queues, so draining one window says nothing about the others. An idle user
// does not cover them either: a note that never got a file and a failed
// metadata write survive any amount of waiting, and the journal holds neither.

interface UpdateDrainRequest {
  sourceWindow: string;
  drainId: string;
  /** Hold input from before the drain until released: the install's last step. */
  holdInput?: boolean;
}

interface UpdateDrainAck {
  sourceWindow: string;
  drainId: string;
  ok: boolean;
}

interface UpdateDrainRelease {
  drainId: string;
}

const WINDOW_LABEL = getCurrentWindow().label;
export const PEER_DRAIN_TIMEOUT_MS = 15_000;
// A held window lets go on its own this long after it answered, in case the
// requester never releases it (its webview reloaded, say). The requester's
// remaining work after the answers is one idle check and the install call.
export const PEER_HOLD_EXPIRY_MS = 60_000;

export interface PeerHold {
  ok: boolean;
  release: () => Promise<void>;
}

async function requestPeers(timeoutMs: number, holdInput: boolean): Promise<PeerHold> {
  const drainId = crypto.randomUUID();
  // Sent even when the request itself failed partway: a window may have
  // received it and be holding its input.
  const release = async () => {
    if (!holdInput) return;
    await emit("update-drain-release", { drainId } satisfies UpdateDrainRelease).catch(() => {});
  };
  const failed = async () => {
    await release();
    return { ok: false, release };
  };

  let pending: Set<string>;
  try {
    pending = new Set(
      (await getAllWebviewWindows())
        .map((w) => w.label)
        .filter((label) => label !== WINDOW_LABEL),
    );
  } catch {
    return { ok: false, release };
  }
  if (pending.size === 0) return { ok: true, release };

  let allOk = true;
  let settle: () => void = () => {};
  const answered = new Promise<void>((resolve) => { settle = resolve; });
  let unlisten: () => void;
  try {
    // Registered before the request, so a fast window cannot ack into the void.
    unlisten = await listen<UpdateDrainAck>("update-drain-ack", (event) => {
      if (event.payload.drainId !== drainId) return;
      if (event.payload.ok !== true) allOk = false;
      pending.delete(event.payload.sourceWindow);
      if (pending.size === 0) settle();
    });
  } catch {
    return { ok: false, release };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await emit("update-drain-request", { sourceWindow: WINDOW_LABEL, drainId, holdInput } satisfies UpdateDrainRequest);
    await Promise.race([
      answered,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    return failed();
  } finally {
    clearTimeout(timer);
    unlisten();
  }
  if (!allOk || pending.size > 0) return failed();
  return { ok: true, release };
}

/**
 * Resolves true only when every other window confirmed its edits are on disk or
 * journalled. A window that cannot answer, including one still starting up, is
 * not confirmed. Events do not cross processes; the single-instance lock in
 * release builds is what keeps every window in this one.
 */
export async function drainPeerWindows(timeoutMs = PEER_DRAIN_TIMEOUT_MS): Promise<boolean> {
  return (await requestPeers(timeoutMs, false)).ok;
}

/**
 * The drain for the install's last step: every other window holds its input
 * first, then drains, and stays held until `release` or its expiry. When `ok`
 * is false the windows have already been released.
 */
export function holdAndDrainPeerWindows(timeoutMs = PEER_DRAIN_TIMEOUT_MS): Promise<PeerHold> {
  return requestPeers(timeoutMs, true);
}

export interface UpdateDrainSyncParams {
  /** The same drain this window runs before its own install. */
  drainRef: React.RefObject<(() => Promise<boolean>) | null>;
  /** Holds this window's input; null when it cannot be held right now. */
  holdInputRef: React.RefObject<(() => (() => void) | null) | null>;
  /** False while this window is in a state a restart must not interrupt. */
  mayInstall: () => boolean;
}

/** Answers other windows' drain requests. */
export function useUpdateDrainSync(params: UpdateDrainSyncParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    let mounted = true;
    const unlisteners: (() => void)[] = [];
    const held = new Map<string, () => void>();
    const releaseHold = (drainId: string) => {
      held.get(drainId)?.();
      held.delete(drainId);
    };
    const track = (registration: Promise<() => void>) => {
      registration.then((fn) => {
        if (mounted) unlisteners.push(fn);
        else fn();
      }).catch(() => { /* no answer: the requesting window treats it as unconfirmed */ });
    };

    track(listen<UpdateDrainRequest>("update-drain-request", (event) => {
      const { sourceWindow, drainId, holdInput } = event.payload;
      if (sourceWindow === WINDOW_LABEL) return;
      void (async () => {
        const { drainRef, holdInputRef, mayInstall } = paramsRef.current;
        let ok = true;
        if (holdInput) {
          const release = holdInputRef.current?.() ?? null;
          if (release) {
            let expiry: ReturnType<typeof setTimeout> | undefined;
            held.set(drainId, () => { clearTimeout(expiry); release(); });
            // Armed only after the answer goes out; see PEER_HOLD_EXPIRY_MS.
            ok = mayInstall() && (await drainRef.current?.().catch(() => false)) === true;
            if (ok && held.has(drainId)) expiry = setTimeout(() => releaseHold(drainId), PEER_HOLD_EXPIRY_MS);
            else releaseHold(drainId);
          } else {
            ok = false;
          }
        } else {
          ok = mayInstall() && (await drainRef.current?.().catch(() => false)) === true;
        }
        await emit("update-drain-ack", { sourceWindow: WINDOW_LABEL, drainId, ok } satisfies UpdateDrainAck).catch(() => {});
      })();
    }));

    track(listen<UpdateDrainRelease>("update-drain-release", (event) => {
      releaseHold(event.payload.drainId);
    }));

    return () => {
      mounted = false;
      for (const fn of unlisteners) fn();
      for (const drainId of [...held.keys()]) releaseHold(drainId);
    };
  }, []);
}
