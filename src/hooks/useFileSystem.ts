import { useCallback, useRef } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import {
  getNotesDir,
  saveManifest,
  deriveTitle,
  sortNotes,
  type NoteDoc,
  type NoteGroup,
} from "./useNotesLoader";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { emitDocCreated, emitDocDeleted, emitDocRenamed } from "./useWindowSync";
import { markOwnWrite } from "./ownWriteTracker";

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
  groups?: NoteGroup[],
) {
  const sortedDocs = sortNotes(nextDocs, notesSortOrder);
  const nextActiveIndex = activeId
    ? Math.max(sortedDocs.findIndex((doc) => doc.id === activeId), 0)
    : 0;

  setDocs(sortedDocs);
  setActiveIndex(nextActiveIndex);
  void saveManifest(sortedDocs, activeId, groups).catch(() => {});
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
  importFile: () => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  newNote: () => Promise<void>;
  switchDocument: (index: number) => void;
  deleteNote: (index: number) => Promise<void>;
  duplicateNote: (index: number) => Promise<void>;
  exportNote: (index: number) => Promise<void>;
  renameNote: (index: number, newName: string) => void;
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
  groups?: NoteGroup[],
  cleanupDeletedNote?: (noteId: string) => void,
): FileSystemActions {
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

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
    if (!targetPath) {
      const selected = await save({ filters: MD_FILTERS, defaultPath: `${doc.fileName}.md` });
      if (!selected) return;
      targetPath = selected;
    }

    markOwnWrite(targetPath);
    await writeTextFile(targetPath, markdown);

    const nextDocs = docs.map((entry, index) => {
      if (index !== activeIndex) return entry;

      const title = entry.customName
        ? entry.fileName
        : deriveTitle(markdown) || entry.fileName || getDefaultDocumentTitle(locale);
      return {
        ...entry,
        filePath: targetPath,
        content: markdown,
        isDirty: false,
        updatedAt: Date.now(),
        fileName: title,
      };
    });

    sortAndPersistDocs(nextDocs, doc.id, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
    state.setIsDirty(false);
    state.setTiptapDirty(false);
  }, [activeIndex, docs, locale, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const saveFileAs = useCallback(async () => {
    const markdown = getCurrentMarkdown(state, tiptapRef);
    const doc = docs[activeIndex];
    const defaultName = doc?.filePath ? getFileName(doc.filePath) : "untitled.md";
    const selected = await save({ filters: MD_FILTERS, defaultPath: defaultName });
    if (!selected) return;
    markOwnWrite(selected);
    await writeTextFile(selected, markdown);
  }, [activeIndex, docs, state, tiptapRef]);

  const importFile = useCallback(async () => {
    cacheCurrentContent();

    const selected = await open({ filters: MD_FILTERS, multiple: false });
    if (!selected) return;

    const sourcePath = selected as string;
    const content = await readTextFile(sourcePath);

    // Derive note name from source file name (without extension)
    const rawName = getFileName(sourcePath).replace(/\.(md|markdown|mdx|txt)$/i, "");
    const baseName = rawName || "Imported";

    // Check for duplicate names and add number suffix if needed
    const existingNames = docs.map((d) => d.fileName);
    let finalName = baseName;
    if (existingNames.includes(finalName)) {
      let counter = 1;
      while (existingNames.includes(`${baseName} (${counter})`)) counter++;
      finalName = `${baseName} (${counter})`;
    }

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    let filePath = "";
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
      markOwnWrite(filePath);
      await writeTextFile(filePath, content);
    } catch (error) {
      console.warn("Failed to write imported note file:", error);
    }

    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: finalName,
      isDirty: false,
      content,
      customName: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const nextDocs = [...docs, newDoc];
    sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
    emitDocCreated(newDoc);

    loadIntoEditor(tiptapRef, content);
    resetDocState(state, filePath, content);
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
      fileName: getDefaultDocumentTitle(locale, docs.map((d) => d.fileName)),
      isDirty: false,
      content: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const nextDocs = [...docs, newDoc];
    sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
    emitDocCreated(newDoc);

    loadIntoEditor(tiptapRef, "");
    resetDocState(state, filePath, "");

    if (!filePath) return;

    try {
      markOwnWrite(filePath);
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
    void saveManifest(docs, target.id, groupsRef.current).catch(() => {});
  }, [activeIndex, cacheCurrentContent, docs, setActiveIndex, state, tiptapRef]);

  const deleteNote = useCallback(async (index: number) => {
    const doc = docs[index];
    if (!doc) return;

    // Remove the file from disk
    if (doc.filePath) {
      try {
        markOwnWrite(doc.filePath);
        await remove(doc.filePath);
      } catch {
        console.warn("Failed to delete note file:", doc.filePath);
      }
    }

    const nextDocs = docs.filter((_, i) => i !== index);
    emitDocDeleted(doc.id);
    cleanupDeletedNote?.(doc.id);

    // If we deleted the last doc, create a fresh one
    if (nextDocs.length === 0) {
      const id = crypto.randomUUID();
      const timestamp = Date.now();
      let filePath = "";
      try {
        const notesDir = await getNotesDir();
        filePath = `${notesDir}/${id}.md`;
        markOwnWrite(filePath);
        await writeTextFile(filePath, "");
      } catch { /* ignore */ }

      const newDoc: NoteDoc = {
        id,
        filePath,
        fileName: getDefaultDocumentTitle(locale),
        isDirty: false,
        content: "",
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setDocs([newDoc]);
      setActiveIndex(0);
      loadIntoEditor(tiptapRef, "");
      resetDocState(state, filePath, "");
      void saveManifest([newDoc], newDoc.id, groupsRef.current).catch(() => {});
      return;
    }

    // Determine the next active document
    const wasActive = index === activeIndex;
    let nextActiveId: string;

    if (wasActive) {
      const target = nextDocs[Math.min(index, nextDocs.length - 1)];
      nextActiveId = target.id;
      loadIntoEditor(tiptapRef, target.content);
      resetDocState(state, target.filePath, target.content);
    } else {
      nextActiveId = docs[activeIndex].id;
    }

    sortAndPersistDocs(nextDocs, nextActiveId, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
  }, [activeIndex, docs, locale, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef, cleanupDeletedNote]);

  const duplicateNote = useCallback(async (index: number) => {
    const doc = docs[index];
    if (!doc) return;

    cacheCurrentContent();

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    let filePath = "";
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
    } catch { /* ignore */ }

    const content = doc.content;
    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: doc.fileName,
      isDirty: false,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (filePath) {
      try {
        markOwnWrite(filePath);
        await writeTextFile(filePath, content);
      } catch {
        console.warn("Failed to write duplicated note file.");
      }
    }

    const nextDocs = [...docs, newDoc];
    sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
    loadIntoEditor(tiptapRef, content);
    resetDocState(state, filePath, content);
  }, [cacheCurrentContent, docs, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const exportNote = useCallback(async (index: number) => {
    const doc = docs[index];
    if (!doc) return;

    const defaultName = doc.filePath ? getFileName(doc.filePath) : `${doc.fileName}.md`;
    const selected = await save({ filters: MD_FILTERS, defaultPath: defaultName });
    if (!selected) return;

    const content = index === activeIndex ? getCurrentMarkdown(state, tiptapRef) : doc.content;
    await writeTextFile(selected, content);
  }, [activeIndex, docs, state, tiptapRef]);

  const renameNote = useCallback(async (index: number, newName: string) => {
    const doc = docs[index];
    if (!doc) return;

    const trimmed = newName.trim();
    if (!trimmed || trimmed === doc.fileName) return;

    const nextDocs = docs.map((entry, i) => {
      if (i !== index) return entry;
      return { ...entry, fileName: trimmed, updatedAt: Date.now(), customName: true };
    });

    sortAndPersistDocs(nextDocs, doc.id, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
    emitDocRenamed(doc.id, doc.filePath, doc.filePath, trimmed);
  }, [docs, notesSortOrder, setActiveIndex, setDocs]);

  return { importFile, saveFile, saveFileAs, newNote, switchDocument, deleteNote, duplicateNote, exportNote, renameNote };
}
