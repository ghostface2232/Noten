import { useCallback, useEffect, useRef } from "react";

interface UseHoverDismissTimerOptions {
  /** Invoked when the timer fires or closeNow is called. Latest-ref'd, no need to memoize. */
  onClose: () => void;
  /** Delay before the close fires after schedule(). */
  delayMs?: number;
}

interface UseHoverDismissTimerResult {
  /** Start the close countdown if not already pending. Idempotent. */
  schedule: () => void;
  /** Cancel any pending close without firing onClose. */
  clear: () => void;
  /** Cancel any pending close and invoke onClose immediately. */
  closeNow: () => void;
}

const DEFAULT_DELAY_MS = 300;

export function useHoverDismissTimer({
  onClose,
  delayMs = DEFAULT_DELAY_MS,
}: UseHoverDismissTimerOptions): UseHoverDismissTimerResult {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timerRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onCloseRef.current();
    }, delayMs);
  }, [delayMs]);

  const closeNow = useCallback(() => {
    clear();
    onCloseRef.current();
  }, [clear]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { schedule, clear, closeNow };
}
