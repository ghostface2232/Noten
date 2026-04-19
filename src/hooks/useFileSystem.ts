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
import { removeNoteAssetDir } from "../utils/imageAssetUtils";
import { emitDocCreated, emitDocDeleted, emitDocRenamed, emitGroupsUpdated, emitTrashUpdated } from "./useWindowSync";
import { markOwnWrite } from "./ownWriteTracker";
import { t } from "../i18n";

export type { NoteDoc } from "./useNotesLoader";

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }];

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || "untitled.md";
}

function escapeRegexForRename(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortAndPersistDocs(
  nextDocs: NoteDoc[],
  activeId: string | null,
  notesSortOrder: NotesSortOrder,
  locale: Locale,
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  groups?: NoteGroup[],
) {
  const sortedDocs = sortNotes(nextDocs, notesSortOrder, locale);
  const nextActiveIndex = activeId
    ? Math.max(sortedDocs.findIndex((doc) => doc.id === activeId), 0)
    : 0;

  setDocs(sortedDocs);
  setActiveIndex(nextActiveIndex);
  void saveManifest(sortedDocs, activeId, groups).catch(() => {});
}

export function getCurrentMarkdown(
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
): string {
  const editor = tiptapRef.current?.getEditor();
  return editor ? editor.getMarkdown() : "";
}

function resetDocState(
  state: MarkdownState,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  docId: string | null,
  filePath: string | null,
  content: string,
  reason: "init" | "switch" | "window-sync" | "file-watch" | "fallback" = "switch",
) {
  if (tiptapRef.current?.openDocument) {
    tiptapRef.current.openDocument({
      noteId: docId,
      filePath,
      markdown: content,
      reason,
    });
  } else {
    tiptapRef.current?.setDocumentContext(docId, filePath, false);
    tiptapRef.current?.setContent(content);
  }
  state.primeMarkdown(content);
  state.setFilePath(filePath);
  state.setIsDirty(false);
}

export interface FileSystemActions {
  importFile: () => Promise<void>;
  importFiles: (paths: string[]) => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  newNote: () => Promise<void>;
  createNoteWithTitle: (title: string) => Promise<string | null>;
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
  flushAutoSaveRef?: React.RefObject<(() => Promise<boolean>) | null>,
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
    if (!flushAutoSaveRef?.current) return !state.isDirty;
    return flushAutoSaveRef.current();
  }, [flushAutoSaveRef, state.isDirty]);

  const getLiveDocsSnapshot = useCallback((baseDocs: NoteDoc[] = docsRef.current) => {
    const currentActiveIndex = activeIndexRef.current;
    const activeDoc = baseDocs[currentActiveIndex];
    if (!activeDoc) {
      return { docs: baseDocs, activeDocId: null as string | null, activeIndex: currentActiveIndex };
    }

    // Only capture editor state into the snapshot when the user has actually
    // dirtied the doc. Otherwise, parse/serialize round-tripping in Tiptap can
    // make `editor.getMarkdown()` differ from the on-disk text in trivial ways
    // (trailing newlines, escape normalization, etc.), which would otherwise
    // stamp `updatedAt: Date.now()` on every doc switch and reorder the sidebar.
    if (!state.isDirty) {
      return { docs: baseDocs, activeDocId: activeDoc.id, activeIndex: currentActiveIndex };
    }

    const content = getCurrentMarkdown(tiptapRef);
    const fileName = activeDoc.customName
      ? activeDoc.fileName
      : deriveTitle(content) || activeDoc.fileName || getDefaultDocumentTitle(locale, baseDocs.map((doc) => doc.fileName));
    const contentChanged = activeDoc.content !== content;
    const titleChanged = activeDoc.fileName !== fileName;

    if (!contentChanged && !titleChanged) {
      return { docs: baseDocs, activeDocId: activeDoc.id, activeIndex: currentActiveIndex };
    }

    const nextDocs = [...baseDocs];
    nextDocs[currentActiveIndex] = {
      ...activeDoc,
      content,
      fileName,
      updatedAt: Date.now(),
      isDirty: state.isDirty,
    };

    return { docs: nextDocs, activeDocId: activeDoc.id, activeIndex: currentActiveIndex };
  }, [locale, state, tiptapRef]);

  const markDocClean = useCallback((baseDocs: NoteDoc[], docId: string | null) => {
    if (!docId) return baseDocs;
    return baseDocs.map((doc) => (
      doc.id === docId
        ? { ...doc, isDirty: false }
        : doc
    ));
  }, []);

  /** Remove the leaving doc if it's empty (no content, no customName, not the last doc).
   *  Returns the cleaned docs array. */
  const pruneEmptyCurrentDoc = useCallback((baseDocs: NoteDoc[], leavingDocId: string | null): NoteDoc[] => {
    if (!leavingDocId) return baseDocs;
    const leaving = baseDocs.find((d) => d.id === leavingDocId);
    if (!leaving) return baseDocs;
    const currentContent = leaving.content.trim();
    if (currentContent || leaving.customName || baseDocs.length <= 1) return baseDocs;

    if (leaving.filePath) {
      try { markOwnWrite(leaving.filePath); remove(leaving.filePath).catch(() => {}); } catch {}
    }
    const leavingId = leaving.id;
    setGroups?.((prev) =>
      prev.map((g) => ({ ...g, noteIds: g.noteIds.filter((id) => id !== leavingId) }))
        .filter((g) => g.noteIds.length > 0));
    cancelDocSaveRef?.current?.(leavingId);
    tiptapRef.current?.invalidateDocumentSession?.(leavingId, leaving.filePath);

    const pruned = baseDocs.filter((d) => d.id !== leavingDocId);
    setDocs(pruned);
    return pruned;
  }, [cancelDocSaveRef, setDocs, setGroups, tiptapRef]);

  const saveFile = useCallback(async () => {
    const doc = docs[activeIndex];
    if (!doc) return;

    const markdown = getCurrentMarkdown(tiptapRef);

    let targetPath = doc.filePath;
    if (!targetPath) {
      const selected = await save({ title: t("dialog.save", locale), filters: MD_FILTERS, defaultPath: `${doc.fileName}.md` });
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

    sortAndPersistDocs(nextDocs, doc.id, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    state.setIsDirty(false);
    state.primeMarkdown(markdown);
  }, [activeIndex, docs, locale, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const saveFileAs = useCallback(async () => {
    const markdown = getCurrentMarkdown(tiptapRef);
    const doc = docs[activeIndex];
    const defaultName = doc?.filePath ? getFileName(doc.filePath) : "untitled.md";
    const selected = await save({ title: t("dialog.export", locale), filters: MD_FILTERS, defaultPath: defaultName });
    if (!selected) return;
    markOwnWrite(selected);
    await writeTextFile(selected, markdown);
  }, [activeIndex, docs, locale, tiptapRef]);

  const importFiles = useCallback(async (paths: string[]) => {
    const sourcePaths = paths.filter(Boolean);
    if (sourcePaths.length === 0) return;

    const { docs: liveDocs, activeDocId } = getLiveDocsSnapshot();
    const didPersistCurrentDoc = await leaveCurrentDoc();
    const baseDocs = didPersistCurrentDoc ? markDocClean(liveDocs, activeDocId) : liveDocs;

    const existingNames = new Set(baseDocs.map((d) => d.fileName));
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
    const prunedDocs = pruneEmptyCurrentDoc(baseDocs, activeDocId);
    const nextDocs = [...prunedDocs, ...importedDocs];
    sortAndPersistDocs(nextDocs, lastImported.id, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    importedDocs.forEach((doc) => emitDocCreated(doc));

    resetDocState(state, tiptapRef, lastImported.id, lastImported.filePath, lastImported.content);
    notifyActiveDocRef?.current?.(lastImported.id, lastImported.filePath);
  }, [getLiveDocsSnapshot, leaveCurrentDoc, markDocClean, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef, pruneEmptyCurrentDoc]);

  const importFile = useCallback(async () => {
    const selected = await open({ filters: MD_FILTERS, multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    await importFiles(paths as string[]);
  }, [importFiles]);

  const newNote = useCallback(async () => {
    const { docs: liveDocs, activeDocId, activeIndex: currentActiveIndex } = getLiveDocsSnapshot();
    const didPersistCurrentDoc = await leaveCurrentDoc();
    const baseDocs = didPersistCurrentDoc ? markDocClean(liveDocs, activeDocId) : liveDocs;

    // If the active note lives in a group, the new note inherits that group.
    const inheritedGroupId = activeDocId
      ? (groupsRef.current?.find((g) => g.noteIds.includes(activeDocId))?.id ?? null)
      : null;

    // Check if current note is empty and should be replaced
    const currentDoc = baseDocs[currentActiveIndex];
    const currentContent = currentDoc?.content.trim() ?? "";
    const willReplace = !!currentDoc && !currentContent && !currentDoc.customName;

    // Remove current empty note (first render — sidebar sees deletion)
    let prunedDocs = baseDocs;
    // Track groups across the pruning step so we can fold the new note in
    // atomically with sortAndPersistDocs's saveManifest call.
    let workingGroups: NoteGroup[] | undefined = groupsRef.current;
    if (willReplace) {
      if (currentDoc.filePath) {
        try { markOwnWrite(currentDoc.filePath); remove(currentDoc.filePath).catch(() => {}); } catch {}
      }
      cancelDocSaveRef?.current?.(currentDoc.id);
      const leavingId = currentDoc.id;
      workingGroups = workingGroups
        ?.map((g) => ({ ...g, noteIds: g.noteIds.filter((noteId) => noteId !== leavingId) }))
        .filter((g) => g.id === inheritedGroupId || g.noteIds.length > 0);
      setGroups?.(workingGroups ?? []);
      prunedDocs = baseDocs.filter((d) => d.id !== currentDoc.id);
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
      // Fold the new note into the inherited group atomically so the
      // manifest saveManifest emits in sortAndPersistDocs is consistent.
      let nextGroups = workingGroups;
      if (inheritedGroupId && nextGroups) {
        const targetExists = nextGroups.some((g) => g.id === inheritedGroupId);
        if (targetExists) {
          nextGroups = nextGroups.map((g) =>
            g.id === inheritedGroupId && !g.noteIds.includes(id)
              ? { ...g, noteIds: [...g.noteIds, id] }
              : g,
          );
          setGroups?.(nextGroups);
          emitGroupsUpdated(nextGroups);
        }
      }
      sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, locale, setDocs, setActiveIndex, nextGroups);
      emitDocCreated(newDoc);
      resetDocState(state, tiptapRef, id, filePath, "");
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
  }, [cancelDocSaveRef, getLiveDocsSnapshot, leaveCurrentDoc, locale, markDocClean, notesSortOrder, setActiveIndex, setDocs, setGroups, state, tiptapRef]);

  // Create a note with an explicit title without switching away from the
  // currently focused document. Used by the wiki-link "create new" path so
  // the user can keep typing while the new note is provisioned in the
  // background. If a note with the same (case-insensitive) title already
  // exists, returns that note's id instead of creating a duplicate.
  const createNoteWithTitle = useCallback(async (rawTitle: string): Promise<string | null> => {
    const title = rawTitle.trim();
    if (!title) return null;

    const existing = docsRef.current.find(
      (doc) => doc.fileName.normalize("NFC").toLowerCase() === title.normalize("NFC").toLowerCase(),
    );
    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    let filePath = "";
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
      markOwnWrite(filePath);
      await writeTextFile(filePath, "");
    } catch (error) {
      console.warn("Failed to create note for wiki link:", error);
      return null;
    }

    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: title,
      isDirty: false,
      content: "",
      customName: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const { docs: liveDocs, activeDocId } = getLiveDocsSnapshot();
    const nextDocs = [...liveDocs, newDoc];
    sortAndPersistDocs(
      nextDocs,
      activeDocId,
      notesSortOrder,
      locale,
      setDocs,
      setActiveIndex,
      groupsRef.current,
    );
    emitDocCreated(newDoc);
    return id;
  }, [getLiveDocsSnapshot, locale, notesSortOrder, setActiveIndex, setDocs]);

  const switchDocument = useCallback(async (index: number) => {
    const { docs: liveDocs, activeDocId, activeIndex: currentActiveIndex } = getLiveDocsSnapshot();
    if (index === currentActiveIndex) return;
    if (index < 0 || index >= liveDocs.length) return;

    const didPersistCurrentDoc = await leaveCurrentDoc();
    const baseDocs = didPersistCurrentDoc ? markDocClean(liveDocs, activeDocId) : liveDocs;

    const targetDoc = baseDocs[index];
    const nextDocs = pruneEmptyCurrentDoc(baseDocs, activeDocId);
    let targetIndex = nextDocs.findIndex((d) => d.id === targetDoc.id);
    if (targetIndex < 0) targetIndex = 0;

    const target = nextDocs[targetIndex];
    setDocs(nextDocs);
    resetDocState(state, tiptapRef, target.id, target.filePath, target.content);
    notifyActiveDocRef?.current?.(target.id, target.filePath);
    setActiveIndex(targetIndex);
    void saveManifest(nextDocs, target.id, groupsRef.current).catch(() => {});
  }, [getLiveDocsSnapshot, leaveCurrentDoc, markDocClean, setActiveIndex, setDocs, state, tiptapRef, pruneEmptyCurrentDoc]);

  const deleteNote = useCallback(async (index: number) => {
    const { docs: liveDocs, activeDocId, activeIndex: currentActiveIndex } = getLiveDocsSnapshot();
    const doc = liveDocs[index];
    if (!doc) return;

    // Cancel any pending autosave timer for this doc to prevent orphan writes after deletion
    cancelDocSaveRef?.current?.(doc.id);

    // Flush pending auto-save so the on-disk file is up-to-date before trash copy
    const didPersistCurrentDoc = index === currentActiveIndex ? await leaveCurrentDoc() : false;
    const baseDocs = index === currentActiveIndex && didPersistCurrentDoc
      ? markDocClean(liveDocs, activeDocId)
      : liveDocs;

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

    const nextDocs = baseDocs.filter((_, i) => i !== index);
    tiptapRef.current?.invalidateDocumentSession?.(doc.id, doc.filePath);
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
      resetDocState(state, tiptapRef, id, filePath, "");
      notifyActiveDocRef?.current?.(id, filePath);
      void saveManifest([newDoc], newDoc.id, cleanedGroups).catch(() => {});
      return;
    }

    // Determine the next active document
    const wasActive = index === currentActiveIndex;
    let nextActiveId: string;

    if (wasActive) {
      const target = nextDocs[Math.min(index, nextDocs.length - 1)];
      nextActiveId = target.id;
      resetDocState(state, tiptapRef, target.id, target.filePath, target.content);
      notifyActiveDocRef?.current?.(target.id, target.filePath);
    } else {
      nextActiveId = baseDocs[currentActiveIndex].id;
    }

    sortAndPersistDocs(nextDocs, nextActiveId, notesSortOrder, locale, setDocs, setActiveIndex, cleanedGroups);
  }, [cancelDocSaveRef, getLiveDocsSnapshot, getGroupForNote, leaveCurrentDoc, locale, markDocClean, notesSortOrder, setActiveIndex, setDocs, setGroups, setTrashedNotes, state, tiptapRef]);

  const duplicateNote = useCallback(async (index: number) => {
    const { docs: liveDocs, activeDocId } = getLiveDocsSnapshot();
    const doc = liveDocs[index];
    if (!doc) return;

    const didPersistCurrentDoc = await leaveCurrentDoc();
    const baseDocs = didPersistCurrentDoc ? markDocClean(liveDocs, activeDocId) : liveDocs;
    const sourceDoc = baseDocs[index];
    if (!sourceDoc) return;

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    let filePath = "";
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
    } catch { /* ignore */ }

    const content = sourceDoc.content;
    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: sourceDoc.fileName,
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

    const prunedDocs = pruneEmptyCurrentDoc(baseDocs, activeDocId);
    const nextDocs = [...prunedDocs, newDoc];
    sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    resetDocState(state, tiptapRef, newDoc.id, filePath, content);
    notifyActiveDocRef?.current?.(newDoc.id, filePath);
  }, [getLiveDocsSnapshot, leaveCurrentDoc, markDocClean, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef, pruneEmptyCurrentDoc]);

  const exportNote = useCallback(async (index: number) => {
    const doc = docs[index];
    if (!doc) return;

    const defaultName = doc.filePath ? getFileName(doc.filePath) : `${doc.fileName}.md`;
    const selected = await save({ title: t("dialog.export", locale), filters: MD_FILTERS, defaultPath: defaultName });
    if (!selected) return;

    const content = index === activeIndex ? getCurrentMarkdown(tiptapRef) : doc.content;
    await writeTextFile(selected, content);
  }, [activeIndex, docs, locale, tiptapRef]);

  const renameNote = useCallback(async (index: number, newName: string) => {
    const { docs: liveDocs, activeDocId, activeIndex: currentActiveIndex } = getLiveDocsSnapshot();
    const doc = liveDocs[index];
    if (!doc) return;

    const trimmed = newName.trim();
    if (!trimmed || trimmed === doc.fileName) return;

    const oldName = doc.fileName;
    // Case-insensitive match — bracketed form `[[OldTitle]]` is the fenced
    // delimiter, so we don't need word boundaries. Case-insensitive so
    // `[[foo]]`, `[[Foo]]`, `[[FOO]]` all update together, and the new
    // casing from `trimmed` replaces whatever was matched.
    const rewritePattern = new RegExp(
      `\\[\\[${escapeRegexForRename(oldName)}\\]\\]`,
      "gi",
    );
    const replacement = `[[${trimmed}]]`;
    const now = Date.now();

    let activeRewrittenContent: string | null = null;
    const diskWrites: Array<{ filePath: string; content: string }> = [];

    const nextDocs = liveDocs.map((entry, i) => {
      if (i === index) {
        return { ...entry, fileName: trimmed, updatedAt: now, customName: true };
      }
      if (!entry.content.includes("[[")) return entry;
      const updated = entry.content.replace(rewritePattern, replacement);
      if (updated === entry.content) return entry;

      if (entry.id === activeDocId) {
        activeRewrittenContent = updated;
        // Active doc is flushed through the editor (below), not direct disk write.
        return { ...entry, content: updated, updatedAt: now };
      }
      if (entry.filePath) {
        diskWrites.push({ filePath: entry.filePath, content: updated });
      }
      return { ...entry, content: updated, updatedAt: now };
    });

    await Promise.all(
      diskWrites.map(async (write) => {
        try {
          markOwnWrite(write.filePath);
          await writeTextFile(write.filePath, write.content);
        } catch {
          console.warn("Failed to rewrite wiki links in note:", write.filePath);
        }
      }),
    );

    if (activeRewrittenContent !== null) {
      const activeDoc = liveDocs[currentActiveIndex];
      if (activeDoc?.filePath) {
        try {
          markOwnWrite(activeDoc.filePath);
          await writeTextFile(activeDoc.filePath, activeRewrittenContent);
        } catch {
          console.warn("Failed to persist rewritten wiki links for active note.");
        }
      }
      tiptapRef.current?.openDocument?.({
        noteId: activeDoc?.id ?? null,
        filePath: activeDoc?.filePath ?? null,
        markdown: activeRewrittenContent,
        reason: "file-watch",
      });
      state.primeMarkdown(activeRewrittenContent);
      state.setIsDirty(false);
    }

    sortAndPersistDocs(nextDocs, doc.id, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    emitDocRenamed(doc.id, doc.filePath, doc.filePath, trimmed);
  }, [getLiveDocsSnapshot, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

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

    const { docs: liveDocs, activeDocId } = getLiveDocsSnapshot();
    const didPersistCurrentDoc = await leaveCurrentDoc();
    const baseDocs = didPersistCurrentDoc ? markDocClean(liveDocs, activeDocId) : liveDocs;

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

    const prunedDocs = pruneEmptyCurrentDoc(baseDocs, activeDocId);
    const nextDocs = [...prunedDocs, restoredDoc];
    sortAndPersistDocs(nextDocs, restoredDoc.id, notesSortOrder, locale, setDocs, setActiveIndex, restoredGroups);
    emitDocCreated(restoredDoc);

    resetDocState(state, tiptapRef, restoredDoc.id, restoredPath, content);
    notifyActiveDocRef?.current?.(restoredDoc.id, restoredPath);
  }, [getLiveDocsSnapshot, leaveCurrentDoc, markDocClean, notesSortOrder, setActiveIndex, setDocs, setGroups, setTrashedNotes, state, tiptapRef, pruneEmptyCurrentDoc]);

  const permanentlyDeleteNote = useCallback(async (trashedNoteId: string) => {
    const trashed = trashedNotesRef.current?.find((n) => n.id === trashedNoteId);
    if (!trashed) return;

    try { await remove(trashed.trashFilePath); } catch { /* already gone */ }
    try {
      const notesDir = await getNotesDir();
      await removeNoteAssetDir(notesDir, trashed.id);
    } catch { /* ignore */ }

    if (setTrashedNotes) {
      setTrashedNotes((prev) => prev.filter((n) => n.id !== trashedNoteId));
      emitTrashUpdated(getTrashedNotesCache());
    }
    tiptapRef.current?.invalidateDocumentSession?.(trashed.id, trashed.originalFilePath);

    // Persist immediately — trash-only change, no sortAndPersistDocs to trigger it
    void saveManifest(docsRef.current, docsRef.current[activeIndexRef.current]?.id ?? null, groupsRef.current).catch(() => {});
  }, [setTrashedNotes, tiptapRef]);

  const emptyTrash = useCallback(async () => {
    const trashedSnapshot = trashedNotesRef.current ?? [];
    let notesDir: string | null = null;
    try { notesDir = await getNotesDir(); } catch { /* ignore */ }
    for (const trashed of trashedSnapshot) {
      try { await remove(trashed.trashFilePath); } catch { /* ignore */ }
      if (notesDir) await removeNoteAssetDir(notesDir, trashed.id);
    }

    if (setTrashedNotes) {
      setTrashedNotes([]);
      emitTrashUpdated([]);
    }

    // Persist immediately
    void saveManifest(docsRef.current, docsRef.current[activeIndexRef.current]?.id ?? null, groupsRef.current).catch(() => {});
  }, [setTrashedNotes]);

  return { importFile, importFiles, saveFile, saveFileAs, newNote, createNoteWithTitle, switchDocument, deleteNote, duplicateNote, exportNote, renameNote, restoreNote, permanentlyDeleteNote, emptyTrash };
}
