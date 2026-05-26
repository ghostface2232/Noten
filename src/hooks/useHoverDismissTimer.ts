import { useCallback, useEffect, useRef } from "react";

interface UseHoverDismissTimerOptions {
  onClose: () => void;
  delayMs?: number;
}

interface UseHoverDismissTimerResult {
  schedule: () => void;
  clear: () => void;
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
