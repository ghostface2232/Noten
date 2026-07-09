import { useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { mkdir, watch, readTextFile } from "@tauri-apps/plugin-fs";
import type { WatchEvent } from "@tauri-apps/plugin-fs";
import {
  getNotesDir,
  deriveTitle,
  saveManifest,
  migrationInProgress,
  metaDirFor,
  groupsPathFor,
  syncGroupsSnapshotFromDisk,
  loadGroupsFromDisk,
  type NoteDoc,
  type NoteGroup,
} from "./useNotesLoader";
import { reconcileFolder, type ReconcileState } from "../utils/reconcileFolder";
import { tauriFileSystem } from "../utils/fs";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { isOwnWrite, isOwnWriteContentMatch, pruneOwnWrites, pathKey } from "./ownWriteTracker";
import { getFileTimestamps } from "../utils/fileTimestamps";
import { readMeta } from "../utils/metadataIO";
import { scanAndAbsorbConflicts } from "../utils/conflictFileDetector";
import { setKnownDiskContent } from "../utils/conflictBackup";
import { markdownEqual } from "../utils/markdownEqual";
import { NotenError } from "../utils/notenError";
import { logNotenError } from "../utils/crashLog";
import type { Locale } from "./useSettings";

export { markOwnWrite } from "./ownWriteTracker";

// Re-exported under the legacy name so existing call sites stay readable, but
// the implementation must be the same one ownWriteTracker uses or own-write
// suppression breaks on Windows (drive case / separators / `\\?\` prefixes).
const normalizePath = pathKey;

const RECONCILE_INTERVAL_MS = 60_000;
const FOCUS_DEBOUNCE_MS = 500;
const WATCH_DELAY_MS = 1500;
// After a reconcile is abandoned because local state moved under it mid-await,
// re-run once the mutation burst has had a moment to settle. Long enough to let
// a rapid create/type/delete sequence quiesce, short enough that remote changes
// still surface well inside the 60s periodic cadence.
const RECONCILE_DRIFT_RETRY_MS = 750;

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
  reconcileState: ReconcileState,
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
  // Pending drift-retry timer + a stable self-reference so the retry can call
  // the latest runReconcile without threading it through the timer closure.
  const reconcileRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runReconcileRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const getRoutedActiveDocId = useCallback(() => {
    const editorDocId = tiptapRef.current?.getEditor?.()?.storage.documentContext.noteId ?? null;
    return editorDocId ?? activeDocIdRef.current;
  }, [tiptapRef]);

  // Group membership is authoritative in per-note meta, not React state.
  const reloadGroupsFromDisk = useCallback(async () => {
    if (migrationInProgress) return;
    const dir = await getNotesDir();
    try {
      await syncGroupsSnapshotFromDisk(dir);
      const next = await loadGroupsFromDisk(dir);
      setGroups(next);
    } catch (err) {
      void logNotenError(new NotenError(
        "RECONCILE_FAILED",
        "recoverable",
        "useFileWatcher.reloadGroupsFromDisk: shared group read failed; keeping current groups until retry",
        { context: { dir, source: "watcher.groups" }, cause: err },
      ));
    }
  }, [setGroups]);

  const applyMetaChange = useCallback(async (id: string) => {
    const dir = await getNotesDir();
    let meta;
    try {
      meta = await readMeta(tauriFileSystem, dir, id);
    } catch (err) {
      void logNotenError(new NotenError(
        "RECONCILE_FAILED",
        "recoverable",
        "useFileWatcher.applyMetaChange: meta read failed; deferring until next reconcile",
        { context: { noteId: id, source: "watcher.metaChange" }, cause: err },
      ));
      return;
    }
    if (!meta) return;

    setDocs((prev) => {
      const idx = prev.findIndex((d) => d.id === id);
      if (idx < 0) return prev;
      const cur = prev[idx];
      // Pin/color can sync while the body is locally dirty.
      if (cur.isDirty) {
        if (cur.pinned === (meta.pinned === true) && cur.color === meta.color) return prev;
        const next = [...prev];
        next[idx] = { ...cur, pinned: meta.pinned === true, color: meta.color, updatedAt: meta.updatedAt };
        return next;
      }
      if (
        cur.fileName === meta.fileName
        && cur.updatedAt === meta.updatedAt
        && cur.pinned === (meta.pinned === true)
        && cur.color === meta.color
      ) return prev;
      const next = [...prev];
      next[idx] = {
        ...cur,
        fileName: meta.fileName,
        updatedAt: meta.updatedAt,
        pinned: meta.pinned === true,
        color: meta.color,
        customName: meta.customName,
      };
      return next;
    });

    const targetGroupId = meta.trashedAt != null ? null : (meta.groupId ?? null);

    // Meta can arrive before the referenced remote-created group.
    if (
      targetGroupId !== null
      && !groupsRef.current.some((g) => g.id === targetGroupId)
    ) {
      await reloadGroupsFromDisk();
      return;
    }

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
  }, [setDocs, setGroups, reloadGroupsFromDisk]);

  const runReconcile = useCallback(async () => {
    if (migrationInProgress) return;
    const dir = await getNotesDir();
    try { await scanAndAbsorbConflicts(tauriFileSystem, dir); } catch { /* best-effort */ }

    // Snapshot the exact state reconcile computes against. reconcileFolder awaits
    // full-folder disk reads that take seconds on a cloud placeholder; if a local
    // mutation (Ctrl+N create, delete/restore, a dirty flip, or a group edit)
    // lands in that window, the reconciled arrays — derived from this now-stale
    // baseline — no longer describe current state. Committing them via setDocs/
    // setGroups would DROP the new note, RESURRECT the deleted one (and make the
    // follow-up saveManifest write its meta as both live and trashed, racing
    // `${path}.tmp`), or clobber the freshly dirtied doc. Every such mutation
    // replaces the docs or groups array reference, so an identity check at commit
    // time is a sound, cheap drift signal. On drift we re-run against the fresh
    // baseline rather than force-replacing — reconcile is idempotent, so the
    // retry yields a correctly merged result. (P0-5)
    const docsBaseline = docsRef.current;
    const groupsBaseline = groupsRef.current;

    let reconciledDocs: NoteDoc[];
    let reconciledGroups: NoteGroup[];
    let changed: boolean;
    try {
      const result = await reconcileFolder(
        tauriFileSystem,
        reconcileState,
        dir,
        docsBaseline,
        groupsBaseline,
        localeRef.current,
      );
      reconciledDocs = result.docs;
      reconciledGroups = result.groups;
      changed = result.changed;
    } catch (err) {
      // Watcher swallows reconcile errors (no outer catch) so the next watch
      // event can retry; the loader path rethrows so its fallback fires.
      if (import.meta.env.DEV) console.warn("[RECONCILE_FAILED:watcher]", err);
      void logNotenError(new NotenError(
        "RECONCILE_FAILED",
        "fatal",
        err instanceof Error ? err.message : String(err),
        { context: { dir, source: "watcher" }, cause: err },
      ));
      return;
    }

    if (!changed) return;

    // Local state moved under us during the reconcile await (see the baseline
    // comment above). Abandon this stale result — committing it would clobber
    // the concurrent mutation — and retry against the fresh baseline. The check
    // sits immediately before the synchronous commit below, so nothing can
    // interleave between here and setDocs.
    if (docsRef.current !== docsBaseline || groupsRef.current !== groupsBaseline) {
      if (reconcileRetryRef.current == null) {
        reconcileRetryRef.current = setTimeout(() => {
          reconcileRetryRef.current = null;
          void runReconcileRef.current();
        }, RECONCILE_DRIFT_RETRY_MS);
      }
      return;
    }

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
  }, [getRoutedActiveDocId, setActiveIndex, setDocs, setGroups, tiptapRef, reconcileState]);
  // Keep the self-reference current so a pending drift retry invokes the latest
  // runReconcile closure (fresh setDocs/deps), not the one captured when armed.
  runReconcileRef.current = runReconcile;

  // Clear any pending drift retry on unmount so it can't fire into a torn-down
  // window (or leak across tests).
  useEffect(() => () => {
    if (reconcileRetryRef.current != null) {
      clearTimeout(reconcileRetryRef.current);
      reconcileRetryRef.current = null;
    }
  }, []);

  const handleRootEvent = useCallback(async (event: WatchEvent) => {
    if (migrationInProgress) return;
    pruneOwnWrites();

    const dir = await getNotesDir();
    const dirNorm = normalizePath(dir);
    const groupsPathNorm = normalizePath(groupsPathFor(dir));

    const affectedPaths = event.paths.map(normalizePath);
    // Use content hashes for .md own-write checks; timestamp grace can hide
    // real remote edits on the same path.
    const groupsChanged = affectedPaths.some((p) => p === groupsPathNorm && !isOwnWrite(p));
    const mdChanges = affectedPaths.filter(
      (p) => p.endsWith(".md") && p.startsWith(dirNorm) && !p.includes("/.trash/"),
    );

    if (groupsChanged) {
      await reloadGroupsFromDisk();
    }

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
        continue;
      }

      if (await isOwnWriteContentMatch(doc.filePath, content)) continue;

      // Track the actual disk bytes as the conflict baseline regardless of
      // whether we reload, so backupIfRemoteWroteFirst compares against reality.
      setKnownDiskContent(doc.filePath, content);

      // A purely cosmetic external rewrite (line endings / trailing newline) is
      // not a real edit — accept it silently without reloading the open editor
      // and jarring the cursor.
      if (markdownEqual(content, doc.content)) continue;

      const { updatedAt: fileUpdatedAt } = await getFileTimestamps(tauriFileSystem, doc.filePath);

      let needsSyncMarkdown = false;
      flushSync(() => {
        setDocs((prev) => {
          const idx = prev.findIndex((d) => d.id === doc.id);
          if (idx < 0) return prev;
          // The dirty check at the top of the loop ran on a pre-await snapshot.
          // The user may have started typing during readTextFile /
          // getFileTimestamps (a slow OneDrive placeholder hydration can take
          // seconds), so re-check here and refuse to overwrite live keystrokes.
          // setKnownDiskContent already recorded the disk baseline, so
          // autosave's last-write-wins plus the remote backup resolves the
          // conflict. Mirrors useWindowSync's doc-updated guard.
          if (prev[idx].isDirty) return prev;
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

    await runReconcile();
  }, [getRoutedActiveDocId, reloadGroupsFromDisk, runReconcile, setDocs, tiptapRef]);

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

      try {
        const raw = await readTextFile(p);
        if (await isOwnWriteContentMatch(p, raw)) continue;
      } catch { /* file may have been deleted; reconcile catches it */ }

      await applyMetaChange(id);
    }

    await runReconcile();
  }, [applyMetaChange, runReconcile]);

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
        // Without this watcher, no remote .md edits propagate into the UI
        // until the user manually refocuses (focus/visibility/60s interval).
        // Previously the only signal was a DEV-only console.warn, so a
        // production user got silently degraded sync.
        void logNotenError(new NotenError(
          "WATCH_SETUP_FAILED",
          "fatal",
          err instanceof Error ? err.message : String(err),
          { context: { dir, scope: "root" }, cause: err },
        ));
      }

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
        // Same as the root watcher: a silent setup failure here means
        // remote pin/color/group changes never reach this window's UI.
        void logNotenError(new NotenError(
          "WATCH_SETUP_FAILED",
          "fatal",
          err instanceof Error ? err.message : String(err),
          { context: { dir: metaDir, scope: "meta" }, cause: err },
        ));
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", beforeUnload);
      teardown();
    };
  }, [enabled, handleRootEvent, handleMetaEvent]);

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
