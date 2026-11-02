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
 * Unlike the manual install, this never proceeds past a failed drain: no one
 * asked for this restart, so it must not be the thing that loses an edit.
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

  // Noten having been the active window at any point in this idle stretch
  // counts, not just at this reading: another app taking focus by itself is no
  // input, and the user may still be reading the note behind it.
  let foregroundSeenAt = Number.NEGATIVE_INFINITY;
  const isIdle = async () => {
    if (!port.mayInstall()) return false;
    const activity = await port.activity();
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
      // A keystroke during the drain fails it as well as a folder outage does,
      // so this keeps trying, but slowly: an outage should not mean a full
      // drain and its error logging every few seconds.
      if (!(await port.drain().catch(() => false))) {
        await port.sleep(AUTO_UPDATE_DRAIN_RETRY_MS);
        continue;
      }
      // The drain can take a while on a cloud folder, and a keystroke during
      // it is exactly what this wait exists to respect.
      if (port.isEnabled() && await isIdle()) {
        if (!(await port.isStillAllowed().catch(() => false))) return giveUp("cancelled");
        try {
          await port.install();
          return "installed";
        } catch (err) {
          return giveUp("install-failed", err);
        }
      }
    }
    await port.sleep(AUTO_UPDATE_POLL_MS);
  }
}
