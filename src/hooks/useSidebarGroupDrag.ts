import { useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import type { NoteGroup } from "./useNotesLoader";

const DRAG_THRESHOLD = 5;
const SCROLL_EDGE = 40;
const SCROLL_SPEED = 8;
const REORDER_ANIM_MS = 280;
const REORDER_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

// Capture screen-space top for every row rendered in the groups section —
// both group headers and the expanded notes under them. Used by the FLIP
// pass on commit: subtracting old-top from new-top yields the delta each
// row needs to slide through as it settles into its new position.
function captureGroupsSectionRowTops(): Map<string, number> {
  const map = new Map<string, number>();
  const section = document.querySelector<HTMLElement>("[data-groups-section]");
  if (!section) return map;
  section.querySelectorAll<HTMLElement>("[data-group-item][data-group-id]").forEach((el) => {
    const id = el.dataset.groupId;
    if (id) map.set(`g:${id}`, el.getBoundingClientRect().top);
  });
  section.querySelectorAll<HTMLElement>("[data-doc-item][data-note-id]").forEach((el) => {
    const id = el.dataset.noteId;
    if (id) map.set(`n:${id}`, el.getBoundingClientRect().top);
  });
  return map;
}

function playReorderFLIP(oldTops: Map<string, number>) {
  const newTops = captureGroupsSectionRowTops();
  const targets: HTMLElement[] = [];

  for (const [key, oldTop] of oldTops) {
    const newTop = newTops.get(key);
    if (newTop === undefined) continue;
    const dy = oldTop - newTop;
    if (Math.abs(dy) < 0.5) continue;

    const [type, id] = [key.slice(0, 1), key.slice(2)];
    const selector = type === "g"
      ? `[data-group-item][data-group-id="${CSS.escape(id)}"]`
      : `[data-doc-item][data-note-id="${CSS.escape(id)}"]`;
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;

    // Place the element visually at its OLD position without a transition.
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
    targets.push(el);
  }

  if (targets.length === 0) return;

  // Flush the inverse transform into the browser before starting the glide.
  // Reading offsetHeight forces a synchronous layout on each element.
  for (const el of targets) void el.offsetHeight;

  requestAnimationFrame(() => {
    for (const el of targets) {
      el.style.transition = `transform ${REORDER_ANIM_MS}ms ${REORDER_EASING}`;
      el.style.transform = "";
    }
    window.setTimeout(() => {
      for (const el of targets) {
        el.style.transition = "";
        el.style.transform = "";
      }
    }, REORDER_ANIM_MS + 40);
  });
}

interface DragSession {
  sourceGroupId: string;
  sourceIndex: number;
  ghost: HTMLElement;
  indicator: HTMLElement;
  offsetX: number;
  offsetY: number;
  pendingX: number;
  pendingY: number;
  rafId: number | null;
  targetInsertIndex: number | null;
  dimmedEl: HTMLElement | null;
  fadedEls: HTMLElement[];
  cleaned: boolean;
}

interface UseSidebarGroupDragOptions {
  groups: NoteGroup[];
  searchActive: boolean;
  editingIndex: number | null;
  editingGroupId: string | null;
  sidebarBodyRef: React.RefObject<HTMLElement | null>;
  onReorderGroups: (fromIndex: number, insertionIndex: number) => void;
}

export function useSidebarGroupDrag(opts: UseSidebarGroupDragOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const sessionRef = useRef<DragSession | null>(null);
  const draggingRef = useRef(false);

  const cleanup = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.cleaned) return;
    s.cleaned = true;

    if (s.rafId !== null) cancelAnimationFrame(s.rafId);

    s.ghost.remove();
    s.indicator.remove();
    if (s.dimmedEl) s.dimmedEl.style.opacity = "";
    s.fadedEls.forEach((el) => { el.style.opacity = ""; el.style.pointerEvents = ""; });

    document.body.style.cursor = "";
    draggingRef.current = false;
    sessionRef.current = null;
  }, []);

  const commit = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const o = optsRef.current;
    if (s.targetInsertIndex !== null) {
      // Snapshot row positions BEFORE the reorder commits, flushSync the
      // state update so the DOM reflects the new order, then translate each
      // row back to its old position and let CSS ease it home — all other
      // rows slide in/out of the gap left by the moved group.
      const fromIdx = s.sourceIndex;
      const toIdx = s.targetInsertIndex;
      const oldTops = captureGroupsSectionRowTops();
      flushSync(() => {
        o.onReorderGroups(fromIdx, toIdx);
      });
      playReorderFLIP(oldTops);
    }
    cleanup();
  }, [cleanup]);

  const tick = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.cleaned) return;
    s.rafId = null;

    const x = s.pendingX;
    const y = s.pendingY;

    s.ghost.style.transform = `translate3d(${x - s.offsetX}px, ${y - s.offsetY}px, 0)`;

    const body = optsRef.current.sidebarBodyRef.current;
    if (body) {
      const rect = body.getBoundingClientRect();
      if (y < rect.top + SCROLL_EDGE) {
        const ratio = 1 - Math.max(0, y - rect.top) / SCROLL_EDGE;
        body.scrollTop -= SCROLL_SPEED * ratio;
      } else if (y > rect.bottom - SCROLL_EDGE) {
        const ratio = 1 - Math.max(0, rect.bottom - y) / SCROLL_EDGE;
        body.scrollTop += SCROLL_SPEED * ratio;
      }
    }

    // Collect group-header rects in render order.
    const groups = optsRef.current.groups;
    const rects: { top: number; bottom: number; left: number; width: number }[] = [];
    for (const g of groups) {
      const el = document.querySelector<HTMLElement>(
        `[data-group-item][data-group-id="${g.id}"]`,
      );
      if (el) rects.push(el.getBoundingClientRect());
    }
    if (rects.length === 0) {
      s.targetInsertIndex = null;
      s.indicator.style.display = "none";
      return;
    }

    // A group's "block" spans from its header to the next header (or the
    // groups-section bottom for the last group). Split at the *header*
    // midpoint so pointer-over-header-top inserts BEFORE, and anywhere
    // below (header bottom half or the group's expanded notes) inserts AFTER.
    const sectionEnd =
      document.querySelector<HTMLElement>("[data-groups-section]")?.getBoundingClientRect().bottom
        ?? rects[rects.length - 1].bottom;

    let insertIdx = 0;
    let indicatorY = rects[0].top;

    if (y < rects[0].top) {
      insertIdx = 0;
      indicatorY = rects[0].top;
    } else if (y >= sectionEnd) {
      insertIdx = rects.length;
      indicatorY = sectionEnd;
    } else {
      for (let i = 0; i < rects.length; i++) {
        const headerTop = rects[i].top;
        const headerMid = (headerTop + rects[i].bottom) / 2;
        const blockBottom = i < rects.length - 1 ? rects[i + 1].top : sectionEnd;
        if (y >= headerTop && y < blockBottom) {
          if (y < headerMid) {
            insertIdx = i;
            indicatorY = headerTop;
          } else {
            insertIdx = i + 1;
            indicatorY = blockBottom;
          }
          break;
        }
      }
    }

    // Hide indicator when the target collapses to the source's current position.
    const isNoOp = insertIdx === s.sourceIndex || insertIdx === s.sourceIndex + 1;
    if (isNoOp) {
      s.targetInsertIndex = null;
      s.indicator.style.display = "none";
      return;
    }

    s.targetInsertIndex = insertIdx;

    const ref = rects[0];
    s.indicator.style.display = "block";
    s.indicator.style.top = `${indicatorY}px`;
    s.indicator.style.left = `${ref.left}px`;
    s.indicator.style.width = `${ref.width}px`;
  }, []);

  const handleGroupDragPointerDown = useCallback((e: React.PointerEvent, groupId: string) => {
    if (e.button !== 0) return;
    const o = optsRef.current;
    if (o.editingIndex !== null || o.editingGroupId !== null || o.searchActive) return;

    // Don't start a drag from interactive children (more-btn, input).
    const target = e.target as HTMLElement;
    if (target.closest("[data-more-btn]")) return;
    if (target.tagName === "INPUT") return;

    const sourceIndex = o.groups.findIndex((g) => g.id === groupId);
    if (sourceIndex < 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        started = true;
        startDrag(groupId, sourceIndex, startX, startY, ev);
      }

      const s = sessionRef.current;
      if (!s) return;
      s.pendingX = ev.clientX;
      s.pendingY = ev.clientY;
      if (s.rafId === null) {
        s.rafId = requestAnimationFrame(tick);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("keydown", onKeyDown);
      if (started) commit();
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("keydown", onKeyDown);
        cleanup();
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("keydown", onKeyDown);
  }, [tick, commit, cleanup]);

  function startDrag(groupId: string, sourceIndex: number, startX: number, startY: number, ev: PointerEvent) {
    const o = optsRef.current;
    const group = o.groups[sourceIndex];
    if (!group) return;

    const noteCount = group.noteIds.length;

    const ghost = document.createElement("div");
    ghost.className = "sidebar-drag-ghost";
    const iconSvg = '<svg fill="currentColor" width="16" height="16" viewBox="0 0 20 20"><path d="M3.75 4a1.75 1.75 0 0 0-1.75 1.75v8.5c0 .97.78 1.75 1.75 1.75h12.5a1.75 1.75 0 0 0 1.75-1.75V7.25A1.75 1.75 0 0 0 16.25 5.5H10.5l-1.5-1.28A1.75 1.75 0 0 0 7.86 4H3.75Z"/></svg>';
    const nameEscaped = group.name.replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c
    ));
    ghost.innerHTML = iconSvg + `<span>${nameEscaped}</span>` + `<span class="sidebar-drag-count">${noteCount}</span>`;
    ghost.style.transform = `translate3d(${startX + 8}px, ${startY - 14}px, 0)`;
    document.body.appendChild(ghost);

    const indicator = document.createElement("div");
    indicator.className = "sidebar-group-drop-indicator";
    indicator.style.display = "none";
    document.body.appendChild(indicator);

    // Dim the source header so the drag is visually anchored to the ghost.
    const sourceEl = document.querySelector<HTMLElement>(
      `[data-group-item][data-group-id="${groupId}"]`,
    );
    let dimmedEl: HTMLElement | null = null;
    if (sourceEl) {
      sourceEl.style.opacity = "0.35";
      dimmedEl = sourceEl;
    }

    // Fade zones that aren't valid drop targets for group reorder.
    const fadedEls: HTMLElement[] = [];
    const notesSection = document.querySelector<HTMLElement>("[data-notes-section]");
    if (notesSection) { notesSection.style.opacity = "0.45"; notesSection.style.pointerEvents = "none"; fadedEls.push(notesSection); }
    const newDocBtn = document.querySelector<HTMLElement>("[data-sidebar-body] > button");
    if (newDocBtn) { newDocBtn.style.opacity = "0.45"; newDocBtn.style.pointerEvents = "none"; fadedEls.push(newDocBtn); }

    document.body.style.cursor = "grabbing";
    draggingRef.current = true;

    sessionRef.current = {
      sourceGroupId: groupId,
      sourceIndex,
      ghost,
      indicator,
      offsetX: -8,
      offsetY: 14,
      pendingX: ev.clientX,
      pendingY: ev.clientY,
      rafId: null,
      targetInsertIndex: null,
      dimmedEl,
      fadedEls,
      cleaned: false,
    };
  }

  return {
    handleGroupDragPointerDown,
    isDraggingGroup: draggingRef,
  };
}
