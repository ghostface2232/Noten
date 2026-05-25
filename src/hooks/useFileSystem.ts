import { useCallback, useRef } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readTextFile, writeTextFile, remove, copyFile } from "@tauri-apps/plugin-fs";
import { tauriFileSystem } from "../utils/fs";
import {
  getNotesDir,
  saveManifest,
  deriveTitle,
  sortNotes,
  getFileBaseName,
  ensureTrashDir,
  getTrashedNotesCache,
  markGroupAsDeleted,
  type NoteDoc,
  type NoteGroup,
  type TrashedNote,
} from "./useNotesLoader";
import type { MarkdownState } from "./useMarkdownState";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle } from "../utils/documentTitle";
import { removeNoteAssetDir } from "../utils/imageAssetUtils";
import { emitDocCreated, emitDocDeleted, emitDocRenamed, emitGroupsUpdated, emitNoteColorUpdated, emitNotePinnedUpdated, emitTrashUpdated } from "./useWindowSync";
import type { NoteColorId } from "../utils/noteColors";
import { markOwnWrite } from "./ownWriteTracker";
import { removeMeta as removeMetaFile } from "../utils/metadataIO";
import { logNotenError } from "../utils/crashLog";
import { NotenError } from "../utils/notenError";
import { t } from "../i18n";

export type { NoteDoc } from "./useNotesLoader";

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }];

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || "untitled.md";
}

