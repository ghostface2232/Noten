import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { sortNotes, type NoteDoc, type NoteGroup, type TrashedNote } from "./useNotesLoader";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { syncGroupsSnapshotFromDisk, getNotesDir } from "./useNotesLoader";
import type { LibrarySnapshot, LibraryUpdater } from "../utils/libraryStore";
import type { Locale, NotesSortOrder } from "./useSettings";
import type { NoteColorId } from "../utils/noteColors";
import type { GroupMembershipOp, GroupUpsert, GroupsDelta } from "../utils/groupsDelta";
import { setKnownDiskContent } from "../utils/conflictBackup";

/**
 * A body save. Small bodies ride along in `content`; larger ones are left off
 * and receivers read `filePath`, which the sender has already written. Every
 * autosave of a large note otherwise pushed the whole body through IPC to
 * every window — the sender's own listener included — once a second while
 * typing.
 */
interface DocUpdatedPayload {
  sourceWindow: string;
  docId: string;
  /** Absent when the body exceeds INLINE_BODY_MAX_CHARS. */
  content?: string;
  /** The path the sender wrote, for receivers to read when `content` is absent. */
  filePath: string;
  updatedAt: number;
}

/** Largest body, in UTF-16 code units, carried inline on doc-updated. */
export const INLINE_BODY_MAX_CHARS = 64 * 1024;

interface DocRenamedPayload {
  sourceWindow: string;
  docId: string;
  oldFilePath: string;
  newFilePath: string;
  newFileName: string;
}

interface DocDeletedPayload {
  sourceWindow: string;
  docId: string;
}

interface DocCreatedPayload {
  sourceWindow: string;
  doc: Omit<NoteDoc, "isDirty">;
}

interface NotePinnedUpdatedPayload {
  sourceWindow: string;
  docId: string;
  pinned: boolean;
}

interface NoteColorUpdatedPayload {
  sourceWindow: string;
  docId: string;
  color: NoteColorId | null;
}

/**
 * A groups CHANGE, not a groups snapshot — the same shift trash-updated made.
 * Broadcasting the sender's whole array made every receiver adopt that
 * window's view wholesale: a group created, renamed, or deleted concurrently
 * in the receiving window was silently undone, an out-of-order event
 * resurrected a deleted group, and the sender's per-machine `collapsed` state
 * overwrote the receiver's. The delta describes only what the sender changed;
 * receivers merge it into their own list with the same per-field clocks the
 * on-disk mergeGroupEntries uses.
 */
interface GroupsUpdatedPayload {
  sourceWindow: string;
  /** Shared meta of groups the sender created or changed. No collapsed (per-machine), no noteIds (carried as membership ops). */
  upserted: GroupUpsert[];
  /**
   * Groups the sender deleted. Plain ids — group ids are uuids that are never
   * reused (mergeGroupEntries never un-sets deletedAt and nothing recreates an
   * id), so no incarnation guard is needed; a session tombstone set handles
   * the removal-before-upsert ordering instead.
   */
  removedIds: string[];
  /** Note membership moves, ordered by their `at` stamps across windows. */
  membership: GroupMembershipOp[];
}

/**
 * A trash CHANGE, not a trash snapshot. Broadcasting the sender's whole array
 * made every receiver adopt that window's view of the trash wholesale, so a
 * concurrent trash/restore/purge in the receiving window was silently undone
 * (and an out-of-order event resurrected entries whose files were already
 * gone). Describing only what the sender moved keeps disjoint operations
 * commutative: each window applies the delta to its own list.
 */
interface TrashUpdatedPayload {
  sourceWindow: string;
  /** Entries the sender moved INTO trash. */
  added: TrashedNote[];
  /**
   * Entries the sender took OUT of trash, by restore or by permanent delete.
   * Carries `trashedAt` because the id alone names the note, not the trash
   * incarnation: the same note can be restored and trashed again, and a
   * removal that reaches a window after the newer re-trash must not delete it.
   */
  removed: TrashRemoval[];
}

