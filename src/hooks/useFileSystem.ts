import { useCallback, useRef } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readTextFile, writeTextFile, remove, copyFile } from "@tauri-apps/plugin-fs";
import {
  getNotesDir,
  saveManifest,
  deriveTitle,
  sortNotes,
  getFileBaseName,
  ensureTrashDir,
  getTrashedNotesCache,
  type NoteDoc,
  type NoteGroup,
  type TrashedNote,
} from "./useNotesLoader";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { emitDocCreated, emitDocDeleted, emitDocRenamed, emitGroupsUpdated, emitTrashUpdated } from "./useWindowSync";
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
  importFiles: (paths: string[]) => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  newNote: () => Promise<void>;
  switchDocument: (index: number) => Promise<void>;
  deleteNote: (index: number) => Promise<void>;
  duplicateNote: (index: number) => Promise<void>;
  exportNote: (index: number) => Promise<void>;
  renameNote: (index: number, newName: string) => void;
  restoreNote: (trashedNoteId: string) => Promise<void>;
  permanentlyDeleteNote: (trashedNoteId: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
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
  setGroups?: React.Dispatch<React.SetStateAction<NoteGroup[]>>,
  getGroupForNote?: (noteId: string) => NoteGroup | null,
  trashedNotes?: TrashedNote[],
  setTrashedNotes?: (updater: TrashedNote[] | ((prev: TrashedNote[]) => TrashedNote[])) => void,
  flushAutoSaveRef?: React.RefObject<(() => Promise<void>) | null>,
  notifyActiveDocRef?: React.RefObject<((id: string, filePath: string) => void) | null>,
  cancelDocSaveRef?: React.RefObject<((docId: string) => void) | null>,
): FileSystemActions {
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const trashedNotesRef = useRef(trashedNotes);
  trashedNotesRef.current = trashedNotes;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  /** Flush pending auto-save to disk before leaving the current document. */
  const leaveCurrentDoc = useCallback(async () => {
    await flushAutoSaveRef?.current?.();
  }, []);

  /** Remove the current doc if it's empty (no content, no customName, not the last doc).
   *  Returns the cleaned docs array. */
  const pruneEmptyCurrentDoc = useCallback((baseDocs: NoteDoc[]): NoteDoc[] => {
    const leaving = baseDocs[activeIndex];
    if (!leaving) return baseDocs;
    const currentContent = getCurrentMarkdown(state, tiptapRef).trim();
    if (currentContent || leaving.customName || baseDocs.length <= 1) return baseDocs;

    if (leaving.filePath) {
      try { markOwnWrite(leaving.filePath); remove(leaving.filePath).catch(() => {}); } catch {}
    }
    const leavingId = leaving.id;
    setGroups?.((prev) =>
      prev.map((g) => ({ ...g, noteIds: g.noteIds.filter((id) => id !== leavingId) }))
        .filter((g) => g.noteIds.length > 0));
    cancelDocSaveRef?.current?.(leavingId);

    const pruned = baseDocs.filter((_, i) => i !== activeIndex);
    setDocs(pruned);
    return pruned;
  }, [activeIndex, state, tiptapRef, setDocs, setGroups]);

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

  const importFiles = useCallback(async (paths: string[]) => {
    const sourcePaths = paths.filter(Boolean);
    if (sourcePaths.length === 0) return;

    await leaveCurrentDoc();

    const existingNames = new Set(docs.map((d) => d.fileName));
    const importedDocs: NoteDoc[] = [];

    for (const sourcePath of sourcePaths) {
      const content = await readTextFile(sourcePath);
      const rawName = getFileName(sourcePath).replace(/\.(md|markdown|mdx|txt)$/i, "");
      const baseName = rawName || "Imported";

      let finalName = baseName;
      if (existingNames.has(finalName)) {
        let counter = 1;
        while (existingNames.has(`${baseName} (${counter})`)) counter++;
        finalName = `${baseName} (${counter})`;
      }
      existingNames.add(finalName);

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

      importedDocs.push({
        id,
        filePath,
        fileName: finalName,
        isDirty: false,
        content,
        customName: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    if (importedDocs.length === 0) return;

    const lastImported = importedDocs[importedDocs.length - 1];
    const prunedDocs = pruneEmptyCurrentDoc(docs);
    const nextDocs = [...prunedDocs, ...importedDocs];
    sortAndPersistDocs(nextDocs, lastImported.id, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
    importedDocs.forEach((doc) => emitDocCreated(doc));

    loadIntoEditor(tiptapRef, lastImported.content);
    resetDocState(state, lastImported.filePath, lastImported.content);
    notifyActiveDocRef?.current?.(lastImported.id, lastImported.filePath);
  }, [docs, leaveCurrentDoc, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const importFile = useCallback(async () => {
    const selected = await open({ filters: MD_FILTERS, multiple: false });
    if (!selected) return;
    await importFiles([selected as string]);
  }, [importFiles]);

  const newNote = useCallback(async () => {
    await leaveCurrentDoc();

    // Check if current note is empty and should be replaced
    const currentDoc = docs[activeIndex];
    const currentContent = getCurrentMarkdown(state, tiptapRef).trim();
    const willReplace = !!currentDoc && !currentContent && !currentDoc.customName;

    // Remove current empty note (first render — sidebar sees deletion)
    let prunedDocs = docs;
    if (willReplace) {
      if (currentDoc.filePath) {
        try { markOwnWrite(currentDoc.filePath); remove(currentDoc.filePath).catch(() => {}); } catch {}
      }
      cancelDocSaveRef?.current?.(currentDoc.id);
      const leavingId = currentDoc.id;
      setGroups?.((prev) =>
        prev.map((g) => ({ ...g, noteIds: g.noteIds.filter((id) => id !== leavingId) }))
          .filter((g) => g.noteIds.length > 0));
      prunedDocs = docs.filter((_, i) => i !== activeIndex);
      setDocs(prunedDocs);
    }

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
      fileName: getDefaultDocumentTitle(locale, prunedDocs.map((d) => d.fileName)),
      isDirty: false,
      content: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const addNewDoc = () => {
      const nextDocs = [...prunedDocs, newDoc];
      sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, setDocs, setActiveIndex, groupsRef.current);
      emitDocCreated(newDoc);
      loadIntoEditor(tiptapRef, "");
      resetDocState(state, filePath, "");
      notifyActiveDocRef?.current?.(id, filePath);
      if (filePath) {
        markOwnWrite(filePath);
        writeTextFile(filePath, "").catch(() => {});
      }
    };

    if (willReplace) {
      // Delay addition so sidebar renders the deletion first, then the new item slides in
      setTimeout(addNewDoc, 120);
    } else {
      addNewDoc();
    }
  }, [activeIndex, leaveCurrentDoc, docs, locale, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const switchDocument = useCallback(async (index: number) => {
    if (index === activeIndex) return;
    if (index < 0 || index >= docs.length) return;

    await leaveCurrentDoc();

    const nextDocs = pruneEmptyCurrentDoc(docs);
    let targetIndex = index;
    if (nextDocs.length < docs.length && index > activeIndex) targetIndex = index - 1;

    const target = nextDocs[targetIndex];
    loadIntoEditor(tiptapRef, target.content);
    resetDocState(state, target.filePath, target.content);
    notifyActiveDocRef?.current?.(target.id, target.filePath);
    setActiveIndex(targetIndex);
    void saveManifest(nextDocs, target.id, groupsRef.current).catch(() => {});
  }, [activeIndex, leaveCurrentDoc, docs, setActiveIndex, setDocs, setGroups, state, tiptapRef]);

  const deleteNote = useCallback(async (index: number) => {
    const doc = docs[index];
    if (!doc) return;

    // Cancel any pending autosave timer for this doc to prevent orphan writes after deletion
    cancelDocSaveRef?.current?.(doc.id);

    // Flush pending auto-save so the on-disk file is up-to-date before trash copy
    if (index === activeIndex) await leaveCurrentDoc();

    // Capture group before it gets cleaned up below
    const group = getGroupForNote?.(doc.id) ?? null;

    // Move file to .trash — abort entire delete if copy fails
    if (doc.filePath) {
      try {
        const trashDir = await ensureTrashDir();
        const fileName = getFileBaseName(doc.filePath);
        const trashPath = `${trashDir}/${fileName}`;

        markOwnWrite(doc.filePath);
        await copyFile(doc.filePath, trashPath);
        // copy succeeded — remove original (orphan in .trash is harmless if this fails)
        try { await remove(doc.filePath); } catch { /* original stays; reconcile picks it up */ }

        const trashedNote: TrashedNote = {
          id: doc.id,
          fileName: doc.fileName,
          originalFilePath: doc.filePath,
          trashFilePath: trashPath,
          trashedAt: Date.now(),
          groupId: group?.id ?? null,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        };

        if (setTrashedNotes) {
          setTrashedNotes((prev) => [...prev, trashedNote]);
          emitTrashUpdated(getTrashedNotesCache());
        }
      } catch {
        // Copy to .trash failed — abort deletion to preserve user data
        console.warn("Failed to move note to trash, deletion aborted:", doc.filePath);
        return;
      }
    }

    const nextDocs = docs.filter((_, i) => i !== index);
    emitDocDeleted(doc.id);

    // Compute cleaned groups atomically (remove note from all groups)
    const cleanedGroups = (groupsRef.current ?? []).map((g) =>
      g.noteIds.includes(doc.id)
        ? { ...g, noteIds: g.noteIds.filter((id) => id !== doc.id) }
        : g,
    );
    setGroups?.(cleanedGroups);
    emitGroupsUpdated(cleanedGroups);

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
      notifyActiveDocRef?.current?.(id, filePath);
      void saveManifest([newDoc], newDoc.id, cleanedGroups).catch(() => {});
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
      notifyActiveDocRef?.current?.(target.id, target.filePath);
    } else {
      nextActiveId = docs[activeIndex].id;
    }

    sortAndPersistDocs(nextDocs, nextActiveId, notesSortOrder, setDocs, setActiveIndex, cleanedGroups);
  }, [activeIndex, docs, locale, notesSortOrder, setActiveIndex, setDocs, setGroups, state, tiptapRef, getGroupForNote, setTrashedNotes]);

  const duplicateNote = useCallback(async (index: number) => {
    const doc = docs[index];
    if (!doc) return;

    await leaveCurrentDoc();

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    let filePath = "";
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
    } catch { /* ignore */ }

    const content = index === activeIndex ? getCurrentMarkdown(state, tiptapRef) : doc.content;
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
    notifyActiveDocRef?.current?.(newDoc.id, filePath);
  }, [leaveCurrentDoc, docs, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

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

  const restoreNote = useCallback(async (trashedNoteId: string) => {
    const trashed = trashedNotesRef.current?.find((n) => n.id === trashedNoteId);
    if (!trashed) return;

    const notesDir = await getNotesDir();
    const fileName = getFileBaseName(trashed.trashFilePath);
    const restoredPath = `${notesDir}/${fileName}`;

    // Copy from .trash to notes dir — abort if this fails
    markOwnWrite(restoredPath);
    try {
      await copyFile(trashed.trashFilePath, restoredPath);
    } catch (err) {
      console.warn("Failed to restore note from trash:", err);
      return;
    }
    // Remove from .trash — orphan is harmless if this fails (auto-purged after 14d)
    try { await remove(trashed.trashFilePath); } catch { /* ignore */ }

    const content = await readTextFile(restoredPath);

    const restoredDoc: NoteDoc = {
      id: trashed.id,
      filePath: restoredPath,
      fileName: trashed.fileName,
      isDirty: false,
      content,
      createdAt: trashed.createdAt,
      updatedAt: trashed.updatedAt,
    };

    await leaveCurrentDoc();

    // Remove from trashed list BEFORE sortAndPersistDocs so saveManifest
    // reads the updated trashedNotesCache (without the restored note)
    if (setTrashedNotes) {
      setTrashedNotes((prev) => prev.filter((n) => n.id !== trashedNoteId));
      emitTrashUpdated(getTrashedNotesCache());
    }

    // Compute groups with restored note added back atomically
    // (avoids addNoteToGroup's stale-docs saveManifest overwrite)
    let restoredGroups = groupsRef.current ?? [];
    if (trashed.groupId) {
      const groupExists = restoredGroups.some((g) => g.id === trashed.groupId);
      if (groupExists) {
        restoredGroups = restoredGroups.map((g) => {
          if (g.id === trashed.groupId && !g.noteIds.includes(trashed.id)) {
            return { ...g, noteIds: [...g.noteIds, trashed.id] };
          }
          return g;
        });
        setGroups?.(restoredGroups);
        emitGroupsUpdated(restoredGroups);
      }
    }

    const prunedDocs = pruneEmptyCurrentDoc(docs);
    const nextDocs = [...prunedDocs, restoredDoc];
    sortAndPersistDocs(nextDocs, restoredDoc.id, notesSortOrder, setDocs, setActiveIndex, restoredGroups);
    emitDocCreated(restoredDoc);

    loadIntoEditor(tiptapRef, content);
    resetDocState(state, restoredPath, content);
    notifyActiveDocRef?.current?.(restoredDoc.id, restoredPath);
  }, [leaveCurrentDoc, docs, notesSortOrder, setActiveIndex, setDocs, setGroups, state, tiptapRef, setTrashedNotes]);

  const permanentlyDeleteNote = useCallback(async (trashedNoteId: string) => {
    const trashed = trashedNotesRef.current?.find((n) => n.id === trashedNoteId);
    if (!trashed) return;

    try { await remove(trashed.trashFilePath); } catch { /* already gone */ }

    if (setTrashedNotes) {
      setTrashedNotes((prev) => prev.filter((n) => n.id !== trashedNoteId));
      emitTrashUpdated(getTrashedNotesCache());
    }

    // Persist immediately — trash-only change, no sortAndPersistDocs to trigger it
    void saveManifest(docsRef.current, docsRef.current[activeIndexRef.current]?.id ?? null, groupsRef.current).catch(() => {});
  }, [setTrashedNotes]);

  const emptyTrash = useCallback(async () => {
    for (const trashed of trashedNotesRef.current ?? []) {
      try { await remove(trashed.trashFilePath); } catch { /* ignore */ }
    }

    if (setTrashedNotes) {
      setTrashedNotes([]);
      emitTrashUpdated([]);
    }

    // Persist immediately
    void saveManifest(docsRef.current, docsRef.current[activeIndexRef.current]?.id ?? null, groupsRef.current).catch(() => {});
  }, [setTrashedNotes]);

  return { importFile, importFiles, saveFile, saveFileAs, newNote, switchDocument, deleteNote, duplicateNote, exportNote, renameNote, restoreNote, permanentlyDeleteNote, emptyTrash };
}
