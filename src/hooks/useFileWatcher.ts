import { useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { watch, readTextFile } from "@tauri-apps/plugin-fs";
import type { WatchEvent } from "@tauri-apps/plugin-fs";
import { getNotesDir, deriveTitle, saveManifest, migrationInProgress, reconcileFolder } from "./useNotesLoader";
import type { NoteDoc, NoteGroup } from "./useNotesLoader";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { isOwnWrite, pruneOwnWrites } from "./ownWriteTracker";
import { getFileTimestamps } from "../utils/fileTimestamps";
import type { Locale } from "./useSettings";

// Re-export markOwnWrite for existing consumers
export { markOwnWrite } from "./ownWriteTracker";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

interface ManifestFile {
  version: 1;
  notes: Omit<NoteDoc, "isDirty" | "content">[];
  activeNoteId: string | null;
  groups?: NoteGroup[];
}

async function readManifestFile(dir: string): Promise<ManifestFile | null> {
  try {
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    const raw = await readTextFile(`${dir}${sep}manifest.json`);
    return JSON.parse(raw) as ManifestFile;
  } catch {
    return null;
  }
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
    const isManifestChange = affectedPaths.some(
      (p) => p.endsWith("/manifest.json") && p.startsWith(dirNorm) && !isOwnWrite(p),
    );
    const mdChanges = affectedPaths.filter(
      (p) => p.endsWith(".md") && p.startsWith(dirNorm) && !isOwnWrite(p),
    );

    if (!isManifestChange && mdChanges.length === 0) return;

    // ── Handle manifest.json changes (groups, note metadata from other device) ──
    if (isManifestChange) {
      const manifest = await readManifestFile(dir);
      if (!manifest) return;

      const currentDocs = docsRef.current;

      // Sync groups — manifest is authoritative; `undefined` means "no groups"
      // (saveManifest omits the field when groups is empty), so clear unconditionally.
      setGroups(manifest.groups ?? []);

      // Discover new notes from manifest that we don't have
      const currentIds = new Set(currentDocs.map((d) => d.id));
      const newEntries = manifest.notes.filter((n) => !currentIds.has(n.id));

      if (newEntries.length > 0) {
        const newDocs = await Promise.all(
          newEntries.map(async (entry) => {
            let content = "";
            try { content = await readTextFile(entry.filePath); } catch { /* file may not be synced yet */ }
            return { ...entry, isDirty: false, content } as NoteDoc;
          }),
        );
        setDocs((prev) => {
          const ids = new Set(prev.map((d) => d.id));
          const toAdd = newDocs.filter((d) => !ids.has(d.id));
          return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
        });
      }

      // Update metadata (fileName, etc.) for existing notes from manifest
      const manifestMap = new Map(manifest.notes.map((n) => [n.id, n]));
      setDocs((prev) => {
        let changed = false;
        const next = prev.map((d) => {
          const remote = manifestMap.get(d.id);
          if (!remote) return d;
          // Only update if remote is newer and doc is not locally dirty
          if (!d.isDirty && remote.updatedAt > d.updatedAt) {
            changed = true;
            return { ...d, fileName: remote.fileName, updatedAt: remote.updatedAt };
          }
          return d;
        });
        return changed ? next : prev;
      });

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
  }, [getRoutedActiveDocId, locale, setDocs, setGroups, setActiveIndex, tiptapRef]);

  useEffect(() => {
    if (!enabled) return;

    let unwatchFn: (() => void) | null = null;
    let cancelled = false;

    // `window.location.reload()` (our hidden dev shortcut) and Tauri window
    // reloads don't give React a chance to run effect cleanups. Without an
    // explicit unwatch, the Rust watcher keeps firing into a Channel whose
    // JS callback is already gone, logging "Couldn't find callback id" on
    // every filesystem event. Hook `beforeunload` to close the watcher
    // best-effort before the page tears down.
    const teardown = () => {
      unwatchFn?.();
      unwatchFn = null;
    };
    const beforeUnload = () => teardown();
    window.addEventListener("beforeunload", beforeUnload);

    (async () => {
      const dir = await getNotesDir();
      if (cancelled) return;

      try {
        const unwatch = await watch(
          dir,
          handleWatchEvent,
          { recursive: false, delayMs: 1500 },
        );
        if (cancelled) {
          unwatch();
        } else {
          unwatchFn = unwatch;
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
}