export interface TrashRemoval {
  id: string;
  /** `trashedAt` of the entry the sender removed. */
  trashedAt: number;
}

const WINDOW_LABEL = getCurrentWindow().label;

// Newest body revision this window has seen on the doc-updated channel, per
// doc: our own persisted saves plus every peer body we accepted. A doc's own
// `updatedAt` cannot serve as this clock — renames and pin/color writes bump it
// without touching the body, which is exactly why applying a remote body keeps
// max(updatedAt) instead of the event's value. Without a body-specific clock,
// a doc-updated that lost the race (two peers saving the same note, or an
// event delayed behind its own disk I/O past our newer save) silently replaces
// a newer body with an older one while the timestamp keeps reading newer — and
// the next local save writes that stale body back over the newer one.
const lastBodyAtByDoc = new Map<string, number>();

/** Drops one doc's body clock. Called when the note is deleted. */
function forgetDocBodyClock(docId: string) {
  lastBodyAtByDoc.delete(docId);
}

/** Clears every body clock. Exists so tests start from a known state. */
export function resetDocBodyClocks() {
  lastBodyAtByDoc.clear();
}

export function emitDocUpdated(docId: string, filePath: string, content: string, updatedAt: number) {
  // Our own write is the newest body we know of, so a peer event that predates
  // it is stale even though this window skips its own broadcasts.
  noteBodyRevision(docId, updatedAt);
  const payload: DocUpdatedPayload = { sourceWindow: WINDOW_LABEL, docId, filePath, updatedAt };
  if (content.length <= INLINE_BODY_MAX_CHARS) payload.content = content;
  emit("doc-updated", payload).catch(() => {});
}

function noteBodyRevision(docId: string, updatedAt: number) {
  const seen = lastBodyAtByDoc.get(docId);
  if (seen == null || updatedAt > seen) lastBodyAtByDoc.set(docId, updatedAt);
}

/** True when this body event predates one already applied for the same doc. */
function isStaleBodyEvent(docId: string, updatedAt: number): boolean {
  const seen = lastBodyAtByDoc.get(docId);
  return seen != null && updatedAt < seen;
}

export function emitDocRenamed(docId: string, oldFilePath: string, newFilePath: string, newFileName: string) {
  emit("doc-renamed", {
    sourceWindow: WINDOW_LABEL, docId, oldFilePath, newFilePath, newFileName,
  } satisfies DocRenamedPayload).catch(() => {});
}

export function emitDocDeleted(docId: string) {
  // A restore reuses the id, so the deleted note's body clock must not outlive
  // it and reject the restored body.
  forgetDocBodyClock(docId);
  emit("doc-deleted", {
    sourceWindow: WINDOW_LABEL, docId,
  } satisfies DocDeletedPayload).catch(() => {});
}

export function emitDocCreated(doc: NoteDoc) {
  const { isDirty: _, ...rest } = doc;
  emit("doc-created", {
    sourceWindow: WINDOW_LABEL, doc: rest,
  } satisfies DocCreatedPayload).catch(() => {});
}

export function emitNotePinnedUpdated(docId: string, pinned: boolean) {
  emit("note-pinned-updated", {
    sourceWindow: WINDOW_LABEL, docId, pinned,
  } satisfies NotePinnedUpdatedPayload).catch(() => {});
}

export function emitNoteColorUpdated(docId: string, color: NoteColorId | null) {
  emit("note-color-updated", {
    sourceWindow: WINDOW_LABEL, docId, color,
  } satisfies NoteColorUpdatedPayload).catch(() => {});
}

// Newest membership stamp this window has seen per note — its own emitted
// moves plus every peer op it recorded. `noteIds` carries no clock in the
// store (membership clocks live in note sidecars), so the event channel keeps
// its own, mirroring lastBodyAtByDoc.
const lastMembershipAtByNote = new Map<string, number>();
// Group ids retired this session, by a local delete or a peer removal. Group
// ids are never reused, so membership here can never block a new group; the
// set is the event-channel analogue of "deletedAt is never un-set" and stops
// a late out-of-order upsert from resurrecting a deleted group.
const retiredGroupIds = new Set<string>();

