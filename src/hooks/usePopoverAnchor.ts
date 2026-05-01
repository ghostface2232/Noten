import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Placement,
} from "@floating-ui/dom";

export interface PopoverReference {
  contextElement?: Element;
  getBoundingClientRect: () => DOMRect;
}

interface UsePopoverAnchorOptions {
  open: boolean;
  popoverRef: RefObject<HTMLElement | null>;
  /**
   * Stabilize with useCallback. Identity change triggers an autoUpdate
   * re-subscription, mirroring the previous effect-deps pattern.
   * Return null to skip setup (e.g. anchor not yet resolved).
   */
  getReference: () => PopoverReference | null;
  placement: Placement;
  offsetPx: number;
  shiftPaddingPx?: number;
  /** Fired once via rAF after autoUpdate is wired. Use for focus/measure side effects. */
  onPositioned?: () => void;
  /** Capture-phase mousedown outside the popover. Omit to disable outside-click handling. */
  onOutsideMouseDown?: () => void;
}

export interface UsePopoverAnchorResult {
  /** Tear down autoUpdate immediately, before React schedules a re-render. */
  teardownNow: () => void;
}

export function usePopoverAnchor({
  open,
  popoverRef,
  getReference,
  placement,
  offsetPx,
  shiftPaddingPx = 8,
  onPositioned,
  onOutsideMouseDown,
}: UsePopoverAnchorOptions): UsePopoverAnchorResult {
  const cleanupRef = useRef<(() => void) | null>(null);
  const onPositionedRef = useRef(onPositioned);
  onPositionedRef.current = onPositioned;
  const onOutsideMouseDownRef = useRef(onOutsideMouseDown);
  onOutsideMouseDownRef.current = onOutsideMouseDown;

  const teardownNow = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    const popoverEl = popoverRef.current;
    const reference = getReference();
    if (!popoverEl || !reference) return;

    const updatePosition = () => {
      void computePosition(reference, popoverEl, {
        strategy: "fixed",
        placement,
        middleware: [offset(offsetPx), flip(), shift({ padding: shiftPaddingPx })],
      }).then(({ x, y }) => {
        popoverEl.style.left = `${x}px`;
        popoverEl.style.top = `${y}px`;
      });
    };

    const cleanup = autoUpdate(reference, popoverEl, updatePosition, { animationFrame: true });
    cleanupRef.current = cleanup;
    updatePosition();

    let positionedFrame: number | null = null;
    if (onPositionedRef.current) {
      positionedFrame = requestAnimationFrame(() => {
        positionedFrame = null;
        onPositionedRef.current?.();
      });
    }

    return () => {
      if (positionedFrame !== null) cancelAnimationFrame(positionedFrame);
      cleanup();
      if (cleanupRef.current === cleanup) {
        cleanupRef.current = null;
      }
    };
  }, [open, popoverRef, getReference, placement, offsetPx, shiftPaddingPx]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!onOutsideMouseDownRef.current) return;
      const target = event.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return;
      onOutsideMouseDownRef.current();
    };
    window.addEventListener("mousedown", handleMouseDown, true);
    return () => window.removeEventListener("mousedown", handleMouseDown, true);
  }, [open, popoverRef]);

  return { teardownNow };
}
