import { useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { watch, readTextFile } from "@tauri-apps/plugin-fs";
import type { WatchEvent } from "@tauri-apps/plugin-fs";
import { getNotesDir, deriveTitle, saveManifest, migrationInProgress, reconcileFolder, sortNotes } from "./useNotesLoader";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { isOwnWrite, pruneOwnWrites } from "./ownWriteTracker";
import { getFileTimestamps } from "../utils/fileTimestamps";
import type { Locale, NotesSortOrder } from "./useSettings";
import { deriveNoteGroups, readStoredGroups } from "../utils/groupsIO";
import { metaToNoteDoc, readAllNoteMetas } from "../utils/metadataIO";
import { readUiState } from "../utils/uiStateIO";
import { metaDirPath, noteFilePath } from "../utils/storagePaths";

// Re-export markOwnWrite for existing consumers
export { markOwnWrite } from "./ownWriteTracker";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

// ── File watcher hook ──

export function useFileWatcher(
  docs: NoteDoc[],
  setDocs: React.Dispatch<React.SetStateAction<NoteDoc[]>>,
  groups: NoteGroup[],
  setGroups: React.Dispatch<React.SetStateAction<NoteGroup[]>>,
  activeIndex: number,
  activeDocId: string | null,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
  tiptapRef: React.RefObject<TiptapEditorHandle | null>,
  locale: Locale,
  notesSortOrder: NotesSortOrder,
  enabled: boolean,
  onActiveDocChanged?: (doc: { filePath: string; content: string }) => void,
) {
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const activeDocIdRef = useRef(activeDocId);
  activeDocIdRef.current = activeDocId;
  const onActiveDocChangedRef = useRef(onActiveDocChanged);
  onActiveDocChangedRef.current = onActiveDocChanged;
  const getRoutedActiveDocId = useCallback(() => {
    const editorDocId = tiptapRef.current?.getEditor?.()?.storage.documentContext.noteId ?? null;
    return editorDocId ?? activeDocIdRef.current;
  }, [tiptapRef]);

  const handleWatchEvent = useCallback(async (event: WatchEvent) => {
    if (migrationInProgress) return;
    pruneOwnWrites();

    const dir = await getNotesDir();
    const dirNorm = normalizePath(dir);

    const affectedPaths = event.paths.map(normalizePath);
    const isIgnoredPath = (path: string) =>
      path.endsWith(".tmp")
      || path.includes("/.assets/")
      || path.includes("/.trash/")
      || path.includes("/.conflicts/");
    const isMetadataChange = affectedPaths.some(
      (p) => !isIgnoredPath(p)
        && p.startsWith(dirNorm)
        && (p.endsWith("/.groups.json") || p.includes("/.meta/"))
        && !isOwnWrite(p),
    );
    const mdChanges = affectedPaths.filter(
      (p) => p.endsWith(".md") && p.startsWith(dirNorm) && !isIgnoredPath(p) && !isOwnWrite(p),
    );

    if (!isMetadataChange && mdChanges.length === 0) return;

    if (isMetadataChange) {
      const metas = await readAllNoteMetas(dir);
      const liveMetas = metas.filter((meta) => !meta.trashedAt);
      const docsFromMeta = await Promise.all(
        liveMetas.map(async (meta) => metaToNoteDoc(meta, dir, await readTextFile(noteFilePath(dir, meta.id)).catch(() => ""))),
      );
      const uiState = await readUiState();
      const nextGroups = deriveNoteGroups(await readStoredGroups(dir), metas, uiState.groupCollapsed);
      const sortedDocs = sortNotes(docsFromMeta, notesSortOrder, locale);
      const activeId = getRoutedActiveDocId();
      setDocs(sortedDocs);
      setGroups(nextGroups);
      if (activeId) {
        const nextIndex = sortedDocs.findIndex((doc) => doc.id === activeId);
        if (nextIndex >= 0 && nextIndex !== activeIndexRef.current) setActiveIndex(nextIndex);
      }
    }

    // ── Handle .md file changes ──
    if (mdChanges.length === 0) return;

    const currentDocs = docsRef.current;

    for (const changedPath of mdChanges) {
      // Find matching doc by normalized path
      const docIndex = currentDocs.findIndex(
        (d) => normalizePath(d.filePath) === changedPath,
      );

      if (docIndex >= 0) {
        const doc = currentDocs[docIndex];

        // Skip if locally dirty (user is actively editing)
        if (doc.isDirty) continue;

        // Reload content
        let content: string;
        try {
          content = await readTextFile(doc.filePath);
        } catch {
          // File was deleted — will be handled by reconcile
          continue;
        }

        // Skip if content unchanged
        if (content === doc.content) continue;

        const { updatedAt: fileUpdatedAt } = await getFileTimestamps(doc.filePath);

        let needsSyncMarkdown = false;

        // flushSync forces the updater to run synchronously so the
        // flag it sets is reliable when checked afterwards.  Side
        // effects stay outside the updater for StrictMode safety.
        flushSync(() => {
          setDocs((prev) => {
            const idx = prev.findIndex((d) => d.id === doc.id);
            if (idx < 0) return prev;
            const updated = [...prev];
            const autoTitle = prev[idx].customName
              ? prev[idx].fileName
              : deriveTitle(content) || prev[idx].fileName;
            updated[idx] = {
              ...prev[idx],
              content,
              fileName: autoTitle,
              updatedAt: fileUpdatedAt,
              isDirty: false,
            };

            if (updated[idx].id === getRoutedActiveDocId()) {
              needsSyncMarkdown = true;
            }

            return updated;
          });
        });

        if (needsSyncMarkdown && tiptapRef.current) {
          tiptapRef.current.openDocument?.({
            noteId: doc.id,
            filePath: doc.filePath,
            markdown: content,
            reason: "file-watch",
          });
          onActiveDocChangedRef.current?.({ filePath: doc.filePath, content });
        }
      }
    }

    // Reconcile: pick up new files or remove deleted ones
    const { docs: reconciledDocs, groups: reconciledGroups, changed } = await reconcileFolder(
      dir,
      docsRef.current,
      groupsRef.current,
      locale,
    );

    if (changed) {
      // Capture the previously-active doc by id *before* committing new state.
      // activeIndex is positional, so if the active file was externally removed,
      // the old index silently re-targets a different doc while Tiptap still
      // holds the stale session. Key off id instead (matches doc-deleted path).
      const prevActiveId = getRoutedActiveDocId();
      const activeStillExists = prevActiveId !== null
        && reconciledDocs.some((d) => d.id === prevActiveId);

      setDocs(reconciledDocs);
      setGroups(reconciledGroups);

      let nextActiveId: string | null;

      if (activeStillExists) {
        nextActiveId = prevActiveId;
        const newIdx = reconciledDocs.findIndex((d) => d.id === prevActiveId);
        if (newIdx !== activeIndexRef.current) setActiveIndex(newIdx);
      } else if (reconciledDocs.length === 0) {
        nextActiveId = null;
        setActiveIndex(0);
        if (prevActiveId) tiptapRef.current?.invalidateDocumentSession?.(prevActiveId, null);
      } else {
        // Active doc was deleted externally — pick the replacement at the same
        // position (clamped) and switch the editor over, mirroring doc-deleted.
        const prevActiveIdx = prevActiveId
          ? docsRef.current.findIndex((d) => d.id === prevActiveId)
          : -1;
        const replacementIdx = Math.min(
          Math.max(prevActiveIdx, 0),
          reconciledDocs.length - 1,
        );
        const replacement = reconciledDocs[replacementIdx];
        nextActiveId = replacement.id;
        setActiveIndex(replacementIdx);

        if (prevActiveId) tiptapRef.current?.invalidateDocumentSession?.(prevActiveId, null);
        tiptapRef.current?.openDocument?.({
          noteId: replacement.id,
          filePath: replacement.filePath,
          markdown: replacement.content,
          reason: "file-watch",
        });
        onActiveDocChangedRef.current?.({
          filePath: replacement.filePath,
          content: replacement.content,
        });
      }

      await saveManifest(reconciledDocs, nextActiveId, reconciledGroups).catch(() => {});
    }
  }, [getRoutedActiveDocId, locale, notesSortOrder, setDocs, setGroups, setActiveIndex, tiptapRef]);

  useEffect(() => {
    if (!enabled) return;

    let unwatchFns: Array<() => void> = [];
    let cancelled = false;

    // `window.location.reload()` (our hidden dev shortcut) and Tauri window
    // reloads don't give React a chance to run effect cleanups. Without an
    // explicit unwatch, the Rust watcher keeps firing into a Channel whose
    // JS callback is already gone, logging "Couldn't find callback id" on
    // every filesystem event. Hook `beforeunload` to close the watcher
    // best-effort before the page tears down.
    const teardown = () => {
      unwatchFns.forEach((unwatch) => unwatch());
      unwatchFns = [];
    };
    const beforeUnload = () => teardown();
    window.addEventListener("beforeunload", beforeUnload);

    (async () => {
      const dir = await getNotesDir();
      if (cancelled) return;

      try {
        const unwatchRoot = await watch(
          dir,
          handleWatchEvent,
          { recursive: false, delayMs: 1500 },
        );
        const unwatchMeta = await watch(
          metaDirPath(dir),
          handleWatchEvent,
          { recursive: false, delayMs: 1500 },
        ).catch(() => null);
        if (cancelled) {
          unwatchRoot();
          unwatchMeta?.();
        } else {
          unwatchFns = [unwatchRoot, ...(unwatchMeta ? [unwatchMeta] : [])];
        }
      } catch (err) {
        console.warn("File watcher setup failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", beforeUnload);
      teardown();
    };
  }, [enabled, handleWatchEvent]);

  useEffect(() => {
    if (!enabled) return;

    const triggerReconcile = () => {
      void getNotesDir().then((dir) => {
        void handleWatchEvent({ paths: [`${dir}/.meta/__reconcile__.json`] } as WatchEvent);
      });
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") triggerReconcile();
    };

    window.addEventListener("focus", triggerReconcile);
    document.addEventListener("visibilitychange", handleVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") triggerReconcile();
    }, 60_000);

    return () => {
      window.removeEventListener("focus", triggerReconcile);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(timer);
    };
  }, [enabled, handleWatchEvent]);
}