function escapeRegexForRename(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Serializes manifest writes across all sortAndPersistDocs callers in this
// window. Without it, two rapid actions (e.g. delete + new note) fired their
// saves in parallel; the later one could finish first and the earlier one
// would then overwrite disk with its stale snapshot. Chaining preserves
// call-time ordering on disk while keeping the UI optimistic — the React
// state below still commits immediately.
let persistChain: Promise<unknown> = Promise.resolve();

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
  // Surface PERSIST_FAILED with the originating stage so a silent .catch()
  // can't hide a save failure from crashLog. The next persist call carries
  // the full latest state, so transient failures self-heal; permanent
  // failures (app closed before any subsequent save lands) at least leave a
  // diagnosable trail instead of vanishing.
  const job = persistChain
    .catch(() => undefined)
    .then(() => saveManifest(sortedDocs, activeId, groups));
  persistChain = job;
  void job.catch((err) => {
    void logNotenError(new NotenError(
      "PERSIST_FAILED",
      "fatal",
      err instanceof Error ? err.message : String(err),
      {
        context: { stage: "sortAndPersistDocs", docCount: sortedDocs.length, activeId },
        cause: err,
      },
    ));
  });
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
  toggleNotePinned: (index: number) => void;
  setNotesPinned: (noteIds: string[], pinned: boolean) => void;
  setNoteColor: (index: number, color: NoteColorId | null) => void;
  setNotesColor: (noteIds: string[], color: NoteColorId | null) => void;
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

    // Avoid parse/serialize churn from stamping updatedAt on clean documents.
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
    void getNotesDir().then((dir) => removeMetaFile(tauriFileSystem, dir, leavingId)).catch(() => {});
    setGroups?.((prev) => {
      const next = prev.map((g) => ({ ...g, noteIds: g.noteIds.filter((id) => id !== leavingId) }));
      const kept = next.filter((g) => g.noteIds.length > 0);
      if (kept.length !== next.length) {
        const keptIds = new Set(kept.map((g) => g.id));
        for (const g of next) if (!keptIds.has(g.id)) markGroupAsDeleted(g.id);
      }
      return kept;
    });
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

    markOwnWrite(targetPath, markdown);
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
    markOwnWrite(selected, markdown);
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

      const id = crypto.randomUUID();
      const timestamp = Date.now();
      let filePath: string;

      try {
        const notesDir = await getNotesDir();
        await mkdir(notesDir, { recursive: true }).catch(() => {});
        filePath = `${notesDir}/${id}.md`;
        markOwnWrite(filePath, content);
        await writeTextFile(filePath, content);
      } catch (error) {
        // Skip rather than pushing a ghost doc that points at a nonexistent
        // file. The source file is still on disk so the user can retry; a
        // loud SAVE_FAILED makes the failure diagnosable instead of vanishing
        // behind a DEV-only warning.
        void logNotenError(new NotenError(
          "SAVE_FAILED",
          "fatal",
          error instanceof Error ? error.message : String(error),
          {
            context: { stage: "importFiles", sourcePath, finalName },
            cause: error,
          },
        ));
        continue;
      }

      existingNames.add(finalName);
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

    // Provision the blank body BEFORE any destructive state changes. If the
    // write fails we want to leave the previous doc untouched rather than
    // commit a clean manifest entry pointing at a missing file.
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    let filePath: string;
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
      markOwnWrite(filePath, "");
      await writeTextFile(filePath, "");
    } catch (error) {
      void logNotenError(new NotenError(
        "SAVE_FAILED",
        "fatal",
        error instanceof Error ? error.message : String(error),
        {
          context: { stage: "newNote", noteId: id },
          cause: error,
        },
      ));
      return;
    }

    const inheritedGroupId = activeDocId
      ? (groupsRef.current?.find((g) => g.noteIds.includes(activeDocId))?.id ?? null)
      : null;

    const currentDoc = baseDocs[currentActiveIndex];
    const currentContent = currentDoc?.content.trim() ?? "";
    const willReplace = !!currentDoc && !currentContent && !currentDoc.customName;

    let prunedDocs = baseDocs;
    let workingGroups: NoteGroup[] | undefined = groupsRef.current;
    if (willReplace) {
      if (currentDoc.filePath) {
        try { markOwnWrite(currentDoc.filePath); remove(currentDoc.filePath).catch(() => {}); } catch {}
      }
      cancelDocSaveRef?.current?.(currentDoc.id);
      const leavingId = currentDoc.id;
      void getNotesDir().then((dir) => removeMetaFile(tauriFileSystem, dir, leavingId)).catch(() => {});
      const beforePrune = workingGroups
        ?.map((g) => ({ ...g, noteIds: g.noteIds.filter((noteId) => noteId !== leavingId) }));
      workingGroups = beforePrune
        ?.filter((g) => g.id === inheritedGroupId || g.noteIds.length > 0);
      if (beforePrune && workingGroups && beforePrune.length !== workingGroups.length) {
        const keptIds = new Set(workingGroups.map((g) => g.id));
        for (const g of beforePrune) if (!keptIds.has(g.id)) markGroupAsDeleted(g.id);
      }
      setGroups?.(workingGroups ?? []);
      prunedDocs = baseDocs.filter((d) => d.id !== currentDoc.id);
      setDocs(prunedDocs);
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
    };

    if (willReplace) {
      setTimeout(addNewDoc, 120);
    } else {
      addNewDoc();
    }
  }, [cancelDocSaveRef, getLiveDocsSnapshot, leaveCurrentDoc, locale, markDocClean, notesSortOrder, setActiveIndex, setDocs, setGroups, state, tiptapRef]);

  // Wiki-link creation path: provision a titled note without switching focus.
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
      markOwnWrite(filePath, "");
      await writeTextFile(filePath, "");
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("Failed to create note for wiki link:", error);
      }
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

    const group = getGroupForNote?.(doc.id) ?? null;

    if (doc.filePath) {
      try {
        const trashDir = await ensureTrashDir();
        const fileName = getFileBaseName(doc.filePath);
        const trashPath = `${trashDir}/${fileName}`;

        markOwnWrite(doc.filePath);
        await copyFile(doc.filePath, trashPath);
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
          pinned: doc.pinned === true,
          color: doc.color,
        };

        if (setTrashedNotes) {
          setTrashedNotes((prev) => [...prev, trashedNote]);
          emitTrashUpdated(getTrashedNotesCache());
        }
      } catch {
        // Abort deletion if the trash copy failed.
        if (import.meta.env.DEV) {
          console.warn("Failed to move note to trash, deletion aborted:", doc.filePath);
        }
        return;
      }
    }

    const nextDocs = baseDocs.filter((_, i) => i !== index);
    tiptapRef.current?.invalidateDocumentSession?.(doc.id, doc.filePath);
    emitDocDeleted(doc.id);

    const cleanedGroups = (groupsRef.current ?? []).map((g) =>
      g.noteIds.includes(doc.id)
        ? { ...g, noteIds: g.noteIds.filter((id) => id !== doc.id) }
        : g,
    );
    setGroups?.(cleanedGroups);
    emitGroupsUpdated(cleanedGroups);

    if (nextDocs.length === 0) {
      const id = crypto.randomUUID();
      const timestamp = Date.now();
      let filePath = "";
      let writeOk = false;
      try {
        const notesDir = await getNotesDir();
        filePath = `${notesDir}/${id}.md`;
        markOwnWrite(filePath, "");
        await writeTextFile(filePath, "");
        writeOk = true;
      } catch (error) {
        // The user just emptied the trash slot; we can't unwind the delete
        // above. Surface the failure and flag the replacement as dirty so the
        // manifest doesn't claim a clean entry that has no body on disk.
        void logNotenError(new NotenError(
          "SAVE_FAILED",
          "fatal",
          error instanceof Error ? error.message : String(error),
          {
            context: { stage: "deleteNote.replacement", noteId: id, filePath },
            cause: error,
          },
        ));
      }

      const newDoc: NoteDoc = {
        id,
        filePath,
        fileName: getDefaultDocumentTitle(locale),
        isDirty: !writeOk,
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
    const content = sourceDoc.content;
    let filePath: string;
    try {
      const notesDir = await getNotesDir();
      await mkdir(notesDir, { recursive: true }).catch(() => {});
      filePath = `${notesDir}/${id}.md`;
      markOwnWrite(filePath, content);
      await writeTextFile(filePath, content);
    } catch (error) {
      // Abort rather than committing a clean duplicate that lies about being
      // persisted. The source doc is unaffected, so the user can retry.
      void logNotenError(new NotenError(
        "SAVE_FAILED",
        "fatal",
        error instanceof Error ? error.message : String(error),
        {
          context: { stage: "duplicateNote", noteId: id, sourceId: sourceDoc.id },
          cause: error,
        },
      ));
      return;
    }

    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: sourceDoc.fileName,
      isDirty: false,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

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

    // Compute proposed rewrites without mutating memory yet; we only commit a
    // rewrite to the in-memory doc once its disk write lands, so memory stays
    // in sync with disk if a write fails.
    interface ProposedRewrite { docId: string; updated: string; filePath: string | null; isActive: boolean; }
    const proposed: ProposedRewrite[] = [];
    for (const entry of liveDocs) {
      if (entry.id === doc.id) continue;
      if (!entry.content.includes("[[")) continue;
      const updated = entry.content.replace(rewritePattern, replacement);
      if (updated === entry.content) continue;
      proposed.push({
        docId: entry.id,
        updated,
        filePath: entry.filePath || null,
        isActive: entry.id === activeDocId,
      });
    }

    const committed = new Set<string>();

    await Promise.all(proposed.map(async (rw) => {
      if (rw.isActive) return; // active doc handled below
      if (!rw.filePath) {
        // Memory-only doc — no disk to diverge from, safe to commit.
        committed.add(rw.docId);
        return;
      }
      try {
        markOwnWrite(rw.filePath, rw.updated);
        await writeTextFile(rw.filePath, rw.updated);
        committed.add(rw.docId);
      } catch (error) {
        void logNotenError(new NotenError(
          "SAVE_FAILED",
          "fatal",
          error instanceof Error ? error.message : String(error),
          {
            context: { stage: "renameNote.rewrite", noteId: rw.docId, filePath: rw.filePath },
            cause: error,
          },
        ));
      }
    }));

    const activeRewrite = proposed.find((rw) => rw.isActive) ?? null;
    let activeWriteOk = false;
    if (activeRewrite) {
      const activeDoc = liveDocs[currentActiveIndex];
      if (activeDoc?.filePath) {
        try {
          markOwnWrite(activeDoc.filePath, activeRewrite.updated);
          await writeTextFile(activeDoc.filePath, activeRewrite.updated);
          activeWriteOk = true;
        } catch (error) {
          void logNotenError(new NotenError(
            "SAVE_FAILED",
            "fatal",
            error instanceof Error ? error.message : String(error),
            {
              context: { stage: "renameNote.rewrite.active", noteId: activeDoc.id, filePath: activeDoc.filePath },
              cause: error,
            },
          ));
        }
      } else {
        // No file path on the active doc — memory only.
        activeWriteOk = true;
      }
      if (activeWriteOk) committed.add(activeRewrite.docId);
    }

    const proposedById = new Map(proposed.map((rw) => [rw.docId, rw]));
    const nextDocs = liveDocs.map((entry, i) => {
      if (i === index) {
        return { ...entry, fileName: trimmed, updatedAt: now, customName: true };
      }
      const rw = proposedById.get(entry.id);
      if (!rw || !committed.has(entry.id)) return entry;
      return { ...entry, content: rw.updated, updatedAt: now };
    });

    // Flip the editor only if the active doc's rewrite actually landed on
    // disk. Clearing isDirty when the write failed would mask the loss; an
    // unchanged editor + dirty flag lets autosave retry.
    if (activeRewrite && activeWriteOk) {
      const activeDoc = liveDocs[currentActiveIndex];
      tiptapRef.current?.openDocument?.({
        noteId: activeDoc?.id ?? null,
        filePath: activeDoc?.filePath ?? null,
        markdown: activeRewrite.updated,
        reason: "file-watch",
      });
      state.primeMarkdown(activeRewrite.updated);
      state.setIsDirty(false);
    }

    sortAndPersistDocs(nextDocs, doc.id, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    emitDocRenamed(doc.id, doc.filePath, doc.filePath, trimmed);
  }, [getLiveDocsSnapshot, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

  const toggleNotePinned = useCallback((index: number) => {
    const doc = docsRef.current[index];
    if (!doc) return;

    const activeId = docsRef.current[activeIndexRef.current]?.id ?? null;
    const nextPinned = !doc.pinned;
    const nextDocs = docsRef.current.map((entry, i) => (
      i === index ? { ...entry, pinned: nextPinned } : entry
    ));

    sortAndPersistDocs(nextDocs, activeId, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    emitNotePinnedUpdated(doc.id, nextPinned);
  }, [locale, notesSortOrder, setActiveIndex, setDocs]);

  const setNotesPinned = useCallback((noteIds: string[], pinned: boolean) => {
    const idSet = new Set(noteIds);
    if (!docsRef.current.some((d) => idSet.has(d.id) && (d.pinned === true) !== pinned)) return;

    const activeId = docsRef.current[activeIndexRef.current]?.id ?? null;
    const nextDocs = docsRef.current.map((entry) => (
      idSet.has(entry.id) ? { ...entry, pinned } : entry
    ));

    sortAndPersistDocs(nextDocs, activeId, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    for (const id of idSet) emitNotePinnedUpdated(id, pinned);
  }, [locale, notesSortOrder, setActiveIndex, setDocs]);

  // Color labels sync through meta without changing body updatedAt.
  const setNoteColor = useCallback((index: number, color: NoteColorId | null) => {
    const doc = docsRef.current[index];
    if (!doc || doc.color === (color ?? undefined)) return;

    const activeId = docsRef.current[activeIndexRef.current]?.id ?? null;
    const nextDocs = docsRef.current.map((entry, i) => (
      i === index ? { ...entry, color: color ?? undefined } : entry
    ));

    sortAndPersistDocs(nextDocs, activeId, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    emitNoteColorUpdated(doc.id, color);
  }, [locale, notesSortOrder, setActiveIndex, setDocs]);

  const setNotesColor = useCallback((noteIds: string[], color: NoteColorId | null) => {
    const idSet = new Set(noteIds);
    const next = color ?? undefined;
    if (!docsRef.current.some((d) => idSet.has(d.id) && d.color !== next)) return;

    const activeId = docsRef.current[activeIndexRef.current]?.id ?? null;
    const nextDocs = docsRef.current.map((entry) => (
      idSet.has(entry.id) ? { ...entry, color: next } : entry
    ));

    sortAndPersistDocs(nextDocs, activeId, notesSortOrder, locale, setDocs, setActiveIndex, groupsRef.current);
    for (const id of idSet) emitNoteColorUpdated(id, color);
  }, [locale, notesSortOrder, setActiveIndex, setDocs]);

  const restoreNote = useCallback(async (trashedNoteId: string) => {
    const trashed = trashedNotesRef.current?.find((n) => n.id === trashedNoteId);
    if (!trashed) return;

    const notesDir = await getNotesDir();
    const fileName = getFileBaseName(trashed.trashFilePath);
    const restoredPath = `${notesDir}/${fileName}`;

    markOwnWrite(restoredPath);
    try {
      await copyFile(trashed.trashFilePath, restoredPath);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn("Failed to restore note from trash:", err);
      }
      return;
    }
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
      pinned: trashed.pinned === true,
      color: trashed.color,
    };

    const { docs: liveDocs, activeDocId } = getLiveDocsSnapshot();
    const didPersistCurrentDoc = await leaveCurrentDoc();
    const baseDocs = didPersistCurrentDoc ? markDocClean(liveDocs, activeDocId) : liveDocs;

    if (setTrashedNotes) {
      setTrashedNotes((prev) => prev.filter((n) => n.id !== trashedNoteId));
      emitTrashUpdated(getTrashedNotesCache());
    }

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
      await removeMetaFile(tauriFileSystem, notesDir, trashed.id);
    } catch { /* ignore */ }

    if (setTrashedNotes) {
      setTrashedNotes((prev) => prev.filter((n) => n.id !== trashedNoteId));
      emitTrashUpdated(getTrashedNotesCache());
    }
    tiptapRef.current?.invalidateDocumentSession?.(trashed.id, trashed.originalFilePath);

    void saveManifest(docsRef.current, docsRef.current[activeIndexRef.current]?.id ?? null, groupsRef.current).catch(() => {});
  }, [setTrashedNotes, tiptapRef]);

  const emptyTrash = useCallback(async () => {
    const trashedSnapshot = trashedNotesRef.current ?? [];
    let notesDir: string | null = null;
    try { notesDir = await getNotesDir(); } catch { /* ignore */ }
    for (const trashed of trashedSnapshot) {
      try { await remove(trashed.trashFilePath); } catch { /* ignore */ }
      if (notesDir) {
        await removeNoteAssetDir(notesDir, trashed.id);
        await removeMetaFile(tauriFileSystem, notesDir, trashed.id);
      }
    }

    if (setTrashedNotes) {
      setTrashedNotes([]);
      emitTrashUpdated([]);
    }

    void saveManifest(docsRef.current, docsRef.current[activeIndexRef.current]?.id ?? null, groupsRef.current).catch(() => {});
  }, [setTrashedNotes]);

  return { importFile, importFiles, saveFile, saveFileAs, newNote, createNoteWithTitle, switchDocument, deleteNote, duplicateNote, exportNote, renameNote, toggleNotePinned, setNotesPinned, setNoteColor, setNotesColor, restoreNote, permanentlyDeleteNote, emptyTrash };
}
