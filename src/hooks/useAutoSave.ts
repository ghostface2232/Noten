import { useCallback, useEffect, useRef } from "react";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { NoteDoc } from "./useNotesLoader";
import { deriveTitle, saveManifest, sortNotes } from "./useNotesLoader";
import { getCurrentMarkdown } from "./useFileSystem";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { MarkdownState } from "./useMarkdownState";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { emitDocUpdated } from "./useWindowSync";
import { markOwnWrite } from "./ownWriteTracker";

const DEBOUNCE_MS = 1000;

export function useAutoSave(
  state: MarkdownState,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  docs: NoteDoc[],
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  locale: Locale,
  notesSortOrder: NotesSortOrder,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef({
    state,
    tiptapRef,
    docs,
    activeIndex,
    locale,
    notesSortOrder,
    setDocs,
    setActiveIndex,
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
  };

  const doSave = useCallback(async () => {
    const {
      state: latestState,
      tiptapRef: latestEditorRef,
      docs: latestDocs,
      activeIndex: latestActiveIndex,
      locale: latestLocale,
      notesSortOrder: latestSortOrder,
      setDocs: latestSetDocs,
      setActiveIndex: latestSetActiveIndex,
    } = stateRef.current;

    const target = latestDocs[latestActiveIndex];
    if (!target?.filePath) return;

    const content = getCurrentMarkdown(latestState, latestEditorRef);

    try {
      markOwnWrite(target.filePath);
      await writeTextFile(target.filePath, content);

      const nextDocs = latestDocs.map((docEntry) => {
        if (docEntry.id !== target.id) return docEntry;

        const autoTitle = docEntry.customName
          ? docEntry.fileName
          : deriveTitle(content) || docEntry.fileName || getDefaultDocumentTitle(latestLocale, latestDocs.map((d) => d.fileName));
        return {
          ...docEntry,
          content,
          isDirty: false,
          updatedAt: Date.now(),
          fileName: autoTitle,
        };
      });

      const sortedDocs = sortNotes(nextDocs, latestSortOrder);
      const nextIndex = Math.max(
        sortedDocs.findIndex((docEntry) => docEntry.id === target.id),
        0,
      );

      latestSetDocs(sortedDocs);
      latestSetActiveIndex(nextIndex);
      void saveManifest(sortedDocs, target.id).catch(() => {});

      const saved = sortedDocs.find((d) => d.id === target.id);
      if (saved) emitDocUpdated(saved.id, content, saved.fileName);

      latestState.setIsDirty(false);
      latestState.setTiptapDirty(false);
    } catch (err) {
      console.warn("Auto-save failed:", err);
    }
  }, []);

  const flushAutoSave = useCallback((): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      return doSave();
    }
    return Promise.resolve();
  }, [doSave]);

  const scheduleAutoSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      doSave();
    }, DEBOUNCE_MS);
  }, [doSave]);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        // Fire-and-forget: doSave reads from stateRef which is still valid
        doSave();
      }
    };
  }, [doSave]);

  return { scheduleAutoSave, flushAutoSave };
}
