import { useCallback, useEffect, useRef } from "react";
import { tauriFileSystem } from "../utils/fs";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";
import { deriveTitle, saveManifest, sortNotes, getNotesDir, migrationInProgress } from "./useNotesLoader";
import { getCurrentMarkdown } from "./useFileSystem";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { MarkdownState } from "./useMarkdownState";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { emitDocUpdated } from "./useWindowSync";
import { markOwnWrite } from "./ownWriteTracker";
import { backupIfRemoteWroteFirst, setKnownDiskContent } from "../utils/conflictBackup";
import { NotenError } from "../utils/notenError";
import { logNotenError } from "../utils/crashLog";

const DEBOUNCE_MS = 1000;

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

export function useAutoSave(
  state: MarkdownState,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  docs: NoteDoc[],
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
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
  const inFlightSavesRef = useRef(new Set<Promise<boolean>>());
  const inFlightSavesByDocRef = useRef(new Map<string, Set<Promise<boolean>>>());
  const stateRef = useRef({
    state,
    tiptapRef,
    docs,
    activeIndex,
    locale,
    notesSortOrder,
    setDocs,
    setActiveIndex,
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
    setActiveIndex,
    groups,
  };

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
    const pendingTarget = pendingTargetsRef.current.get(snapshot.docId);
    if (pendingTarget && pendingTarget.editSerial <= snapshot.editSerial) {
      pendingTargetsRef.current.delete(snapshot.docId);
    }
    refreshHasPendingChanges();
  }, [refreshHasPendingChanges]);

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

    const {
      locale: latestLocale,
      notesSortOrder: latestSortOrder,
      setDocs: latestSetDocs,
      setActiveIndex: latestSetActiveIndex,
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
      // savedDocStillExists check below still guards the manifest commit, but
      // skipping the write itself avoids the wasted I/O and the ghost file.
      if (!stateRef.current.docs.some((d) => d.id === snapshot.docId)) {
        return false;
      }

      if (!snapshotIsCurrent(snapshot)) {
        return false;
      }

      markOwnWrite(snapshot.filePath, snapshot.content);
      await tauriFileSystem.writeTextFile(snapshot.filePath, snapshot.content);
      setKnownDiskContent(snapshot.filePath, snapshot.content);

      if (!snapshotIsCurrent(snapshot)) {
        return false;
      }

      const live = stateRef.current;
      // Prefer the synchronous activeDocRef over stateRef.current.docs/
      // activeIndex: when a fast-path switchDocument has already called
      // notifyActiveDoc but React hasn't committed the corresponding setDocs/
      // setActiveIndex yet, stateRef still reflects the leaving doc. Using the
      // stale id would let a post-switch background save flip isDirty on the
      // wrong doc and resort/reselect the leaving doc as active.
      const currentActiveId = activeDocRef.current?.id
        ?? live.docs[live.activeIndex]?.id
        ?? null;
      const activeDocStillMatches = currentActiveId === snapshot.docId
        ? live.state.getCachedMarkdown() === snapshot.content
        : false;

      let savedDocStillExists = false;
      const nextDocs = live.docs.map((docEntry) => {
        if (docEntry.id !== snapshot.docId) return docEntry;
        savedDocStillExists = true;

        const autoTitle = docEntry.customName
          ? docEntry.fileName
          : deriveTitle(snapshot.content) || docEntry.fileName || getDefaultDocumentTitle(latestLocale, live.docs.map((d) => d.fileName));
        return {
          ...docEntry,
          content: snapshot.content,
          isDirty: currentActiveId === snapshot.docId ? !activeDocStillMatches : false,
          updatedAt: Date.now(),
          fileName: autoTitle,
        };
      });

      if (!savedDocStillExists) {
        return false;
      }

      const sortedDocs = sortNotes(nextDocs, latestSortOrder, latestLocale);
      const nextIndex = currentActiveId
        ? Math.max(sortedDocs.findIndex((docEntry) => docEntry.id === currentActiveId), 0)
        : 0;

      latestSetDocs(sortedDocs);
      latestSetActiveIndex(nextIndex);
      try {
        await saveManifest(sortedDocs, currentActiveId, stateRef.current.groups);
      } catch {
        return false;
      }

      const saved = sortedDocs.find((d) => d.id === snapshot.docId);
      if (saved) emitDocUpdated(saved.id, snapshot.content, saved.fileName);

      if (activeDocStillMatches) {
        live.state.setIsDirty(false);
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
  const trackInFlight = useCallback((docId: string, p: Promise<boolean>): Promise<boolean> => {
    inFlightSavesRef.current.add(p);
    let docSaves = inFlightSavesByDocRef.current.get(docId);
    if (!docSaves) {
      docSaves = new Set();
      inFlightSavesByDocRef.current.set(docId, docSaves);
    }
    docSaves.add(p);
    void p.finally(() => {
      inFlightSavesRef.current.delete(p);
      const currentDocSaves = inFlightSavesByDocRef.current.get(docId);
      currentDocSaves?.delete(p);
      if (currentDocSaves?.size === 0) {
        inFlightSavesByDocRef.current.delete(docId);
      }
    });
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
      else refreshHasPendingChanges();
      return saved;
    });
    return trackInFlight(snapshot.docId, save);
  }, [clearPendingSnapshotIfCurrent, doSave, refreshHasPendingChanges, trackInFlight]);

  const flushAutoSave = useCallback((): Promise<boolean> => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();

    if (!hasPendingChangesRef.current && !stateRef.current.state.isDirty) {
      return Promise.resolve(true);
    }

    const freshSnapshot = createSnapshot();
    if (!freshSnapshot) return Promise.resolve(false);

    return startBackgroundSave(freshSnapshot);
  }, [createSnapshot, startBackgroundSave]);

  // Awaits every save currently in flight (whether queued by scheduleAutoSave,
  // flushAutoSave, or captureAndQueueSave). Used by close handlers and
  // notes-dir migrations that must not quit while a background save is still
  // writing to disk. Stale in-flight saves are expected to bail on the
  // snapshot guard inside doSave; this just waits for them to settle.
  const awaitInFlightSaves = useCallback(async (): Promise<void> => {
    while (inFlightSavesRef.current.size > 0) {
      const snapshot = Array.from(inFlightSavesRef.current);
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

    const saved = await trackInFlight(snapshot.docId, doSave(snapshot));
    if (saved) clearPendingSnapshotIfCurrent(snapshot);
    else refreshHasPendingChanges();
    return saved;
  }, [awaitDocSave, clearPendingSnapshotIfCurrent, doSave, refreshHasPendingChanges, snapshotIsCurrent, trackInFlight]);

  // Retry any snapshots whose background save settled with failure (returned
  // false → still in pendingSnapshotsRef, no timer scheduled). Background
  // saves come from captureAndQueueSave; without an explicit retry on close,
  // a transient backup/write failure during a fire-and-forget switch would
  // silently strand the leaving doc's unsaved content. flushAutoSave alone
  // would not catch it because it only re-captures the *current* active doc.
  const flushPendingSnapshots = useCallback(async (): Promise<void> => {
    const stranded = Array.from(pendingSnapshotsRef.current.values());
    for (const snapshot of stranded) {
      if (!snapshotIsCurrent(snapshot)) {
        clearPendingSnapshotIfCurrent(snapshot);
        continue;
      }
      try {
        const saved = await trackInFlight(snapshot.docId, doSave(snapshot));
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
    if (!freshSnapshot) return;

    void startBackgroundSave(freshSnapshot);
  }, [createSnapshot, hasPendingForDoc, startBackgroundSave]);

  const scheduleAutoSave = useCallback(() => {
    if (migrationInProgress) return;

    const pending = markActiveDocEdited();
    if (!pending) return;

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
  }, [createSnapshot, discardPendingTarget, markActiveDocEdited, startBackgroundSave]);

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
    refreshHasPendingChanges();
  }, [refreshHasPendingChanges]);

  return { scheduleAutoSave, flushAutoSave, captureAndQueueSave, awaitInFlightSaves, awaitDocSave, flushDocSave, flushPendingSnapshots, notifyActiveDoc, cancelDocSave };
}
