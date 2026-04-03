import { useCallback, useEffect, useRef } from "react";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";
import { deriveTitle, saveManifest, sortNotes } from "./useNotesLoader";
import { getCurrentMarkdown } from "./useFileSystem";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { MarkdownState } from "./useMarkdownState";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { emitDocUpdated } from "./useWindowSync";
import { markOwnWrite } from "./ownWriteTracker";

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

  // Synchronously tracks which doc the editor currently holds.
  // Two update paths (both required):
  //   1. Render path (below): keeps ref in sync when React state is committed.
  //   2. notifyActiveDoc(): called imperatively right after loading a new doc
  //      into the editor, BEFORE React re-renders. This covers the window
  //      between setActiveIndex() call and the next render where
  //      docs[activeIndex] still points to the old doc.
  // In React 18 automatic batching, notifyActiveDoc and setActiveIndex are
  // processed in the same batch, so path 1 always sees the correct doc once
  // the render fires. The two paths converge safely.
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

    const content = getCurrentMarkdown(latestState, latestEditorRef);
    const revision = (latestRevisionByDocRef.current.get(target.id) ?? 0) + 1;
    latestRevisionByDocRef.current.set(target.id, revision);

    return {
      docId: target.id,
      filePath: target.filePath,
      content,
      revision,
    };
  }, []);

  const doSave = useCallback(async (snapshot: SaveSnapshot): Promise<boolean> => {
    const {
      locale: latestLocale,
      notesSortOrder: latestSortOrder,
      setDocs: latestSetDocs,
      setActiveIndex: latestSetActiveIndex,
    } = stateRef.current;

    try {
      markOwnWrite(snapshot.filePath);
      await writeTextFile(snapshot.filePath, snapshot.content);

      if ((latestRevisionByDocRef.current.get(snapshot.docId) ?? 0) !== snapshot.revision) {
        return false;
      }

      const live = stateRef.current;
      const currentActiveId = live.docs[live.activeIndex]?.id ?? null;
      const currentMarkdown = currentActiveId === snapshot.docId
        ? getCurrentMarkdown(live.state, live.tiptapRef)
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
        live.state.setTiptapDirty(false);
      }
      return true;
    } catch (err) {
      console.warn("Auto-save failed:", err);
      return false;
    }
  }, []);

  const flushAutoSave = useCallback((): Promise<boolean> => {
    // Clear all pending timers
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();
    pendingSnapshotsRef.current.clear();

    // Only save if scheduleAutoSave was called (content actually changed)
    if (!hasPendingChangesRef.current) {
      return Promise.resolve(!stateRef.current.state.isDirty);
    }
    hasPendingChangesRef.current = false;

    // Capture a fresh snapshot from the current editor state
    const freshSnapshot = createSnapshot();
    if (!freshSnapshot) return Promise.resolve(false);

    return doSave(freshSnapshot);
  }, [createSnapshot, doSave]);

  const scheduleAutoSave = useCallback(() => {
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
      pendingSnapshotsRef.current.delete(snapshot.docId);
      if (pending) {
        hasPendingChangesRef.current = false;
        void doSave(pending);
      }
    }, DEBOUNCE_MS);

    timersRef.current.set(snapshot.docId, timer);
  }, [createSnapshot, doSave]);

  // Flush pending save on unmount
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

  /** Immediately update activeDocRef so createSnapshot targets the correct doc.
   *  Call this right after loading a new doc into the editor, before React re-renders. */
  const notifyActiveDoc = useCallback((id: string, filePath: string) => {
    activeDocRef.current = { id, filePath };
  }, []);

  /** Cancel pending autosave for a specific doc (e.g. before deletion). */
  const cancelDocSave = useCallback((docId: string) => {
    const timer = timersRef.current.get(docId);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(docId);
    pendingSnapshotsRef.current.delete(docId);
  }, []);

  return { scheduleAutoSave, flushAutoSave, notifyActiveDoc, cancelDocSave };
}
