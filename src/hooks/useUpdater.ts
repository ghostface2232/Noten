import { useState, useRef, useCallback } from "react";
import type { RefObject } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "upToDate"
  | "error";

export interface UpdaterState {
  status: UpdateStatus;
  version: string | null;
  body: string | null;
  progress: number;
  error: string | null;
}

/**
 * @param beforeInstallRef Runs immediately before the installer does, and is
 *   awaited. Tauri's quiet install mode ends the process from inside
 *   `downloadAndInstall`, so the window never gets its close event and the
 *   drain that guards it never runs — an unsaved edit simply went with the
 *   process. This is the last point at which anything can be persisted, so it
 *   belongs inside the hook rather than at a call site a later caller could
 *   forget.
 */
export function useUpdater(beforeInstallRef?: RefObject<(() => Promise<void>) | null>) {
  const [state, setState] = useState<UpdaterState>({
    status: "idle",
    version: null,
    body: null,
    progress: 0,
    error: null,
  });
  const updateRef = useRef<Update | null>(null);

  const checkForUpdate = useCallback(async () => {
    setState((s) => ({ ...s, status: "checking", error: null }));
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setState((s) => ({
          ...s,
          status: "available",
          version: update.version,
          body: update.body ?? null,
        }));
      } else {
        setState((s) => ({ ...s, status: "upToDate" }));
      }
    } catch {
      setState((s) => ({ ...s, status: "error", error: "check_failed" }));
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setState((s) => ({ ...s, status: "downloading", progress: 0 }));
    try {
      // Never let a failure here stop the update; the point is only to give
      // unsaved work its last chance to reach disk.
      await beforeInstallRef?.current?.().catch(() => {});
      let totalLength = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalLength = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (totalLength > 0) {
            setState((s) => ({
              ...s,
              progress: Math.round((downloaded / totalLength) * 100),
            }));
          }
        } else if (event.event === "Finished") {
          setState((s) => ({ ...s, progress: 100 }));
        }
      });
      setState((s) => ({ ...s, status: "ready" }));
    } catch {
      setState((s) => ({ ...s, status: "error", error: "install_failed" }));
    }
  }, [beforeInstallRef]);

  const restartApp = useCallback(async () => {
    await relaunch();
  }, []);

  return { state, checkForUpdate, installUpdate, restartApp };
}
