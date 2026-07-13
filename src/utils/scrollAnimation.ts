/**
 * Animate an element's scrollTop with a fixed duration and ease-out curve.
 *
 * Used for outline jumps instead of scrollTo({ behavior: "smooth" }): the
 * native smooth scroll picks its own distance-dependent duration, which can
 * exceed the editor's 300ms chrome lock on long documents and read as a
 * hide-chrome gesture. A fixed short duration stays inside the lock.
 *
 * The animation yields to the user immediately: any wheel or mousedown on the
 * container cancels it, as does calling the returned cancel function (e.g. a
 * newer jump). `onUserCancel` fires only for the wheel/mousedown path — the
 * caller can undo side effects (like a chrome lock) the moment the user takes
 * over, without reacting to its own programmatic cancels or natural
 * completion. With prefers-reduced-motion the scroll applies instantly.
 *
 * Returns a cancel function; safe to call more than once.
 */
export function animateScrollTop(
  container: HTMLElement,
  targetTop: number,
  durationMs: number,
  options: { onUserCancel?: () => void } = {},
): () => void {
  const startTop = container.scrollTop;
  const distance = targetTop - startTop;

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion || Math.abs(distance) < 1 || durationMs <= 0) {
    container.scrollTop = targetTop;
    return () => {};
  }

  let frame: number | null = null;
  let done = false;

  const cancel = () => {
    if (done) return;
    done = true;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    container.removeEventListener("wheel", userCancel);
    container.removeEventListener("mousedown", userCancel);
  };

  const userCancel = () => {
    if (done) return;
    cancel();
    options.onUserCancel?.();
  };

  let startTime: number | null = null;
  const step = (now: number) => {
    if (startTime === null) startTime = now;
    const t = Math.min(1, (now - startTime) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic: fast start, soft landing
    container.scrollTop = startTop + distance * eased;
    if (t < 1) {
      frame = requestAnimationFrame(step);
    } else {
      cancel();
    }
  };

  container.addEventListener("wheel", userCancel, { passive: true });
  container.addEventListener("mousedown", userCancel);
  frame = requestAnimationFrame(step);
  return cancel;
}
