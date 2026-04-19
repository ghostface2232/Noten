import { useState, useRef, useEffect, useCallback } from "react";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";

interface UseSidebarAnimationsOptions {
  docs: NoteDoc[];
  groups: NoteGroup[];
}

export function useSidebarAnimations({ docs, groups }: UseSidebarAnimationsOptions) {
  // Detect added/removed docs for animation
  const prevDocListRef = useRef<string[]>(docs.map((d) => d.id));
  const prevDocsSnapshotRef = useRef<Map<string, NoteDoc>>(new Map(docs.map((d) => [d.id, d])));
  const [newDocIds, setNewDocIds] = useState<Set<string>>(new Set());
  const [slideUpFromIndex, setSlideUpFromIndex] = useState(-1);
  const [exitingDoc, setExitingDoc] = useState<{ doc: NoteDoc; index: number } | null>(null);

  // Track groups that just expanded / collapsed (for child animation).
  // Detection happens during render (not in useEffect) so that a collapsing
  // group's notes can stay mounted for the animation — by the time an effect
  // runs React would already have filtered them out via `!group.collapsed`.
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [collapsingGroupIds, setCollapsingGroupIds] = useState<Set<string>>(new Set());
  const prevGroupCollapsedRef = useRef<Map<string, boolean>>(new Map(groups.map((g) => [g.id, g.collapsed])));

  // Track newly created groups (for slide-in animation)
  const prevGroupIdsRef = useRef<Set<string>>(new Set(groups.map((g) => g.id)));

  // Track groups being removed (for collapse-out animation)
  const [removingGroupIds, setRemovingGroupIds] = useState<Set<string>>(new Set());
  const [newGroupIds, setNewGroupIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const prevList = prevDocListRef.current;
    const prevSet = new Set(prevList);
    const currentIds = docs.map((d) => d.id);
    const currentSet = new Set(currentIds);
    const timers: ReturnType<typeof setTimeout>[] = [];

    const added = new Set<string>();
    for (const id of currentIds) {
      if (!prevSet.has(id)) added.add(id);
    }
    let removedId: string | null = null;
    let removedIdx = -1;
    for (let idx = 0; idx < prevList.length; idx++) {
      if (!currentSet.has(prevList[idx])) {
        removedId = prevList[idx];
        removedIdx = idx;
        break;
      }
    }

    if (added.size > 0) {
      setNewDocIds(added);
      timers.push(setTimeout(() => setNewDocIds(new Set()), 300));
    }

    if (removedId && added.size === 0) {
      const snapshot = prevDocsSnapshotRef.current.get(removedId);
      if (snapshot) {
        // Exit animation handles the space collapse — no slideUp needed
        setExitingDoc({ doc: snapshot, index: removedIdx });
        timers.push(setTimeout(() => setExitingDoc(null), 280));
      } else {
        // Fallback: no snapshot, use slideUp
        setSlideUpFromIndex(removedIdx);
        timers.push(setTimeout(() => setSlideUpFromIndex(-1), 250));
      }
    }

    prevDocListRef.current = currentIds;
    prevDocsSnapshotRef.current = new Map(docs.map((d) => [d.id, d]));
    return () => timers.forEach(clearTimeout);
  }, [docs]);

  // Detect expand/collapse transitions synchronously during render (see note
  // above). Uses the "setState during render, guarded by a change condition"
  // pattern — React discards the current render and retries with the updated
  // state, so the collapse-animation class lands on the same paint as the
  // state flip and the notes never visibly disappear before animating out.
  {
    const prev = prevGroupCollapsedRef.current;
    const justExpanded: string[] = [];
    const justCollapsed: string[] = [];
    // Groups that never appeared in `prev` — covers every first-seen source:
    // the async manifest load on cold start, remote `groups-updated` syncs,
    // file-watcher reconciles, and user-created groups. Without silently
    // seeding the ref for these cases, `prev` would stay at its mount-time
    // snapshot forever (empty Map if the manifest loaded after first render),
    // every later toggle would read `wasColl === undefined`, and the animation
    // classes would never attach. First-time observation must not itself
    // trigger an expand/collapse animation — the ref sync below records the
    // state without firing setState.
    let hasUntrackedGroup = false;
    for (const g of groups) {
      const wasColl = prev.get(g.id);
      if (wasColl === undefined) hasUntrackedGroup = true;
      else if (wasColl === true && !g.collapsed) justExpanded.push(g.id);
      else if (wasColl === false && g.collapsed) justCollapsed.push(g.id);
    }
    const membershipChanged = hasUntrackedGroup || prev.size !== groups.length;
    if (justExpanded.length > 0 || justCollapsed.length > 0 || membershipChanged) {
      prevGroupCollapsedRef.current = new Map(groups.map((g) => [g.id, g.collapsed]));
    }
    if (justExpanded.length > 0 || justCollapsed.length > 0) {
      if (justExpanded.length > 0) {
        setExpandedGroupIds((s) => {
          const next = new Set(s);
          for (const id of justExpanded) next.add(id);
          return next;
        });
        // Rapid toggle: cancel any in-flight collapse for these groups.
        setCollapsingGroupIds((s) => {
          if (!justExpanded.some((id) => s.has(id))) return s;
          const next = new Set(s);
          for (const id of justExpanded) next.delete(id);
          return next;
        });
      }
      if (justCollapsed.length > 0) {
        setCollapsingGroupIds((s) => {
          const next = new Set(s);
          for (const id of justCollapsed) next.add(id);
          return next;
        });
        setExpandedGroupIds((s) => {
          if (!justCollapsed.some((id) => s.has(id))) return s;
          const next = new Set(s);
          for (const id of justCollapsed) next.delete(id);
          return next;
        });
      }
    }
  }

  // Clear the in-flight animation sets after every staggered note has
  // finished. The visible duration is `groupChildExpand` / `groupCollapseOut`
  // (280ms) plus a per-note stagger of 30ms assigned in renderNoteItem,
  // so the last note finishes at 280 + (noteCount - 1) × 30 ms. A fixed
  // 420ms cut off the tail of any group with 6+ notes — the bottom notes
  // got unmounted mid-animation, which read as a visible stutter. Compute
  // the timeout from the largest active group so the whole stagger lands
  // before cleanup.
  //
  // Keep the 280 / 30 constants in sync with the animation-duration in
  // Sidebar.styles.ts and the stagger multipliers in Sidebar.renderNoteItem.
  const ANIMATION_DURATION_MS = 280;
  const STAGGER_STEP_MS = 30;
  const FRAME_BUFFER_MS = 50;
  const cleanupDurationFor = (active: Set<string>): number => {
    let maxNotes = 0;
    for (const g of groups) {
      if (active.has(g.id) && g.noteIds.length > maxNotes) {
        maxNotes = g.noteIds.length;
      }
    }
    return ANIMATION_DURATION_MS + Math.max(0, maxNotes - 1) * STAGGER_STEP_MS + FRAME_BUFFER_MS;
  };

  useEffect(() => {
    if (expandedGroupIds.size === 0) return;
    const timer = setTimeout(() => setExpandedGroupIds(new Set()), cleanupDurationFor(expandedGroupIds));
    return () => clearTimeout(timer);
    // `groups` dep keeps the timer honest if a group's note count changes
    // mid-animation (rare — animation is < 1s — but correct).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedGroupIds, groups]);

  useEffect(() => {
    if (collapsingGroupIds.size === 0) return;
    const timer = setTimeout(() => setCollapsingGroupIds(new Set()), cleanupDurationFor(collapsingGroupIds));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsingGroupIds, groups]);

  // Detect newly created groups (for slide-in). Effect is fine here — notes
  // appear on mount so the class just needs to be applied post-render.
  useEffect(() => {
    const prevIds = prevGroupIdsRef.current;
    const addedGroups = new Set<string>();
    for (const g of groups) {
      if (!prevIds.has(g.id)) addedGroups.add(g.id);
    }
    prevGroupIdsRef.current = new Set(groups.map((g) => g.id));
    if (addedGroups.size === 0) return;
    setNewGroupIds(addedGroups);
    const timer = setTimeout(() => setNewGroupIds(new Set()), 250);
    return () => clearTimeout(timer);
  }, [groups]);

  const animateGroupRemoval = useCallback((groupId: string, noteIds: string[], callback: () => void) => {
    // Collect all IDs to animate: group header + its child notes
    const allIds = new Set<string>([groupId, ...noteIds]);
    setRemovingGroupIds(allIds);
    setTimeout(() => {
      callback();
      setRemovingGroupIds(new Set());
    }, 200);
  }, []);

  return {
    newDocIds,
    slideUpFromIndex,
    exitingDoc,
    expandedGroupIds,
    collapsingGroupIds,
    removingGroupIds,
    newGroupIds,
    animateGroupRemoval,
  };
}