/** Group ids retired this session — deleted locally or via a peer delta. The
 *  watcher's disk reload must refuse to resurrect them too: a peer's delete
 *  reaches this window as a `groups-updated` delta before the peer's tombstone
 *  reaches `.groups.json`, and a reload in that gap would re-insert the group
 *  from the still-alive disk entry, bypassing the receiver's guard. */
export function getRetiredGroupIds(): ReadonlySet<string> {
  return retiredGroupIds;
}

/** Clears the group sync clocks. Exists so tests start from a known state. */
export function resetGroupSyncClocks() {
  lastMembershipAtByNote.clear();
  retiredGroupIds.clear();
}

export function emitGroupsDelta(delta: GroupsDelta) {
  const { upserted, removedIds, membership } = delta;
  if (upserted.length === 0 && removedIds.length === 0 && membership.length === 0) return;
  // Self-record like emitDocUpdated: our own change must beat a late peer
  // event, so the clocks advance at emit time, not only on receipt.
  for (const id of removedIds) retiredGroupIds.add(id);
  for (const op of membership) {
    const current = lastMembershipAtByNote.get(op.noteId) ?? 0;
    if (op.at > current) lastMembershipAtByNote.set(op.noteId, op.at);
  }
  emit("groups-updated", {
    sourceWindow: WINDOW_LABEL, upserted, removedIds, membership,
  } satisfies GroupsUpdatedPayload).catch(() => {});
}

export function emitTrashUpdated(change: { added?: TrashedNote[]; removed?: TrashRemoval[] }) {
  const added = change.added ?? [];
  const removed = change.removed ?? [];
  if (added.length === 0 && removed.length === 0) return;
  emit("trash-updated", {
    sourceWindow: WINDOW_LABEL, added, removed,
  } satisfies TrashUpdatedPayload).catch(() => {});
}

