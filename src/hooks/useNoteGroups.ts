import { useCallback } from "react";
import {
  saveManifest,
  markGroupAsDeleted,
  markGroupMembershipChanged,
  markGroupMembershipChanges,
  type NoteDoc,
  type NoteGroup,
} from "./useNotesLoader";
import { genOrderKeyAfter, genOrderKeyBefore, genOrderKeyBetween } from "../utils/groupsIO";
import { setGroupCollapsedPersisted } from "./useUiState";
import { emitGroupsUpdated } from "./useWindowSync";

function withUpdatedAt(g: NoteGroup, now: number, name?: boolean): NoteGroup {
  return name === false
    ? g
    : { ...g, updatedAt: now };
}

export function useNoteGroups(
  groups: NoteGroup[],
  setGroups: React.Dispatch<React.SetStateAction<NoteGroup[]>>,
  docs: NoteDoc[],
  activeIndex: number,
) {
  const persist = useCallback(
    (nextGroups: NoteGroup[]) => {
      setGroups(nextGroups);
      void saveManifest(docs, docs[activeIndex]?.id ?? null, nextGroups).catch(() => {});
      emitGroupsUpdated(nextGroups);
    },
    [docs, activeIndex, setGroups],
  );

  const createGroup = useCallback(
    (name: string, initialNoteIds: string[] = []) => {
      const now = Date.now();
      const lastKey = groups[groups.length - 1]?.orderKey;
      const newGroup: NoteGroup = {
        id: crypto.randomUUID(),
        name,
        noteIds: initialNoteIds,
        collapsed: false,
        createdAt: now,
        orderKey: genOrderKeyAfter(lastKey),
        orderUpdatedAt: now,
        updatedAt: now,
      };
      const cleaned = initialNoteIds.length > 0
        ? groups.map((g) => ({
            ...g,
            noteIds: g.noteIds.filter((id) => !initialNoteIds.includes(id)),
          }))
        : groups;
      markGroupMembershipChanges(initialNoteIds, newGroup.id, now);
      persist([...cleaned, newGroup]);
      return newGroup.id;
    },
    [groups, persist],
  );

  const renameGroup = useCallback(
    (groupId: string, name: string) => {
      const now = Date.now();
      persist(groups.map((g) => (g.id === groupId ? { ...g, name, updatedAt: now } : g)));
    },
    [groups, persist],
  );

  const deleteGroup = useCallback(
    (groupId: string) => {
      markGroupAsDeleted(groupId);
      const noteIds = groups.find((g) => g.id === groupId)?.noteIds ?? [];
      markGroupMembershipChanges(noteIds, null);
      persist(groups.filter((g) => g.id !== groupId));
    },
    [groups, persist],
  );

  const ungroupGroup = useCallback(
    (groupId: string) => {
      markGroupAsDeleted(groupId);
      const noteIds = groups.find((g) => g.id === groupId)?.noteIds ?? [];
      markGroupMembershipChanges(noteIds, null);
      persist(groups.filter((g) => g.id !== groupId));
    },
    [groups, persist],
  );

  const addNoteToGroup = useCallback(
    (noteId: string, groupId: string) => {
      const now = Date.now();
      const currentGroupId = groups.find((g) => g.noteIds.includes(noteId))?.id ?? null;
      if (currentGroupId !== groupId) markGroupMembershipChanged(noteId, groupId, now);
      persist(
        groups.map((g) => {
          if (g.id === groupId) {
            return g.noteIds.includes(noteId)
              ? g
              : withUpdatedAt({ ...g, noteIds: [...g.noteIds, noteId] }, now, false);
          }
          return g.noteIds.includes(noteId)
            ? withUpdatedAt({ ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }, now, false)
            : g;
        }),
      );
    },
    [groups, persist],
  );

  const removeNoteFromGroup = useCallback(
    (noteId: string) => {
      const now = Date.now();
      markGroupMembershipChanged(noteId, null, now);
      persist(
        groups.map((g) =>
          g.noteIds.includes(noteId)
            ? withUpdatedAt({ ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }, now, false)
            : g,
        ),
      );
    },
    [groups, persist],
  );

  const removeNotesFromGroups = useCallback(
    (noteIds: string[]) => {
      if (noteIds.length === 0) return;
      const now = Date.now();
      const idSet = new Set(noteIds);
      const groupedNoteIds = noteIds.filter((noteId) => groups.some((g) => g.noteIds.includes(noteId)));
      markGroupMembershipChanges(groupedNoteIds, null, now);
      persist(
        groups.map((g) => {
          const filtered = g.noteIds.filter((id) => !idSet.has(id));
          return filtered.length !== g.noteIds.length
            ? withUpdatedAt({ ...g, noteIds: filtered }, now, false)
            : g;
        }),
      );
    },
    [groups, persist],
  );

  const moveNotesToGroup = useCallback(
    (noteIds: string[], groupId: string) => {
      const now = Date.now();
      const movedNoteIds = noteIds.filter((noteId) => {
        const currentGroupId = groups.find((g) => g.noteIds.includes(noteId))?.id ?? null;
        return currentGroupId !== groupId;
      });
      markGroupMembershipChanges(movedNoteIds, groupId, now);
      persist(
        groups.map((g) => {
          if (g.id === groupId) {
            const existing = new Set(g.noteIds);
            const toAdd = noteIds.filter((id) => !existing.has(id));
            return toAdd.length > 0
              ? withUpdatedAt({ ...g, noteIds: [...g.noteIds, ...toAdd] }, now, false)
              : g;
          }
          const filtered = g.noteIds.filter((id) => !noteIds.includes(id));
          return filtered.length !== g.noteIds.length
            ? withUpdatedAt({ ...g, noteIds: filtered }, now, false)
            : g;
        }),
      );
    },
    [groups, persist],
  );

  const reorderNoteInGroup = useCallback(
    (noteId: string, groupId: string, newIndex: number) => {
      persist(
        groups.map((g) => {
          if (g.id !== groupId) return g;
          const cur = g.noteIds.indexOf(noteId);
          if (cur === -1 || cur === newIndex) return g;
          const next = [...g.noteIds];
          next.splice(cur, 1);
          next.splice(newIndex, 0, noteId);
          return { ...g, noteIds: next };
        }),
      );
    },
    [groups, persist],
  );

  const insertNoteInGroup = useCallback(
    (noteId: string, groupId: string, index: number) => {
      const now = Date.now();
      const currentGroupId = groups.find((g) => g.noteIds.includes(noteId))?.id ?? null;
      if (currentGroupId !== groupId) markGroupMembershipChanged(noteId, groupId, now);
      persist(
        groups.map((g) => {
          if (g.id === groupId) {
            const filtered = g.noteIds.filter((id) => id !== noteId);
            filtered.splice(index, 0, noteId);
            return withUpdatedAt({ ...g, noteIds: filtered }, now, false);
          }
          return g.noteIds.includes(noteId)
            ? withUpdatedAt({ ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }, now, false)
            : g;
        }),
      );
    },
    [groups, persist],
  );

  const toggleGroupCollapsed = useCallback(
    (groupId: string) => {
      let nextCollapsed: boolean | null = null;
      setGroups((prev) => {
        const idx = prev.findIndex((g) => g.id === groupId);
        if (idx < 0) return prev;
        nextCollapsed = !prev[idx].collapsed;
        const next = [...prev];
        next[idx] = { ...prev[idx], collapsed: nextCollapsed };
        return next;
      });
      if (nextCollapsed !== null) {
        void setGroupCollapsedPersisted(groupId, nextCollapsed).catch(() => {});
      }
    },
    [setGroups],
  );

  // Reorder one group's fractional key; insertionIndex uses gap semantics.
  const reorderGroups = useCallback(
    (fromIndex: number, insertionIndex: number) => {
      if (fromIndex < 0 || fromIndex >= groups.length) return;
      if (insertionIndex === fromIndex || insertionIndex === fromIndex + 1) return;

      const filtered = groups.filter((_, i) => i !== fromIndex);
      const insertAt = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
      const before = filtered[insertAt - 1];
      const after = filtered[insertAt];
      const moved = groups[fromIndex];
      const now = Date.now();

      let newKey: string;
      if (!before && !after) newKey = genOrderKeyAfter(undefined);
      else if (!before) newKey = genOrderKeyBefore(after!.orderKey);
      else if (!after) newKey = genOrderKeyAfter(before.orderKey);
      else newKey = genOrderKeyBetween(before.orderKey, after.orderKey);

      const updated: NoteGroup = {
        ...moved,
        orderKey: newKey,
        orderUpdatedAt: now,
      };

      const next = [...filtered];
      next.splice(insertAt, 0, updated);
      persist(next);
    },
    [groups, persist],
  );

  const createGroupFromSelection = useCallback(
    (noteIds: string[], name: string) => {
      return createGroup(name, noteIds);
    },
    [createGroup],
  );

  const cleanupDeletedNote = useCallback(
    (noteId: string) => {
      const needsCleanup = groups.some((g) => g.noteIds.includes(noteId));
      if (!needsCleanup) return;
      const now = Date.now();
      markGroupMembershipChanged(noteId, null, now);
      persist(
        groups.map((g) =>
          g.noteIds.includes(noteId)
            ? withUpdatedAt({ ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }, now, false)
            : g,
        ),
      );
    },
    [groups, persist],
  );

  const getGroupForNote = useCallback(
    (noteId: string): NoteGroup | null => {
      return groups.find((g) => g.noteIds.includes(noteId)) ?? null;
    },
    [groups],
  );

  return {
    createGroup,
    renameGroup,
    deleteGroup,
    ungroupGroup,
    addNoteToGroup,
    removeNoteFromGroup,
    removeNotesFromGroups,
    moveNotesToGroup,
    reorderNoteInGroup,
    insertNoteInGroup,
    toggleGroupCollapsed,
    reorderGroups,
    createGroupFromSelection,
    cleanupDeletedNote,
    getGroupForNote,
  };
}
