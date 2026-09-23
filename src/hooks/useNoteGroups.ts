import { useCallback } from "react";
import {
  saveManifest,
  markGroupAsDeleted,
  markGroupMembershipChanged,
  markGroupMembershipChanges,
  type NoteDoc,
  type NoteGroup,
} from "./useNotesLoader";
import { genOrderKeyAfter, genOrderKeyBefore, genOrderKeyBetween, genSpreadOrderKeys, isOrderKeyBetween } from "../utils/groupsIO";
import { setGroupCollapsedPersisted } from "./useUiState";
import { emitGroupsDelta } from "./useWindowSync";
import { diffGroupsDelta } from "../utils/groupsDelta";

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
  // Commits are functional deltas against the store's `prev`, mirroring
  // sortAndPersistDocs: the `groups` render prop is a projection that can lag
  // a peer commit, and committing it absolutely would erase that commit and
  // then broadcast the erasure. The adapter runs updaters synchronously, so
  // the committed array is captured through the closure and is what gets
  // broadcast — never a pre-commit derivation.
  const persist = useCallback(
    (update: (prev: NoteGroup[]) => NoteGroup[]) => {
      let prevGroups: NoteGroup[] | null = null;
      let committed: NoteGroup[] | null = null;
      setGroups((prev) => {
        prevGroups = prev;
        committed = update(prev);
        return committed;
      });
      if (!prevGroups || !committed) return;
      void saveManifest(docs, docs[activeIndex]?.id ?? null, committed).catch(() => {});
      // Broadcast the CHANGE this mutation made — the diff between the
      // updater's own prev and what it committed — never a whole array: a
      // snapshot makes every receiver adopt this window's view wholesale,
      // undoing their concurrent group changes.
      emitGroupsDelta(diffGroupsDelta(prevGroups, committed));
    },
    [docs, activeIndex, setGroups],
  );

  const createGroup = useCallback(
    (name: string, initialNoteIds: string[] = []) => {
      const now = Date.now();
      const newGroupId = crypto.randomUUID();
      markGroupMembershipChanges(initialNoteIds, newGroupId, now);
      persist((prev) => {
        const last = prev[prev.length - 1];
        const orderKey = genOrderKeyAfter(last?.orderKey);
        const newGroup: NoteGroup = {
          id: newGroupId,
          name,
          noteIds: initialNoteIds,
          collapsed: false,
          createdAt: now,
          orderKey,
          orderUpdatedAt: now,
          updatedAt: now,
        };
        const cleaned = initialNoteIds.length > 0
          ? prev.map((g) => ({
              ...g,
              noteIds: g.noteIds.filter((id) => !initialNoteIds.includes(id)),
            }))
          : prev;
        const next = [...cleaned, newGroup];
        // A key past the length clamp is a time key, unrelated to `last`.
        if (isOrderKeyBetween(orderKey, last, undefined)) return next;
        const keys = genSpreadOrderKeys(next.length);
        return next.map((group, i) => ({ ...group, orderKey: keys[i], orderUpdatedAt: now }));
      });
      return newGroupId;
    },
    [persist],
  );

  const renameGroup = useCallback(
    (groupId: string, name: string) => {
      const now = Date.now();
      persist((prev) => prev.map((g) => (g.id === groupId ? { ...g, name, updatedAt: now } : g)));
    },
    [persist],
  );

  const deleteGroup = useCallback(
    (groupId: string) => {
      markGroupAsDeleted(groupId);
      const noteIds = groups.find((g) => g.id === groupId)?.noteIds ?? [];
      markGroupMembershipChanges(noteIds, null);
      persist((prev) => prev.filter((g) => g.id !== groupId));
    },
    [groups, persist],
  );

  const ungroupGroup = useCallback(
    (groupId: string) => {
      markGroupAsDeleted(groupId);
      const noteIds = groups.find((g) => g.id === groupId)?.noteIds ?? [];
      markGroupMembershipChanges(noteIds, null);
      persist((prev) => prev.filter((g) => g.id !== groupId));
    },
    [groups, persist],
  );

  const addNoteToGroup = useCallback(
    (noteId: string, groupId: string) => {
      const now = Date.now();
      const currentGroupId = groups.find((g) => g.noteIds.includes(noteId))?.id ?? null;
      if (currentGroupId !== groupId) markGroupMembershipChanged(noteId, groupId, now);
      persist((prev) =>
        prev.map((g) => {
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
      persist((prev) =>
        prev.map((g) =>
          g.noteIds.includes(noteId)
            ? withUpdatedAt({ ...g, noteIds: g.noteIds.filter((id) => id !== noteId) }, now, false)
            : g,
        ),
      );
    },
    [persist],
  );

  const removeNotesFromGroups = useCallback(
    (noteIds: string[]) => {
      if (noteIds.length === 0) return;
      const now = Date.now();
      const idSet = new Set(noteIds);
      const groupedNoteIds = noteIds.filter((noteId) => groups.some((g) => g.noteIds.includes(noteId)));
      markGroupMembershipChanges(groupedNoteIds, null, now);
      persist((prev) =>
        prev.map((g) => {
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
      persist((prev) =>
        prev.map((g) => {
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
      persist((prev) =>
        prev.map((g) => {
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
    [persist],
  );

  const insertNoteInGroup = useCallback(
    (noteId: string, groupId: string, index: number) => {
      const now = Date.now();
      const currentGroupId = groups.find((g) => g.noteIds.includes(noteId))?.id ?? null;
      if (currentGroupId !== groupId) markGroupMembershipChanged(noteId, groupId, now);
      persist((prev) =>
        prev.map((g) => {
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
      // The alphabet cannot express every position (nothing sorts before "0",
      // and long keys fall back to a time key), and a key persisted on the
      // wrong side of a neighbour sorts wrong on every machine and cannot be
      // fixed by repeating the drag. Rekey the whole list instead.
      const renormalize = !isOrderKeyBetween(newKey, before, after);

      // Apply the move by id against `prev`: the moved group keeps whatever a
      // concurrent commit did to its members, and the insertion point is
      // resolved by neighbour id rather than by index into a stale array.
      persist((prev) => {
        const idx = prev.findIndex((g) => g.id === moved.id);
        if (idx < 0) return prev;
        const updated: NoteGroup = {
          ...prev[idx],
          orderKey: newKey,
          orderUpdatedAt: now,
        };
        const without = prev.filter((g) => g.id !== moved.id);
        let insertPos: number;
        if (before) {
          const beforeIdx = without.findIndex((g) => g.id === before.id);
          insertPos = beforeIdx >= 0 ? beforeIdx + 1 : without.length;
        } else if (after) {
          const afterIdx = without.findIndex((g) => g.id === after.id);
          insertPos = afterIdx >= 0 ? afterIdx : without.length;
        } else {
          insertPos = without.length;
        }
        const next = [...without];
        next.splice(insertPos, 0, updated);
        if (!renormalize) return next;
        // Keyed in the committed array's order, which is the render order and
        // includes whatever a concurrent commit added.
        const keys = genSpreadOrderKeys(next.length);
        return next.map((group, i) => ({ ...group, orderKey: keys[i], orderUpdatedAt: now }));
      });
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
      persist((prev) =>
        prev.map((g) =>
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
