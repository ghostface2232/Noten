/**
 * How long a refused close keeps the discard override armed.
 *
 * The first refusal explains the cause so a recoverable condition can be fixed
 * and the close retried with every edit intact; the attempt right after it
 * offers the discard, so an unfixable cause cannot wedge the window. The
 * refusal belongs to one close attempt, not to the window's lifetime: a
 * refusal hours ago, for a different and possibly transient cause, must not
 * turn today's first failed close straight into "closing discards these".
 */
export const CLOSE_OVERRIDE_WINDOW_MS = 5 * 60 * 1000;

/** Both times come from `performance.now()`: a monotonic clock, so a wall
 *  clock correction cannot arm or expire the override. */
export function isCloseOverrideArmed(lastRefusedAt: number | null, now: number): boolean {
  return lastRefusedAt != null && now >= lastRefusedAt && now - lastRefusedAt <= CLOSE_OVERRIDE_WINDOW_MS;
}
