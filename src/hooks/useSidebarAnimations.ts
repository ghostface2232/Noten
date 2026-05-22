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

  // Track groups that are mid-collapse. Detection happens during render (not
  // in useEffect) so a collapsing group's notes can stay mounted for the
  // slide-out — by the time an effect runs React would already have filtered
  // them out via `!group.collapsed`. Expansion needs no tracking: the grid
  // transition fires on its own when the wrapper's collapsed class drops.
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

  // Detect collapse transitions synchronously during render (see note above).
  // Uses the "setState during render, guarded by a change condition" pattern —
  // React discards the current render and retries with the updated state, so
  // the group lands in `collapsingGroupIds` on the same paint as the state
  // flip and its notes never visibly disappear before sliding out.
  {
    const prev = prevGroupCollapsedRef.current;
    const justCollapsed: string[] = [];
    // Groups that never appeared in `prev` — covers every first-seen source:
    // the async manifest load on cold start, remote `groups-updated` syncs,
    // file-watcher reconciles, and user-created groups. Without silently
    // seeding the ref for these cases, `prev` would stay at its mount-time
    // snapshot forever (empty Map if the manifest loaded after first render),
    // every later toggle would read `wasColl === undefined`, and the collapse
    // animation would never attach. First-time observation must not itself
    // trigger a collapse animation — the ref sync below records the state
    // without firing setState.
    let hasUntrackedGroup = false;
    let stateChanged = false;
    for (const g of groups) {
      const wasColl = prev.get(g.id);
      if (wasColl === undefined) {
        hasUntrackedGroup = true;
      } else if (wasColl !== g.collapsed) {
        stateChanged = true;
        // wasColl differs from g.collapsed; wasColl === false means this is a
        // false → true transition: a collapse.
        if (wasColl === false) justCollapsed.push(g.id);
      }
    }
    const membershipChanged = hasUntrackedGroup || prev.size !== groups.length;
    // Re-sync the ref on ANY collapsed-state change — expansions included.
    // Previously it was re-synced only on collapse/membership changes, so an
    // expand left `prev` stale at `collapsed: true`. The NEXT collapse then
    // read `wasColl === true`, failed the `false → true` test, never entered
    // `collapsingGroupIds`, so the note rows were filtered out immediately
    // instead of staying mounted for the slide-out — the collapse snapped
    // shut with almost no motion.
    if (stateChanged || membershipChanged) {
      prevGroupCollapsedRef.current = new Map(groups.map((g) => [g.id, g.collapsed]));
    }
    if (justCollapsed.length > 0) {
      setCollapsingGroupIds((s) => {
        const next = new Set(s);
        for (const id of justCollapsed) next.add(id);
        return next;
      });
    }
  }

  // Drop `collapsingGroupIds` once the collapse slide has finished, which
  // unmounts the now-hidden note rows. The whole block slides as one unit, so
  // the duration is fixed: `groupNotesSlide`'s transition plus a frame buffer.
  // Keep in sync with the 0.28s transition-duration in Sidebar.styles.ts.
  const COLLAPSE_CLEANUP_MS = 280 + 50;

  useEffect(() => {
    if (collapsingGroupIds.size === 0) return;
    const timer = setTimeout(() => setCollapsingGroupIds(new Set()), COLLAPSE_CLEANUP_MS);
    return () => clearTimeout(timer);
  }, [collapsingGroupIds]);

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
    collapsingGroupIds,
    removingGroupIds,
    newGroupIds,
    animateGroupRemoval,
  };
}
