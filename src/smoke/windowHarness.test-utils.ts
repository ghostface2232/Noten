// Smoke-test harness: a "window" wired to the REAL persistence and sync core.
//
// Every other suite in this repo tests one module with its neighbours mocked.
// These smoke tests instead run the real libraryStore, the real
// persistDecomposedState / loadDecomposedState, the real reconcileFolder, and
// the real mergeDiskGroups against one shared in-memory folder, with two
// windows on it — the shape the app actually runs in. What they are for is the
// bug class the recent fixes all belong to: a commit computed from a snapshot
// that went stale across an await, erasing a concurrent change. That class is
// invisible to per-module tests because every module is individually correct;
// it only appears when the store, the disk, and a second window interleave.
//
// The adapters below MIRROR production (useNotesLoader's commitDocsUpdate /
// commitGroupsUpdate, useFileWatcher's reloadGroupsFromDisk and
// performReconcile). They are deliberately thin: if one drifts from the hook
// it mirrors, the reference in its doc comment is the place to look.
import { createLibraryStore, type LibraryStore } from "../utils/libraryStore";
import {
  persistDecomposedState,
  loadDecomposedState,
  seedWriteSnapshots,
  syncGroupsSnapshotFromDisk,
  createPersistState,
  type PersistState,
} from "../utils/decomposedState";
import { readGroupsFile } from "../utils/groupsIO";
import { readAllMeta, invalidateReadAllMetaCache } from "../utils/metadataIO";
import { reconcileFolder, createReconcileState, type ReconcileState } from "../utils/reconcileFolder";
import { mergeDiskGroups } from "../utils/mergeDiskGroups";
import type { FileSystem } from "../utils/fs";
import type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";

export const DIR = "/notes";

export interface SmokeWindow {
  readonly label: string;
  readonly store: LibraryStore;
  readonly persistState: PersistState;
  readonly reconcileState: ReconcileState;
  docs(): NoteDoc[];
  groups(): NoteGroup[];
  /** Group id → member note ids, for assertions that don't care about order. */
  membership(): Record<string, string[]>;
  /** Functional docs commit — the only shape production allows. */
  commitDocs(update: (prev: NoteDoc[]) => NoteDoc[]): void;
  /** Functional groups commit (mirrors commitGroupsUpdate: entries cloned first). */
  commitGroups(update: (prev: NoteGroup[]) => NoteGroup[]): void;
  /** Drop this window's readAllMeta TTL cache, as production's convergence
   *  flows do on entry. Called by every disk-reading flow below — see the
   *  note at the method. */
  invalidateOwnMetaCache(): void;
  /** Seed this window from disk, DISCARDING local state — this models the
   *  directory-switch seed, not the loader's `mergeHydratedLibrary` rebase
   *  (which is generation-bound and Tauri-side). */
  loadDiscardingLocal(): Promise<void>;
  /** Write the store to disk (mirrors saveManifest → persistDecomposedState). */
  persist(): Promise<void>;
  /** Mirrors useFileWatcher.reloadGroupsFromDisk (clock merge, not overwrite). */
  reloadGroups(): Promise<void>;
  /** Mirrors useFileWatcher.performReconcile, token guard included. */
  reconcile(): Promise<{ changed: boolean; committed: boolean }>;
  /** Functional trash commit (mirrors commitTrashedNotesUpdate). */
  commitTrash(update: (prev: TrashedNote[]) => TrashedNote[]): void;
  /** Record an unwritten local move, as markGroupMembershipChanged does. */
  markMembership(noteId: string, groupId: string | null, at: number): void;
  /** Record an unwritten local group delete, as markGroupAsDeleted does. */
  markGroupDeleted(groupId: string, seq: number): void;
}

