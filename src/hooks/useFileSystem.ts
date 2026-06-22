import { useCallback, useRef } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, readTextFile, writeTextFile, remove, copyFile } from "@tauri-apps/plugin-fs";
import { tauriFileSystem } from "../utils/fs";
import { atomicWriteText } from "../utils/atomicWrite";
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
import { setKnownDiskContent } from "../utils/conflictBackup";
import { removeMeta as removeMetaFile, readMeta, writeMeta, type NoteMeta } from "../utils/metadataIO";
import { getMachineIdCached } from "../utils/machineId";
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
  // Ordering + PERSIST_FAILED logging are handled inside saveManifest's
  // own persistChain; callers just enqueue and stay non-blocking. The source
  // tag travels through to the crashLog so the failure is still traceable
  // to this entry point.
  void saveManifest(sortedDocs, activeId, groups, "sortAndPersistDocs").catch(() => {});
}

export function getCurrentMarkdown(
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
): string {
  const editor = tiptapRef.current?.getEditor();
  return editor ? editor.getMarkdown() : "";
}

// Standard "create a new note file" recipe (notes-dir resolve, mkdir,
// markOwnWrite, writeTextFile) with the SAVE_FAILED logging that every caller
// repeated. Returns the would-be filePath and whether the write landed, so a
// caller can either abort on `!ok` or commit a dirty doc pointing at the path.
async function provisionNoteFile(
  id: string,
  content: string,
  stage: string,
  extraContext: Record<string, unknown> = {},
): Promise<{ filePath: string; ok: boolean }> {
  let filePath = "";
  try {
    const notesDir = await getNotesDir();
    await mkdir(notesDir, { recursive: true }).catch(() => {});
    filePath = `${notesDir}/${id}.md`;
    markOwnWrite(filePath, content);
    await atomicWriteText(tauriFileSystem, filePath, content, { failClosed: true });
    return { filePath, ok: true };
  } catch (error) {
    void logNotenError(new NotenError(
      "SAVE_FAILED",
      "fatal",
      error instanceof Error ? error.message : String(error),
      {
        context: { stage, noteId: id, filePath, ...extraContext },
        cause: error,
      },
    ));
    return { filePath, ok: false };
  }
}

