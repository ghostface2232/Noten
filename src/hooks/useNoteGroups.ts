import { useCallback } from "react";
import { saveManifest, type NoteDoc, type NoteGroup } from "./useNotesLoader";
import { emitGroupsUpdated } from "./useWindowSync";

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
      const newGroup: NoteGroup = {
        id: crypto.randomUUID(),
        name,
        noteIds: initialNoteIds,
        collapsed: false,
        createdAt: Date.now(),
      };
      // Remove initialNoteIds from any existing groups
      const cleaned = initialNoteIds.length > 0
        ? groups.map((g) => ({
            ...g,
            noteIds: g.noteIds.filter((id) => !initialNoteIds.includes(id)),
          }))
        : groups;
      persist([...cleaned, newGroup]);
      return newGroup.id;
    },
    [groups, persist],
  );

  const renameGroup = useCallback(
    (groupId: string, name: string) => {
      persist(groups.map((g) => (g.id === groupId ? { ...g, name } : g)));
    },
    [groups, persist],
  );

  const deleteGroup = useCallback(
    (groupId: string) => {
      persist(groups.filter((g) => g.id !== groupId));
    },
    [groups, persist],
  );

  const ungroupGroup = useCallback(
    (groupId: string) => {
      persist(groups.filter((g) => g.id !== groupId));
    },
    [groups, persist],
  );

  const addNoteToGroup = useCallback(
    (noteId: string, groupId: string) => {
      persist(
        groups.map((g) => {
          // Remove from other groups, add to target
          if (g.id === groupId) {
            return g.noteIds.includes(noteId) ? g : { ...g, noteIds: [...g.noteIds, noteId] };
          }
          return g.noteIds.includes(noteId)
            ? { ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }
            : g;
        }),
      );
    },
    [groups, persist],
  );

  const removeNoteFromGroup = useCallback(
    (noteId: string) => {
      persist(
        groups.map((g) =>
          g.noteIds.includes(noteId)
            ? { ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }
            : g,
        ),
      );
    },
    [groups, persist],
  );

  const moveNotesToGroup = useCallback(
    (noteIds: string[], groupId: string) => {
      persist(
        groups.map((g) => {
          if (g.id === groupId) {
            const existing = new Set(g.noteIds);
            const toAdd = noteIds.filter((id) => !existing.has(id));
            return toAdd.length > 0 ? { ...g, noteIds: [...g.noteIds, ...toAdd] } : g;
          }
          const filtered = g.noteIds.filter((id) => !noteIds.includes(id));
          return filtered.length !== g.noteIds.length ? { ...g, noteIds: filtered } : g;
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
      persist(
        groups.map((g) => {
          if (g.id === groupId) {
            const filtered = g.noteIds.filter((id) => id !== noteId);
            filtered.splice(index, 0, noteId);
            return { ...g, noteIds: filtered };
          }
          return g.noteIds.includes(noteId)
            ? { ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }
            : g;
        }),
      );
    },
    [groups, persist],
  );

  const toggleGroupCollapsed = useCallback(
    (groupId: string) => {
      persist(
        groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)),
      );
    },
    [groups, persist],
  );

  // `insertionIndex` uses "gap" semantics: 0 = before first group, groups.length = after last.
  // No-op when the gap is the source's current position (equal to fromIndex or fromIndex + 1).
  const reorderGroups = useCallback(
    (fromIndex: number, insertionIndex: number) => {
      if (fromIndex < 0 || fromIndex >= groups.length) return;
      if (insertionIndex === fromIndex || insertionIndex === fromIndex + 1) return;
      const next = [...groups];
      const [moved] = next.splice(fromIndex, 1);
      const insertAt = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
      next.splice(insertAt, 0, moved);
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
      persist(
        groups.map((g) =>
          g.noteIds.includes(noteId)
            ? { ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }
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
