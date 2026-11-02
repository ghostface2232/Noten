import { useState, useRef, useCallback } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { runAutoUpdate, runManualInstall, type AutoUpdateOutcome, type UpdateActivity } from "../utils/autoUpdate";
import { logNotenError } from "../utils/crashLog";
import { NotenError } from "../utils/notenError";
import { readAutoUpdateAllowed } from "./useSettings";
import { drainPeerWindows, holdAndDrainPeerWindows } from "./useUpdateDrainSync";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "upToDate"
  | "error";

export type UpdateError = "check_failed" | "install_failed" | "install_blocked";

export interface UpdaterState {
  status: UpdateStatus;
  version: string | null;
  body: string | null;
  progress: number;
  error: UpdateError | null;
}

export interface AutoUpdateGates {
  isEnabled: () => boolean;
}

const readActivity = () => invoke<UpdateActivity>("update_activity");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface UpdaterParams {
  /**
   * Runs immediately before the installer does, and is awaited. Tauri's quiet
   * install mode ends the process from inside `install`, so the window never
   * gets its close event and the drain that guards it never runs — an unsaved
   * edit simply went with the process. This is the last point at which
   * anything can be persisted, so it belongs inside the hook rather than at a
   * call site a later caller could forget. Resolves true when every unsaved
   * edit is on disk or journalled.
   */
  drainRef: RefObject<(() => Promise<boolean>) | null>;
  /** Holds this window's input for the install's last step; null when it cannot. */
  holdInputRef: RefObject<(() => (() => void) | null) | null>;
  /**
   * False while this window is in a state a restart must not interrupt
   * (loading, a migration, an export). Both install paths wait on it.
   */
  mayInstall: () => boolean;
}

export function useUpdater({ drainRef: beforeInstallRef, holdInputRef, mayInstall }: UpdaterParams) {
  const [state, setState] = useState<UpdaterState>({
    status: "idle",
    version: null,
    body: null,
    progress: 0,
    error: null,
  });
  const updateRef = useRef<Update | null>(null);
  const downloadedRef = useRef(false);
  // Once the user has asked, the automatic path stands down for good.
  const manualInstallRef = useRef(false);
  const installingRef = useRef(false);

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
      beforeInstallRef.current?.().catch(() => false),
      drainPeerWindows(),
    ]);
    return own === true && peers;
  }, [beforeInstallRef]);

  // The install's last step. Every window holds its input first and drains
  // again, so an edit made after the first drain is either saved now or never
  // made: from here to the process ending, nothing can change a document.
  // Resolves the release when every window confirmed, else null, released.
  const holdAndDrainAllWindows = useCallback(async (): Promise<(() => Promise<void>) | null> => {
    const releaseOwn = holdInputRef.current?.() ?? null;
    if (!releaseOwn) return null;
    const [own, peers] = await Promise.all([
      beforeInstallRef.current?.().catch(() => false),
      holdAndDrainPeerWindows(),
    ]);
    const release = async () => {
      releaseOwn();
      await peers.release();
    };
    if (own === true && peers.ok) return release;
    await release();
    return null;
  }, [beforeInstallRef, holdInputRef]);

  // A user-driven install. It waits on no pause in their input, because they
  // just asked for it, but it does wait for every window's edits to be safe.
  const installNow = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installingRef.current) return;
    manualInstallRef.current = true;
    installingRef.current = true;
    try {
      // The drain runs after the download, because anything typed during the
      // download has to be covered too.
      if (!downloadedRef.current) await download();
      setState((s) => ({ ...s, status: "installing", error: null }));
      const outcome = await runManualInstall({
        mayInstall,
        activity: readActivity,
        drain: drainAllWindows,
        holdAndDrain: holdAndDrainAllWindows,
        install: () => update.install(),
        sleep,
        now: () => performance.now(),
      });
      if (outcome === "blocked") {
        void logNotenError(new NotenError("AUTO_UPDATE_FAILED", "recoverable", "manualInstall: unsaved edits or an export did not settle"));
        setState((s) => ({ ...s, status: "available", error: "install_blocked" }));
      } else if (outcome === "install-failed") {
        setState((s) => ({ ...s, status: "error", error: "install_failed" }));
      }
    } catch {
      setState((s) => ({ ...s, status: "error", error: "install_failed" }));
    } finally {
      installingRef.current = false;
    }
  }, [download, drainAllWindows, holdAndDrainAllWindows, mayInstall]);

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
      mayInstall,
      isStillAllowed: readAutoUpdateAllowed,
      activity: readActivity,
      now: () => performance.now(),
      drain: drainAllWindows,
      holdAndDrain: holdAndDrainAllWindows,
      install: async () => {
        try {
          await updateRef.current?.install();
        } catch (err) {
          setState((s) => ({ ...s, status: "error", error: "install_failed" }));
          throw err;
        }
      },
      sleep,
      reportFailure: (outcome, cause) => {
        void logNotenError(new NotenError("AUTO_UPDATE_FAILED", "recoverable", `autoUpdate: ${outcome}`, { cause }));
      },
    })
  ), [download, drainAllWindows, findUpdate, holdAndDrainAllWindows, mayInstall]);

  return { state, checkForUpdate, installUpdate: installNow, restartApp, startAutoUpdate };
}
