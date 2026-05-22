import { useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import type { NoteGroup, NoteDoc } from "./useNotesLoader";
import { captureSidebarRowTops, playSidebarRowsFLIP } from "../utils/sidebarFlip";

const DRAG_THRESHOLD = 5;
const AUTO_EXPAND_DELAY = 600;
const SCROLL_EDGE = 40;
const SCROLL_SPEED = 8;

type DropTarget =
  | { type: "group"; groupId: string }
  | { type: "ungrouped" };

interface DragSession {
  noteId: string;
  allNoteIds: string[];
  sourceGroupId: string | null;
  ghost: HTMLElement;
  startX: number;
  startY: number;
  pendingX: number;
  pendingY: number;
  offsetX: number;
  offsetY: number;
  rafId: number | null;
  target: DropTarget | null;
  expandTimer: number | null;
  expandGroupId: string | null;
  dimmedEls: HTMLElement[];
  fadedEls: HTMLElement[];
  cleaned: boolean;
}

interface UseSidebarDragOptions {
  groups: NoteGroup[];
  docs: NoteDoc[];
  selectedNoteIds: Set<string>;
  selectMode: boolean;
  editingIndex: number | null;
  editingGroupId: string | null;
  searchActive: boolean;
  sidebarBodyRef: React.RefObject<HTMLElement | null>;
  onAddNoteToGroup: (noteId: string, groupId: string) => void;
  onMoveNotesToGroup: (noteIds: string[], groupId: string) => void;
  onRemoveNotesFromGroups: (noteIds: string[]) => void;
  onToggleGroupCollapsed: (groupId: string) => void;
}

export function useSidebarDrag(opts: UseSidebarDragOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const sessionRef = useRef<DragSession | null>(null);
  const draggingRef = useRef(false);

  const cleanup = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.cleaned) return;
    s.cleaned = true;

    if (s.rafId !== null) cancelAnimationFrame(s.rafId);
    if (s.expandTimer !== null) clearTimeout(s.expandTimer);

    s.ghost.remove();
    s.dimmedEls.forEach((el) => { el.style.opacity = ""; });
    s.fadedEls.forEach((el) => { el.style.opacity = ""; el.style.pointerEvents = ""; });

    document.querySelectorAll(".sidebar-drag-over").forEach((el) => el.classList.remove("sidebar-drag-over"));
    document.body.style.cursor = "";

    draggingRef.current = false;
    sessionRef.current = null;
  }, []);

  const commit = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const o = optsRef.current;
    const t = s.target;

    // Run FLIP only for mutating drops so displaced rows slide into place.
    let mutate: (() => void) | null = null;
    if (t?.type === "group" && t.groupId !== s.sourceGroupId) {
      mutate = s.allNoteIds.length === 1
        ? () => o.onAddNoteToGroup(s.noteId, t.groupId)
        : () => o.onMoveNotesToGroup(s.allNoteIds, t.groupId);
    } else if (t?.type === "ungrouped" && s.sourceGroupId !== null) {
      mutate = () => o.onRemoveNotesFromGroups(s.allNoteIds);
    }

    if (mutate) {
      s.dimmedEls.forEach((el) => { el.style.opacity = ""; });
      const oldTops = captureSidebarRowTops();
      flushSync(mutate);
      playSidebarRowsFLIP(oldTops);
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

    const el = document.elementFromPoint(x, y);
    if (!el) {
      clearTarget(s);
      return;
    }

    const groupHeader = el.closest<HTMLElement>("[data-group-item][data-group-id]");
    const noteInGroup = el.closest<HTMLElement>("[data-doc-item][data-group-id]");
    const notesSection = el.closest<HTMLElement>("[data-notes-section]");

    let nextTarget: DropTarget | null = null;
    let targetGroupId: string | null = null;

    if (groupHeader) {
      targetGroupId = groupHeader.dataset.groupId!;
    } else if (noteInGroup && noteInGroup.dataset.noteId !== s.noteId) {
      targetGroupId = noteInGroup.dataset.groupId!;
    }

    if (targetGroupId) {
      nextTarget = { type: "group", groupId: targetGroupId };

      const group = optsRef.current.groups.find((g) => g.id === targetGroupId);
      if (group?.collapsed && s.expandGroupId !== targetGroupId) {
        if (s.expandTimer !== null) clearTimeout(s.expandTimer);
        s.expandGroupId = targetGroupId;
        s.expandTimer = window.setTimeout(() => {
          s.expandTimer = null;
          optsRef.current.onToggleGroupCollapsed(targetGroupId!);
        }, AUTO_EXPAND_DELAY);
      } else if (!groupHeader) {
        clearAutoExpand(s);
      }
    } else if (notesSection && s.sourceGroupId !== null) {
      nextTarget = { type: "ungrouped" };
      clearAutoExpand(s);
    } else {
      clearAutoExpand(s);
    }

    applyTarget(nextTarget);
    s.target = nextTarget;
  }, []);

  const handleDragPointerDown = useCallback((e: React.PointerEvent, noteId: string) => {
    if (e.button !== 0) return;
    const o = optsRef.current;
    if (o.editingIndex !== null || o.editingGroupId !== null || o.searchActive) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        started = true;
        startDrag(noteId, startX, startY, ev);
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

  function startDrag(noteId: string, startX: number, startY: number, ev: PointerEvent) {
    const o = optsRef.current;

    const allNoteIds = o.selectMode && o.selectedNoteIds.has(noteId)
      ? Array.from(o.selectedNoteIds)
      : [noteId];

    const sourceGroup = o.groups.find((g) => g.noteIds.includes(noteId));

    const ghost = document.createElement("div");
    ghost.className = "sidebar-drag-ghost";
    const doc = o.docs.find((d) => d.id === noteId);
    const iconSvg = '<svg fill="currentColor" width="16" height="16" viewBox="0 0 20 20"><path d="M6 2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8h-3a2 2 0 0 1-2-2V3H6Zm5 1.07V6a1 1 0 0 0 1 1h2.93L11 3.07ZM5 4a1 1 0 0 1 1-1h4v3a2 2 0 0 0 2 2h3v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4Z"/></svg>';
    ghost.innerHTML = iconSvg + `<span>${doc?.fileName ?? ""}</span>`;
    if (allNoteIds.length > 1) {
      ghost.innerHTML += `<span class="sidebar-drag-count">+${allNoteIds.length - 1}</span>`;
    }
    ghost.style.transform = `translate3d(${startX + 8}px, ${startY - 14}px, 0)`;
    document.body.appendChild(ghost);

    const dimmedEls: HTMLElement[] = [];
    for (const id of allNoteIds) {
      const el = document.querySelector<HTMLElement>(`[data-doc-item][data-note-id="${id}"]`);
      if (el) {
        el.style.opacity = "0.35";
        dimmedEls.push(el);
      }
    }

    const fadedEls: HTMLElement[] = [];
    if (sourceGroup === undefined) {
      const notesSection = document.querySelector<HTMLElement>("[data-notes-section]");
      if (notesSection) { notesSection.style.opacity = "0.45"; notesSection.style.pointerEvents = "none"; fadedEls.push(notesSection); }
    }
    const newDocBtn = document.querySelector<HTMLElement>("[data-sidebar-body] > button");
    if (newDocBtn) { newDocBtn.style.opacity = "0.45"; newDocBtn.style.pointerEvents = "none"; fadedEls.push(newDocBtn); }

    document.body.style.cursor = "grabbing";
    draggingRef.current = true;

    sessionRef.current = {
      noteId,
      allNoteIds,
      sourceGroupId: sourceGroup?.id ?? null,
      ghost,
      startX,
      startY,
      pendingX: ev.clientX,
      pendingY: ev.clientY,
      offsetX: -8,
      offsetY: 14,
      rafId: null,
      target: null,
      expandTimer: null,
      expandGroupId: null,
      dimmedEls,
      fadedEls,
      cleaned: false,
    };
  }

  return {
    handleDragPointerDown,
    isDragging: draggingRef,
  };
}

function clearAutoExpand(s: DragSession) {
  if (s.expandTimer !== null) {
    clearTimeout(s.expandTimer);
    s.expandTimer = null;
  }
  s.expandGroupId = null;
}

function clearTarget(s: DragSession) {
  document.querySelectorAll(".sidebar-drag-over").forEach((el) => el.classList.remove("sidebar-drag-over"));
  s.target = null;
}

function applyTarget(t: DropTarget | null) {
  document.querySelectorAll(".sidebar-drag-over").forEach((el) => el.classList.remove("sidebar-drag-over"));
  if (!t) return;
  if (t.type === "group") {
    const header = document.querySelector<HTMLElement>(`[data-group-item][data-group-id="${t.groupId}"]`);
    if (header) header.classList.add("sidebar-drag-over");
  } else {
    const section = document.querySelector<HTMLElement>("[data-notes-section]");
    if (section) section.classList.add("sidebar-drag-over");
  }
}
