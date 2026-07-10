import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";

// Where a removed note sat in the last committed render: its section (null =
// the ungrouped list, otherwise a group id), the id of the surviving note
// rendered right below it (null = it was last in its section), and its
// position within the section (orders stacked ghosts on a multi-delete).
export interface ExitAnchor {
  groupId: string | null;
  beforeId: string | null;
  orderIndex: number;
}

export interface ExitingDoc extends ExitAnchor {
  doc: NoteDoc;
}

interface UseSidebarAnimationsOptions {
  docs: NoteDoc[];
  groups: NoteGroup[];
  getExitAnchor: (removedId: string, survivingIds: Set<string>) => ExitAnchor | null;
}

export function useSidebarAnimations({ docs, groups, getExitAnchor }: UseSidebarAnimationsOptions) {
  const prevDocListRef = useRef<string[]>(docs.map((d) => d.id));
  const prevDocsSnapshotRef = useRef<Map<string, NoteDoc>>(new Map(docs.map((d) => [d.id, d])));
  const [newDocIds, setNewDocIds] = useState<Set<string>>(new Set());
  const [exitingDocs, setExitingDocs] = useState<ExitingDoc[]>([]);

  // Set during render so collapsing groups keep their notes mounted for exit.
  const [collapsingGroupIds, setCollapsingGroupIds] = useState<Set<string>>(new Set());
  const prevGroupCollapsedRef = useRef<Map<string, boolean>>(new Map(groups.map((g) => [g.id, g.collapsed])));

  const prevGroupIdsRef = useRef<Set<string>>(new Set(groups.map((g) => g.id)));

  const [removingGroupIds, setRemovingGroupIds] = useState<Set<string>>(new Set());
  const [newGroupIds, setNewGroupIds] = useState<Set<string>>(new Set());

  // useLayoutEffect (not useEffect) so the enter/exit classes land in the
  // same paint as the list change — with useEffect the list flashed one
  // frame with the deleted row already gone (rows jumped up) before the
  // exit ghost re-expanded it.
  useLayoutEffect(() => {
    const prevList = prevDocListRef.current;
    const prevSet = new Set(prevList);
    const currentIds = docs.map((d) => d.id);
    const currentSet = new Set(currentIds);

    const added = new Set<string>();
    for (const id of currentIds) {
      if (!prevSet.has(id)) added.add(id);
    }
    const removedIds = prevList.filter((id) => !currentSet.has(id));

    if (added.size > 0) setNewDocIds(added);

    if (removedIds.length > 0 && added.size === 0) {
      const ghosts: ExitingDoc[] = [];
      for (const id of removedIds) {
        const doc = prevDocsSnapshotRef.current.get(id);
        // No anchor means the note wasn't visible in the last render
        // (collapsed group, filtered out) — nothing to animate for it.
        const anchor = getExitAnchor(id, currentSet);
        if (doc && anchor) ghosts.push({ doc, ...anchor });
      }
      if (ghosts.length > 0) setExitingDocs(ghosts);
    }

    prevDocListRef.current = currentIds;
    prevDocsSnapshotRef.current = new Map(docs.map((d) => [d.id, d]));
  }, [docs, getExitAnchor]);

  useEffect(() => {
    if (newDocIds.size === 0) return;
    const timer = setTimeout(() => setNewDocIds(new Set()), 300);
    return () => clearTimeout(timer);
  }, [newDocIds]);

  // Keep in sync with the `docSlideOut` animation duration plus frame buffer.
  const EXIT_CLEANUP_MS = 300 + 60;

  useEffect(() => {
    if (exitingDocs.length === 0) return;
    const timer = setTimeout(() => setExitingDocs([]), EXIT_CLEANUP_MS);
    return () => clearTimeout(timer);
  }, [exitingDocs]);

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
    exitingDocs,
    collapsingGroupIds,
    removingGroupIds,
    newGroupIds,
    animateGroupRemoval,
  };
}
