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
  readDiskGroupsSnapshot,
  getPendingGroupSyncSnapshot,
  getPendingGroupMembership,
  type NoteDoc,
  type NoteGroup,
} from "./useNotesLoader";
import { reconcileFolder, type ReconcileState } from "../utils/reconcileFolder";
import { libraryStore } from "../utils/libraryStore";
import { mergeDiskGroups } from "../utils/mergeDiskGroups";
import { getRetiredGroupIds } from "./useWindowSync";
import { tauriFileSystem } from "../utils/fs";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { isOwnWrite, isOwnWriteContentMatch, pruneOwnWrites, pathKey } from "./ownWriteTracker";
import { getFileTimestamps } from "../utils/fileTimestamps";
import { readMeta, invalidateReadAllMetaCache } from "../utils/metadataIO";
import { scanAndAbsorbConflicts } from "../utils/conflictFileDetector";
import { getKnownDiskContent, setKnownDiskContent } from "../utils/conflictBackup";
import { markdownEqual } from "../utils/markdownEqual";
import { keepManualTitle } from "../utils/documentTitle";
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
  // Watch, focus, visibility, and periodic signals can arrive while a slow
  // cloud-backed reconcile is still reading the folder. Keep at most one pass
  // in flight and collapse every overlapping request into one follow-up pass.
  const reconcileDrainRef = useRef<Promise<void> | null>(null);
  const reconcileRequestedRef = useRef(false);

  const getRoutedActiveDocId = useCallback(() => {
    const editorDocId = tiptapRef.current?.getEditor?.()?.storage.documentContext.noteId ?? null;
    return editorDocId ?? activeDocIdRef.current;
  }, [tiptapRef]);

  // Group membership is authoritative in per-note meta, not React state.
  const reloadGroupsFromDisk = useCallback(async () => {
    if (migrationInProgress) return;
    const dir = await getNotesDir();
    try {
      // Same rule as performReconcile: this reload runs because something
      // signalled the folder changed, so the sidecars it merges membership
      // from must be read after that signal — never the autosave-path TTL
      // cache, which only our own writes keep consistent (see the note there).
      invalidateReadAllMetaCache(tauriFileSystem, dir);
      await syncGroupsSnapshotFromDisk(dir);
      const disk = await readDiskGroupsSnapshot(dir);
      // Disk state is MERGED into the live groups with the same per-field
      // clocks the `groups-updated` receiver and mergeGroupEntries use —
      // never committed absolutely. The reads above take seconds on a cloud
      // placeholder, and a local persist or a peer delta committing to the
      // store in that window must survive this reload; an absolute commit
      // erased it, and (because syncGroupsSnapshotFromDisk had just reset the
      // write snapshot to disk state) the reverted store then looked
      // snapshot-equal at persist time, so the change was never written —
      // silent, durable loss. The functional updater runs synchronously
      // against the store's prev at commit time, so there is no drift window
      // and no retry machinery needed. Pending local intents (unwritten
      // tombstones, membership moves) are read AFTER the awaits, in the same
      // tick as the commit.
      const pending = getPendingGroupSyncSnapshot();
      const liveDocIds = new Set(libraryStore.getSnapshot().docs.map((d) => d.id));
      setGroups((prev) => mergeDiskGroups(prev, {
        entries: disk.entries,
        metaById: disk.metaById,
        collapsedByGroup: disk.collapsedByGroup,
        // Local unwritten deletes AND session-retired ids (a peer's delete
        // arrives as a delta before its tombstone reaches .groups.json; the
        // still-alive disk entry must not resurrect it here either).
        pendingTombstoneIds: new Set([...pending.tombstoneIds, ...getRetiredGroupIds()]),
        pendingMembership: pending.membership,
        liveDocIds,
      }));
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
      // A sidecar read can predate a rename this window already applied from
      // doc-renamed; the peer's own write of it may still be in flight.
      const title = keepManualTitle(cur, { fileName: meta.fileName, customName: meta.customName });
      if (
        cur.fileName === title.fileName
        && !!cur.customName === !!title.customName
        && cur.updatedAt === meta.updatedAt
        && cur.pinned === (meta.pinned === true)
        && cur.color === meta.color
      ) return prev;
      const next = [...prev];
      next[idx] = {
        ...cur,
        fileName: title.fileName,
        updatedAt: meta.updatedAt,
        pinned: meta.pinned === true,
        color: meta.color,
        customName: title.customName,
      };
      return next;
    });

    // An unwritten local move outranks the sidecar, unconditionally — the same
    // rule resolveGroupSnapshot (persist) and mergeDiskGroups (reload) apply,
    // so all three settle on the same target. A peer rewriting this sidecar
    // for an unrelated reason (rename/pin/color) carries the note's OLD
    // groupId, since its own persist reads groupId from disk rather than from
    // the delta it just received; adopting it here yanked the note back to its
    // pre-move group until the next periodic reconcile. Remote trash still
    // ungroups: that branch is decided before the pending map is consulted.
    const pendingMove = getPendingGroupMembership().get(id);
    const targetGroupId = meta.trashedAt != null
      ? null
      : (pendingMove ? pendingMove.groupId : (meta.groupId ?? null));

    // Meta can arrive before the referenced remote-created group. The target
    // may now be a pending one: if it isn't in the (render-lagging) groupsRef
    // yet, the reload runs and applies the same pending intent through
    // mergeDiskGroups, so the outcome matches — only the cheap membership
    // updater is traded for one folder read.
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

  const performReconcile = useCallback(async () => {
    if (migrationInProgress) return;
    const dir = await getNotesDir();
    try { await scanAndAbsorbConflicts(tauriFileSystem, dir); } catch { /* best-effort */ }

    // This pass exists to converge memory with the folder, and it runs because
    // something signalled the folder changed under us (a watch event, a focus
    // return, the periodic interval). readAllMeta's short TTL cache serves the
    // autosave hot path and is kept consistent only with OUR writes — a
    // sidecar a cloud client synced after the cache filled is invisible to it,
    // and a pass reconciling against that view takes the unmanaged-file ingest
    // branch for the peer's note: it rewrites the just-synced sidecar with
    // stat-derived timestamps and no group, which then propagates back through
    // the cloud. The external signal outranks the TTL: drop the cache so the
    // pass reads sidecars no older than its own trigger. (The smoke suite's
    // adoption test pins the disk-level outcome against the harness mirror of
    // this flow.)
    invalidateReadAllMetaCache(tauriFileSystem, dir);

    // Snapshot the exact state reconcile computes against. reconcileFolder awaits
    // full-folder disk reads that take seconds on a cloud placeholder; if a
    // mutation (Ctrl+N create, delete/restore, a dirty flip, a group edit, or a
    // peer-window commit) lands in that window, the reconciled arrays — derived
    // from this now-stale baseline — no longer describe current state.
    // Committing them via setDocs/setGroups would DROP the new note, RESURRECT
    // the deleted one (and make the follow-up saveManifest write its meta as
    // both live and trashed, racing `${path}.tmp`), or clobber the freshly
    // dirtied doc. The baseline must come from the canonical store, NOT the
    // docsRef/groupsRef projections: refs only update on render, so a store
    // commit whose render hasn't flushed yet (peer doc-created/doc-deleted via
    // useWindowSync, which commits synchronously from a Tauri listener) would
    // be both invisible to a ref-identity drift check AND missing from a
    // ref-captured baseline. The store token (revision + directoryGeneration)
    // pins this exact state; any commit from anywhere bumps it. On drift we
    // re-run against the fresh baseline rather than force-replacing —
    // reconcile is idempotent, so the retry yields a correctly merged result.
    // (P0-5)
    const baselineToken = libraryStore.getToken();
    const storeBaseline = libraryStore.getSnapshot();
    // `dir` was resolved before the scanAndAbsorbConflicts await; if a
    // directory switch fully seeded the store inside that gap, the baseline
    // now describes a different folder than the one this pass will list.
    // Merging the new library against the old folder's listing could strip
    // every doc whose body lives elsewhere — bail and let the watcher or the
    // periodic interval re-fire against a coherent pair.
    if (
      storeBaseline.notesDirectory !== null
      && storeBaseline.notesDirectory !== dir
    ) {
      return;
    }
    const docsBaseline: NoteDoc[] = [...storeBaseline.docs];
    const groupsBaseline: NoteGroup[] = storeBaseline.groups.map((group) => ({
      ...group,
      noteIds: [...group.noteIds],
    }));

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
        getPendingGroupMembership(),
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

    // The canonical store moved under us during the reconcile await (see the
    // baseline comment above). Abandon this stale result — committing it would
    // clobber the concurrent mutation — and retry against the fresh baseline.
    // The check sits immediately before the synchronous commit below and store
    // commits are synchronous too, so nothing can interleave between here and
    // setDocs. The token is deliberately coarser than the data it protects —
    // a trashedNotes- or activeNoteId-only commit also bumps the revision and
    // abandons this pass. That over-approximation is intentional: the token
    // cannot cheaply attribute a bump to docs/groups, and a false abandon only
    // costs one RECONCILE_DRIFT_RETRY_MS deferral.
    const commitToken = libraryStore.getToken();
    if (
      commitToken.revision !== baselineToken.revision
      || commitToken.directoryGeneration !== baselineToken.directoryGeneration
    ) {
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
      // Position from the store baseline, not the docsRef projection — the ref
      // can lag the store by a render, and the no-drift token check above
      // guarantees the baseline equaled the store at the moment the commit was
      // decided, which is the position set the replacement index must come
      // from (the setDocs above has already advanced the store by now).
      const prevActiveIdx = prevActiveId
        ? docsBaseline.findIndex((d) => d.id === prevActiveId)
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

  const runReconcile = useCallback((): Promise<void> => {
    reconcileRequestedRef.current = true;
    if (reconcileDrainRef.current) return reconcileDrainRef.current;

    const drain = (async () => {
      try {
        while (reconcileRequestedRef.current) {
          reconcileRequestedRef.current = false;
          await performReconcile();
        }
      } finally {
        reconcileDrainRef.current = null;
      }
    })();
    reconcileDrainRef.current = drain;
    return drain;
  }, [performReconcile]);
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
    // Unknown paths, group changes, new/deleted bodies, unreadable bodies, and
    // real remote writes still require the conservative full-folder pass. The
    // only event batch that may skip it is one made exclusively of known,
    // readable note bodies whose content hash matches a write from this
    // window. Timestamp-only suppression is deliberately insufficient here:
    // it could hide a remote same-path edit inside the grace window.
    let shouldReconcile = affectedPaths.length === 0 || affectedPaths.some(
      (p) => !mdChanges.includes(p) && !p.endsWith(".tmp"),
    );

    if (groupsChanged) {
      await reloadGroupsFromDisk();
    }

    const currentDocs = docsRef.current;
    for (const changedPath of mdChanges) {
      const docIndex = currentDocs.findIndex(
        (d) => normalizePath(d.filePath) === changedPath,
      );

      if (docIndex < 0) {
        shouldReconcile = true;
        continue;
      }
      const doc = currentDocs[docIndex];
      if (doc.isDirty) {
        // The event for autosave's own rename arrives WATCH_DELAY_MS later, by
        // which time the user has typed again and the doc is dirty. Bytes that
        // match a write from this window are the same proof the clean path
        // accepts, so the typing window skips the library-wide pass for them.
        // Anything else still takes the pass; the dirty body is never replaced
        // here either way.
        let diskContent: string | null = null;
        try { diskContent = await readTextFile(doc.filePath); } catch { /* reconcile decides */ }
        if (diskContent === null || !(await isOwnWriteContentMatch(doc.filePath, diskContent))) {
          shouldReconcile = true;
        }
        continue;
      }

      let content: string;
      try {
        content = await readTextFile(doc.filePath);
      } catch {
        shouldReconcile = true;
        continue;
      }

      if (await isOwnWriteContentMatch(doc.filePath, content)) continue;
      // A sibling window's autosave: this window already adopted the body
      // through doc-updated, which recorded it as the baseline, so the bytes
      // are known in full. Own-write hashes are per window and cannot say so.
      if (content === doc.content && content === getKnownDiskContent(doc.filePath)) continue;
      shouldReconcile = true;

      // A purely cosmetic external rewrite (line endings / trailing newline) is
      // not a real edit — accept it silently without reloading the open editor
      // and jarring the cursor. The bytes still become the baseline: they agree
      // with the body we already hold, so no later save can destroy anything
      // by matching them.
      if (markdownEqual(content, doc.content)) {
        setKnownDiskContent(doc.filePath, content);
        continue;
      }

      const { updatedAt: fileUpdatedAt } = await getFileTimestamps(tauriFileSystem, doc.filePath);

      let needsSyncMarkdown = false;
      let adoptedRemoteBody = false;
      flushSync(() => {
        setDocs((prev) => {
          const idx = prev.findIndex((d) => d.id === doc.id);
          if (idx < 0) return prev;
          // The dirty check at the top of the loop ran on a pre-await snapshot.
          // The user may have started typing during readTextFile /
          // getFileTimestamps (a slow OneDrive placeholder hydration can take
          // seconds), so re-check here and refuse to overwrite live keystrokes.
          // Declining leaves the conflict baseline at the body we last agreed
          // on, which is what makes the remote version recoverable — see the
          // seed below. Mirrors useWindowSync's doc-updated guard.
          if (prev[idx].isDirty) return prev;
          adoptedRemoteBody = true;
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

      // The remote body becomes the baseline only once it is actually in
      // memory. Recording it before the dirty re-check above destroyed the
      // protection it exists for: a user who started typing during the awaits
      // kept their own body, but backupIfRemoteWroteFirst then found
      // disk === lastKnown, skipped the .conflicts copy, and the next autosave
      // overwrote the remote version with no backup anywhere.
      if (adoptedRemoteBody) setKnownDiskContent(doc.filePath, content);

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

    if (shouldReconcile) await runReconcile();
  }, [getRoutedActiveDocId, reloadGroupsFromDisk, runReconcile, setDocs, tiptapRef]);

  const handleMetaEvent = useCallback(async (event: WatchEvent) => {
    if (migrationInProgress) return;
    pruneOwnWrites();

    const affectedPaths = event.paths.map(normalizePath);
    let shouldReconcile = affectedPaths.length === 0;
    for (const p of affectedPaths) {
      if (!p.endsWith(".json")) {
        if (p.endsWith(".tmp")) continue;
        shouldReconcile = true;
        continue;
      }
      if (p.endsWith(".tmp.json") || p.endsWith(".tmp")) {
        continue;
      }

      const fileName = p.split("/").pop() ?? "";
      const id = fileName.replace(/\.json$/i, "");
      if (!id) {
        shouldReconcile = true;
        continue;
      }

      let contentMatchesOwnWrite = false;
      try {
        const raw = await readTextFile(p);
        contentMatchesOwnWrite = await isOwnWriteContentMatch(p, raw);
      } catch { /* file may have been deleted; reconcile catches it */ }
      if (contentMatchesOwnWrite) continue;

      // Keep the existing timestamp grace for avoiding an eager partial apply,
      // but still reconcile unless the stronger content-hash check above
      // proved this exact sidecar came from us.
      shouldReconcile = true;
      if (isOwnWrite(p)) continue;

      await applyMetaChange(id);
    }

    if (shouldReconcile) await runReconcile();
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