// Same SAVE_FAILED contract for writes to an existing note file (rename
// rewrites). Returns whether the write landed so callers can gate the
// in-memory commit on disk success.
async function rewriteNoteFile(
  filePath: string,
  content: string,
  stage: string,
  noteId: string,
): Promise<boolean> {
  try {
    markOwnWrite(filePath, content);
    await atomicWriteText(tauriFileSystem, filePath, content, { failClosed: true });
    // Keep the conflict-backup baseline in sync, or the next autosave of this
    // doc would treat our own rewrite as an unseen remote write and back it
    // up to .conflicts.
    setKnownDiskContent(filePath, content);
    return true;
  } catch (error) {
    void logNotenError(new NotenError(
      "SAVE_FAILED",
      "fatal",
      error instanceof Error ? error.message : String(error),
      {
        context: { stage, noteId, filePath },
        cause: error,
      },
    ));
    return false;
  }
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

function focusEditor(tiptapRef: React.RefObject<TiptapEditorHandle | null>) {
  tiptapRef.current?.focus?.();
}

export interface FileSystemActions {
  importFile: () => Promise<void>;
  importFiles: (paths: string[]) => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  newNote: () => Promise<void>;
  createNoteWithTitle: (title: string) => Promise<string | null>;
  switchDocument: (index: number) => Promise<void>;
  /** Both return the ids actually moved to .trash, so callers can offer undo. */
  deleteNote: (index: number) => Promise<string[]>;
  deleteNotes: (noteIds: string[]) => Promise<string[]>;
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
  captureAndQueueSaveRef?: React.RefObject<(() => void) | null>,
  flushDocSaveRef?: React.RefObject<((docId: string) => Promise<boolean>) | null>,
): FileSystemActions {
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const trashedNotesRef = useRef(trashedNotes);
  trashedNotesRef.current = trashedNotes;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const newNoteInFlightRef = useRef(false);

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

  const pruneEmptyCurrentDoc = useCallback(async (baseDocs: NoteDoc[], leavingDocId: string | null): Promise<NoteDoc[]> => {
    if (!leavingDocId) return baseDocs;
    const leaving = baseDocs.find((d) => d.id === leavingDocId);
    if (!leaving) return baseDocs;
    const currentContent = leaving.content.trim();
    // The docs list can lag the live editor: autosave just committed (isDirty
    // false) but the user typed once more before triggering the switch. Every
    // caller passes the doc the editor is still showing at this point, so
    // consult the editor directly — pruning on the stale list alone would
    // remove the file while a queued background save for it exists, and the
    // cancelDocSave below would then drop that save, losing the input.
    const liveContent = getCurrentMarkdown(tiptapRef).trim();
    if (currentContent || liveContent || leaving.customName || baseDocs.length <= 1) return baseDocs;

    // Order matters: remove the .md BEFORE the .meta. The reverse order
    // (meta gone, body still present) is the dangerous one — the watcher's
    // reconcileFolder treats a body without a sidecar as an unmanaged file
    // and re-ingests it as a fresh doc with groupId: null, which surfaces as
    // "the deleted note reappeared outside its group". Awaiting both also
    // serializes them against the upcoming saveManifest's readAllMeta, which
    // was racing the fire-and-forget removeMeta and surfacing as
    // PERSIST_FAILED / RECONCILE_FAILED "os error 2" on .meta/<id>.json.
    if (leaving.filePath) {
      try { markOwnWrite(leaving.filePath); await remove(leaving.filePath); } catch { /* already gone or locked; reconcile recovers */ }
    }
    const leavingId = leaving.id;
    try {
      const dir = await getNotesDir();
      await removeMetaFile(tauriFileSystem, dir, leavingId);
    } catch { /* ignore — already gone or unreachable */ }
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
    try {
      await atomicWriteText(tauriFileSystem, targetPath, markdown, { failClosed: true });
    } catch (error) {
      // Fail-closed: the body could not be written atomically. Leave the doc
      // dirty (do NOT mark clean below) so the change is not silently lost.
      void logNotenError(new NotenError(
        "SAVE_FAILED",
        "fatal",
        error instanceof Error ? error.message : String(error),
        { context: { stage: "saveFile", noteId: doc.id, filePath: targetPath }, cause: error },
      ));
      return;
    }

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
      let content: string;
      try {
        content = await readTextFile(sourcePath);
      } catch (error) {
        // A transient read failure on a single source file must not abort
        // the whole batch: any files already written above would then be on
        // disk without a manifest entry until next reload reconciles. Log,
        // skip this file, keep importing the rest.
        void logNotenError(new NotenError(
          "BODY_READ_FAILED",
          "recoverable",
          error instanceof Error ? error.message : String(error),
          {
            context: { stage: "importFiles", sourcePath },
            cause: error,
          },
        ));
        continue;
      }
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

      // Skip rather than pushing a ghost doc that points at a nonexistent
      // file. The source file is still on disk so the user can retry.
      const { filePath, ok } = await provisionNoteFile(id, content, "importFiles", { sourcePath, finalName });
      if (!ok) continue;

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
    const prunedDocs = await pruneEmptyCurrentDoc(baseDocs, activeDocId);
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
    if (newNoteInFlightRef.current) return;
    newNoteInFlightRef.current = true;
    try {
      // Click-handler sync portion MUST stay minimal — Chrome's "click handler
      // took Xms" violation measures everything until the first macrotask
      // yield, and editor.getMarkdown() can be 100–150ms on docs with custom
      // NodeViews (Mermaid, WikiLink, ImageView). So:
      //   - skip getLiveDocsSnapshot here (it calls getMarkdown when isDirty)
      //   - defer captureAndQueueSave to after the first await (the snapshot
      //     it captures is still correct as long as resetDocState hasn't run)
      //   - read baseDocs/groups straight from refs
      const baseDocs = docsRef.current;
      const currentActiveIndex = activeIndexRef.current;
      const currentDoc = baseDocs[currentActiveIndex] ?? null;
      const activeDocId = currentDoc?.id ?? null;

      // willReplace check: only consult the editor when the stored content is
      // empty AND state is dirty (i.e. user may have typed since last
      // autosave). Otherwise the stored .content already tells us non-empty,
      // and we can skip the serialization.
      let willReplace = false;
      if (currentDoc && !currentDoc.customName && currentDoc.content.trim() === "") {
        const liveContent = state.isDirty ? getCurrentMarkdown(tiptapRef).trim() : "";
        willReplace = liveContent === "";
      }

      const id = crypto.randomUUID();
      const timestamp = Date.now();
      // Provision the new file BEFORE any destructive state changes — first
      // await of the function, also the macrotask yield that closes the click
      // handler's sync portion. If the write fails the previous doc is left
      // untouched.
      const { filePath, ok } = await provisionNoteFile(id, "", "newNote");
      if (!ok) return;

      // captureAndQueueSave runs AFTER provisionNoteFile so its getMarkdown
      // call lands in a continuation microtask instead of the click handler's
      // sync portion. The editor still points at the leaving doc here
      // (resetDocState below hasn't run yet), so the snapshot captures the
      // right content. willReplace skips this entirely — the leaving body is
      // empty and is about to be deleted.
      if (!willReplace) {
        if (captureAndQueueSaveRef?.current) {
          captureAndQueueSaveRef.current();
        } else {
          // Fallback for environments where the ref wasn't wired (tests).
          await leaveCurrentDoc();
        }
      } else if (currentDoc) {
        cancelDocSaveRef?.current?.(currentDoc.id);
      }

      const inheritedGroupId = activeDocId
        ? (groupsRef.current?.find((g) => g.noteIds.includes(activeDocId))?.id ?? null)
        : null;

      let prunedDocs = baseDocs;
      let workingGroups: NoteGroup[] | undefined = groupsRef.current;
      if (willReplace && currentDoc) {
        const leavingId = currentDoc.id;
        const beforePrune = workingGroups
          ?.map((g) => ({ ...g, noteIds: g.noteIds.filter((noteId) => noteId !== leavingId) }));
        workingGroups = beforePrune
          ?.filter((g) => g.id === inheritedGroupId || g.noteIds.length > 0);
        if (beforePrune && workingGroups && beforePrune.length !== workingGroups.length) {
          const keptIds = new Set(workingGroups.map((g) => g.id));
          for (const g of beforePrune) if (!keptIds.has(g.id)) markGroupAsDeleted(g.id);
        }
        prunedDocs = baseDocs.filter((d) => d.id !== currentDoc.id);
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
        }
      }
      // Commit groups in ONE setGroups so willReplace's prune and the new
      // doc's add land in the same React commit (previously two separate
      // setGroups calls produced a brief "no group" frame mid-flow).
      if (nextGroups !== groupsRef.current) {
        setGroups?.(nextGroups ?? []);
        emitGroupsUpdated(nextGroups ?? []);
      }
      sortAndPersistDocs(nextDocs, newDoc.id, notesSortOrder, locale, setDocs, setActiveIndex, nextGroups);
      emitDocCreated(newDoc);
      resetDocState(state, tiptapRef, id, filePath, "");
      notifyActiveDocRef?.current?.(id, filePath);
      focusEditor(tiptapRef);

      // willReplace disk cleanup runs AFTER state commits, fire-and-forget.
      // Safe to not await because:
      //   - readAllMeta is TOCTOU-tolerant (metadataIO.ts), so a saveManifest
      //     racing this removeMeta no longer surfaces PERSIST_FAILED
      //   - hydrateGroupMembershipFromMeta preserves in-memory grouping for
      //     live docs without on-disk meta, so a watcher reconcile firing
      //     mid-cleanup can't yank the new doc out of its group
      //   - .md is removed before .meta, so the bodyless-meta path in
      //     reconcileFolder (with its 2-pass grace) absorbs any orphan
      // Cancellation of the leaving doc's autosave already happened above.
      if (willReplace && currentDoc?.filePath) {
        const leavingFilePath = currentDoc.filePath;
        const leavingId = currentDoc.id;
        void (async () => {
          try { markOwnWrite(leavingFilePath); await remove(leavingFilePath); } catch { /* already gone or locked; reconcile recovers */ }
          try {
            const dir = await getNotesDir();
            await removeMetaFile(tauriFileSystem, dir, leavingId);
          } catch { /* ignore — already gone or unreachable */ }
        })();
      }
    } finally {
      newNoteInFlightRef.current = false;
    }
  }, [cancelDocSaveRef, captureAndQueueSaveRef, leaveCurrentDoc, locale, notesSortOrder, setActiveIndex, setDocs, setGroups, state, tiptapRef]);

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
    const { filePath, ok } = await provisionNoteFile(id, "", "createNoteWithTitle", { title });
    if (!ok) return null;

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

    // Fast path: the leaving doc is non-empty (or pinned by customName), so
    // pruneEmptyCurrentDoc below will not race the autosave. Fire the save
    // synchronously (snapshot is captured in-band, doSave runs in background)
    // and switch immediately. doSave gates each write on the live docs list
    // and activeDocRef, so writing after the switch still hits the correct
    // path; window close awaits in-flight saves via flushAutoSave.
    //
    // Slow path: the leaving doc is empty + auto-titled. pruneEmptyCurrentDoc
    // will remove its file, so we must serialize the save BEFORE the prune to
    // avoid a "save resurrects a deleted file" race.
    //
    // Emptiness MUST be checked against the live editor — leaving.content in
    // liveDocs can lag the editor when state.isDirty is false (autosave just
    // committed) but the user has typed one more char before clicking. Trusting
    // the stale liveDocs would mis-route to the fast path, queue a background
    // save with the real (non-empty) content, and pruneEmptyCurrentDoc would
    // simultaneously delete the file — a guaranteed race.
    const leavingDoc = liveDocs[currentActiveIndex];
    const leavingHasContent = !!leavingDoc
      && (
        leavingDoc.content.trim() !== ""
        || getCurrentMarkdown(tiptapRef).trim() !== ""
      );
    const isPruneCandidate = !!leavingDoc
      && !leavingHasContent
      && !leavingDoc.customName
      && liveDocs.length > 1;

    // Slow path absorbs both (a) prune candidates that need save-before-delete
    // serialization and (b) the defensive case where the capture ref hasn't
    // been wired yet (shouldn't happen in App.tsx — the ref is assigned every
    // render — but the optional chain keeps this resilient to future refactors).
    let baseDocs: NoteDoc[];
    if (isPruneCandidate || !captureAndQueueSaveRef?.current) {
      const didPersistCurrentDoc = await leaveCurrentDoc();
      baseDocs = didPersistCurrentDoc ? markDocClean(liveDocs, activeDocId) : liveDocs;
    } else {
      captureAndQueueSaveRef.current();
      baseDocs = liveDocs;
    }

    const targetDoc = baseDocs[index];
    const nextDocs = await pruneEmptyCurrentDoc(baseDocs, activeDocId);
    let targetIndex = nextDocs.findIndex((d) => d.id === targetDoc.id);
    if (targetIndex < 0) targetIndex = 0;

    const target = nextDocs[targetIndex];
    setDocs(nextDocs);
    resetDocState(state, tiptapRef, target.id, target.filePath, target.content);
    notifyActiveDocRef?.current?.(target.id, target.filePath);
    setActiveIndex(targetIndex);
    void saveManifest(nextDocs, target.id, groupsRef.current).catch(() => {});
  }, [captureAndQueueSaveRef, getLiveDocsSnapshot, leaveCurrentDoc, markDocClean, setActiveIndex, setDocs, state, tiptapRef, pruneEmptyCurrentDoc]);

  // Batch delete core. The per-note trash I/O runs sequentially, but the doc
  // list / groups / trash list / active-doc handoff commit exactly ONCE at the
  // end. Firing N independent deleteNote calls without awaiting (the old bulk
  // path) let every call snapshot the same stale docs array in the same
  // microtask; last-writer-wins setDocs then resurrected N-1 ghost rows whose
  // files were already in .trash.
  //
  // Returns the ids that actually landed in the trash, so the caller can offer
  // an undo. Notes whose autosave flush or trash copy failed are skipped (not
  // deleted) rather than aborting the rest of the batch.
  const deleteNotes = useCallback(async (noteIds: string[]): Promise<string[]> => {
    const requested: NoteDoc[] = [];
    const seen = new Set<string>();
    for (const id of noteIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const doc = docsRef.current.find((d) => d.id === id);
      if (doc) requested.push(doc);
    }
    if (requested.length === 0) return [];

    // Flush in-flight saves first; a failed flush means the on-disk body may
    // be stale, so trashing it would lose the unsaved edits.
    const flushed: NoteDoc[] = [];
    for (const doc of requested) {
      const didFlush = await flushDocSaveRef?.current?.(doc.id);
      if (didFlush === false) continue;
      flushed.push(doc);
    }
    if (flushed.length === 0) return [];

    const { docs: liveDocs, activeDocId, activeIndex: currentActiveIndex } = getLiveDocsSnapshot();
    const targets = flushed
      .map((d) => liveDocs.find((entry) => entry.id === d.id))
      .filter((d): d is NoteDoc => d !== undefined);
    if (targets.length === 0) return [];

    // Cancel pending autosave timers to prevent orphan writes after deletion.
    for (const doc of targets) cancelDocSaveRef?.current?.(doc.id);

    // Flush pending auto-save so the on-disk file is up-to-date before trash copy
    const deletingActive = activeDocId !== null && targets.some((d) => d.id === activeDocId);
    const didPersistCurrentDoc = deletingActive ? await leaveCurrentDoc() : false;
    const baseDocs = deletingActive && didPersistCurrentDoc
      ? markDocClean(liveDocs, activeDocId)
      : liveDocs;

    const trashedNotes: TrashedNote[] = [];
    const deletedIds = new Set<string>();
    for (const doc of targets) {
      if (doc.filePath) {
        try {
          const trashDir = await ensureTrashDir();
          const fileName = getFileBaseName(doc.filePath);
          const trashPath = `${trashDir}/${fileName}`;

          markOwnWrite(doc.filePath);
          await copyFile(doc.filePath, trashPath);
          try { await remove(doc.filePath); } catch { /* original stays; reconcile picks it up */ }

          trashedNotes.push({
            id: doc.id,
            fileName: doc.fileName,
            originalFilePath: doc.filePath,
            trashFilePath: trashPath,
            trashedAt: Date.now(),
            groupId: getGroupForNote?.(doc.id)?.id ?? null,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            pinned: doc.pinned === true,
            color: doc.color,
          });
        } catch {
          // Skip this note if the trash copy failed; the rest of the batch
          // proceeds. The skipped note stays in the list untouched.
          if (import.meta.env.DEV) {
            console.warn("Failed to move note to trash, deletion aborted:", doc.filePath);
          }
          continue;
        }
      }
      deletedIds.add(doc.id);
    }
    if (deletedIds.size === 0) return [];

    if (setTrashedNotes && trashedNotes.length > 0) {
      setTrashedNotes((prev) => [...prev, ...trashedNotes]);
      emitTrashUpdated(getTrashedNotesCache());
    }

    const nextDocs = baseDocs.filter((entry) => !deletedIds.has(entry.id));
    for (const doc of targets) {
      if (!deletedIds.has(doc.id)) continue;
      tiptapRef.current?.invalidateDocumentSession?.(doc.id, doc.filePath);
      emitDocDeleted(doc.id);
    }

    const cleanedGroups = (groupsRef.current ?? []).map((g) =>
      g.noteIds.some((id) => deletedIds.has(id))
        ? { ...g, noteIds: g.noteIds.filter((id) => !deletedIds.has(id)) }
        : g,
    );
    setGroups?.(cleanedGroups);
    emitGroupsUpdated(cleanedGroups);

    const deletedList = Array.from(deletedIds);

    if (nextDocs.length === 0) {
      const id = crypto.randomUUID();
      const timestamp = Date.now();
      // The user just emptied the note list; we can't unwind the deletes above.
      // On write failure, surface SAVE_FAILED and flag the replacement as
      // dirty so the manifest doesn't claim a clean entry with no body on disk.
      const { filePath, ok: writeOk } = await provisionNoteFile(id, "", "deleteNote.replacement");

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
      return deletedList;
    }

    const activeDeleted = activeDocId !== null && deletedIds.has(activeDocId);
    let nextActiveId: string;

    if (activeDeleted) {
      // Hand off to the nearest survivor at or after the old active position,
      // falling back to the nearest one before it.
      let replacement: NoteDoc | undefined;
      for (let i = currentActiveIndex; i < baseDocs.length; i++) {
        if (!deletedIds.has(baseDocs[i].id)) { replacement = baseDocs[i]; break; }
      }
      if (!replacement) {
        for (let i = Math.min(currentActiveIndex, baseDocs.length - 1); i >= 0; i--) {
          if (!deletedIds.has(baseDocs[i].id)) { replacement = baseDocs[i]; break; }
        }
      }
      const target = replacement ?? nextDocs[nextDocs.length - 1];
      nextActiveId = target.id;
      resetDocState(state, tiptapRef, target.id, target.filePath, target.content);
      notifyActiveDocRef?.current?.(target.id, target.filePath);
    } else {
      nextActiveId = activeDocId ?? nextDocs[0].id;
    }

    sortAndPersistDocs(nextDocs, nextActiveId, notesSortOrder, locale, setDocs, setActiveIndex, cleanedGroups);
    return deletedList;
  }, [cancelDocSaveRef, flushDocSaveRef, getLiveDocsSnapshot, getGroupForNote, leaveCurrentDoc, locale, markDocClean, notesSortOrder, setActiveIndex, setDocs, setGroups, setTrashedNotes, state, tiptapRef]);

  const deleteNote = useCallback(async (index: number): Promise<string[]> => {
    const doc = docsRef.current[index];
    if (!doc) return [];
    return deleteNotes([doc.id]);
  }, [deleteNotes]);

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
    // Abort rather than committing a clean duplicate that lies about being
    // persisted. The source doc is unaffected, so the user can retry.
    const { filePath, ok } = await provisionNoteFile(id, content, "duplicateNote", { sourceId: sourceDoc.id });
    if (!ok) return;

    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: sourceDoc.fileName,
      isDirty: false,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const prunedDocs = await pruneEmptyCurrentDoc(baseDocs, activeDocId);
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

    // Settle the autosave machine for every doc we may rewrite BEFORE touching
    // disk: an in-flight or stranded doSave landing after the rewrite would
    // overwrite it with pre-rename content while memory keeps the rewritten
    // body (isDirty false), silently splitting memory from disk. For the
    // active doc, captureAndQueueSave also disarms the debounce timer so it
    // can't fire mid-rename with the pre-rewrite editor content.
    const candidates = liveDocs.filter(
      (entry) => entry.id !== doc.id && entry.content.includes("[["),
    );
    const flushFailed = new Set<string>();
    for (const entry of candidates) {
      if (entry.id === activeDocId) captureAndQueueSaveRef?.current?.();
      const flushed = await flushDocSaveRef?.current?.(entry.id);
      if (flushed === false) flushFailed.add(entry.id);
    }

    // Compute proposed rewrites without mutating memory yet; we only commit a
    // rewrite to the in-memory doc once its disk write lands, so memory stays
    // in sync with disk if a write fails.
    interface ProposedRewrite { docId: string; updated: string; filePath: string | null; isActive: boolean; }
    const proposed: ProposedRewrite[] = [];
    for (const entry of candidates) {
      // A failed flush means this doc has unsaved content we could not land;
      // rewriting its file now would be undone by the close-time retry of the
      // stranded snapshot. Leave both disk and memory untouched.
      if (flushFailed.has(entry.id)) continue;
      const isActive = entry.id === activeDocId;
      // The active doc's truth is the live editor (already folded into
      // entry.content by getLiveDocsSnapshot). For background docs the just-
      // flushed save can be newer than entry.content (React hasn't committed
      // doSave's setDocs yet), so rewrite what is actually on disk. If the
      // body can't be read back, skip the doc — rewriting from the stale
      // in-memory copy could regress its latest save.
      let base = entry.content;
      if (!isActive && entry.filePath) {
        try {
          base = await readTextFile(entry.filePath);
        } catch {
          continue;
        }
      }
      const updated = base.replace(rewritePattern, replacement);
      if (updated === base) continue;
      proposed.push({
        docId: entry.id,
        updated,
        filePath: entry.filePath || null,
        isActive,
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
      if (await rewriteNoteFile(rw.filePath, rw.updated, "renameNote.rewrite", rw.docId)) {
        committed.add(rw.docId);
      }
    }));

    const activeRewrite = proposed.find((rw) => rw.isActive) ?? null;
    let activeWriteOk = false;
    if (activeRewrite) {
      const activeDoc = liveDocs[currentActiveIndex];
      if (activeDoc?.filePath) {
        activeWriteOk = await rewriteNoteFile(
          activeDoc.filePath,
          activeRewrite.updated,
          "renameNote.rewrite.active",
          activeDoc.id,
        );
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
  }, [captureAndQueueSaveRef, flushDocSaveRef, getLiveDocsSnapshot, notesSortOrder, setActiveIndex, setDocs, state, tiptapRef]);

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

    // Flip the sidecar to "not trashed" on disk BEFORE the body copy lands.
    // Windows copyFile preserves the source mtime, so the restored body stays
    // older than meta.trashedAt; if the watcher's reconcile (fires ~1.5s after
    // the copy) still reads trashedAt != null, its root-vs-trash arbitration
    // deterministically moves the body straight back to .trash and the restore
    // silently undoes itself a moment later. The async saveManifest below also
    // rewrites the meta, but it races that reconcile — only an awaited
    // meta-first write closes the window.
    let previousMeta: NoteMeta | null = null;
    let metaKnownAbsent = false;
    try {
      previousMeta = await readMeta(tauriFileSystem, notesDir, trashed.id);
      metaKnownAbsent = previousMeta === null;
    } catch { /* unreadable sidecar — rebuild from the trash entry below */ }
    const restoredMeta: NoteMeta = {
      version: 2,
      id: trashed.id,
      fileName: trashed.fileName,
      createdAt: trashed.createdAt,
      updatedAt: trashed.updatedAt,
      groupId: trashed.groupId ?? null,
      pinned: trashed.pinned === true,
      color: trashed.color,
      ...(previousMeta ?? {}),
      trashedAt: null,
      trashedFromPath: null,
    };
    try {
      await writeMeta(tauriFileSystem, notesDir, restoredMeta, getMachineIdCached());
    } catch { /* best-effort; saveManifest below rewrites it */ }

    markOwnWrite(restoredPath);
    try {
      await copyFile(trashed.trashFilePath, restoredPath);
    } catch (err) {
      // Roll the sidecar back so disk state stays consistent with the trash
      // entry that this function leaves untouched on failure.
      try {
        if (previousMeta) await writeMeta(tauriFileSystem, notesDir, previousMeta, getMachineIdCached());
        else if (metaKnownAbsent) await removeMetaFile(tauriFileSystem, notesDir, trashed.id);
      } catch { /* best-effort */ }
      if (import.meta.env.DEV) {
        console.warn("Failed to restore note from trash:", err);
      }
      return;
    }
    try { await remove(trashed.trashFilePath); } catch { /* ignore */ }

    // copyFile above succeeded, so the file is on disk at restoredPath.
    // If the read here fails, defer the UI commit — next reload's reconcile
    // discovers the restored file and creates the doc with real content.
    // Surfacing the failure prevents the user's click from looking like a
    // silent no-op (trash entry still showing, no new doc).
    let content: string;
    try {
      content = await readTextFile(restoredPath);
    } catch (error) {
      void logNotenError(new NotenError(
        "BODY_READ_FAILED",
        "recoverable",
        error instanceof Error ? error.message : String(error),
        {
          context: { stage: "restoreNote", noteId: trashedNoteId, filePath: restoredPath },
          cause: error,
        },
      ));
      return;
    }

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

    const prunedDocs = await pruneEmptyCurrentDoc(baseDocs, activeDocId);
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

  return { importFile, importFiles, saveFile, saveFileAs, newNote, createNoteWithTitle, switchDocument, deleteNote, deleteNotes, duplicateNote, exportNote, renameNote, toggleNotePinned, setNotesPinned, setNoteColor, setNotesColor, restoreNote, permanentlyDeleteNote, emptyTrash };
}
