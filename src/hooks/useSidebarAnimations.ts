import { useState, useRef, useEffect, useCallback } from "react";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";

interface UseSidebarAnimationsOptions {
  docs: NoteDoc[];
  groups: NoteGroup[];
}

export function useSidebarAnimations({ docs, groups }: UseSidebarAnimationsOptions) {
  const prevDocListRef = useRef<string[]>(docs.map((d) => d.id));
  const prevDocsSnapshotRef = useRef<Map<string, NoteDoc>>(new Map(docs.map((d) => [d.id, d])));
  const [newDocIds, setNewDocIds] = useState<Set<string>>(new Set());
  const [slideUpFromIndex, setSlideUpFromIndex] = useState(-1);
  const [exitingDoc, setExitingDoc] = useState<{ doc: NoteDoc; index: number } | null>(null);

  // Set during render so collapsing groups keep their notes mounted for exit.
  const [collapsingGroupIds, setCollapsingGroupIds] = useState<Set<string>>(new Set());
  const prevGroupCollapsedRef = useRef<Map<string, boolean>>(new Map(groups.map((g) => [g.id, g.collapsed])));

  const prevGroupIdsRef = useRef<Set<string>>(new Set(groups.map((g) => g.id)));

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
        setExitingDoc({ doc: snapshot, index: removedIdx });
        timers.push(setTimeout(() => setExitingDoc(null), 280));
      } else {
        setSlideUpFromIndex(removedIdx);
        timers.push(setTimeout(() => setSlideUpFromIndex(-1), 250));
      }
    }

    prevDocListRef.current = currentIds;
    prevDocsSnapshotRef.current = new Map(docs.map((d) => [d.id, d]));
    return () => timers.forEach(clearTimeout);
  }, [docs]);

  // Guarded render-time state update lets collapse animation start same-paint.
  {
    const prev = prevGroupCollapsedRef.current;
    const justCollapsed: string[] = [];
    let hasUntrackedGroup = false;
    let stateChanged = false;
    for (const g of groups) {
      const wasColl = prev.get(g.id);
      if (wasColl === undefined) {
        hasUntrackedGroup = true;
      } else if (wasColl !== g.collapsed) {
        stateChanged = true;
        if (wasColl === false) justCollapsed.push(g.id);
      }
    }
    const membershipChanged = hasUntrackedGroup || prev.size !== groups.length;
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

  // Keep in sync with `groupNotesSlide` transition duration plus frame buffer.
  const COLLAPSE_CLEANUP_MS = 280 + 50;

  useEffect(() => {
    if (collapsingGroupIds.size === 0) return;
    const timer = setTimeout(() => setCollapsingGroupIds(new Set()), COLLAPSE_CLEANUP_MS);
    return () => clearTimeout(timer);
  }, [collapsingGroupIds]);

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