export function useWindowSync(
  commitRemote: (update: LibraryUpdater) => LibrarySnapshot | null,
  activeDocId: string | null,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  onActiveDocChanged?: (doc: { filePath: string; content: string }) => void,
  notesSortOrder: NotesSortOrder = "updated-desc",
  locale: Locale = "en",
  settleRemoteDeletedDoc?: (docId: string) => Promise<boolean>,
) {
  const activeDocIdRef = useRef(activeDocId);
  activeDocIdRef.current = activeDocId;
  const onActiveDocChangedRef = useRef(onActiveDocChanged);
  onActiveDocChangedRef.current = onActiveDocChanged;
  const getRoutedActiveDocId = useCallback(() => {
    const editorDocId = tiptapRef.current?.getEditor?.()?.storage.documentContext.noteId ?? null;
    return editorDocId ?? activeDocIdRef.current;
  }, [tiptapRef]);
  const showInEditor = useCallback((doc: NoteDoc) => {
    tiptapRef.current?.openDocument?.({
      noteId: doc.id,
      filePath: doc.filePath,
      markdown: doc.content,
      reason: "window-sync",
    });
    onActiveDocChangedRef.current?.({ filePath: doc.filePath, content: doc.content });
  }, [tiptapRef]);

  const applyRemoteBody = useCallback((docId: string, content: string, updatedAt: number) => {
    const committed = commitRemote((current) => {
      const idx = current.docs.findIndex((d) => d.id === docId);
      if (idx < 0) return null;
      // Mirror useFileWatcher's guard: a locally-dirty doc means the
      // user is actively editing here, so refuse to overwrite content
      // and keep the dirty flag. Last-write-wins on the disk side
      // (our own autosave) resolves conflicts, not remote events.
      if (current.docs[idx].isDirty) return null;
      const docs = [...current.docs];
      // Titles are sidecar/rename metadata. A delayed body notification
      // must not roll a newer rename back in the receiving window.
      docs[idx] = {
        ...docs[idx],
        content,
        updatedAt: Math.max(docs[idx].updatedAt, updatedAt),
        isDirty: false,
      };
      return { docs };
    });
    if (!committed || docId !== getRoutedActiveDocId()) return;
    const updated = committed.docs.find((d) => d.id === docId);
    if (updated) showInEditor(updated);
  }, [commitRemote, getRoutedActiveDocId, showInEditor]);

  useEffect(() => {
    let mounted = true;
    let unlisteners: (() => void)[] = [];
    const deletingDocIds = new Set<string>();

    Promise.all([
      listen<DocUpdatedPayload>("doc-updated", (event) => {
        const { sourceWindow, docId, content, filePath, updatedAt } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;
        // Event delivery is not ordered across source windows, and a body
        // event can arrive after this window has already saved a newer body.
        if (isStaleBodyEvent(docId, updatedAt)) return;
        // Recorded even when the commit below declines (locally dirty): the
        // body still lost to something newer, and only strictly older events
        // are dropped, so a later peer body still applies.
        noteBodyRevision(docId, updatedAt);

        if (content != null) {
          applyRemoteBody(docId, content, updatedAt);
          return;
        }
        void (async () => {
          let body: string;
          // A failed read leaves the doc as is; the file watcher sees the
          // peer's write too and reloads it.
          try { body = await readTextFile(filePath); } catch { return; }
          // A newer body may have been applied (or saved here) while the read
          // was in flight, and this read may predate that write.
          if (!mounted || isStaleBodyEvent(docId, updatedAt)) return;
          applyRemoteBody(docId, body, updatedAt);
        })();
      }),

      listen<DocRenamedPayload>("doc-renamed", (event) => {
        const { sourceWindow, docId, newFilePath, newFileName } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        commitRemote((current) => {
          const idx = current.docs.findIndex((d) => d.id === docId);
          if (idx < 0) return null;
          const docs = [...current.docs];
          docs[idx] = { ...docs[idx], filePath: newFilePath, fileName: newFileName };
          return { docs };
        });
      }),

      listen<DocDeletedPayload>("doc-deleted", (event) => {
        const { sourceWindow, docId } = event.payload;
        if (sourceWindow === WINDOW_LABEL || deletingDocIds.has(docId)) return;
        deletingDocIds.add(docId);
        forgetDocBodyClock(docId);

        void (async () => {
          try {
            // settleRemoteDeletedDoc captures and quarantines the local body
            // synchronously before its promise reaches the first await. Remove
            // the live editor immediately afterwards so the user cannot keep
            // typing into a document whose deletion already committed.
            let settlement: Promise<boolean> | null = null;
            if (settleRemoteDeletedDoc) {
              try { settlement = settleRemoteDeletedDoc(docId); } catch { /* deletion remains authoritative */ }
            }

            // Active identity is stored by id, so removing a doc before the
            // active one needs no index shuffling; only a deleted active doc
            // hands off to its neighbour, in the same commit as the removal.
            let deletedActiveDoc = false;
            const committed = commitRemote((current) => {
              const idx = current.docs.findIndex((d) => d.id === docId);
              if (idx < 0) return null;
              const docs = current.docs.filter((d) => d.id !== docId);
              deletedActiveDoc = current.activeNoteId === docId || getRoutedActiveDocId() === docId;
              if (!deletedActiveDoc) return { docs };
              return { docs, activeNoteId: docs[Math.min(idx, docs.length - 1)]?.id ?? null };
            });
            if (committed && deletedActiveDoc && committed.activeNoteId) {
              const next = committed.docs.find((d) => d.id === committed.activeNoteId);
              if (next) showInEditor(next);
            }
            // Preservation is best-effort and is also tracked by the autosave
            // close/migration drain. The originating window already committed
            // the delete, so failure must not put the document back in state.
            if (settlement) {
              try { await settlement; } catch { /* deletion remains authoritative */ }
            }
          } finally {
            deletingDocIds.delete(docId);
          }
        })();
      }),

      listen<DocCreatedPayload>("doc-created", (event) => {
        const { sourceWindow, doc } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        // Deletion and creation are separate Tauri events, so the replacement
        // may arrive after the peer has already removed its last document.
        let shouldActivate = false;
        const committed = commitRemote((current) => {
          if (current.docs.some((d) => d.id === doc.id || d.filePath === doc.filePath)) return null;
          shouldActivate = current.docs.length === 0;
          const docs = [...current.docs, { ...doc, isDirty: false }];
          return shouldActivate ? { docs, activeNoteId: doc.id } : { docs };
        });
        // The peer emits this only after provisionNoteFile's fail-closed write
        // succeeded, so `doc.content` is what is on disk. Recording it as the
        // conflict baseline keeps a peer-created note behaving like a locally
        // created one: no spurious .conflicts copy on its first save here, and
        // the empty-note prunes can still clean it up.
        if (committed && doc.filePath) setKnownDiskContent(doc.filePath, doc.content);
        if (committed && shouldActivate) showInEditor({ ...doc, isDirty: false });
      }),

      listen<NotePinnedUpdatedPayload>("note-pinned-updated", (event) => {
        const { sourceWindow, docId, pinned } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        commitRemote((current) => {
          const idx = current.docs.findIndex((d) => d.id === docId);
          if (idx < 0) return null;
          const docs = [...current.docs];
          docs[idx] = { ...docs[idx], pinned };
          return { docs: sortNotes(docs, notesSortOrder, locale) };
        });
      }),

      listen<NoteColorUpdatedPayload>("note-color-updated", (event) => {
        const { sourceWindow, docId, color } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        commitRemote((current) => {
          const idx = current.docs.findIndex((d) => d.id === docId);
          if (idx < 0 || current.docs[idx].color === (color ?? undefined)) return null;
          const docs = [...current.docs];
          docs[idx] = { ...docs[idx], color: color ?? undefined };
          return { docs };
        });
      }),

      listen<GroupsUpdatedPayload>("groups-updated", (event) => {
        const { sourceWindow, upserted, removedIds, membership } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        // Record removals and membership clocks BEFORE the commit (mirroring
        // the doc-updated body clock): even a delta the commit declines must
        // advance the clocks, or a duplicate delivery could apply later.
        for (const id of removedIds) retiredGroupIds.add(id);
        const freshOps = membership.filter((op) => (lastMembershipAtByNote.get(op.noteId) ?? 0) < op.at);
        for (const op of freshOps) lastMembershipAtByNote.set(op.noteId, op.at);

        commitRemote((current) => {
          // No per-entry clone: every merge step below builds new objects for
          // the entries it changes and passes the rest through by reference,
          // so untouched groups keep their store-owned identity — the
          // hydration epoch watcher records a peer touch per entry, and a
          // clone-all base would mark EVERY group touched and make the
          // hydration rebase keep stale projections for all of them.
          let groups: NoteGroup[] = [...current.groups] as NoteGroup[];
          let changed = false;
          let orderDirty = false;

          // 1. Removals — delete wins over everything, matching the disk rule
          //    that deletedAt is never un-set.
          if (removedIds.length > 0 && groups.some((g) => removedIds.includes(g.id))) {
            groups = groups.filter((g) => !removedIds.includes(g.id));
            changed = true;
          }

          // 2. Upserts — per-field clocks, exactly mergeGroupEntries' rules.
          //    `collapsed` is per-machine ui-state and never crosses windows.
          for (const u of upserted) {
            if (retiredGroupIds.has(u.id)) continue;
            const idx = groups.findIndex((g) => g.id === u.id);
            if (idx < 0) {
              groups = [...groups, { ...u, noteIds: [], collapsed: false }];
              changed = true;
              orderDirty = true;
              continue;
            }
            const local = groups[idx];
            let next = local;
            if ((u.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
              next = { ...next, name: u.name, updatedAt: u.updatedAt };
            }
            if ((u.orderUpdatedAt ?? 0) > (local.orderUpdatedAt ?? 0)) {
              next = { ...next, orderKey: u.orderKey, orderUpdatedAt: u.orderUpdatedAt };
              orderDirty = true;
            }
            if (u.createdAt < next.createdAt) {
              next = { ...next, createdAt: u.createdAt };
              // createdAt is the comparator's tiebreaker, so adopting it can
              // change the group's position too.
              orderDirty = true;
            }
            if (next !== local) {
              groups = groups.map((g, i) => (i === idx ? next : g));
              changed = true;
            }
          }

          // 3. Membership — set semantics: remove everywhere, add-if-absent to
          //    the target. An op whose target group the receiver lacks (deleted
          //    concurrently) degrades to remove-everywhere, matching disk.
          for (const op of freshOps) {
            const applied = groups.map((g) => {
              if (g.id === op.groupId) {
                return g.noteIds.includes(op.noteId) ? g : { ...g, noteIds: [...g.noteIds, op.noteId] };
              }
              return g.noteIds.includes(op.noteId)
                ? { ...g, noteIds: g.noteIds.filter((id) => id !== op.noteId) }
                : g;
            });
            if (applied.some((g, i) => g !== groups[i])) {
              groups = applied;
              changed = true;
            }
          }

          if (!changed) return null;
          // Array order IS the render order (the sidebar iterates the array),
          // so an insert or an adopted orderKey re-sorts with the same
          // comparator buildGroupsFromShared uses on load.
          if (orderDirty) {
            groups = [...groups].sort((a, b) => {
              const ak = a.orderKey ?? "";
              const bk = b.orderKey ?? "";
              if (ak === bk) return a.createdAt - b.createdAt;
              return ak < bk ? -1 : 1;
            });
          }
          return { groups };
        });
        // Keep saveManifest's deletion-detection snapshot aligned with what
        // the other window just observed on disk; otherwise deleting a group
        // here would silently fail to emit a tombstone.
        void getNotesDir().then((dir) => syncGroupsSnapshotFromDisk(dir)).catch(() => {});
      }),

      listen<TrashUpdatedPayload>("trash-updated", (event) => {
        const { sourceWindow, added, removed } = event.payload;
        if (sourceWindow === WINDOW_LABEL) return;

        commitRemote((current) => {
          const removedAt = new Map(removed.map((entry) => [entry.id, entry.trashedAt]));
          const incoming = new Map(added.map((note) => [note.id, note]));
          let changed = false;
          // Re-trashing an entry this window already holds keeps the newer
          // trashedAt, mirroring the local publish rule in deleteNotes.
          const kept: TrashedNote[] = [];
          for (const note of current.trashedNotes) {
            // A removal only retires the incarnation it named. A note restored
            // and trashed again is a NEWER entry, and the late removal of the
            // older one must leave it alone.
            const retiredAt = removedAt.get(note.id);
            if (retiredAt != null && note.trashedAt <= retiredAt) { changed = true; continue; }
            const update = incoming.get(note.id);
            incoming.delete(note.id);
            if (update && update.trashedAt > note.trashedAt) {
              kept.push(update);
              changed = true;
            } else {
              kept.push(note);
            }
          }
          // Entries this window has not seen trashed yet go on the end, where
          // a local trash would have put them.
          for (const note of added) {
            if (!incoming.has(note.id)) continue;
            kept.push(note);
            changed = true;
          }
          return changed ? { trashedNotes: kept } : null;
        });
      }),
    ]).then((fns) => {
      if (!mounted) { fns.forEach((fn) => fn()); return; }
      unlisteners = fns;
    });

    return () => { mounted = false; unlisteners.forEach((fn) => fn()); };
  }, [applyRemoteBody, commitRemote, getRoutedActiveDocId, showInEditor, notesSortOrder, locale, settleRemoteDeletedDoc]);
}
