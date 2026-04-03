import { useState, useEffect, useCallback, useRef, type RefObject } from "react";

const CHROME_HIDE_SCROLL_THRESHOLD = 36;
const CHROME_LOCK_MS = 300;

export function useChromeVisibility(
  contentRef: RefObject<HTMLDivElement | null>,
  activeDocId: string | undefined,
  surface: "note" | "markdown",
) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeLockUntilRef = useRef(0);
  const chromeVisibleRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const handleShowEditorChrome = useCallback(() => {
    chromeVisibleRef.current = true;
    setChromeVisible(true);
    chromeLockUntilRef.current = Date.now() + CHROME_LOCK_MS;
  }, []);

  const [toolbarHeight, setToolbarHeight] = useState(0);
  const editorTopOffset = Math.max(toolbarHeight - 16, 0);
  const handleBarHeight = useCallback((h: number) => {
    setToolbarHeight((prev) => (prev === h ? prev : h));
  }, []);

  // 스크롤 기반 크롬(toolbar/statusbar) 가시성 제어
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const updateChromeVisibility = () => {
      const nextTop = el.scrollTop;
      const now = Date.now();

      if (now < chromeLockUntilRef.current) {
        lastScrollTopRef.current = nextTop;
        return;
      }

      const previousTop = lastScrollTopRef.current;
      let next: boolean | undefined;

      if (nextTop <= 1) {
        next = true;
      } else if (nextTop < previousTop) {
        next = true;
      } else if (nextTop >= CHROME_HIDE_SCROLL_THRESHOLD) {
        next = false;
      }

      if (next !== undefined && next !== chromeVisibleRef.current) {
        chromeVisibleRef.current = next;
        setChromeVisible(next);
        chromeLockUntilRef.current = now + 300;
      }

      lastScrollTopRef.current = nextTop;
    };

    lastScrollTopRef.current = el.scrollTop;
    updateChromeVisibility();
    el.addEventListener("scroll", updateChromeVisibility, { passive: true });
    return () => el.removeEventListener("scroll", updateChromeVisibility);
  }, []);

  // 문서 전환/surface 변경 시 리셋
  useEffect(() => {
    requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) return;
      const nextTop = el.scrollTop;
      lastScrollTopRef.current = nextTop;
      const next = nextTop < CHROME_HIDE_SCROLL_THRESHOLD;
      chromeVisibleRef.current = next;
      setChromeVisible(next);
    });
  }, [activeDocId, surface]);

  return {
    chromeVisible,
    toolbarHeight,
    editorTopOffset,
    handleShowEditorChrome,
    handleBarHeight,
  };
}
