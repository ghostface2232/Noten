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

  // Track groups that just expanded (for child animation)
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const prevGroupCollapsedRef = useRef<Map<string, boolean>>(new Map());

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

  // Detect group expand/collapse and new groups for animation
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const prevCollapsed = prevGroupCollapsedRef.current;
    const justExpanded = new Set<string>();

    for (const g of groups) {
      const wasColl = prevCollapsed.get(g.id);
      if (wasColl === true && !g.collapsed) {
        justExpanded.add(g.id);
      }
    }
    if (justExpanded.size > 0) {
      setExpandedGroupIds(justExpanded);
      timers.push(setTimeout(() => setExpandedGroupIds(new Set()), 250));
    }

    // Detect newly created groups
    const prevIds = prevGroupIdsRef.current;
    const addedGroups = new Set<string>();
    for (const g of groups) {
      if (!prevIds.has(g.id)) addedGroups.add(g.id);
    }
    if (addedGroups.size > 0) {
      setNewGroupIds(addedGroups);
      timers.push(setTimeout(() => setNewGroupIds(new Set()), 250));
    }

    prevGroupCollapsedRef.current = new Map(groups.map((g) => [g.id, g.collapsed]));
    prevGroupIdsRef.current = new Set(groups.map((g) => g.id));
    return () => timers.forEach(clearTimeout);
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
    removingGroupIds,
    newGroupIds,
    animateGroupRemoval,
  };
}
