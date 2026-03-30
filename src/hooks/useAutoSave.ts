import { useEffect, useRef } from "react";
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
  const stateRef = useRef({ state, tiptapRef, docs, activeIndex });
  stateRef.current = { state, tiptapRef, docs, activeIndex };

  useEffect(() => {
    if (!state.isDirty) return;

    const doc = docs[activeIndex];
    if (!doc?.filePath) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const {
        state: latestState,
        tiptapRef: latestEditorRef,
        docs: latestDocs,
        activeIndex: latestActiveIndex,
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
            : deriveTitle(content) || docEntry.fileName || getDefaultDocumentTitle(locale, latestDocs.map((d) => d.fileName));
          return {
            ...docEntry,
            content,
            isDirty: false,
            updatedAt: Date.now(),
            fileName: autoTitle,
          };
        });

        const sortedDocs = sortNotes(nextDocs, notesSortOrder);
        const nextIndex = Math.max(
          sortedDocs.findIndex((docEntry) => docEntry.id === target.id),
          0,
        );

        setDocs(sortedDocs);
        setActiveIndex(nextIndex);
        void saveManifest(sortedDocs, target.id).catch(() => {});

        const saved = sortedDocs.find((d) => d.id === target.id);
        if (saved) emitDocUpdated(saved.id, content, saved.fileName);

        latestState.setIsDirty(false);
        latestState.setTiptapDirty(false);
      } catch (err) {
        console.warn("Auto-save failed:", err);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [
    activeIndex,
    docs,
    locale,
    notesSortOrder,
    setActiveIndex,
    setDocs,
    state.isDirty,
    state.markdown,
    state.tiptapDirty,
  ]);
}
