import { useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  getNotesDir,
  saveManifest,
  deriveTitle,
  sortNotes,
  type NoteDoc,
} from "./useNotesLoader";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";

export type { NoteDoc } from "./useNotesLoader";

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }];

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || "untitled.md";
}

function sortAndPersistDocs(
  nextDocs: NoteDoc[],
  activeId: string | null,
  notesSortOrder: NotesSortOrder,
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
) {
  const sortedDocs = sortNotes(nextDocs, notesSortOrder);
  const nextActiveIndex = activeId
    ? Math.max(sortedDocs.findIndex((doc) => doc.id === activeId), 0)
    : 0;

  setDocs(sortedDocs);
  setActiveIndex(nextActiveIndex);
  void saveManifest(sortedDocs, activeId).catch(() => {});
}

export function getCurrentMarkdown(
  state: MarkdownState,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
): string {
  if (state.isEditing && state.editorMode === "markdown") {
    return state.markdown;
  }

  const editor = tiptapRef.current?.getEditor();
  return editor ? editor.getMarkdown() : state.markdown;
}

function loadIntoEditor(
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  content: string,
) {
  tiptapRef.current?.setContent(content);
}

function resetDocState(
  state: MarkdownState,
  filePath: string | null,
  content: string,
) {
  state.setMarkdownRaw(content);
  state.setFilePath(filePath);
  state.setIsDirty(false);
  state.setTiptapDirty(false);
}

export interface FileSystemActions {
  openFile: () => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  newNote: () => Promise<void>;
  switchDocument: (index: number) => void;
}

export function useFileSystem(
  state: MarkdownState,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  docs: NoteDoc[],
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  activeIndex: number,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  locale: Locale,
  notesSortOrder: NotesSortOrder,
): FileSystemActions {
  const cacheCurrentContent = useCallback(() => {
    const markdown = getCurrentMarkdown(state, tiptapRef);
    setDocs((prev) => {
      if (activeIndex < 0 || activeIndex >= prev.length) return prev;
      const updated = [...prev];
      updated[activeIndex] = { ...updated[activeIndex], content: markdown };
      return updated;
    });
    return markdown;
  }, [activeIndex, setDocs, state, tiptapRef]);

  const saveFile = useCallback(async () => {
    const doc = docs[activeIndex];
    if (!doc) return;

    const markdown = getCurrentMarkdown(state, tiptapRef);

    let targetPath = doc.filePath;
    if (doc.isExternal && !targetPath) {
      const selected = await save({ filters: MD_FILTERS, defaultPath: "untitled.md" });
      if (!selected) return;
      targetPath = selected;
    }

    await writeTextFile(targetPath, markdown);

    const nextDocs = docs.map((entry, index) => {
      if (index !== activeIndex) return entry;

      const title = deriveTitle(markdown) || entry.fileName;
      return {
        ...entry,
        filePath: targetPath,
        content: markdown,
        isDirty: false,
        updatedAt: Date.now(),
        fileName: entry.isExternal ? entry.fileName : title || getDefaultDocumentTitle(locale),
      };
    });

    sortAndPersistDocs(nextDocs, doc.id, notesSortOrder, setDocs, setActiveIndex);
    state.setIsDirty(false);
    state.setTiptapDirty(false);
  }, [activeIndex, docs, locale, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const saveFileAs = useCallback(async () => {
    const markdown = getCurrentMarkdown(state, tiptapRef);
    const doc = docs[activeIndex];
    const defaultName = doc?.filePath ? getFileName(doc.filePath) : "untitled.md";
    const selected = await save({ filters: MD_FILTERS, defaultPath: defaultName });
    if (!selected) return;
    await writeTextFile(selected, markdown);
  }, [activeIndex, docs, state, tiptapRef]);

  const openFile = useCallback(async () => {
    cacheCurrentContent();

    const selected = await open({ filters: MD_FILTERS, multiple: false });
    if (!selected) return;

    const path = selected as string;
    const existingIndex = docs.findIndex((doc) => doc.filePath === path);
    if (existingIndex >= 0) {
      setActiveIndex(existingIndex);
      loadIntoEditor(tiptapRef, docs[existingIndex].content);
      resetDocState(state, path, docs[existingIndex].content);
      return;
    }

    const content = await readTextFile(path);
    const fileName = getFileName(path);

    let isExternal = true;
    try {
      const notesDir = await getNotesDir();
      if (path.startsWith(notesDir)) isExternal = false;
    } catch {
      // Ignore notes dir lookup failure and keep external state.
    }

    const timestamp = Date.now();
    const newDoc: NoteDoc = {
      id: crypto.randomUUID(),
      filePath: path,
      fileName,
      isExternal,
      isDirty: false,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const nextDocs = [...docs, newDoc];
    sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, setDocs, setActiveIndex);

    loadIntoEditor(tiptapRef, content);
    resetDocState(state, path, content);
  }, [cacheCurrentContent, docs, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const newNote = useCallback(async () => {
    cacheCurrentContent();

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    let filePath = "";
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
    } catch (error) {
      console.warn("Failed to resolve notes directory for new note:", error);
    }

    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: getDefaultDocumentTitle(locale),
      isExternal: false,
      isDirty: false,
      content: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const nextDocs = [...docs, newDoc];
    sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, setDocs, setActiveIndex);

    loadIntoEditor(tiptapRef, "");
    resetDocState(state, filePath, "");

    if (!filePath) return;

    try {
      await writeTextFile(filePath, "");
    } catch (error) {
      console.warn("Failed to create new note file:", error);
    }
  }, [cacheCurrentContent, docs, locale, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const switchDocument = useCallback((index: number) => {
    if (index === activeIndex) return;
    if (index < 0 || index >= docs.length) return;

    cacheCurrentContent();

    const target = docs[index];
    loadIntoEditor(tiptapRef, target.content);
    resetDocState(state, target.filePath, target.content);
    setActiveIndex(index);
    void saveManifest(docs, target.id).catch(() => {});
  }, [activeIndex, cacheCurrentContent, docs, setActiveIndex, state, tiptapRef]);

  return { openFile, saveFile, saveFileAs, newNote, switchDocument };
}
