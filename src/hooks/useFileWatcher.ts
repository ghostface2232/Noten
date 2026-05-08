import { useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { mkdir, watch, readTextFile } from "@tauri-apps/plugin-fs";
import type { WatchEvent } from "@tauri-apps/plugin-fs";
import {
  getNotesDir,
  deriveTitle,
  saveManifest,
  migrationInProgress,
  reconcileFolder,
  metaDirFor,
  groupsPathFor,
  syncGroupsSnapshotFromDisk,
  loadGroupsFromDisk,
  type NoteDoc,
  type NoteGroup,
} from "./useNotesLoader";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { isOwnWrite, isOwnWriteContentMatch, pruneOwnWrites } from "./ownWriteTracker";
import { getFileTimestamps } from "../utils/fileTimestamps";
import { readMeta } from "../utils/metadataIO";
import { scanAndAbsorbConflicts } from "../utils/conflictFileDetector";
import { setKnownDiskContent } from "../utils/conflictBackup";
import type { Locale } from "./useSettings";

// Re-export markOwnWrite for existing consumers
export { markOwnWrite } from "./ownWriteTracker";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

const RECONCILE_INTERVAL_MS = 60_000;
const FOCUS_DEBOUNCE_MS = 500;
const WATCH_DELAY_MS = 1500;

// ─────────────────────────────────────────────────────────────────────────────
// useFileWatcher
// ─────────────────────────────────────────────────────────────────────────────

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
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const getRoutedActiveDocId = useCallback(() => {
    const editorDocId = tiptapRef.current?.getEditor?.()?.storage.documentContext.noteId ?? null;
    return editorDocId ?? activeDocIdRef.current;
  }, [tiptapRef]);

  // ── Reload groups from disk (`.groups.json` + every `.meta/*.json`) ──
  // Membership (noteIds) is authoritative from each meta's `groupId`, NOT from
  // React state — a remote-only move (e.g. PC B reassigned a note's groupId)
  // would otherwise be invisible because `.groups.json` itself doesn't carry
  // membership.
  const reloadGroupsFromDisk = useCallback(async () => {
    if (migrationInProgress) return;
    const dir = await getNotesDir();
    // Keep the saveManifest write-snapshot aligned with what we just observed
    // on disk so name/orderKey diffs are correctly attributed.
    await syncGroupsSnapshotFromDisk(dir);
    const next = await loadGroupsFromDisk(dir);
    setGroups(next);
  }, [setGroups]);

  // ── Apply a single .meta/{id}.json change ──
  const applyMetaChange = useCallback(async (id: string) => {
    const dir = await getNotesDir();
    const meta = await readMeta(dir, id);
    if (!meta) return;

    setDocs((prev) => {
      const idx = prev.findIndex((d) => d.id === id);
      if (idx < 0) return prev;
      const cur = prev[idx];
      // Skip if locally dirty (active edits trump remote rename) or unchanged.
      if (cur.isDirty) return prev;
      if (cur.fileName === meta.fileName && cur.updatedAt === meta.updatedAt) return prev;
      const next = [...prev];
      next[idx] = {
        ...cur,
        fileName: meta.fileName,
        updatedAt: meta.updatedAt,
        customName: meta.customName,
      };
      return next;
    });

    // Propagate group-membership changes. Membership lives in each meta's
    // `groupId`, so a remote move (group A → group B) is only visible after
    // we re-read the meta. Without this, the in-memory groups state would
    // stay stale and the next `saveManifest` would write the old groupId
    // back into the meta file, undoing the remote change.
    const targetGroupId = meta.trashedAt != null ? null : (meta.groupId ?? null);
    setGroups((prev) => {
      let changed = false;
      const next = prev.map((g) => {
        const has = g.noteIds.includes(id);
        const should = g.id === targetGroupId;
        if (has && !should) {
          changed = true;
          return { ...g, noteIds: g.noteIds.filter((nid) => nid !== id) };
        }
        if (!has && should) {
          changed = true;
          return { ...g, noteIds: [...g.noteIds, id] };
        }
        return g;
      });
      return changed ? next : prev;
    });
  }, [setDocs, setGroups]);

  // ── reconcile shorthand ──
  const runReconcile = useCallback(async () => {
    if (migrationInProgress) return;
    const dir = await getNotesDir();
    try { await scanAndAbsorbConflicts(dir); } catch { /* best-effort */ }

    const { docs: reconciledDocs, groups: reconciledGroups, changed } = await reconcileFolder(
      dir,
      docsRef.current,
      groupsRef.current,
      localeRef.current,
    );

    if (!changed) return;

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
  }, [getRoutedActiveDocId, setActiveIndex, setDocs, setGroups, tiptapRef]);

  // ── Root-folder watch handler ──
  const handleRootEvent = useCallback(async (event: WatchEvent) => {
    if (migrationInProgress) return;
    pruneOwnWrites();

    const dir = await getNotesDir();
    const dirNorm = normalizePath(dir);
    const groupsPathNorm = normalizePath(groupsPathFor(dir));

    const affectedPaths = event.paths.map(normalizePath);
    // Time-based isOwnWrite is intentionally NOT applied to .md candidates here:
    // a 2 s grace window over the same path can swallow a real remote write
    // whose content differs from ours. The hash-based check inside the loop
    // (`isOwnWriteContentMatch` after reading the file) is the authoritative
    // own-write decision for `.md`. We still apply the time check to
    // `.groups.json` since we cannot easily hash-check it (the read-merge-
    // write cycle creates a moving target).
    const groupsChanged = affectedPaths.some((p) => p === groupsPathNorm && !isOwnWrite(p));
    const mdChanges = affectedPaths.filter(
      (p) => p.endsWith(".md") && p.startsWith(dirNorm) && !p.includes("/.trash/"),
    );

    if (groupsChanged) {
      // We can't hash-check the groups file because we may have just done a
      // read-merge-write — but isOwnWrite handles the typical short window.
      await reloadGroupsFromDisk();
    }

    // ── Handle .md file changes ──
    const currentDocs = docsRef.current;
    for (const changedPath of mdChanges) {
      const docIndex = currentDocs.findIndex(
        (d) => normalizePath(d.filePath) === changedPath,
      );

      if (docIndex < 0) continue;
      const doc = currentDocs[docIndex];
      if (doc.isDirty) continue;

      let content: string;
      try {
        content = await readTextFile(doc.filePath);
      } catch {
        continue; // file deleted — reconcile handles it
      }

      // Hash-based own-write match: we ignore events whose content matches a
      // hash we recorded ourselves. Pure-time grace was already filtered above,
      // so this layer guards against the OneDrive-latency case where a real
      // remote change would otherwise be swallowed.
      if (await isOwnWriteContentMatch(doc.filePath, content)) continue;
      if (content === doc.content) continue;

      // Register the new disk baseline so a subsequent local autosave can
      // detect concurrent remote writes against this content (not the stale
      // one we held before).
      setKnownDiskContent(doc.filePath, content);

      const { updatedAt: fileUpdatedAt } = await getFileTimestamps(doc.filePath);

      let needsSyncMarkdown = false;
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

    // Always run reconcile after root-level events: it picks up new files,
    // drops deletions, and absorbs conflict copies.
    await runReconcile();
  }, [getRoutedActiveDocId, reloadGroupsFromDisk, runReconcile, setDocs, tiptapRef]);

  // ── .meta/ watch handler ──
  const handleMetaEvent = useCallback(async (event: WatchEvent) => {
    if (migrationInProgress) return;
    pruneOwnWrites();

    const affectedPaths = event.paths.map(normalizePath);
    for (const p of affectedPaths) {
      if (!p.endsWith(".json")) continue;
      if (p.endsWith(".tmp.json") || p.endsWith(".tmp")) continue;
      if (isOwnWrite(p)) continue;

      const fileName = p.split("/").pop() ?? "";
      const id = fileName.replace(/\.json$/i, "");
      if (!id) continue;

      // Hash-based own-write check (event timing race).
      try {
        const raw = await readTextFile(p);
        if (await isOwnWriteContentMatch(p, raw)) continue;
      } catch { /* file may have been deleted; reconcile catches it */ }

      await applyMetaChange(id);
    }

    // After applying meta changes, reconcile to pick up trashed / restored
    // notes whose meta moved between trashedAt = null ↔ number.
    await runReconcile();
  }, [applyMetaChange, runReconcile]);

  // ── Watcher setup ──
  useEffect(() => {
    if (!enabled) return;

    let rootUnwatch: (() => void) | null = null;
    let metaUnwatch: (() => void) | null = null;
    let cancelled = false;

    const teardown = () => {
      try { rootUnwatch?.(); } catch { /* ignore */ }
      try { metaUnwatch?.(); } catch { /* ignore */ }
      rootUnwatch = null;
      metaUnwatch = null;
    };
    const beforeUnload = () => teardown();
    window.addEventListener("beforeunload", beforeUnload);

    (async () => {
      const dir = await getNotesDir();
      if (cancelled) return;

      try {
        const unwatch = await watch(
          dir,
          handleRootEvent,
          { recursive: false, delayMs: WATCH_DELAY_MS },
        );
        if (cancelled) unwatch();
        else rootUnwatch = unwatch;
      } catch (err) {
        console.warn("Root file watcher setup failed:", err);
      }

      // Ensure .meta/ exists before watching it (otherwise the watch call fails).
      const metaDir = metaDirFor(dir);
      try { await mkdir(metaDir, { recursive: true }); } catch { /* ignore */ }

      try {
        const unwatch = await watch(
          metaDir,
          handleMetaEvent,
          { recursive: false, delayMs: WATCH_DELAY_MS },
        );
        if (cancelled) unwatch();
        else metaUnwatch = unwatch;
      } catch (err) {
        console.warn("Meta file watcher setup failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", beforeUnload);
      teardown();
    };
  }, [enabled, handleRootEvent, handleMetaEvent]);

  // ── Reconcile triggers: focus, visibility, interval ──
  useEffect(() => {
    if (!enabled) return;

    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedReconcile = () => {
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusTimer = null;
        void runReconcile();
        void reloadGroupsFromDisk();
      }, FOCUS_DEBOUNCE_MS);
    };

    const onFocus = () => debouncedReconcile();
    const onVisibility = () => {
      if (document.visibilityState === "visible") debouncedReconcile();
    };

    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (intervalHandle != null) return;
      intervalHandle = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        void runReconcile();
        void reloadGroupsFromDisk();
      }, RECONCILE_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (intervalHandle != null) clearInterval(intervalHandle);
      intervalHandle = null;
    };
    const visibilityIntervalSync = () => {
      if (document.visibilityState === "visible") startInterval();
      else stopInterval();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("visibilitychange", visibilityIntervalSync);

    if (document.visibilityState === "visible") startInterval();

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("visibilitychange", visibilityIntervalSync);
      if (focusTimer) clearTimeout(focusTimer);
      stopInterval();
    };
  }, [enabled, runReconcile, reloadGroupsFromDisk]);
}
