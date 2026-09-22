import { useCallback, useEffect, useRef } from "react";
import { tauriFileSystem } from "../utils/fs";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";
import { deriveTitle, saveNoteMetadata, sortNotes, getNotesDir, migrationInProgress } from "./useNotesLoader";
import { getCurrentMarkdown, provisionNoteFile } from "./useFileSystem";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { MarkdownState } from "./useMarkdownState";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { emitDocUpdated } from "./useWindowSync";
import { markOwnWrite } from "./ownWriteTracker";
import { backupIfRemoteWroteFirst, backupLocalDeletionVersion, getKnownDiskContent, setKnownDiskContent } from "../utils/conflictBackup";
import { clearRecoveryRecord, writeRecoveryRecord } from "../utils/recoveryJournal";
import { appDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { atomicWriteText } from "../utils/atomicWrite";
import { NotenError } from "../utils/notenError";
import { logNotenError } from "../utils/crashLog";
import { markdownEqual } from "../utils/markdownEqual";
import { normalizeSep } from "../utils/pathUtils";
import { libraryStore } from "../utils/libraryStore";
import { isNoteLifecycleBlocked } from "./noteLifecycleGate";

const DEBOUNCE_MS = 1000;
// Failed provisioning of a pathless doc retries on later edits, but at most
// this often — a dead notes dir would otherwise log SAVE_FAILED per keystroke.
const PROVISION_RETRY_MS = 5000;

/**
 * Outcome of a flushAutoSave call. Explicit because "did the flush leave the
 * caller's docs snapshot safe to mark clean" and "is the content on disk" are
 * different questions, and a single boolean could only answer one of them:
 * a provision writes the body but also changes the doc's filePath, which the
 * caller's pre-flush snapshot does not have.
 */
export type FlushResult =
  /** A pending/dirty snapshot was written. */
  | { status: "saved" }
  /** The active doc had no filePath; it was provisioned and its body written. */
  | { status: "provisioned"; filePath: string }
  /** Nothing was pending and the editor was not dirty. */
  | { status: "clean" }
  /** Nothing reached disk; the doc stays dirty and will retry. */
  | { status: "failed"; reason: "save-failed" | "provision-failed" | "unavailable" };

/** True when the caller's pre-flush docs snapshot may be marked clean. */
export function flushLeftDocClean(result: FlushResult): boolean {
  return result.status === "saved" || result.status === "clean";
}

// The recovery journal mirrors pendingSnapshotsRef — the app's own record of
// edits that are not yet durable in the notes folder. Records are written at
// the points where the process may be about to end rather than before every
// save; see recoveryJournal.ts for why that is enough.
// Both resolved lazily: touching Tauri at module scope would make this file
// unimportable anywhere the window API is not mocked, which is every test that
// only wants the save logic.
let windowLabel: string | null = null;
function getWindowLabel(): string {
  if (windowLabel === null) windowLabel = getCurrentWindow().label;
  return windowLabel;
}
let appDataDirPromise: Promise<string> | null = null;
function getAppDataDir(): Promise<string> {
  // Drop a rejected promise rather than memoizing it: caching one transient
  // failure would disable journalling for the rest of the window's life.
  if (!appDataDirPromise) {
    appDataDirPromise = appDataDir().catch((err) => {
      appDataDirPromise = null;
      throw err;
    });
  }
  return appDataDirPromise;
}

interface SaveSnapshot {
  docId: string;
  filePath: string;
  content: string;
  editSerial: number;
  revision: number;
}

interface PendingSaveTarget {
  docId: string;
  filePath: string;
  editSerial: number;
}

interface RemoteDeletionTombstone {
  // The `docs` entry that was live when the deletion arrived, or null when this
  // window never held the note.
  deletedDoc: NoteDoc | null;
  // Set once `docs` has actually been observed without the id, i.e. the removal
  // this tombstone describes really landed in local state.
  removalObserved: boolean;
}

// A remote deletion tombstone blocks every write path for the deleted id — but
// only for as long as that id stays deleted. `restoreNote` reuses the original
// id and re-broadcasts it via `emitDocCreated`, and a watcher reconcile can
// rediscover the restored body on its own, so a session-lifetime tombstone
// would leave a restored note permanently unsaveable: markActiveDocEdited
// refuses to arm a timer while the dirty indicator still lights up, and the
// close-time flush captures no snapshot, so the edits vanish when the window
// closes. Any entry under that id which is not the object the deletion removed
// (or any entry at all, once the removal has been observed) is the restored
// note, so the tombstone is lifted for it.
function syncRemoteDeletionTombstones(
  tombstones: Map<string, RemoteDeletionTombstone>,
  docs: NoteDoc[],
): void {
  if (tombstones.size === 0) return;
  for (const [docId, tombstone] of tombstones) {
    const live = docs.find((doc) => doc.id === docId) ?? null;
    if (live === null) {
      tombstone.removalObserved = true;
    } else if (tombstone.removalObserved || live !== tombstone.deletedDoc) {
      tombstones.delete(docId);
    }
  }
}

export function useAutoSave(
  state: MarkdownState,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  docs: NoteDoc[],
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  activeIndex: number,
  locale: Locale,
  notesSortOrder: NotesSortOrder,
  groups: NoteGroup[],
) {
  // Save lifecycle per doc: edit → pendingTargetsRef (debounced 1s) → snapshot captured into pendingSnapshotsRef → doSave promise tracked in inFlightSavesRef → cleared on success, kept (no timer) on failure so flushPendingSnapshots can retry at close.
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingTargetsRef = useRef(new Map<string, PendingSaveTarget>());
  const pendingSnapshotsRef = useRef(new Map<string, SaveSnapshot>());
  const latestEditSerialByDocRef = useRef(new Map<string, number>());
  const latestRevisionByDocRef = useRef(new Map<string, number>());
  const hasPendingChangesRef = useRef(false);
  // Tracks every doSave promise still in flight. flushAutoSave awaits the full
  // set so callers (window close, notes-dir migration) never quit before a
  // background save lands. Without this the new fire-and-forget switch path
  // could drop a save if the user closed mid-write.
  // Only ever awaited for settlement, never for a value: body saves resolve to
  // a boolean and provisions to the adopted path.
  const inFlightSavesRef = useRef(new Set<Promise<unknown>>());
  const inFlightSavesByDocRef = useRef(new Map<string, Set<Promise<unknown>>>());
  const inFlightSnapshotsByDocRef = useRef(new Map<string, Set<SaveSnapshot>>());
  // A remote delete tombstones the id: no later editor update or stale callback
  // may create another write for it. Lifted only when the id comes back as a
  // restored document — see syncRemoteDeletionTombstones.
  const remoteDeletedDocsRef = useRef(new Map<string, RemoteDeletionTombstone>());
  // Remote-deletion preservation continues after the document is removed from
  // React state. Close/migration drains must still wait for its trash/conflict
  // write to finish.
  const remoteDeletionSettlementsRef = useRef(new Set<Promise<boolean>>());
  // Per-doc serialization tail for the body-write critical section inside
  // doSave. Each save's write is chained after the previous write of the SAME
  // doc, so two never touch `${path}.tmp` concurrently and clobber each other
  // (the 1s autosave can still be mid-write on a slow cloud folder when a
  // doc-switch queues the next save). Only the write is serialized — backup and
  // manifest stay parallel. Keyed by docId, so different docs stay parallel.
  const saveTailByDocRef = useRef(new Map<string, Promise<unknown>>());
  const stateRef = useRef({
    state,
    tiptapRef,
    docs,
    activeIndex,
    locale,
    notesSortOrder,
    setDocs,
    groups,
  });
  stateRef.current = {
    state,
    tiptapRef,
    docs,
    activeIndex,
    locale,
    notesSortOrder,
    setDocs,
    groups,
  };

  // Reconcile tombstones during render, not in an effect: useWindowSync removes
  // the deleted doc inside flushSync, so this render is the one that observes
  // the removal, and every editor callback that consults a tombstone runs after
  // the render that committed a restore.
  syncRemoteDeletionTombstones(remoteDeletedDocsRef.current, docs);

  // Synchronous active-doc ref prevents wrong-doc saves during rapid switches.
  const activeDocRef = useRef<{ id: string; filePath: string } | null>(null);
  const activeTarget = docs[activeIndex];
  if (activeTarget) {
    activeDocRef.current = { id: activeTarget.id, filePath: activeTarget.filePath };
  }

  const refreshHasPendingChanges = useCallback(() => {
    hasPendingChangesRef.current = pendingTargetsRef.current.size > 0 || pendingSnapshotsRef.current.size > 0;
  }, []);

  const markActiveDocEdited = useCallback((): PendingSaveTarget | null => {
    const target = activeDocRef.current;
    if (!target?.filePath) return null;
    if (remoteDeletedDocsRef.current.has(target.id)) return null;

    const editSerial = (latestEditSerialByDocRef.current.get(target.id) ?? 0) + 1;
    latestEditSerialByDocRef.current.set(target.id, editSerial);

    const pending = {
      docId: target.id,
      filePath: target.filePath,
      editSerial,
    };
    pendingTargetsRef.current.set(target.id, pending);
    refreshHasPendingChanges();
    return pending;
  }, [refreshHasPendingChanges]);

  const createSnapshot = useCallback((pendingTarget?: PendingSaveTarget): SaveSnapshot | null => {
    const {
      state: latestState,
      tiptapRef: latestEditorRef,
    } = stateRef.current;

    const target = pendingTarget ?? activeDocRef.current;
    if (!target?.filePath) return null;
    const docId = "docId" in target ? target.docId : target.id;
    if (remoteDeletedDocsRef.current.has(docId)) return null;
    if (activeDocRef.current?.id !== docId) {
      return null;
    }

    const content = getCurrentMarkdown(latestEditorRef);
    latestState.primeMarkdown(content);
    const filePath = target.filePath;
    const editSerial = "editSerial" in target
      ? target.editSerial
      : latestEditSerialByDocRef.current.get(docId) ?? 0;
    const revision = (latestRevisionByDocRef.current.get(docId) ?? 0) + 1;
    latestRevisionByDocRef.current.set(docId, revision);

    return {
      docId,
      filePath,
      content,
      editSerial,
      revision,
    };
  }, []);

  const clearPendingSnapshotIfCurrent = useCallback((snapshot: SaveSnapshot) => {
    const current = pendingSnapshotsRef.current.get(snapshot.docId);
    if (current?.revision !== snapshot.revision) return;
    pendingSnapshotsRef.current.delete(snapshot.docId);
    // The edit is durable, so drop any recovery record for it. Fire and
    // forget: a record left behind costs one extra check at the next startup,
    // where recovery finds the disk body already equal to the record and
    // deletes it. Blocking the save path on this I/O would buy nothing.
    void (async () => {
      try {
        await clearRecoveryRecord(tauriFileSystem, await getAppDataDir(), getWindowLabel(), snapshot.docId);
      } catch { /* best-effort */ }
    })();
    const pendingTarget = pendingTargetsRef.current.get(snapshot.docId);
    if (pendingTarget && pendingTarget.editSerial <= snapshot.editSerial) {
      pendingTargetsRef.current.delete(snapshot.docId);
    }
    refreshHasPendingChanges();
  }, [refreshHasPendingChanges]);

  /**
   * Record every edit that is not yet durable, so it survives the process.
   *
   * Called where the process may be about to end — a failed save, focus loss,
   * the close drain, an update install — rather than before every save. The
   * body write is fail-closed temp+rename, so a crash mid-write leaves the
   * previous body intact and costs at most the last debounce window of typing;
   * what actually went missing before this existed was an edit that stayed in
   * memory after its save failed.
   *
   * Returns whether every pending edit is now recorded. A caller that is about
   * to let the process die (the close gate) must treat false as "these edits
   * still live only in memory".
   */
  /** Record one snapshot. Used by the failure path, which must not rewrite
   *  every other pending doc's body on each individual failure — during a
   *  folder outage that is a full atomic write per pending note per second. */
  const journalSnapshot = useCallback(async (snapshot: SaveSnapshot): Promise<boolean> => {
    try {
      await writeRecoveryRecord(tauriFileSystem, await getAppDataDir(), getWindowLabel(), {
        version: 1,
        docId: snapshot.docId,
        filePath: snapshot.filePath,
        content: snapshot.content,
        baseContent: getKnownDiskContent(snapshot.filePath) ?? null,
        editSerial: snapshot.editSerial,
        updatedAt: Date.now(),
      });
      return true;
    } catch (err) {
      void logNotenError(new NotenError(
        "SAVE_FAILED",
        "fatal",
        "journalSnapshot: could not record an unsaved edit for recovery",
        { context: { noteId: snapshot.docId, filePath: snapshot.filePath }, cause: err },
      ));
      return false;
    }
  }, []);

  const journalPendingEdits = useCallback(async (): Promise<boolean> => {
    const pending = Array.from(pendingSnapshotsRef.current.values());
    // A pending TARGET newer than its snapshot has content this function
    // cannot see — its text is still only in the editor. Callers flush first,
    // which converts the active doc's target into a snapshot; anything still
    // ahead of its snapshot here is an edit we cannot protect, and saying
    // otherwise would let the close gate wave it through. Comparing by id
    // alone missed the common case: typing during the awaited close drain
    // leaves a target newer than the snapshot the drain already captured.
    const uncovered = Array.from(pendingTargetsRef.current.values()).some((target) => {
      const snapshot = pendingSnapshotsRef.current.get(target.docId);
      return !snapshot || target.editSerial > snapshot.editSerial;
    });
    let allRecorded = true;
    for (const snapshot of pending) {
      if (!(await journalSnapshot(snapshot))) allRecorded = false;
    }
    return allRecorded && !uncovered;
  }, [journalSnapshot]);

  const discardPendingTarget = useCallback((docId: string) => {
    pendingTargetsRef.current.delete(docId);
    refreshHasPendingChanges();
  }, [refreshHasPendingChanges]);

  const snapshotIsCurrent = useCallback((snapshot: SaveSnapshot) => (
    (latestRevisionByDocRef.current.get(snapshot.docId) ?? 0) === snapshot.revision
    && (latestEditSerialByDocRef.current.get(snapshot.docId) ?? 0) === snapshot.editSerial
  ), []);

  const hasPendingForDoc = useCallback((docId: string) => (
    pendingTargetsRef.current.has(docId)
    || pendingSnapshotsRef.current.has(docId)
  ), []);

  const doSave = useCallback(async (snapshot: SaveSnapshot): Promise<boolean> => {
    // Snapshots captured before a notes-dir migration point at stale paths.
    if (migrationInProgress) return false;
    if (remoteDeletedDocsRef.current.has(snapshot.docId)) return false;
    if (isNoteLifecycleBlocked(snapshot.docId)) return false;

    const {
      locale: latestLocale,
      notesSortOrder: latestSortOrder,
      setDocs: latestSetDocs,
    } = stateRef.current;

    try {
      try {
        const dir = await getNotesDir();
        await backupIfRemoteWroteFirst(tauriFileSystem, dir, snapshot.filePath, snapshot.docId, snapshot.content);
      } catch (err) {
        // The pre-save safety net (.conflicts/ backup of a possibly-newer
        // remote body) could not run. Overwriting now risks remote data loss
        // with no recovery, so defer this save — the doc stays dirty, the
        // next autosave debounce retries, and a transient cloud-sync failure
        // self-heals. A permanent failure repeatedly logs and surfaces via
        // the dirty indicator instead of silently corrupting on disk.
        void logNotenError(err instanceof NotenError
          ? err
          : new NotenError(
              "BACKUP_FAILED",
              "fatal",
              err instanceof Error ? err.message : String(err),
              {
                context: { noteId: snapshot.docId, filePath: snapshot.filePath },
                cause: err,
              },
            ));
        return false;
      }

      // Backup can stall for seconds on cloud-sync placeholder hydration. If
      // the user deletes the note in that window, writing now would resurrect
      // the file at its old path right after deleteNote moved it to .trash,
      // leaving a ghost the next reconcile has to clean up. The post-write
      // savedDocStillExists check below still guards the metadata commit, but
      // skipping the write itself avoids the wasted I/O and the ghost file.
      if (!stateRef.current.docs.some((d) => d.id === snapshot.docId)) {
        return false;
      }

      if (!snapshotIsCurrent(snapshot)) {
        return false;
      }

      // Serialize the body write per-doc. Two overlapping saves for the same
      // doc (e.g. a slow cloud-sync write still in flight when a doc-switch
      // queues the next save) would otherwise both write `${path}.tmp` at once
      // and clobber each other — the snapshot revision guards above bracket the
      // write but don't make it mutually exclusive. Only the write itself is
      // serialized; backup (above) and the metadata commit (below) stay outside
      // the lock so a slow remote-backup on an older save can't hold up a newer
      // one. Re-check the revision INSIDE the lock so a save superseded while it
      // waited bails without writing, leaving only the newest content on disk.
      const performBodyWrite = async (): Promise<boolean> => {
        if (remoteDeletedDocsRef.current.has(snapshot.docId)) return false;
        if (isNoteLifecycleBlocked(snapshot.docId)) return false;
        if (!snapshotIsCurrent(snapshot)) return false;
        markOwnWrite(snapshot.filePath, snapshot.content);
        // The body .md is the single source of truth: a crash or cloud-sync/AV
        // interruption mid-write must never leave it truncated, so route through
        // temp+rename. The root watcher ignores `.md.tmp` (endsWith(".md")
        // filter) and the rename lands on the marked own-write path. failClosed
        // so a locked rename throws (→ caught below, doc stays dirty, retried)
        // instead of degrading to a truncation-prone direct overwrite.
        await atomicWriteText(tauriFileSystem, snapshot.filePath, snapshot.content, { failClosed: true });
        setKnownDiskContent(snapshot.filePath, snapshot.content);
        return true;
      };
      const priorWrite = saveTailByDocRef.current.get(snapshot.docId) ?? Promise.resolve();
      // Chain whether the prior write resolved or rejected, so one doc's failed
      // write can't poison the queue for its later saves.
      const thisWrite = priorWrite.then(performBodyWrite, performBodyWrite);
      saveTailByDocRef.current.set(snapshot.docId, thisWrite);
      // Settle-cleanup via then(cb, cb) — NOT .finally — so a rejected write
      // (failClosed throw) doesn't surface as an unhandled rejection on this
      // side branch. The rejection is still handled by the `await thisWrite`
      // below (and the next save's then-onRejected).
      const cleanupTail = () => {
        if (saveTailByDocRef.current.get(snapshot.docId) === thisWrite) {
          saveTailByDocRef.current.delete(snapshot.docId);
        }
      };
      void thisWrite.then(cleanupTail, cleanupTail);
      const wroteBody = await thisWrite;
      if (!wroteBody) {
        return false;
      }

      if (!snapshotIsCurrent(snapshot)) {
        return false;
      }

      const live = stateRef.current;
      // Prefer the synchronous activeDocRef over stateRef.current.docs/
      // activeIndex: when a fast-path switchDocument has already called
      // notifyActiveDoc but React hasn't committed the corresponding setDocs/
      // setActiveIndex yet, stateRef still reflects the leaving doc. Using the
      // stale id would let a post-switch background save flip isDirty on the
      // wrong doc.
      const currentActiveId = activeDocRef.current?.id
        ?? live.docs[live.activeIndex]?.id
        ?? null;
      const activeDocStillMatches = currentActiveId === snapshot.docId
        ? live.state.getCachedMarkdown() === snapshot.content
        : false;

      const savedAt = Date.now();
      const canonicalAtEnqueue = libraryStore.getSnapshot();
      const liveDoc = canonicalAtEnqueue.docs.find((docEntry) => docEntry.id === snapshot.docId)
        ?? live.docs.find((docEntry) => docEntry.id === snapshot.docId);
      if (!liveDoc) return false;
      const autoTitle = liveDoc.customName
        ? liveDoc.fileName
        : deriveTitle(snapshot.content) || liveDoc.fileName || getDefaultDocumentTitle(
          latestLocale,
          canonicalAtEnqueue.docs.map((docEntry) => docEntry.fileName),
        );
      const candidate: NoteDoc = {
        ...liveDoc,
        content: snapshot.content,
        isDirty: currentActiveId === snapshot.docId ? !activeDocStillMatches : false,
        updatedAt: savedAt,
        fileName: autoTitle,
      };
      const fallbackGroupId = live.groups.find(
        (group) => group.noteIds.includes(snapshot.docId),
      )?.id ?? null;
      let persistedBase: NoteDoc | null = null;
      const publishPersistedMetadata = (
        effective: NonNullable<Awaited<ReturnType<typeof saveNoteMetadata>>>,
        executionBase: NoteDoc,
        changedDuringWrite: { title: boolean; pinned: boolean; color: boolean },
      ) => {
        persistedBase = executionBase;
        latestSetDocs((prev) => {
          let found = false;
          let changed = false;
          const next = prev.map((docEntry) => {
            if (docEntry.id !== snapshot.docId) return docEntry;
            found = true;
            const titleUnchanged = (
              docEntry.fileName === executionBase.fileName
              && !!docEntry.customName === !!executionBase.customName
            ) && !changedDuringWrite.title;
            const createdAtUnchanged = docEntry.createdAt === executionBase.createdAt;
            const pinUnchanged = (docEntry.pinned === true) === (executionBase.pinned === true)
              && !changedDuringWrite.pinned;
            const colorUnchanged = docEntry.color === executionBase.color
              && !changedDuringWrite.color;
            const contentUnchanged = docEntry.content === executionBase.content;
            const merged = {
              ...docEntry,
              content: contentUnchanged ? snapshot.content : docEntry.content,
              fileName: titleUnchanged ? effective.fileName : docEntry.fileName,
              customName: titleUnchanged
                ? effective.customName || undefined
                : docEntry.customName,
              createdAt: createdAtUnchanged ? effective.createdAt : docEntry.createdAt,
              updatedAt: Math.max(docEntry.updatedAt, effective.updatedAt),
              pinned: pinUnchanged
                ? effective.pinned === true ? true : undefined
                : docEntry.pinned,
              color: colorUnchanged ? effective.color : docEntry.color,
            };
            changed = changed
              || merged.content !== docEntry.content
              || merged.fileName !== docEntry.fileName
              || merged.customName !== docEntry.customName
              || merged.createdAt !== docEntry.createdAt
              || merged.updatedAt !== docEntry.updatedAt
              || merged.pinned !== docEntry.pinned
              || merged.color !== docEntry.color;
            return merged;
          });
          return found && changed ? next : prev;
        });
      };
      let persisted: Awaited<ReturnType<typeof saveNoteMetadata>>;
      try {
        // A body autosave changes only this note's title/timestamps. Persisting
        // the entire pre-commit docs array here let an unrelated concurrent
        // delete be replayed as live metadata.
        persisted = await saveNoteMetadata(
          candidate,
          fallbackGroupId,
          "autosave",
          publishPersistedMetadata,
        );
      } catch {
        return false;
      }
      if (!persisted || !snapshotIsCurrent(snapshot)) return false;

      const commitState = stateRef.current;
      if (!commitState.docs.some((docEntry) => docEntry.id === snapshot.docId)) return false;
      const commitActiveId = activeDocRef.current?.id
        ?? commitState.docs[commitState.activeIndex]?.id
        ?? null;
      const editorStillMatches = commitActiveId === snapshot.docId
        ? commitState.state.getCachedMarkdown() === snapshot.content
        : false;

      // Builds the post-save docs array from any base. Returns null when the
      // saved doc is absent from that base (concurrently deleted).
      const buildCommit = (base: NoteDoc[]): NoteDoc[] | null => {
        const mergeBase = persistedBase ?? liveDoc;
        let found = false;
        const mapped = base.map((docEntry) => {
          if (docEntry.id !== snapshot.docId) return docEntry;
          found = true;
          if (persistedBase) {
            return {
              ...docEntry,
              isDirty: commitActiveId === snapshot.docId ? !editorStillMatches : false,
            };
          }
          // Metadata actions can commit while the writer above is awaiting
          // disk. Adopt its merged disk value only when that field is still at
          // the execution-time canonical base; otherwise `prev` is the newer
          // local intent and must win.
          const titleUnchanged = docEntry.fileName === mergeBase.fileName
            && !!docEntry.customName === !!mergeBase.customName;
          const pinUnchanged = (docEntry.pinned === true) === (mergeBase.pinned === true);
          const colorUnchanged = docEntry.color === mergeBase.color;
          const contentUnchanged = docEntry.content === mergeBase.content;
          return {
            ...docEntry,
            content: contentUnchanged ? snapshot.content : docEntry.content,
            isDirty: commitActiveId === snapshot.docId ? !editorStillMatches : false,
            fileName: titleUnchanged ? persisted.fileName : docEntry.fileName,
            customName: titleUnchanged
              ? persisted.customName || undefined
              : docEntry.customName,
            createdAt: docEntry.createdAt === mergeBase.createdAt
              ? persisted.createdAt
              : docEntry.createdAt,
            updatedAt: Math.max(docEntry.updatedAt, persisted.updatedAt),
            pinned: pinUnchanged
              ? persisted.pinned === true ? true : undefined
              : docEntry.pinned,
            color: colorUnchanged ? persisted.color : docEntry.color,
          };
        });
        return found ? sortNotes(mapped, latestSortOrder, latestLocale) : null;
      };

      // Commit functionally, recomputing against `prev`. An absolute
      // docs array built from stateRef could resurrect a doc
      // a concurrent deleteNotes just removed — its setDocs may not have
      // rendered into stateRef yet, so the stale array still contains the
      // deleted entry (a ghost row whose file already moved to .trash). If the
      // saved doc itself vanished from `prev`, leave `prev` untouched.
      //
      // Do NOT touch the active index here. Active identity is an id in
      // libraryStore, so it survives the re-sort on its own and the store
      // adapter re-derives React's activeIndex from the committed array. A
      // nested setActiveIndex would resolve its index against the PRE-commit
      // docs (the store commits only after this updater returns), so an index
      // computed on the re-sorted array pointed at whichever note previously
      // occupied that slot — repointing activeDocRef and every following
      // keystroke at the wrong file.
      latestSetDocs((prev) => buildCommit(prev) ?? prev);
      emitDocUpdated(snapshot.docId, snapshot.filePath, snapshot.content, persisted.updatedAt);

      if (editorStillMatches) {
        commitState.state.setIsDirty(false);
      }
      return true;
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[SAVE_FAILED]", err);
      void logNotenError(new NotenError(
        "SAVE_FAILED",
        "fatal",
        err instanceof Error ? err.message : String(err),
        {
          context: { noteId: snapshot.docId, filePath: snapshot.filePath, revision: snapshot.revision },
          cause: err,
        },
      ));
      return false;
    }
  }, []);

  // Wrap a doSave call so the promise lives in inFlightSavesRef until it
  // settles. Returned promise still rejects/resolves identically.
  const trackInFlight = useCallback((snapshot: SaveSnapshot, p: Promise<boolean>): Promise<boolean> => {
    const docId = snapshot.docId;
    inFlightSavesRef.current.add(p);
    let docSaves = inFlightSavesByDocRef.current.get(docId);
    if (!docSaves) {
      docSaves = new Set();
      inFlightSavesByDocRef.current.set(docId, docSaves);
    }
    docSaves.add(p);
    let docSnapshots = inFlightSnapshotsByDocRef.current.get(docId);
    if (!docSnapshots) {
      docSnapshots = new Set();
      inFlightSnapshotsByDocRef.current.set(docId, docSnapshots);
    }
    docSnapshots.add(snapshot);
    const cleanup = () => {
      inFlightSavesRef.current.delete(p);
      const currentDocSaves = inFlightSavesByDocRef.current.get(docId);
      currentDocSaves?.delete(p);
      if (currentDocSaves?.size === 0) {
        inFlightSavesByDocRef.current.delete(docId);
      }
      const currentSnapshots = inFlightSnapshotsByDocRef.current.get(docId);
      currentSnapshots?.delete(snapshot);
      if (currentSnapshots?.size === 0) {
        inFlightSnapshotsByDocRef.current.delete(docId);
      }
    };
    void p.then(cleanup, cleanup);
    return p;
  }, []);

  // Shared "register pending + track + reconcile" tail used by flushAutoSave,
  // captureAndQueueSave, and the scheduleAutoSave timer callback. Side effects:
  // sets pendingSnapshotsRef, marks hasPendingChangesRef, registers the doSave
  // in the in-flight set, clears the pending entry on success, and refreshes
  // the pending flag on failure.
  const startBackgroundSave = useCallback((snapshot: SaveSnapshot): Promise<boolean> => {
    pendingSnapshotsRef.current.set(snapshot.docId, snapshot);
    hasPendingChangesRef.current = true;
    const save = doSave(snapshot).then((saved) => {
      if (saved) clearPendingSnapshotIfCurrent(snapshot);
      else {
        refreshHasPendingChanges();
        // The edit is still only in memory. Record it now rather than at the
        // next lifecycle point, so a crash between here and then does not take
        // it with it. Only THIS doc: a folder outage fails every pending save,
        // and rewriting them all on each failure is quadratic.
        void journalSnapshot(snapshot);
      }
      return saved;
    });
    return trackInFlight(snapshot, save);
  }, [clearPendingSnapshotIfCurrent, doSave, journalSnapshot, refreshHasPendingChanges, trackInFlight]);

  // A doc without a filePath (the loader-failure fallback stub, or a
  // replacement doc whose provisioning failed in deleteNotes) is invisible to
  // the whole save pipeline: markActiveDocEdited and createSnapshot both bail
  // on it, so nothing ever becomes pending and its edits would be silently
  // discarded at close. Provisioning writes the live editor content to a real
  // `<notesDir>/<id>.md` and adopts the path, after which the normal save
  // machinery applies. Retried on later edits (throttled) because the usual
  // cause — an unreadable notes dir at launch — can recover mid-session.
  // Single-flight per doc; concurrent callers share the same attempt. Resolves
  // to the adopted path so callers report the real one rather than re-reading
  // activeDocRef, which may already point at another doc by then.
  //
  // A caller that joins an in-flight attempt still captures the editor: the
  // attempt wrote the text as it was when it STARTED, and the joining call is
  // typically the doc-switch capture (captureAndQueueSave), i.e. the last look
  // at the editor before it is repointed. Without that capture the text typed
  // during the provision would exist nowhere once the attempt lands its older
  // content into the store, and the doc — now dirty but with a filePath —
  // would pass every close gate. The newest capture is what the attempt
  // commits and, if it differs from what it wrote, what it saves next.
  const provisioningDocsRef = useRef(new Map<string, Promise<string | null>>());
  const provisionAttemptAtRef = useRef(new Map<string, number>());
  const latestPathlessCaptureRef = useRef(new Map<string, string>());
  const provisionPathlessActiveDoc = useCallback((opts?: { force?: boolean }): Promise<string | null> => {
    // Same gate as doSave: never write into a directory that a migration may
    // be about to clear (getNotesDir still resolves to the OLD dir until the
    // migrating window commits the new one).
    if (migrationInProgress) return Promise.resolve(null);
    const target = activeDocRef.current;
    if (!target || target.filePath) return Promise.resolve(null);
    if (remoteDeletedDocsRef.current.has(target.id)) return Promise.resolve(null);
    if (isNoteLifecycleBlocked(target.id)) {
      // The editor can switch away while a delete transaction is awaiting I/O.
      // Preserve a pathless target's live text in canonical memory so a failed
      // lifecycle leaves a dirty, close-gated note instead of losing the edit.
      const { state: latestState, tiptapRef: latestEditorRef, setDocs: latestSetDocs } = stateRef.current;
      const content = getCurrentMarkdown(latestEditorRef);
      latestState.primeMarkdown(content);
      latestSetDocs((prev) => prev.map((doc) => (
        doc.id === target.id && !doc.filePath
          ? { ...doc, content, isDirty: true }
          : doc
      )));
      return Promise.resolve(null);
    }

    const inFlight = provisioningDocsRef.current.get(target.id);
    if (inFlight) {
      const { state: latestState, tiptapRef: latestEditorRef } = stateRef.current;
      const content = getCurrentMarkdown(latestEditorRef);
      latestState.primeMarkdown(content);
      latestPathlessCaptureRef.current.set(target.id, content);
      return inFlight;
    }
    const lastAttemptAt = provisionAttemptAtRef.current.get(target.id) ?? 0;
    if (!opts?.force && Date.now() - lastAttemptAt < PROVISION_RETRY_MS) {
      return Promise.resolve(null);
    }
    provisionAttemptAtRef.current.set(target.id, Date.now());

    // Capture the content synchronously: captureAndQueueSave calls this right
    // before the editor is repointed at another doc.
    const { state: latestState, tiptapRef: latestEditorRef, setDocs: latestSetDocs } = stateRef.current;
    const content = getCurrentMarkdown(latestEditorRef);
    latestState.primeMarkdown(content);

    latestPathlessCaptureRef.current.delete(target.id);
    const attempt = (async () => {
      try {
        const { filePath, ok } = await provisionNoteFile(target.id, content, "autosave-provision-pathless");
        // Text captured by callers that joined this attempt while it was in
        // flight — newer than `content`, and possibly no longer in the editor.
        const takeLatestCapture = () => {
          const latest = latestPathlessCaptureRef.current.get(target.id);
          latestPathlessCaptureRef.current.delete(target.id);
          return latest ?? content;
        };
        if (!ok) {
          // Keep the captured text in React state: the caller may be about to
          // repoint the editor (doc switch), and without this the edits would
          // exist nowhere. The doc stays dirty+pathless, so switching back
          // reloads this content and the next edit retries provisioning.
          const stash = takeLatestCapture();
          latestSetDocs((prev) => prev.map((doc) =>
            doc.id === target.id && !doc.filePath && doc.content !== stash ? { ...doc, content: stash } : doc,
          ));
          return null;
        }
        // Re-check the tombstone after the awaits: a remote deletion that
        // arrived while the provision was in flight must win — leaving this
        // write on disk would let the watcher reconcile resurrect the deleted
        // note. Mirrors the re-check doSave does inside its write section.
        if (remoteDeletedDocsRef.current.has(target.id) || isNoteLifecycleBlocked(target.id)) {
          latestPathlessCaptureRef.current.delete(target.id);
          markOwnWrite(filePath);
          await tauriFileSystem.remove(filePath).catch(() => {});
          return null;
        }
        // Adopt the path in the synchronous ref first so the very next edit
        // (or a flush retry in the same task) arms a normal pending save
        // without waiting for a re-render.
        if (activeDocRef.current?.id === target.id && !activeDocRef.current.filePath) {
          activeDocRef.current = { id: target.id, filePath };
          latestState.setFilePath(filePath);
        }
        const newest = takeLatestCapture();
        latestSetDocs((prev) => prev.map((doc) =>
          doc.id === target.id && !doc.filePath ? { ...doc, filePath, content: newest } : doc,
        ));
        if (newest !== content) {
          // The file holds the older text. Save the newer capture through the
          // normal pipeline before resolving, so a `provisioned` result means
          // the newest text is on disk or, if that write failed, tracked as a
          // pending snapshot the close-time drain retries. createSnapshot
          // cannot be used here because the doc may no longer be active.
          const editSerial = (latestEditSerialByDocRef.current.get(target.id) ?? 0) + 1;
          latestEditSerialByDocRef.current.set(target.id, editSerial);
          const revision = (latestRevisionByDocRef.current.get(target.id) ?? 0) + 1;
          latestRevisionByDocRef.current.set(target.id, revision);
          await startBackgroundSave({ docId: target.id, filePath, content: newest, editSerial, revision });
        }
        return filePath;
      } finally {
        provisioningDocsRef.current.delete(target.id);
        latestPathlessCaptureRef.current.delete(target.id);
      }
    })();
    provisioningDocsRef.current.set(target.id, attempt);
    // Register like a body save so close/migration drains and
    // settleRemoteDeletedDoc's awaitDocSave wait for the provision to settle
    // before acting on this doc.
    inFlightSavesRef.current.add(attempt);
    let docSaves = inFlightSavesByDocRef.current.get(target.id);
    if (!docSaves) {
      docSaves = new Set();
      inFlightSavesByDocRef.current.set(target.id, docSaves);
    }
    docSaves.add(attempt);
    const cleanup = () => {
      inFlightSavesRef.current.delete(attempt);
      const currentDocSaves = inFlightSavesByDocRef.current.get(target.id);
      currentDocSaves?.delete(attempt);
      if (currentDocSaves?.size === 0) {
        inFlightSavesByDocRef.current.delete(target.id);
      }
    };
    void attempt.then(cleanup, cleanup);
    return attempt;
  }, [startBackgroundSave]);

  const flushAutoSave = useCallback(async (): Promise<FlushResult> => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();

    if (!hasPendingChangesRef.current && !stateRef.current.state.isDirty) {
      return { status: "clean" };
    }

    const freshSnapshot = createSnapshot();
    if (!freshSnapshot) {
      // A pathless active doc cannot snapshot. Provisioning writes the live
      // content itself; on success re-snapshot so edits that landed while the
      // provision was in flight are saved too. This reports "provisioned", not
      // "saved", because the doc IDENTITY changed underneath the caller: a
      // caller holding a docs snapshot taken before the flush still has an
      // entry with filePath "", and marking that clean would orphan the
      // provisioned file and blind hasUnsaveableChanges.
      const provisionedPath = await provisionPathlessActiveDoc({ force: true });
      if (!provisionedPath) return { status: "failed", reason: "provision-failed" };
      const retry = createSnapshot();
      if (retry && !await startBackgroundSave(retry)) {
        return { status: "failed", reason: "save-failed" };
      }
      return { status: "provisioned", filePath: provisionedPath };
    }

    return await startBackgroundSave(freshSnapshot)
      ? { status: "saved" }
      : { status: "failed", reason: "save-failed" };
  }, [createSnapshot, provisionPathlessActiveDoc, startBackgroundSave]);

  // Synchronous "is anything still unsaved" probe for close/migration drain
  // gates. Reads only the synchronously-maintained pending refs (via
  // hasPendingChangesRef) — NOT React's isDirty state, which can lag a
  // successful save until the next render and would falsely report unsaved
  // work inside an awaited close handler that never re-renders.
  const hasUnsavedChanges = useCallback((): boolean => hasPendingChangesRef.current, []);

  // Complementary probe for edits the pending refs can never see: a dirty doc
  // with no filePath whose provisioning has not succeeded. Deliberately a
  // SEPARATE signal from hasUnsavedChanges — every consumer of that one treats
  // `true` as "drain and retry", which a structurally unsaveable doc can never
  // satisfy; folding this in would turn those gates into permanent latches.
  // Callers should offer an explicit discard instead of blocking. The isDirty
  // lag concern above does not apply here: no save can clear a pathless doc's
  // isDirty, and a doc that just gained a path is exempted via activeDocRef,
  // which provisioning updates synchronously.
  const hasUnsaveableChanges = useCallback((): boolean =>
    stateRef.current.docs.some((doc) => {
      if (!doc.isDirty || doc.filePath) return false;
      if (activeDocRef.current?.id === doc.id && activeDocRef.current.filePath) return false;
      return true;
    }), []);

  // Awaits every save currently in flight (whether queued by scheduleAutoSave,
  // flushAutoSave, or captureAndQueueSave). Used by close handlers and
  // notes-dir migrations that must not quit while a background save is still
  // writing to disk. Stale in-flight saves are expected to bail on the
  // snapshot guard inside doSave; this just waits for them to settle.
  const awaitInFlightSaves = useCallback(async (): Promise<void> => {
    while (inFlightSavesRef.current.size > 0 || remoteDeletionSettlementsRef.current.size > 0) {
      const snapshot = [
        ...Array.from(inFlightSavesRef.current),
        ...Array.from(remoteDeletionSettlementsRef.current),
      ];
      await Promise.allSettled(snapshot);
    }
  }, []);

  const awaitDocSave = useCallback(async (docId: string): Promise<void> => {
    while ((inFlightSavesByDocRef.current.get(docId)?.size ?? 0) > 0) {
      const snapshot = Array.from(inFlightSavesByDocRef.current.get(docId) ?? []);
      await Promise.allSettled(snapshot);
    }
  }, []);

  const flushDocSave = useCallback(async (docId: string): Promise<boolean> => {
    await awaitDocSave(docId);
    const snapshot = pendingSnapshotsRef.current.get(docId);
    if (!snapshot) return true;
    if (!snapshotIsCurrent(snapshot)) {
      clearPendingSnapshotIfCurrent(snapshot);
      return true;
    }

    const saved = await trackInFlight(snapshot, doSave(snapshot));
    if (saved) clearPendingSnapshotIfCurrent(snapshot);
    else {
      refreshHasPendingChanges();
      void journalSnapshot(snapshot);
    }
    return saved;
  }, [awaitDocSave, clearPendingSnapshotIfCurrent, doSave, journalSnapshot, refreshHasPendingChanges, snapshotIsCurrent, trackInFlight]);

  // Retry any snapshots whose background save settled with failure (returned
  // false → still in pendingSnapshotsRef, no timer scheduled). Background
  // saves come from captureAndQueueSave; without an explicit retry on close,
  // a transient backup/write failure during a fire-and-forget switch would
  // silently strand the leaving doc's unsaved content. flushAutoSave alone
  // would not catch it because it only re-captures the *current* active doc.
  /**
   * Run `write` as the only body write in flight for `docId`, on the same
   * per-doc tail `doSave` uses, and refuse while that doc has input this
   * window has not persisted.
   *
   * Recovery needs both halves. It decided what to do from a disk read taken
   * before several awaits, and the editor goes live on the same `isLoading`
   * flip that starts it, so by the time it writes, an autosave for that note
   * may have already landed — and writing directly would clobber it with no
   * backup and race the same `${path}.tmp`, which the tail exists to prevent.
   * `write` must re-establish its own preconditions once inside.
   */
  const runExclusiveBodyWrite = useCallback(async (
    docId: string,
    write: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (hasPendingForDoc(docId)) return false;
    if (activeDocRef.current?.id === docId && stateRef.current.state.isDirty) return false;
    if (inFlightSavesByDocRef.current.has(docId)) return false;
    const prior = saveTailByDocRef.current.get(docId) ?? Promise.resolve();
    const run = prior.then(write, write);
    saveTailByDocRef.current.set(docId, run);
    const cleanup = () => {
      if (saveTailByDocRef.current.get(docId) === run) saveTailByDocRef.current.delete(docId);
    };
    void run.then(cleanup, cleanup);
    return run;
  }, [hasPendingForDoc]);

  const flushPendingSnapshots = useCallback(async (): Promise<void> => {
    const stranded = Array.from(pendingSnapshotsRef.current.values());
    for (const snapshot of stranded) {
      if (!snapshotIsCurrent(snapshot)) {
        clearPendingSnapshotIfCurrent(snapshot);
        continue;
      }
      try {
        const saved = await trackInFlight(snapshot, doSave(snapshot));
        if (saved) clearPendingSnapshotIfCurrent(snapshot);
      } catch {
        // doSave already logged; nothing more we can do at close time.
      }
    }
    refreshHasPendingChanges();
  }, [clearPendingSnapshotIfCurrent, doSave, refreshHasPendingChanges, snapshotIsCurrent, trackInFlight]);

  // Fire-and-forget variant of flushAutoSave: captures the snapshot
  // synchronously (so the editor can be repointed at a different doc
  // immediately afterwards without poisoning the snapshot) and lets doSave run
  // in the background. Used by doc-switch paths so the user sees the new doc
  // load without waiting for cloud-sync I/O on the leaving doc.
  const captureAndQueueSave = useCallback((): void => {
    const activeDocId = activeDocRef.current?.id ?? null;
    if (!activeDocId) return;
    if (!hasPendingForDoc(activeDocId) && !stateRef.current.state.isDirty) return;

    const timer = timersRef.current.get(activeDocId);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(activeDocId);

    const freshSnapshot = createSnapshot();
    if (!freshSnapshot) {
      // Pathless doc: provisioning captures the content synchronously, before
      // the caller repoints the editor at the next doc. Forced — the retry
      // throttle must not skip that capture, or a switch within the throttle
      // window would strand the edits in the repointed editor.
      void provisionPathlessActiveDoc({ force: true });
      return;
    }

    void startBackgroundSave(freshSnapshot);
  }, [createSnapshot, hasPendingForDoc, provisionPathlessActiveDoc, startBackgroundSave]);

  const scheduleAutoSave = useCallback(() => {
    if (migrationInProgress) return;

    const pending = markActiveDocEdited();
    if (!pending) {
      void provisionPathlessActiveDoc();
      return;
    }

    const existingTimer = timersRef.current.get(pending.docId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      timersRef.current.delete(pending.docId);
      const pendingTarget = pendingTargetsRef.current.get(pending.docId);
      if (pendingTarget) {
        const snapshot = createSnapshot(pendingTarget);
        if (!snapshot) {
          discardPendingTarget(pending.docId);
          return;
        }
        void startBackgroundSave(snapshot);
      }
    }, DEBOUNCE_MS);

    timersRef.current.set(pending.docId, timer);
  }, [createSnapshot, discardPendingTarget, markActiveDocEdited, provisionPathlessActiveDoc, startBackgroundSave]);

  useEffect(() => {
    return () => {
      const activePending = activeDocRef.current
        ? pendingTargetsRef.current.get(activeDocRef.current.id)
        : null;
      if (activePending) {
        const snapshot = createSnapshot(activePending);
        if (snapshot) pendingSnapshotsRef.current.set(snapshot.docId, snapshot);
      }

      const pendingEntries = Array.from(pendingSnapshotsRef.current.values());
      pendingTargetsRef.current.clear();
      pendingSnapshotsRef.current.clear();

      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();

      for (const snapshot of pendingEntries) {
        void doSave(snapshot);
      }
    };
  }, [createSnapshot, doSave]);

  const notifyActiveDoc = useCallback((id: string, filePath: string) => {
    activeDocRef.current = { id, filePath };
  }, []);

  const cancelDocSave = useCallback((docId: string) => {
    const timer = timersRef.current.get(docId);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(docId);
    pendingTargetsRef.current.delete(docId);
    pendingSnapshotsRef.current.delete(docId);
    // saveTailByDocRef is intentionally left alone: a write already in flight
    // for this doc must finish, and its cleanupTail self-removes the entry on
    // settle. Clearing it here could let a concurrent write skip the chain.
    refreshHasPendingChanges();
  }, [refreshHasPendingChanges]);

  const settleRemoteDeletedDoc = useCallback((docId: string): Promise<boolean> => {
    const live = stateRef.current;
    const doc = live.docs.find((entry) => entry.id === docId) ?? null;
    // Quarantine synchronously, before returning the promise to useWindowSync.
    // The window-sync handler can then remove the live editor immediately
    // without any timer or callback reopening the write path. A window that
    // does not hold the note has no removal to observe, so its tombstone starts
    // already-settled and lifts the moment a restore reintroduces the id —
    // otherwise a window that never even opened the note would refuse to
    // autosave it forever.
    remoteDeletedDocsRef.current.set(docId, { deletedDoc: doc, removalObserved: doc === null });
    if (!doc) return Promise.resolve(true);

    const isActive = activeDocRef.current?.id === docId;
    const pendingSnapshot = pendingSnapshotsRef.current.get(docId);
    const hasLocalEdits = hasPendingForDoc(docId)
      || doc.isDirty
      || (isActive && live.state.isDirty);
    const localContent = isActive
      ? getCurrentMarkdown(live.tiptapRef)
      : pendingSnapshot?.content ?? doc.content;
    const inFlightSnapshots = Array.from(inFlightSnapshotsByDocRef.current.get(docId) ?? []);
    const possibleLocalWrites = [
      localContent,
      pendingSnapshot?.content,
      doc.content,
      ...inFlightSnapshots.map((snapshot) => snapshot.content),
    ]
      .filter((body): body is string => body !== undefined);

    // Invalidate before the first await. An atomic write already in progress
    // may finish, but it can no longer commit state or emit doc-updated.
    latestEditSerialByDocRef.current.set(
      docId,
      (latestEditSerialByDocRef.current.get(docId) ?? 0) + 1,
    );
    latestRevisionByDocRef.current.set(
      docId,
      (latestRevisionByDocRef.current.get(docId) ?? 0) + 1,
    );
    const timer = timersRef.current.get(docId);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(docId);
    pendingTargetsRef.current.delete(docId);
    pendingSnapshotsRef.current.delete(docId);
    refreshHasPendingChanges();

    const settlement = (async (): Promise<boolean> => {
      await awaitDocSave(docId);
      if (!hasLocalEdits) return true;

      let notesDir: string | null = null;
      try {
        const dir = await getNotesDir();
        notesDir = dir;
        const base = normalizeSep(dir);
        const trashDir = `${base}.trash`;
        const trashPath = `${trashDir}/${docId}.md`;
        let trashContent: string | null = null;
        try {
          trashContent = await tauriFileSystem.readTextFile(trashPath);
        } catch (err) {
          if (await tauriFileSystem.exists(trashPath)) throw err;
        }

        if (trashContent === null || markdownEqual(trashContent, doc.content)) {
          // The deleting window's trash copy is the same body this editor was
          // based on, so fold the local edit into the deleted note. Deletion
          // still wins; restoring from trash later recovers the latest text.
          await tauriFileSystem.mkdir(trashDir, { recursive: true });
          markOwnWrite(trashPath, localContent);
          await atomicWriteText(tauriFileSystem, trashPath, localContent, { failClosed: true });
        } else if (!markdownEqual(trashContent, localContent)) {
          // Both windows changed the body. Keep the deleting window's trash
          // version authoritative and preserve only this genuinely divergent
          // local edit as a conflict artifact.
          await backupLocalDeletionVersion(tauriFileSystem, dir, docId, localContent);
        }

        // If an older local autosave crossed the deletion and recreated the live
        // body, remove only a body matching one of our captured local versions.
        if (await tauriFileSystem.exists(doc.filePath)) {
          const diskContent = await tauriFileSystem.readTextFile(doc.filePath);
          if (possibleLocalWrites.some((body) => markdownEqual(body, diskContent))) {
            markOwnWrite(doc.filePath);
            await tauriFileSystem.remove(doc.filePath);
          }
        }
        return true;
      } catch (err) {
        try {
          const dir = notesDir ?? await getNotesDir();
          await backupLocalDeletionVersion(tauriFileSystem, dir, docId, localContent);
          return true;
        } catch (backupErr) {
          // Deletion remains authoritative even when both preservation paths are
          // unavailable. Record the exceptional loss of the recovery copy, but
          // never resurrect or retain a note the user deleted in another window.
          const failure = backupErr ?? err;
          void logNotenError(failure instanceof NotenError
            ? failure
            : new NotenError(
                "BACKUP_FAILED",
                "fatal",
                failure instanceof Error ? failure.message : String(failure),
                { context: { noteId: docId, filePath: doc.filePath }, cause: failure },
              ));
          return true;
        }
      }
    })();
    remoteDeletionSettlementsRef.current.add(settlement);
    const cleanup = () => remoteDeletionSettlementsRef.current.delete(settlement);
    void settlement.then(cleanup, cleanup);
    return settlement;
  }, [awaitDocSave, hasPendingForDoc, refreshHasPendingChanges]);

  return { scheduleAutoSave, flushAutoSave, hasUnsavedChanges, hasUnsaveableChanges, captureAndQueueSave, awaitInFlightSaves, awaitDocSave, flushDocSave, flushPendingSnapshots, journalPendingEdits, runExclusiveBodyWrite, notifyActiveDoc, cancelDocSave, settleRemoteDeletedDoc };
}
