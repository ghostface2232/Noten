import { useEffect, useRef } from "react";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { NoteDoc } from "./useNotesLoader";
import { deriveTitle, saveManifest, sortNotes } from "./useNotesLoader";
import { getCurrentMarkdown } from "./useFileSystem";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { MarkdownState } from "./useMarkdownState";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";

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
        await writeTextFile(target.filePath, content);

        const nextDocs = latestDocs.map((docEntry) => {
          if (docEntry.id !== target.id) return docEntry;

          const nextTitle = deriveTitle(content) || getDefaultDocumentTitle(locale);
          return {
            ...docEntry,
            content,
            isDirty: false,
            updatedAt: Date.now(),
            fileName: docEntry.isExternal ? docEntry.fileName : nextTitle,
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