export function createSmokeWindow(sharedFs: FileSystem, label: string): SmokeWindow {
  // Per-window facade over the shared folder. readAllMeta caches by FileSystem
  // IDENTITY (metadataIO), and two windows are two JS realms with two caches —
  // sharing one object would let a peer's write refresh our cache and hand
  // these tests fresher sidecars than production ever sees.
  const fs: FileSystem = { ...sharedFs };
  const store = createLibraryStore();
  const persistState = createPersistState();
  const reconcileState = createReconcileState();

  type GroupLike = Omit<NoteGroup, "noteIds"> & { noteIds: readonly string[] };
  const cloneGroups = (groups: readonly GroupLike[]): NoteGroup[] =>
    groups.map((g) => ({ ...g, noteIds: [...g.noteIds] }));

  const win: SmokeWindow = {
    label,
    store,
    persistState,
    reconcileState,

    docs: () => [...store.getSnapshot().docs] as NoteDoc[],
    groups: () => cloneGroups(store.getSnapshot().groups),
    membership: () => Object.fromEntries(
      cloneGroups(store.getSnapshot().groups).map((g) => [g.id, [...g.noteIds].sort()]),
    ),

    commitDocs(update) {
      const previous = [...store.getSnapshot().docs] as NoteDoc[];
      const next = update(previous);
      if (next === previous) return;
      store.commit({ docs: next }, "local");
    },

    commitGroups(update) {
      const previous = cloneGroups(store.getSnapshot().groups);
      const next = update(previous);
      if (next === previous) return;
      store.commit({ groups: next }, "local");
    },

    // Mirrors the invalidateReadAllMetaCache call at the top of production's
    // convergence flows (useFileWatcher.performReconcile and
    // reloadGroupsFromDisk, plus the loader's directory seeds): a flow that
    // runs because the folder changed under us must read sidecars no older
    // than its trigger — never the autosave-path TTL cache, which only our
    // own writes keep consistent. In these tests every step runs within one
    // 500ms TTL window, so without the drop each disk-reading flow would
    // re-read the sidecars as of this window's LAST read, and whether the
    // fresh or the stale path ran would depend on wall-clock time.
    // persist() deliberately does NOT drop the cache — faithful to
    // production: autosave is the hot path the cache exists for, and
    // writeMeta patches it in place for our own writes.
    invalidateOwnMetaCache() {
      invalidateReadAllMetaCache(fs, DIR);
    },

    async loadDiscardingLocal() {
      win.invalidateOwnMetaCache();
      const loaded = await loadDecomposedState(fs, DIR, {
        activeNoteId: null,
        lastOpenedNoteId: null,
        groupCollapsed: {},
      });
      await seedWriteSnapshots(fs, DIR, persistState);
      store.seedDirectory(DIR, {
        docs: loaded.docs,
        groups: loaded.groups,
        trashedNotes: loaded.trashedNotes,
        activeNoteId: loaded.activeNoteId,
      });
    },

    async persist() {
      // Production's persistence job reads the store when it EXECUTES, never a
      // captured array (see src/hooks/AGENTS.md's manifest-queue rule), so read here.
      const snapshot = store.getSnapshot();
      await persistDecomposedState(
        fs,
        DIR,
        persistState,
        [...snapshot.docs] as NoteDoc[],
        snapshot.activeNoteId,
        cloneGroups(snapshot.groups),
        {
          // Read from the store at execution time, like the real persistence
          // job — never a value captured when the write was queued.
          trashedNotes: snapshot.trashedNotes.map((t) => ({ ...t })),
          machineId: label,
          cachePath: null,
          imageAssetMigrationCompletedAt: null,
        },
      );
    },

    async reloadGroups() {
      win.invalidateOwnMetaCache();
      // Production runs this first, and it is load-bearing: it resets the
      // write snapshot to disk state, so a store reverted by an absolute
      // commit would then look snapshot-equal at persist time and never be
      // written — the silent, durable half of the old bug.
      await syncGroupsSnapshotFromDisk(fs, DIR, persistState);
      const file = await readGroupsFile(fs, DIR);
      const { byId: metaById } = await readAllMeta(fs, DIR);
      // Pending intents and live ids are read AFTER the awaits, in the same
      // tick as the commit — exactly as the watcher does.
      // Production also unions useWindowSync's session `retiredGroupIds` here;
      // that set is Tauri-bound, so the peer-delete-before-tombstone path is
      // not modelled by these tests.
      const pendingTombstoneIds = new Set(persistState.pendingTombstones.keys());
      const pendingMembership = new Map(persistState.pendingGroupMembership);
      const liveDocIds = new Set(store.getSnapshot().docs.map((d) => d.id));
      win.commitGroups((prev) => mergeDiskGroups(prev, {
        entries: file.groups,
        metaById,
        collapsedByGroup: {},
        pendingTombstoneIds,
        pendingMembership,
        liveDocIds,
      }));
    },

    async reconcile() {
      win.invalidateOwnMetaCache();
      const token = store.getToken();
      const baseline = store.getSnapshot();
      const result = await reconcileFolder(
        fs,
        reconcileState,
        DIR,
        [...baseline.docs] as NoteDoc[],
        cloneGroups(baseline.groups),
        "en",
        persistState.pendingGroupMembership,
      );
      if (!result.changed) return { changed: false, committed: false };
      // The watcher's absolute commit is legal only while the store has not
      // moved; commitIfCurrent is that guard as a store primitive.
      const committed = store.commitIfCurrent(
        token,
        { docs: result.docs, groups: result.groups },
        "reconcile",
      );
      return { changed: true, committed: committed !== null };
    },

    commitTrash(update) {
      const previous = [...store.getSnapshot().trashedNotes] as TrashedNote[];
      const next = update(previous);
      if (next === previous) return;
      store.commit({ trashedNotes: next }, "local");
    },

    markMembership(noteId, groupId, at) {
      persistState.pendingGroupMembership.set(noteId, { groupId, updatedAt: at });
    },

    markGroupDeleted(groupId, seq) {
      persistState.pendingTombstones.set(groupId, seq);
    },
  };

  return win;
}

export function makeDoc(id: string, overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    id,
    filePath: `${DIR}/${id}.md`,
    fileName: id,
    isDirty: false,
    content: `# ${id}\n`,
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    ...overrides,
  };
}

export function makeGroup(id: string, overrides: Partial<NoteGroup> = {}): NoteGroup {
  return {
    id,
    name: id.toUpperCase(),
    noteIds: [],
    collapsed: false,
    createdAt: 1000,
    orderKey: "m",
    orderUpdatedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}
