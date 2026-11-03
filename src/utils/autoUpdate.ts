// No keyboard or mouse input for this long, anywhere in the Windows session,
// is what counts as "not in use". Installing restarts the app in front of the
// user, so it waits for a pause however long that takes.
export const AUTO_UPDATE_IDLE_MS = 30_000;
// While a Noten window is the active one the user may be reading it, which
// produces no input at all, so the pause has to be longer.
export const AUTO_UPDATE_FOREGROUND_IDLE_MS = 60_000;
export const AUTO_UPDATE_POLL_MS = 5_000;
export const AUTO_UPDATE_DRAIN_RETRY_MS = 60_000;

export type AutoUpdateOutcome =
  | "not-claimed"
  | "up-to-date"
  | "cancelled"
  | "check-failed"
  | "download-failed"
  | "install-failed"
  | "installed";

/** One native reading, so idle time and focus describe the same moment. */
export interface UpdateActivity {
  /** Since the last input anywhere in the Windows session; 0 while a mouse button is held. */
  idleMs: number;
  /** A Noten window is the active window. */
  foreground: boolean;
  /** A PDF export is running in this process. */
  exporting: boolean;
}

export interface AutoUpdatePort {
  claim: () => Promise<boolean>;
  settle: (consumed: boolean) => Promise<void>;
  /** Resolves true when a newer version exists. */
  check: () => Promise<boolean>;
  download: () => Promise<void>;
  /** Read on every poll: the toggle can be turned off during the wait. */
  isEnabled: () => boolean;
  /** False while the app is in a state a restart must not interrupt. */
  mayInstall: () => boolean;
  /** The saved setting, the only place an opt-out from another window reaches. */
  isStillAllowed: () => Promise<boolean>;
  activity: () => Promise<UpdateActivity>;
  now: () => number;
  /** Resolves true only when every unsaved edit is on disk or journalled. */
  drain: () => Promise<boolean>;
  /**
   * Holds every window's input, then drains again. Resolves the release once
   * every window confirmed; null when one did not, already released.
   */
  holdAndDrain: () => Promise<(() => Promise<void>) | null>;
  install: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  reportFailure: (outcome: AutoUpdateOutcome, cause: unknown) => void;
}

/**
 * One silent update attempt for this Windows logon. A failed or abandoned
 * attempt gives its claim back, so a logon that started offline or closed the
 * app before a pause updates on a later launch; only "no newer version" and a
 * started install use the logon's one check up.
 *
 * Like the manual install, this never proceeds past a failed drain; unlike
 * it, it also waits for the user to stop, since no one asked for this restart.
 */
export async function runAutoUpdate(port: AutoUpdatePort): Promise<AutoUpdateOutcome> {
  if (!(await port.claim().catch(() => false))) return "not-claimed";

  const giveUp = async (outcome: AutoUpdateOutcome, cause?: unknown) => {
    if (cause !== undefined) port.reportFailure(outcome, cause);
    await port.settle(false).catch(() => {});
    return outcome;
  };

  let available: boolean;
  try {
    available = await port.check();
  } catch (err) {
    return giveUp("check-failed", err);
  }
  if (!available) {
    await port.settle(true).catch(() => {});
    return "up-to-date";
  }

  try {
    await port.download();
  } catch (err) {
    return giveUp("download-failed", err);
  }

  // Noten having been the active window at any reading in this idle stretch
  // counts, not just this one: another app taking focus by itself is no input,
  // and the user may still be reading the note behind it. Readings are one
  // poll apart, so a focus change in the stretch's first seconds can slip by.
  let foregroundSeenAt = Number.NEGATIVE_INFINITY;
  const isIdle = async () => {
    if (!port.mayInstall()) return false;
    const activity = await port.activity().catch(() => null);
    if (!activity) return false;
    const now = port.now();
    if (activity.foreground) foregroundSeenAt = now;
    if (activity.exporting) return false;
    const required = foregroundSeenAt >= now - activity.idleMs
      ? AUTO_UPDATE_FOREGROUND_IDLE_MS
      : AUTO_UPDATE_IDLE_MS;
    return activity.idleMs >= required;
  };
  for (;;) {
    if (!port.isEnabled()) return giveUp("cancelled");
    if (await isIdle()) {
      // Read before the drains, so nothing slow sits between the last idle
      // check and the install.
      if (!(await port.isStillAllowed().catch(() => false))) return giveUp("cancelled");
      // A keystroke during the drain fails it as well as a folder outage does,
      // so this keeps trying, but slowly: an outage should not mean a full
      // drain and its error logging every few seconds. This drain does the
      // slow work with input still live; the held one below normally finds
      // nothing left to write.
      if (!(await port.drain().catch(() => false))) {
        await port.sleep(AUTO_UPDATE_DRAIN_RETRY_MS);
        continue;
      }
      // The drain can take a while on a cloud folder, and a keystroke during
      // it is exactly what this wait exists to respect.
      if (port.isEnabled() && await isIdle()) {
        const release = await port.holdAndDrain().catch(() => null);
        if (release) {
          // Input held since before the last drain: whatever this reading
          // sees, no edit was made that the drain missed. Any input it does
          // see was swallowed by the hold and means the user is back.
          let installError: unknown = null;
          let installed = false;
          try {
            if (port.isEnabled() && await isIdle()) {
              await port.install();
              installed = true;
              return "installed";
            }
          } catch (err) {
            installError = err ?? new Error("install failed");
          } finally {
            // On Windows a successful install has already ended the process.
            if (!installed) await release().catch(() => {});
          }
          if (installError) return giveUp("install-failed", installError);
        }
      }
    }
    await port.sleep(AUTO_UPDATE_POLL_MS);
  }
}

// A user-driven install waits this long for saves, exports and a blocked
// folder to settle before it says it could not install.
export const MANUAL_INSTALL_WAIT_MS = 90_000;
export const MANUAL_INSTALL_RETRY_MS = 3_000;

export type ManualInstallOutcome = "installed" | "blocked" | "install-failed";

export interface ManualInstallPort {
  /** False while some window is in a state a restart must not interrupt. */
  mayInstall: () => boolean;
  activity: () => Promise<UpdateActivity>;
  /** Resolves true only when every unsaved edit is on disk or journalled. */
  drain: () => Promise<boolean>;
  /** As in AutoUpdatePort. */
  holdAndDrain: () => Promise<(() => Promise<void>) | null>;
  install: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * The install the user asked for. It needs no pause in their input, but it
 * holds the same line on their data as the automatic path: nothing installs
 * past a drain that did not confirm every window, or while an export runs.
 * Asking for an update is not asking to lose an edit, so a save or export in
 * progress is waited out quietly, and only one that outlasts the wait is
 * reported.
 */
export async function runManualInstall(port: ManualInstallPort): Promise<ManualInstallOutcome> {
  const deadline = port.now() + MANUAL_INSTALL_WAIT_MS;
  const ready = async () => port.mayInstall()
    && !(await port.activity().then((a) => a.exporting, () => true));
  for (;;) {
    if (await ready() && await port.drain().catch(() => false)) {
      const release = await port.holdAndDrain().catch(() => null);
      if (release) {
        let installed = false;
        try {
          // An export started from a click before the hold took effect.
          if (await ready()) {
            await port.install();
            installed = true;
            return "installed";
          }
        } catch {
          return "install-failed";
        } finally {
          if (!installed) await release().catch(() => {});
        }
      }
    }
    if (port.now() >= deadline) return "blocked";
    await port.sleep(MANUAL_INSTALL_RETRY_MS);
  }
}
