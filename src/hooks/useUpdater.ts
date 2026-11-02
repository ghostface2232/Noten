import { useState, useRef, useCallback } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { runAutoUpdate, type AutoUpdateOutcome } from "../utils/autoUpdate";
import { logNotenError } from "../utils/crashLog";
import { NotenError } from "../utils/notenError";
import { readAutoUpdateAllowed } from "./useSettings";
import { drainPeerWindows } from "./useUpdateDrainSync";

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

export interface AutoUpdateGates {
  isEnabled: () => boolean;
  mayInstall: () => boolean;
}

/**
 * @param beforeInstallRef Runs immediately before the installer does, and is
 *   awaited. Tauri's quiet install mode ends the process from inside
 *   `install`, so the window never gets its close event and the drain that
 *   guards it never runs — an unsaved edit simply went with the process. This
 *   is the last point at which anything can be persisted, so it belongs inside
 *   the hook rather than at a call site a later caller could forget. Resolves
 *   true when every unsaved edit is on disk or journalled.
 */
export function useUpdater(beforeInstallRef?: RefObject<(() => Promise<boolean>) | null>) {
  const [state, setState] = useState<UpdaterState>({
    status: "idle",
    version: null,
    body: null,
    progress: 0,
    error: null,
  });
  const updateRef = useRef<Update | null>(null);
  const downloadedRef = useRef(false);
  const manualInstallRef = useRef(false);

  const findUpdate = useCallback(async (): Promise<boolean> => {
    setState((s) => ({ ...s, status: "checking", error: null }));
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        downloadedRef.current = false;
        setState((s) => ({
          ...s,
          status: "available",
          version: update.version,
          body: update.body ?? null,
        }));
        return true;
      }
      setState((s) => ({ ...s, status: "upToDate" }));
      return false;
    } catch (err) {
      setState((s) => ({ ...s, status: "error", error: "check_failed" }));
      throw err;
    }
  }, []);

  const checkForUpdate = useCallback(async () => {
    await findUpdate().catch(() => {});
  }, [findUpdate]);

  const download = useCallback(async () => {
    const update = updateRef.current;
    if (!update) throw new Error("no update to download");
    setState((s) => ({ ...s, status: "downloading", progress: 0 }));
    let totalLength = 0;
    let downloaded = 0;
    await update.download((event) => {
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
    downloadedRef.current = true;
  }, []);

  // The installer ends the whole process, so this covers every window.
  const drainAllWindows = useCallback(async (): Promise<boolean> => {
    const [own, peers] = await Promise.all([
      beforeInstallRef?.current?.().catch(() => false),
      drainPeerWindows(),
    ]);
    return own === true && peers;
  }, [beforeInstallRef]);

  // A user-driven install. It waits on no pause, because they just asked for it.
  const installNow = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    manualInstallRef.current = true;
    try {
      if (!downloadedRef.current) await download();
      // Never let a failure here stop the update; the point is only to give
      // unsaved work its last chance to reach disk. It runs after the download
      // because anything typed during the download has to be covered too.
      await drainAllWindows();
      await update.install();
      setState((s) => ({ ...s, status: "ready" }));
    } catch {
      setState((s) => ({ ...s, status: "error", error: "install_failed" }));
    }
  }, [download, drainAllWindows]);

  const restartApp = useCallback(async () => {
    // On Windows "ready" means a download waiting for the user to be idle, not
    // an install that needs a restart: relaunching would discard it.
    if (updateRef.current && downloadedRef.current) {
      await installNow();
      return;
    }
    await relaunch();
  }, [installNow]);

  const startAutoUpdate = useCallback((gates: AutoUpdateGates): Promise<AutoUpdateOutcome> => (
    runAutoUpdate({
      claim: () => invoke<boolean>("claim_logon_update_check"),
      settle: (consumed) => invoke("settle_logon_update_check", { consumed }),
      check: findUpdate,
      download: async () => {
        try {
          await download();
          setState((s) => ({ ...s, status: "ready" }));
        } catch (err) {
          setState((s) => ({ ...s, status: "error", error: "install_failed" }));
          throw err;
        }
      },
      isEnabled: () => gates.isEnabled() && !manualInstallRef.current,
      mayInstall: gates.mayInstall,
      isStillAllowed: readAutoUpdateAllowed,
      idleMs: () => invoke<number>("auto_update_idle_ms"),
      drain: drainAllWindows,
      install: async () => {
        try {
          await updateRef.current?.install();
        } catch (err) {
          setState((s) => ({ ...s, status: "error", error: "install_failed" }));
          throw err;
        }
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      reportFailure: (outcome, cause) => {
        void logNotenError(new NotenError("AUTO_UPDATE_FAILED", "recoverable", `autoUpdate: ${outcome}`, { cause }));
      },
    })
  ), [download, drainAllWindows, findUpdate]);

  return { state, checkForUpdate, installUpdate: installNow, restartApp, startAutoUpdate };
}
