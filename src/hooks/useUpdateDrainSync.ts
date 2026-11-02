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
}

interface UpdateDrainAck {
  sourceWindow: string;
  drainId: string;
  ok: boolean;
}

const WINDOW_LABEL = getCurrentWindow().label;
export const PEER_DRAIN_TIMEOUT_MS = 15_000;

/**
 * Resolves true only when every other window confirmed its edits are on disk or
 * journalled. A window that cannot answer, including one still starting up, is
 * not confirmed. Events do not cross processes, so a second Noten process is
 * not covered.
 */
export async function drainPeerWindows(timeoutMs = PEER_DRAIN_TIMEOUT_MS): Promise<boolean> {
  let pending: Set<string>;
  try {
    pending = new Set(
      (await getAllWebviewWindows())
        .map((w) => w.label)
        .filter((label) => label !== WINDOW_LABEL),
    );
  } catch {
    return false;
  }
  if (pending.size === 0) return true;

  const drainId = crypto.randomUUID();
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
    return false;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await emit("update-drain-request", { sourceWindow: WINDOW_LABEL, drainId } satisfies UpdateDrainRequest);
    await Promise.race([
      answered,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
  return allOk && pending.size === 0;
}

export interface UpdateDrainSyncParams {
  /** The same drain this window runs before its own install. */
  drainRef: React.RefObject<(() => Promise<boolean>) | null>;
  /** False while this window is in a state a restart must not interrupt. */
  mayInstall: () => boolean;
}

/** Answers other windows' drain requests. */
export function useUpdateDrainSync(params: UpdateDrainSyncParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;

    listen<UpdateDrainRequest>("update-drain-request", (event) => {
      const { sourceWindow, drainId } = event.payload;
      if (sourceWindow === WINDOW_LABEL) return;
      void (async () => {
        const { drainRef, mayInstall } = paramsRef.current;
        const ok = mayInstall() && (await drainRef.current?.().catch(() => false)) === true;
        await emit("update-drain-ack", { sourceWindow: WINDOW_LABEL, drainId, ok } satisfies UpdateDrainAck).catch(() => {});
      })();
    }).then((fn) => {
      if (mounted) unlisten = fn;
      else fn();
    }).catch(() => { /* no answer: the requesting window treats it as unconfirmed */ });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);
}
