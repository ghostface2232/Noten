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
  revision: number;
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
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingSnapshotsRef = useRef(new Map<string, SaveSnapshot>());
  const latestRevisionByDocRef = useRef(new Map<string, number>());
  const hasPendingChangesRef = useRef(false);
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

  const createSnapshot = useCallback((): SaveSnapshot | null => {
    const {
      state: latestState,
      tiptapRef: latestEditorRef,
    } = stateRef.current;

    const target = activeDocRef.current;
    if (!target?.filePath) return null;

    const content = getCurrentMarkdown(latestEditorRef);
    latestState.primeMarkdown(content);
    const revision = (latestRevisionByDocRef.current.get(target.id) ?? 0) + 1;
    latestRevisionByDocRef.current.set(target.id, revision);

    return {
      docId: target.id,
      filePath: target.filePath,
      content,
      revision,
    };
  }, []);

  const refreshHasPendingChanges = useCallback(() => {
    hasPendingChangesRef.current = pendingSnapshotsRef.current.size > 0;
  }, []);

  const clearPendingSnapshotIfCurrent = useCallback((snapshot: SaveSnapshot) => {
    const current = pendingSnapshotsRef.current.get(snapshot.docId);
    if (current?.revision !== snapshot.revision) return;
    pendingSnapshotsRef.current.delete(snapshot.docId);
    refreshHasPendingChanges();
  }, [refreshHasPendingChanges]);

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

      markOwnWrite(snapshot.filePath, snapshot.content);
      await tauriFileSystem.writeTextFile(snapshot.filePath, snapshot.content);
      setKnownDiskContent(snapshot.filePath, snapshot.content);

      if ((latestRevisionByDocRef.current.get(snapshot.docId) ?? 0) !== snapshot.revision) {
        return false;
      }

      const live = stateRef.current;
      const currentActiveId = live.docs[live.activeIndex]?.id ?? null;
      const currentMarkdown = currentActiveId === snapshot.docId
        ? getCurrentMarkdown(live.tiptapRef)
        : null;
      const activeDocStillMatches = currentActiveId === snapshot.docId
        ? currentMarkdown === snapshot.content
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
      await saveManifest(sortedDocs, currentActiveId, stateRef.current.groups).catch(() => {});

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

    hasPendingChangesRef.current = true;
    pendingSnapshotsRef.current.set(freshSnapshot.docId, freshSnapshot);

    return doSave(freshSnapshot).then((saved) => {
      if (saved) clearPendingSnapshotIfCurrent(freshSnapshot);
      else refreshHasPendingChanges();
      return saved;
    });
  }, [clearPendingSnapshotIfCurrent, createSnapshot, doSave, refreshHasPendingChanges]);

  const scheduleAutoSave = useCallback(() => {
    if (migrationInProgress) return;

    const snapshot = createSnapshot();
    if (!snapshot) return;

    hasPendingChangesRef.current = true;
    pendingSnapshotsRef.current.set(snapshot.docId, snapshot);

    const existingTimer = timersRef.current.get(snapshot.docId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      timersRef.current.delete(snapshot.docId);
      const pending = pendingSnapshotsRef.current.get(snapshot.docId);
      if (pending) {
        void doSave(pending).then((saved) => {
          if (saved) clearPendingSnapshotIfCurrent(pending);
          else refreshHasPendingChanges();
        });
      }
    }, DEBOUNCE_MS);

    timersRef.current.set(snapshot.docId, timer);
  }, [clearPendingSnapshotIfCurrent, createSnapshot, doSave, refreshHasPendingChanges]);

  useEffect(() => {
    return () => {
      const pendingEntries = Array.from(pendingSnapshotsRef.current.values());
      pendingSnapshotsRef.current.clear();

      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();

      for (const snapshot of pendingEntries) {
        void doSave(snapshot);
      }
    };
  }, [doSave]);

  const notifyActiveDoc = useCallback((id: string, filePath: string) => {
    activeDocRef.current = { id, filePath };
  }, []);

  const cancelDocSave = useCallback((docId: string) => {
    const timer = timersRef.current.get(docId);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(docId);
    pendingSnapshotsRef.current.delete(docId);
  }, []);

  return { scheduleAutoSave, flushAutoSave, notifyActiveDoc, cancelDocSave };
}
