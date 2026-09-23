import { useState, useEffect, useRef, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import {
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { tauriFileSystem } from "../utils/fs";
import { mapWithConcurrency } from "../utils/concurrency";
import { normalizeSep } from "../utils/pathUtils";
import { reconcileFolder, createReconcileState, clearReconcileState, type ReconcileState } from "../utils/reconcileFolder";
import {
  createPersistState,
  clearPersistState,
  persistDecomposedState as persistDecomposedStateImpl,
  type PersistResult,
  loadDecomposedState as loadDecomposedStateImpl,
  seedWriteSnapshots as seedWriteSnapshotsImpl,
  syncGroupsSnapshotFromDisk as syncGroupsSnapshotFromDiskImpl,
  readLocalCache as readLocalCacheImpl,
  writeLocalCache as writeLocalCacheImpl,
  type MetaSnapshot,
  type LocalCache,
  type DecomposedState,
} from "../utils/decomposedState";
import { markOwnWrite } from "./ownWriteTracker";
import { isValidNoteId } from "../utils/noteId";
import { NotenError } from "../utils/notenError";
import { logNotenError } from "../utils/crashLog";
import type { Locale, NotesSortOrder } from "./useSettings";
import { getDefaultDocumentTitle, keepManualTitle } from "../utils/documentTitle";
import type { NoteColorId } from "../utils/noteColors";
import type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
import {
  libraryStore,
  type LibraryCommitOrigin,
  type LibraryCommitToken,
  type LibraryData,
  type LibraryPatch,
  type LibrarySnapshot,
  type LibraryUpdater,
} from "../utils/libraryStore";
export type { NoteDoc, NoteGroup, TrashedNote } from "../utils/noteTypes";
export { deriveTitle, getFileBaseName, stripInlineMarkdown, stripMarkdownContent } from "../utils/noteText";
import { migrateDataUrlImagesToAssets } from "../utils/migrateImageAssets";
import { purgeTrashedNoteFiles } from "../utils/trashPurge";
import {
  metaPathFor,
  metaDirFor,
  readAllMeta,
  readMeta,
  writeMeta as writeMetaFile,
  removeMeta as removeMetaFile,
  invalidateReadAllMetaCache,
  type NoteMeta,
} from "../utils/metadataIO";
import {
  groupsPathFor,
  readGroupsFile,
  writeGroupsWithMerge,
  genOrderKeyAfter,
  type SharedGroupEntry,
} from "../utils/groupsIO";
import { getMachineId, getMachineIdCached } from "../utils/machineId";
import {
  ensureSharedDirs,
  retireLegacyManifest,
  scanAndAbsorbConflicts,
} from "../utils/conflictFileDetector";
import {
  isTrashExpired,
  observeTrash,
  readTrashObservations,
  writeTrashObservations,
  type TrashObservation,
  type TrashObservations,
} from "../utils/trashRetention";
import {
  setKnownDiskContent,
  resetKnownDiskContent,
  restoreKnownDiskContent,
  type KnownDiskContentSnapshot,
} from "../utils/conflictBackup";
import {
  getUiStateCached,
  loadUiState,
  setActiveNoteIdPersisted,
  setGroupCollapsedPersisted,
} from "./useUiState";

let notesDirCache: string | null = null;
let imageAssetMigrationV1CompletedAtCache: number | null = null;
let trashedNotesCache: TrashedNote[] = [];
export function getTrashedNotesCache(): TrashedNote[] { return trashedNotesCache; }
export function setTrashedNotesCache(notes: TrashedNote[]) { trashedNotesCache = notes; }

/** Blocks public persistence while the notes directory is moving or reloading. */
export let migrationInProgress = false;
export function setMigrationInProgress(v: boolean) { migrationInProgress = v; }

// Held by the loader while a hydration epoch is in flight. Until it drops the
// store holds a manifest-cache projection and the write snapshots are unseeded,
// so a full-library persist would rewrite every sidecar from stale cache values
// (trashedAt: null included). Distinct from migrationInProgress because a
// migration deliberately enqueues its persistence barrier BEFORE raising that
// guard and still expects the barrier to write.
let hydrationInProgress = false;
let hydrationSettled: Promise<void> = Promise.resolve();
let resolveHydrationSettled: (() => void) | null = null;
function setHydrationInProgress(value: boolean) {
  if (value === hydrationInProgress) return;
  hydrationInProgress = value;
  if (value) {
    hydrationSettled = new Promise<void>((resolve) => { resolveHydrationSettled = resolve; });
  } else {
    resolveHydrationSettled?.();
    resolveHydrationSettled = null;
  }
}
// Loops so a reload that starts right as the previous load settles is
// awaited too; callers re-check the migration guard afterwards.
async function awaitHydrationSettled(): Promise<void> {
  while (hydrationInProgress) await hydrationSettled;
}

// Single bundle of diff caches and pending writes. External helpers below
// (markGroupAsDeleted etc.) mutate this bundle so callers in useFileSystem,
// useNoteGroups, and useWindowSync don't need to thread it explicitly.
const persistState = createPersistState();

// Monotonic logical clock for group deletions. `markGroupAsDeleted` stamps each
// tombstone with the next value; `saveManifest` captures the current value when
// a save is ENQUEUED. Comparing the two at drain time lets persist tell a
// genuine resurrection (save enqueued after the delete) from a slow in-flight
// save whose groups snapshot predates the delete, so the latter can no longer
// cancel the tombstone and revive the group (P0-4).
let groupMutationSeq = 0;
let noteMetadataMutationSeq = 0;
const noteMetadataMutationClocks = new Map<string, {
  title: number;
  pinned: number;
  color: number;
}>();
const ackedNoteMetadataMutationClocks = new Map<string, {
  title: number;
  pinned: number;
  color: number;
}>();

function noteMetadataClock(noteId: string) {
  return noteMetadataMutationClocks.get(noteId) ?? { title: 0, pinned: 0, color: 0 };
}

function ackedNoteMetadataClock(noteId: string) {
  return ackedNoteMetadataMutationClocks.get(noteId) ?? { title: 0, pinned: 0, color: 0 };
}

function acknowledgeNoteMetadataClock(
  noteId: string,
  clock: { title: number; pinned: number; color: number },
  fields: { title: boolean; pinned: boolean; color: boolean } = {
    title: true,
    pinned: true,
    color: true,
  },
): void {
  const acknowledged = ackedNoteMetadataClock(noteId);
  ackedNoteMetadataMutationClocks.set(noteId, {
    title: fields.title ? Math.max(acknowledged.title, clock.title) : acknowledged.title,
    pinned: fields.pinned ? Math.max(acknowledged.pinned, clock.pinned) : acknowledged.pinned,
    color: fields.color ? Math.max(acknowledged.color, clock.color) : acknowledged.color,
  });
}

function markNoteMetadataFieldChanged(
  noteIds: string[],
  field: "title" | "pinned" | "color",
): void {
  const seq = ++noteMetadataMutationSeq;
  for (const noteId of noteIds) {
    noteMetadataMutationClocks.set(noteId, { ...noteMetadataClock(noteId), [field]: seq });
  }
}

export function markNoteTitleChanged(noteId: string): void {
  markNoteMetadataFieldChanged([noteId], "title");
}

export function markNotesPinnedChanged(noteIds: string[]): void {
  markNoteMetadataFieldChanged(noteIds, "pinned");
}

export function markNotesColorChanged(noteIds: string[]): void {
  markNoteMetadataFieldChanged(noteIds, "color");
}

export function markGroupMembershipChanged(noteId: string, groupId: string | null, updatedAt = Date.now()): void {
  persistState.pendingGroupMembership.set(noteId, { groupId, updatedAt });
}

export function markGroupMembershipChanges(
  noteIds: string[],
  groupId: string | null,
  updatedAt = Date.now(),
): void {
  for (const noteId of noteIds) {
    persistState.pendingGroupMembership.set(noteId, { groupId, updatedAt });
  }
}

export function markGroupAsDeleted(id: string): void {
  persistState.pendingTombstones.set(id, ++groupMutationSeq);
}

export function unmarkGroupAsDeleted(id: string): void {
  persistState.pendingTombstones.delete(id);
}

function resetWriteSnapshots() {
  clearPersistState(persistState);
  noteMetadataMutationClocks.clear();
  ackedNoteMetadataMutationClocks.clear();
}

async function seedWriteSnapshots(dir: string): Promise<void> {
  await seedWriteSnapshotsImpl(tauriFileSystem, dir, persistState);
}

export async function syncGroupsSnapshotFromDisk(dir: string): Promise<void> {
  await syncGroupsSnapshotFromDiskImpl(tauriFileSystem, dir, persistState);
}

export function sortNotes(docs: NoteDoc[], order: NotesSortOrder, locale: Locale = "en"): NoteDoc[] {
  const sorted = [...docs];
  const desc = order.endsWith("-desc");
  const direction = desc ? -1 : 1;
  const byTitle = order.startsWith("title");
  const byCreated = order.startsWith("created");

  sorted.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;

    if (byTitle) {
      const cmp = a.fileName.localeCompare(b.fileName, locale);
      if (cmp !== 0) return cmp * direction;
      return b.updatedAt - a.updatedAt;
    }

    const primaryDiff = byCreated
      ? a.createdAt - b.createdAt
      : a.updatedAt - b.updatedAt;
    if (primaryDiff !== 0) return primaryDiff * direction;

    const secondaryDiff = byCreated
      ? a.updatedAt - b.updatedAt
      : a.createdAt - b.createdAt;
    if (secondaryDiff !== 0) return secondaryDiff * direction;

    return a.fileName.localeCompare(b.fileName, locale);
  });

  return sorted;
}

/**
 * Live bookkeeping for one hydration epoch, maintained by the loader while the
 * disk read is in flight and read when the result is rebased. Provenance is
 * recorded explicitly here rather than inferred from the data: an empty body is
 * a legitimate document state, not a marker for a cache projection, and an id
 * missing from the store may have been deleted by a peer or may simply not have
 * been projected yet. It covers docs, groups, and trash alike — a stale disk
 * read wins over a concurrent peer change in any of the three otherwise.
 */
export interface HydrationEpochState {
  /** Every doc id the loader itself put in the store this epoch. */
  readonly seededIds: ReadonlySet<string>;
  /** Seeded ids still holding a body-less manifest-cache projection. */
  readonly projectionIds: ReadonlySet<string>;
  /** Ids a non-loader commit removed this epoch: peer or local deletions. */
  readonly deletedIds: ReadonlySet<string>;
  /** Group ids the loader itself put in the store this epoch. */
  readonly seededGroupIds: ReadonlySet<string>;
  /** Group ids a non-loader commit added or changed this epoch. */
  readonly touchedGroupIds: ReadonlySet<string>;
  /** Group ids a non-loader commit removed this epoch. */
  readonly removedGroupIds: ReadonlySet<string>;
  /** Trash ids the loader itself put in the store this epoch. */
  readonly seededTrashIds: ReadonlySet<string>;
  /**
   * Trash entries a non-loader commit removed this epoch (restore / purge),
   * by the `trashedAt` of the incarnation that was removed — the id alone
   * would also retire a later re-trash.
   */
  readonly trashRemovals: ReadonlyMap<string, number>;
}

/**
 * Rebase a hydration result onto whatever the store holds now. Hydration is
 * generation-bound, not revision-bound: a peer window's doc-updated /
 * doc-created / groups-updated / trash-updated event, or App's own projection
 * effects, may commit while the disk load is in flight, and aborting on that
 * would leave the manifest-cache projection (empty bodies) as the canonical
 * library. Disk wins wherever the epoch saw no concurrent change; a peer body
 * newer than the disk read survives, an entity the loader never seeded (a
 * peer-created note, group, or trash entry) is kept rather than dropped, and
 * one a peer deleted mid-epoch stays deleted rather than being resurrected.
 */
export function mergeHydratedLibrary(
  current: LibrarySnapshot,
  hydrated: LibraryData,
  epoch: HydrationEpochState,
  order: NotesSortOrder,
  locale: Locale,
): LibraryPatch {
  const liveById = new Map(current.docs.map((doc) => [doc.id, doc]));
  const docs: NoteDoc[] = [];
  for (const doc of hydrated.docs) {
    const live = liveById.get(doc.id);
    if (!live) {
      // Absent from the store because it was deleted while we loaded, not
      // because it had yet to be projected: the stale read must not revive it.
      if (epoch.deletedIds.has(doc.id)) continue;
      docs.push(doc);
      continue;
    }
    const diskBodyWins = epoch.projectionIds.has(doc.id)
      || live.content === doc.content
      || live.updatedAt <= doc.updatedAt;
    // The sidecar this read can predate a rename, whether it landed during the
    // load or is still queued in a peer; the manual pair survives the rebase.
    docs.push(keepManualTitle(
      live,
      diskBodyWins ? doc : { ...doc, content: live.content, updatedAt: live.updatedAt },
    ));
  }
  const hydratedIds = new Set(hydrated.docs.map((doc) => doc.id));
  for (const live of current.docs) {
    if (hydratedIds.has(live.id) || epoch.seededIds.has(live.id)) continue;
    docs.push(live);
  }

  // Groups carry no reliable version (updatedAt is optional), so the epoch's
  // record of what a peer touched decides, not a timestamp comparison.
  const liveGroupById = new Map(current.groups.map((group) => [group.id, group]));
  const groups: LibraryData["groups"][number][] = [];
  for (const group of hydrated.groups) {
    if (epoch.removedGroupIds.has(group.id)) continue;
    const live = liveGroupById.get(group.id);
    groups.push(live && epoch.touchedGroupIds.has(group.id) ? live : group);
  }
  const hydratedGroupIds = new Set(hydrated.groups.map((group) => group.id));
  for (const live of current.groups) {
    if (hydratedGroupIds.has(live.id) || epoch.seededGroupIds.has(live.id)) continue;
    groups.push(live);
  }

  // Trash does carry a version — `trashedAt` — and the same incarnation rule
  // the trash-updated receiver applies: a removal retires one incarnation.
  const liveTrashById = new Map(current.trashedNotes.map((note) => [note.id, note]));
  const trashedNotes: LibraryData["trashedNotes"][number][] = [];
  for (const note of hydrated.trashedNotes) {
    const live = liveTrashById.get(note.id);
    if (!live) {
      const retiredAt = epoch.trashRemovals.get(note.id);
      if (retiredAt != null && note.trashedAt <= retiredAt) continue;
      trashedNotes.push(note);
      continue;
    }
    trashedNotes.push(live.trashedAt > note.trashedAt ? live : note);
  }
  const hydratedTrashIds = new Set(hydrated.trashedNotes.map((note) => note.id));
  for (const live of current.trashedNotes) {
    if (hydratedTrashIds.has(live.id) || epoch.seededTrashIds.has(live.id)) continue;
    trashedNotes.push(live);
  }

  const sorted = sortNotes(docs, order, locale);
  const has = (id: string | null) => id != null && sorted.some((doc) => doc.id === id);
  const activeNoteId = has(hydrated.activeNoteId)
    ? hydrated.activeNoteId
    : has(current.activeNoteId)
      ? current.activeNoteId
      : (sorted[0]?.id ?? null);
  return {
    docs: sorted,
    groups,
    trashedNotes,
    activeNoteId,
  };
}

let defaultNotesDirCache: string | null = null;

/** The app-data fallback directory, without touching the active-dir cache. */
export async function getDefaultNotesDir(): Promise<string> {
  const base = await appDataDir();
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  defaultNotesDirCache = `${base}${sep}notes`;
  return defaultNotesDirCache;
}

function isSameNotesDir(a: string, b: string): boolean {
  const norm = (dir: string) => normalizeSep(dir).replace(/\\/g, "/").toLocaleLowerCase();
  return norm(a) === norm(b);
}

export async function getNotesDir(): Promise<string> {
  if (notesDirCache) return notesDirCache;
  notesDirCache = await getDefaultNotesDir();
  return notesDirCache;
}

/**
 * Cleared state mirrors the active notes directory; pass the ReconcileState
 * instance so its bodyMissing observations are reset alongside the snapshot
 * caches. Callers that omit it accept that the observations will carry over.
 */
export function setNotesDir(dir: string, reconcileState?: ReconcileState) {
  const sameDirectory = notesDirCache != null && isSameNotesDir(notesDirCache, dir);
  if (sameDirectory) {
    notesDirCache = dir;
    return;
  }
  libraryStore.clearDirectory("hydrate");
  notesDirCache = dir;
  imageAssetMigrationV1CompletedAtCache = null;
  resetWriteSnapshots();
  resetKnownDiskContent();
  invalidateReadAllMetaCache(tauriFileSystem);
  if (reconcileState) clearReconcileState(reconcileState);
}

/**
 * Rebind a failed directory migration without discarding the still-live UI state.
 *
 * `baselines` must be captured alongside `preserved`. The settings effect has
 * usually already switched to the new directory and cleared the map, and no
 * hydration follows this rollback. An empty map would make every note's first
 * save write a spurious .conflicts copy, refuse the empty-note prunes for the
 * rest of the session, and journal recovery records with no base to apply.
 */
export function restoreNotesDir(
  dir: string,
  preserved: LibraryData,
  baselines: KnownDiskContentSnapshot,
  reconcileState?: ReconcileState,
) {
  libraryStore.seedDirectory(dir, preserved, "hydrate");
  notesDirCache = dir;
  imageAssetMigrationV1CompletedAtCache = null;
  resetWriteSnapshots();
  restoreKnownDiskContent(baselines);
  invalidateReadAllMetaCache(tauriFileSystem);
  if (reconcileState) clearReconcileState(reconcileState);
}

export function resetNotesDir(reconcileState?: ReconcileState) {
  // Idempotent when the cache already points at the default directory, like
  // setNotesDir for a same-path directory: a use-selected-only revert seeds the
  // preserved library back under the default dir and then persists "" — the
  // settings effect that follows must not clear the store it just restored.
  const bound = libraryStore.getSnapshot().notesDirectory;
  if (
    notesDirCache != null
    && defaultNotesDirCache != null
    && bound != null
    && isSameNotesDir(notesDirCache, defaultNotesDirCache)
    && isSameNotesDir(bound, defaultNotesDirCache)
  ) return;
  libraryStore.clearDirectory("hydrate");
  notesDirCache = null;
  imageAssetMigrationV1CompletedAtCache = null;
  resetWriteSnapshots();
  resetKnownDiskContent();
  invalidateReadAllMetaCache(tauriFileSystem);
  if (reconcileState) clearReconcileState(reconcileState);
}

async function ensureNotesDir(): Promise<string> {
  const dir = await getNotesDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

export async function getTrashDir(): Promise<string> {
  const notesDir = await getNotesDir();
  const sep = notesDir.endsWith("/") || notesDir.endsWith("\\") ? "" : "/";
  return `${notesDir}${sep}.trash`;
}

export async function ensureTrashDir(): Promise<string> {
  const dir = await getTrashDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

let trashObservationsCache: TrashObservations = {};

/** This machine's sighting of a trash entry as of the last purge pass, for
 *  showing how long the purge will actually wait. */
export function getTrashObservation(noteId: string): TrashObservation | undefined {
  return trashObservationsCache[noteId];
}

async function getTrashObservationsPath(): Promise<string> {
  const base = await appDataDir();
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  return `${base}${sep}trash-observed.json`;
}

export async function purgeExpiredTrash(trashedNotes: TrashedNote[]): Promise<TrashedNote[]> {
  const now = Date.now();
  const kept: TrashedNote[] = [];
  // Machine-local (appData, never the synced folder): it records what this
  // machine's clock saw, which is the point.
  let observationsPath: string | null = null;
  let observations: TrashObservations = {};
  try {
    observationsPath = await getTrashObservationsPath();
    observations = await readTrashObservations(tauriFileSystem, observationsPath);
  } catch { /* nothing observed yet: every entry is kept this launch */ }
  let notesDir: string | null = null;
  try {
    notesDir = await getNotesDir();
  } catch (err) {
    // Trash body removal below still works (absolute trashFilePath), but the
    // asset-dir and meta sidecar cleanups depend on notesDir and now get
    // skipped. Orphan files are recoverable on next launch's reconcile, but
    // the partial-cleanup state should be diagnosable.
    void logNotenError(new NotenError(
      "TRASH_PURGE_FAILED",
      "recoverable",
      "purgeExpiredTrash: getNotesDir failed; bodies removed but meta/assets stay orphaned",
      { cause: err },
    ));
  }

  for (const note of trashedNotes) {
    // Defense-in-depth: an unsafe id here drives recursive deletes
    // (removeNoteAssetDir). Upstream validation should prevent it, but never
    // purge such an entry — keep it visible/inert so the bad sidecar can be
    // diagnosed rather than acted on.
    if (!isValidNoteId(note.id)) {
      void logNotenError(new NotenError(
        "INVALID_NOTE_ID",
        "recoverable",
        "purgeExpiredTrash: skipping trashed note with unsafe id",
        { context: { noteId: note.id } },
      ));
      kept.push(note);
      continue;
    }
    // A body that could not be removed stays listed, so the next launch
    // retries instead of the file lingering in .trash with no sidecar.
    if (
      !isTrashExpired(note, observations[note.id], now)
      || !await purgeTrashedNoteFiles(tauriFileSystem, notesDir, note)
    ) {
      kept.push(note);
    }
  }

  const nextObservations = observeTrash(observations, kept, now);
  trashObservationsCache = nextObservations;
  if (observationsPath) {
    // A failed write only restarts the local count next launch, but one that
    // keeps failing means the trash never purges, so leave a trace of it.
    await writeTrashObservations(tauriFileSystem, observationsPath, nextObservations).catch((err) => {
      void logNotenError(new NotenError(
        "TRASH_PURGE_FAILED",
        "recoverable",
        "purgeExpiredTrash: could not record trash sightings; purges wait until one is recorded",
        { context: { path: observationsPath }, cause: err },
      ));
    });
  }
  return kept;
}

let localCachePathPromise: Promise<string> | null = null;

async function getLocalCachePath(): Promise<string> {
  if (!localCachePathPromise) {
    localCachePathPromise = (async () => {
      const base = await appDataDir();
      await mkdir(base, { recursive: true }).catch(() => {});
      const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
      return `${base}${sep}manifest-cache.json`;
    })();
  }
  return localCachePathPromise;
}

async function readLocalCache(notesDir: string): Promise<LocalCache | null> {
  const path = await getLocalCachePath();
  const cache = await readLocalCacheImpl(tauriFileSystem, path, notesDir);
  if (cache) imageAssetMigrationV1CompletedAtCache = cache.imageAssetMigrationV1CompletedAt ?? null;
  return cache;
}

/**
 * Returns `null` on read failure rather than `""`, because a transient
 * cloud-sync read failure followed by an empty-string fallback would poison
 * the in-memory doc: the user sees a blank note, edits it, and autosave
 * overwrites the real on-disk body. Callers must skip the doc on `null` so
 * the next load (or watcher event) retries the read.
 */
async function readFileContent(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch (err) {
    void logNotenError(new NotenError(
      "BODY_READ_FAILED",
      "recoverable",
      "useNotesLoader: body read failed; deferring doc until next load",
      { context: { filePath: path }, cause: err },
    ));
    return null;
  }
}

/** Raw on-disk group state for a clock-based merge (mergeDiskGroups). Keeps
 *  tombstoned entries and the full sidecar map — the tombstoned / absent
 *  distinction and the membership clocks are what let the watcher merge disk
 *  into the live store instead of overwriting it. */
export async function readDiskGroupsSnapshot(dir: string): Promise<{
  entries: Record<string, SharedGroupEntry>;
  metaById: Map<string, NoteMeta>;
  collapsedByGroup: Record<string, boolean>;
}> {
  await loadUiState();
  const file = await readGroupsFile(tauriFileSystem, dir);
  // Quarantined sidecars are left out of the map, which mergeDiskGroups
  // already reads conservatively: a live note with no disk meta keeps the
  // group it currently has rather than being ungrouped.
  const { byId: metaById } = await readAllMeta(tauriFileSystem, dir);
  return {
    entries: file.groups,
    metaById,
    collapsedByGroup: getUiStateCached().groupCollapsed,
  };
}

/** The LIVE pending-membership map, for consumers that must observe intents
 *  added after they started (reconcileFolder resolves membership at the end of
 *  a multi-second pass; it pairs this with its own copy taken at the sidecar
 *  read). Read-only by contract: only the persist layer may mutate it. */
export function getPendingGroupMembership(): ReadonlyMap<
  string,
  { groupId: string | null; updatedAt: number }
> {
  return persistState.pendingGroupMembership;
}

/** Snapshot of the not-yet-persisted local group intents (delete tombstones
 *  and membership moves). The watcher's disk merge must respect both, or a
 *  reload racing an unwritten local intent would revert it in-store — and,
 *  for deletes, the resurrection would cancel the pending tombstone. */
export function getPendingGroupSyncSnapshot(): {
  tombstoneIds: Set<string>;
  membership: Map<string, { groupId: string | null; updatedAt: number }>;
} {
  return {
    tombstoneIds: new Set(persistState.pendingTombstones.keys()),
    membership: new Map(persistState.pendingGroupMembership),
  };
}

async function loadDecomposedState(dir: string): Promise<DecomposedState> {
  return loadDecomposedStateImpl(tauriFileSystem, dir, getUiStateCached());
}

// Body reads run through a fixed window instead of one IPC call per note at
// once. See mapWithConcurrency for why an unbounded fan-out hurts most on the
// cloud-synced folders this app explicitly supports.
const BODY_READ_CONCURRENCY = 12;

async function attachDocContents(docs: NoteDoc[]): Promise<NoteDoc[]> {
  const results = await mapWithConcurrency(docs, BODY_READ_CONCURRENCY, async (d) => {
    const content = await readFileContent(d.filePath);
    if (content === null) return null;
    if (d.filePath) setKnownDiskContent(d.filePath, content);
    return { ...d, content } as NoteDoc;
  });
  return results.filter((d): d is NoteDoc => d !== null);
}

interface LegacyManifestNote {
  id: string;
  filePath: string;
  fileName: string;
  customName?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  color?: NoteColorId;
}

interface LegacyManifestGroup {
  id: string;
  name: string;
  noteIds: string[];
  collapsed?: boolean;
  createdAt?: number;
}

interface LegacyManifestTrashed {
  id: string;
  fileName: string;
  originalFilePath: string;
  trashFilePath: string;
  trashedAt: number;
  groupId: string | null;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  color?: NoteColorId;
}

interface LegacyManifest {
  version?: number;
  notes?: LegacyManifestNote[];
  activeNoteId?: string | null;
  groups?: LegacyManifestGroup[];
  trashedNotes?: LegacyManifestTrashed[];
  imageAssetMigrationV1CompletedAt?: number;
}

async function readLegacyManifestFile(dir: string): Promise<LegacyManifest | null> {
  try {
    const raw = await readTextFile(`${normalizeSep(dir)}manifest.json`);
    return JSON.parse(raw) as LegacyManifest;
  } catch {
    return null;
  }
}

async function decomposeLegacyManifest(dir: string, manifest: LegacyManifest): Promise<void> {
  const machineId = await getMachineId();

  const sharedGroups: Record<string, SharedGroupEntry> = {};
  let lastKey: string | undefined = undefined;
  const collapsedMap: Record<string, boolean> = {};
  const noteIdToGroupId = new Map<string, string>();
  const now = Date.now();

  for (const g of manifest.groups ?? []) {
    if (!g.id) continue;
    const orderKey = genOrderKeyAfter(lastKey);
    lastKey = orderKey;
    sharedGroups[g.id] = {
      id: g.id,
      name: g.name ?? "",
      orderKey,
      orderUpdatedAt: now,
      updatedAt: now,
      createdAt: g.createdAt ?? now,
      deletedAt: null,
    };
    if (g.collapsed) collapsedMap[g.id] = true;
    for (const noteId of g.noteIds ?? []) {
      noteIdToGroupId.set(noteId, g.id);
    }
  }

  if (Object.keys(sharedGroups).length > 0) {
    await writeGroupsWithMerge(tauriFileSystem, dir, sharedGroups);
  }

  for (const n of manifest.notes ?? []) {
    if (!isValidNoteId(n.id)) continue;
    await writeMetaFile(tauriFileSystem, dir, {
      version: 2,
      id: n.id,
      fileName: n.fileName,
      customName: n.customName || undefined,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      pinned: n.pinned === true,
      color: n.color,
      groupId: noteIdToGroupId.get(n.id) ?? null,
      groupUpdatedAt: n.updatedAt,
      trashedAt: null,
    }, machineId);
  }

  for (const t of manifest.trashedNotes ?? []) {
    if (!isValidNoteId(t.id)) continue;
    await writeMetaFile(tauriFileSystem, dir, {
      version: 2,
      id: t.id,
      fileName: t.fileName,
      customName: undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      pinned: t.pinned === true,
      color: t.color,
      groupId: t.groupId ?? null,
      groupUpdatedAt: t.updatedAt,
      trashedAt: t.trashedAt,
      trashedFromPath: t.originalFilePath,
    }, machineId);
  }

  if (manifest.activeNoteId) {
    await setActiveNoteIdPersisted(manifest.activeNoteId);
  }
  for (const [gid, collapsed] of Object.entries(collapsedMap)) {
    if (collapsed) await setGroupCollapsedPersisted(gid, true);
  }

  if (manifest.imageAssetMigrationV1CompletedAt) {
    imageAssetMigrationV1CompletedAtCache = manifest.imageAssetMigrationV1CompletedAt;
  }
}


// Ungated writer used by the loader while it already owns `migrationInProgress`.
// External callers should use `saveManifest`.
async function persistDecomposedState(
  docs: NoteDoc[],
  activeId: string | null,
  groups?: NoteGroup[],
  source?: string,
  snapshotSeq?: number,
  targetDir?: string,
  trashedNotes: TrashedNote[] = trashedNotesCache,
): Promise<PersistResult> {
  const dir = targetDir ?? await getNotesDir();
  const cachePath = await getLocalCachePath();
  try {
    return await persistDecomposedStateImpl(tauriFileSystem, dir, persistState, docs, activeId, groups, {
      trashedNotes,
      machineId: getMachineIdCached(),
      cachePath,
      imageAssetMigrationCompletedAt: imageAssetMigrationV1CompletedAtCache,
      setActiveNoteId: setActiveNoteIdPersisted,
      // Direct loader calls run while pendingTombstones is empty. Chained
      // saves pass a clock captured beside their execution-time groups array.
      groupsSnapshotSeq: snapshotSeq ?? groupMutationSeq,
    });
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[PERSIST_FAILED]", err);
    void logNotenError(new NotenError(
      "PERSIST_FAILED",
      "fatal",
      err instanceof Error ? err.message : String(err),
      { context: { dir, docCount: docs.length, activeId, source }, cause: err },
    ));
    throw err;
  }
}

function metaSnapshotFromFile(meta: NoteMeta): MetaSnapshot {
  return {
    fileName: meta.fileName,
    customName: !!meta.customName,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pinned: meta.pinned === true,
    color: meta.color ?? null,
    groupId: meta.groupId ?? null,
    groupUpdatedAt: meta.groupUpdatedAt ?? meta.updatedAt,
    trashedAt: meta.trashedAt ?? null,
  };
}

async function persistSavedNoteMetadata(
  doc: NoteDoc,
  fallbackGroupId: string | null,
  dir: string,
  source?: string,
  preferCanonical?: {
    title: boolean;
    createdAt: boolean;
    pinned: boolean;
    color: boolean;
  },
): Promise<NoteMeta | null> {
  try {
    // Read lifecycle at execution time, after older jobs on this window's
    // metadata chain have drained. This rejects a trash transition already on
    // disk; cross-window read/write exclusion belongs to the lifecycle
    // coordinator rather than this ordinary metadata patch.
    const disk = await readMeta(tauriFileSystem, dir, doc.id);
    if (disk?.trashedAt != null) {
      persistState.writtenMeta.set(doc.id, metaSnapshotFromFile(disk));
      return null;
    }
    if (!disk && (!doc.filePath || !(await tauriFileSystem.exists(doc.filePath)))) {
      return null;
    }

    // Autosave owns title/body timestamps only. Pin, color, group membership,
    // and lifecycle have independent mutation paths and clocks, so preserve
    // their latest disk values rather than replaying the editor's snapshot.
    const pendingGroup = persistState.pendingGroupMembership.get(doc.id);
    const groupId = pendingGroup
      ? pendingGroup.groupId
      : disk ? (disk.groupId ?? null) : fallbackGroupId;
    const groupUpdatedAt = pendingGroup?.updatedAt
      ?? disk?.groupUpdatedAt
      ?? disk?.updatedAt
      ?? doc.updatedAt;
    const diskOwnsTitle = disk?.customName === true && !preferCanonical?.title;
    const customName = diskOwnsTitle || doc.customName === true;
    const next: NoteMeta = {
      version: 2,
      id: doc.id,
      // Once a title is manual it is permanent. A stale autosave from a peer
      // that has not observed the rename must not re-enable auto-title.
      fileName: diskOwnsTitle ? disk.fileName : doc.fileName,
      customName,
      createdAt: disk && !preferCanonical?.createdAt ? disk.createdAt : doc.createdAt,
      updatedAt: doc.updatedAt,
      pinned: disk && !preferCanonical?.pinned
        ? disk.pinned === true
        : doc.pinned === true,
      color: disk && !preferCanonical?.color ? disk.color : doc.color,
      groupId,
      groupUpdatedAt,
      trashedAt: null,
      trashedFromPath: disk?.trashedFromPath ?? null,
    };

    await writeMetaFile(tauriFileSystem, dir, next, getMachineIdCached());
    persistState.writtenMeta.set(doc.id, metaSnapshotFromFile(next));

    // Keep the per-machine quick-paint cache current without rebuilding it
    // from the autosave's pre-commit full docs array.
    const cachePath = await getLocalCachePath();
    const cache = await readLocalCacheImpl(tauriFileSystem, cachePath, dir);
    if (cache) {
      const cachedDoc = {
        id: doc.id,
        filePath: doc.filePath,
        fileName: next.fileName,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
        ...(next.customName ? { customName: true } : {}),
        ...(next.pinned ? { pinned: true } : {}),
        ...(next.color ? { color: next.color } : {}),
      };
      const existingIndex = cache.notes.findIndex((entry) => entry.id === doc.id);
      const notes = existingIndex >= 0
        ? cache.notes.map((entry, index) => index === existingIndex ? cachedDoc : entry)
        : [...cache.notes, cachedDoc];
      const nextCache: LocalCache = { ...cache, notes };
      const serialized = JSON.stringify(nextCache, null, 2);
      if (persistState.lastWrittenLocalCache !== serialized) {
        await writeLocalCacheImpl(tauriFileSystem, cachePath, nextCache);
        persistState.lastWrittenLocalCache = serialized;
      }
    }
    return next;
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[PERSIST_FAILED]", err);
    void logNotenError(new NotenError(
      "PERSIST_FAILED",
      "fatal",
      err instanceof Error ? err.message : String(err),
      { context: { dir, noteId: doc.id, source }, cause: err },
    ));
    throw err;
  }
}

// Serializes ALL manifest writes within this window through a single chain.
// Without it, concurrent callers (autosave + watcher reconcile, sidebar action
// + autosave, etc.) raced: the later call's stale snapshot could finish first
// and the earlier one would overwrite disk on resolve. Chaining preserves
// call-time ordering on disk; .catch(() => undefined) keeps a failed entry
// from breaking subsequent writes. Multi-window races are a separate problem
// — this chain lives per-process, so each window has its own queue.
let persistChain: Promise<unknown> = Promise.resolve();
let persistedLibraryGeneration = -1;
let persistedLibraryRevision = -1;
let persistedGroupMutationSeq = -1;

interface LibraryPersistenceRequest {
  revision: number;
  directoryGeneration: number;
  source?: string;
}

// Notes whose sidecar the most recent persist deliberately did not write
// (readAllMeta's quarantine). The revision is still marked persisted, because
// flushPersistence loops until it is and an unreadable sidecar may never
// become readable — but the flush must not then report the library as fully
// durable, or the close gate and the migration ack accept work never done.
let lastPersistSkippedMeta = new Set<string>();

async function persistLatestLibrarySnapshot(
  request: LibraryPersistenceRequest,
  options?: { force?: boolean },
): Promise<boolean> {
  if (hydrationInProgress) return false;
  const latest = libraryStore.getSnapshot();
  if (
    latest.notesDirectory == null
    || latest.directoryGeneration !== request.directoryGeneration
  ) return false;
  if (
    !options?.force
    && persistedLibraryGeneration === latest.directoryGeneration
    && persistedLibraryRevision >= latest.revision
    && persistedGroupMutationSeq >= groupMutationSeq
  ) return true;

  // Queue entries carry only a revision/generation request. The full state is
  // read at execution time so a stale React array can never replay onto disk.
  const docs = latest.docs.map((doc) => ({ ...doc }));
  const noteClocks = new Map(docs.map((doc) => [doc.id, { ...noteMetadataClock(doc.id) }]));
  const groups = latest.groups.map((group) => ({
    ...group,
    noteIds: [...group.noteIds],
  }));
  // Group tombstones are module-level durable intents rather than library
  // entities. Capture their clock beside the execution-time group snapshot.
  const latestGroupMutationSeq = groupMutationSeq;
  const { skippedMetaIds } = await persistDecomposedState(
    docs,
    latest.activeNoteId,
    groups,
    request.source,
    latestGroupMutationSeq,
    latest.notesDirectory,
    latest.trashedNotes.map((note) => ({ ...note })),
  );

  const afterWrite = libraryStore.getSnapshot();
  if (
    afterWrite.directoryGeneration !== latest.directoryGeneration
    || afterWrite.notesDirectory !== latest.notesDirectory
  ) return false;
  persistedLibraryGeneration = latest.directoryGeneration;
  persistedLibraryRevision = latest.revision;
  persistedGroupMutationSeq = latestGroupMutationSeq;
  lastPersistSkippedMeta = skippedMetaIds;
  // A note whose sidecar the persist skipped had nothing written, so its
  // metadata clock stays unacknowledged and the intent remains retryable —
  // the same rule a thrown persist used to enforce for the whole batch.
  for (const [noteId, clock] of noteClocks) {
    if (skippedMetaIds.has(noteId)) continue;
    acknowledgeNoteMetadataClock(noteId, clock);
  }
  return true;
}

function enqueueLatestLibraryPersistence(request: LibraryPersistenceRequest): Promise<void> {
  const job = persistChain
    .catch(() => undefined)
    .then(async () => {
      await persistLatestLibrarySnapshot(request);
    });
  persistChain = job;
  return job;
}

export async function saveManifest(
  _docs: NoteDoc[],
  _activeId: string | null,
  _groups?: NoteGroup[],
  source?: string,
): Promise<void> {
  if (migrationInProgress) return;
  const requested = libraryStore.getSnapshot();
  return enqueueLatestLibraryPersistence({
    revision: requested.revision,
    directoryGeneration: requested.directoryGeneration,
    source,
  });
}

/** Drain all metadata work through a stable canonical library revision. */
/** Resolves true when every intent in the store is durable. False means the
 *  drain finished but some note's metadata was skipped — its sidecar could not
 *  be read, so writing would have clobbered it. Callers that gate on a
 *  completed drain (the close gate, the migration ack) must treat false as
 *  "not everything landed". */
export async function flushPersistence(source = "flushPersistence"): Promise<boolean> {
  while (true) {
    // A projection mid-hydration is not user state; the loader persists the
    // hydrated library itself once it lands. Waiting here would tie a window
    // close to cloud-folder I/O, and writing would clobber peer sidecars.
    if (hydrationInProgress) return true;
    const requested = libraryStore.getSnapshot();
    if (requested.notesDirectory == null) {
      // An empty, unbound store has nothing durable to flush. Never turn a
      // rejected metadata tail into a successful close/migration acknowledgement.
      await persistChain;
      const after = libraryStore.getSnapshot();
      if (
        after.directoryGeneration !== requested.directoryGeneration
        || after.revision !== requested.revision
      ) continue;
      if (
        after.docs.length > 0
        || after.groups.length > 0
        || after.trashedNotes.length > 0
        || after.activeNoteId != null
      ) {
        throw new Error("Cannot flush library state without an active notes directory");
      }
      return true;
    }
    await enqueueLatestLibraryPersistence({
      revision: requested.revision,
      directoryGeneration: requested.directoryGeneration,
      source,
    });
    // A reload that started while the barrier was queued skipped the write.
    if (hydrationInProgress) return true;
    const after = libraryStore.getSnapshot();
    if (
      after.directoryGeneration === persistedLibraryGeneration
      && after.revision <= persistedLibraryRevision
      && groupMutationSeq <= persistedGroupMutationSeq
    ) return lastPersistSkippedMeta.size === 0;
  }
}

class PersistenceTransactionInvalidatedError extends Error {}

export interface PersistenceTransactionContext {
  notesDirectory: string;
  directoryGeneration: number;
  snapshot: LibrarySnapshot;
  assertCurrent: () => void;
  readNoteMeta: (noteId: string) => Promise<NoteMeta | null>;
  mergeNoteMeta: (noteId: string, canonical: NoteMeta, disk: NoteMeta | null) => NoteMeta;
  writeNoteMeta: (meta: NoteMeta) => Promise<void>;
  removeNoteMeta: (noteId: string) => Promise<void>;
  finalizeNoteMeta: (
    noteId: string,
    options?: {
      acknowledgeFields?: { title?: boolean; pinned?: boolean; color?: boolean };
      acknowledgeGroupMembership?: boolean;
    },
  ) => void;
  discardNoteIntents: (noteId: string) => void;
}

export type PersistenceTransactionResult<T> =
  | { status: "invalidated" }
  | { status: "committed"; value: T; followupPersisted: boolean };

/**
 * Serialize a metadata/lifecycle transaction with targeted and full-library
 * persistence. `publish` is awaited only while the directory generation is
 * current, then the coordinator persists the published canonical projection
 * before the next queued job can run.
 * Target ids bind intent tokens at execution start. Call finalizeNoteMeta or
 * discardNoteIntents only after that target's body/meta transition is final;
 * provisional writes that may roll back must not finalize intents.
 *
 * The callbacks must use only the supplied context for durable metadata I/O.
 * They must not await saveManifest, flushPersistence, saveNoteMetadata, or a
 * nested transaction: those APIs enqueue behind this transaction and waiting
 * for them here would create a self-deadlock.
 * `afterCommit` is synchronous and runs after generation validation but before
 * the forced projection write. Its failure is logged without undoing the
 * already-committed lifecycle transition.
 */
export function runPersistenceTransaction<T>(
  source: string,
  targetNoteIds: readonly string[],
  operation: (context: PersistenceTransactionContext) => Promise<T>,
  publish: (result: T, directoryGeneration: number) => LibrarySnapshot | null | Promise<LibrarySnapshot | null>,
  afterCommit?: (result: T, committed: LibrarySnapshot) => undefined,
): Promise<PersistenceTransactionResult<T>> {
  // A real migration invalidates outright. Hydration also raises the
  // migration guard, but a lifecycle action taken while cached notes are
  // already visible must land rather than silently vanish: park it on the
  // chain until the load settles, then run against the hydrated snapshot.
  if (migrationInProgress && !hydrationInProgress) return Promise.resolve({ status: "invalidated" });
  const requested = libraryStore.getSnapshot();
  if (requested.notesDirectory == null) return Promise.resolve({ status: "invalidated" });

  const job = persistChain
    .catch(() => undefined)
    .then(async () => {
      await awaitHydrationSettled();
      if (migrationInProgress) return { status: "invalidated" } as const;
      const latest = libraryStore.getSnapshot();
      if (
        latest.directoryGeneration !== requested.directoryGeneration
        || latest.notesDirectory == null
      ) return { status: "invalidated" } as const;
      const notesDirectory = latest.notesDirectory;
      const directoryGeneration = latest.directoryGeneration;
      const stagedFinalizers: Array<() => void> = [];
      const targetIds = new Set(targetNoteIds);
      for (const noteId of targetIds) {
        if (!isValidNoteId(noteId)) throw new Error(`Unsafe note id: ${noteId}`);
      }
      const intentBaselines = new Map(Array.from(targetIds, (noteId) => [noteId, {
        mutationClock: noteMetadataMutationClocks.get(noteId),
        clock: { ...noteMetadataClock(noteId) },
        acknowledgedClock: { ...ackedNoteMetadataClock(noteId) },
        pendingGroup: persistState.pendingGroupMembership.get(noteId),
      }]));
      const isCurrent = () => {
        const current = libraryStore.getSnapshot();
        return current.directoryGeneration === directoryGeneration
          && current.notesDirectory === notesDirectory;
      };
      const assertCurrent = () => {
        if (!isCurrent()) throw new PersistenceTransactionInvalidatedError();
      };
      const validateNoteId = (noteId: string) => {
        if (!isValidNoteId(noteId)) throw new Error(`Unsafe note id: ${noteId}`);
        if (!targetIds.has(noteId)) throw new Error(`Note id is outside transaction scope: ${noteId}`);
      };
      const result = await operation({
        notesDirectory,
        directoryGeneration,
        snapshot: latest,
        assertCurrent,
        readNoteMeta: async (noteId) => {
          validateNoteId(noteId);
          assertCurrent();
          const meta = await readMeta(tauriFileSystem, notesDirectory, noteId);
          assertCurrent();
          return meta;
        },
        mergeNoteMeta: (noteId, canonical, disk) => {
          validateNoteId(noteId);
          const baseline = intentBaselines.get(noteId)!;
          const preferCanonical = {
            title: baseline.clock.title > baseline.acknowledgedClock.title,
            pinned: baseline.clock.pinned > baseline.acknowledgedClock.pinned,
            color: baseline.clock.color > baseline.acknowledgedClock.color,
          };
          // A rename applied from doc-renamed does not bump this window's title
          // clock, so the disk pair can still predate it here.
          const title = preferCanonical.title || !disk ? canonical : keepManualTitle(canonical, disk);
          return {
            ...canonical,
            ...(disk ?? {}),
            fileName: title.fileName,
            customName: title.customName,
            createdAt: disk?.createdAt ?? canonical.createdAt,
            updatedAt: Math.max(canonical.updatedAt, disk?.updatedAt ?? 0),
            pinned: preferCanonical.pinned ? canonical.pinned : (disk ? disk.pinned : canonical.pinned),
            color: preferCanonical.color ? canonical.color : (disk ? disk.color : canonical.color),
            groupId: baseline.pendingGroup
              ? canonical.groupId
              : (disk ? (disk.groupId ?? null) : canonical.groupId),
            groupUpdatedAt: baseline.pendingGroup?.updatedAt
              ?? disk?.groupUpdatedAt
              ?? canonical.groupUpdatedAt,
          };
        },
        writeNoteMeta: async (meta) => {
          validateNoteId(meta.id);
          assertCurrent();
          await writeMetaFile(tauriFileSystem, notesDirectory, meta, getMachineIdCached());
          assertCurrent();
          persistState.writtenMeta.set(meta.id, metaSnapshotFromFile(meta));
        },
        removeNoteMeta: async (noteId) => {
          validateNoteId(noteId);
          assertCurrent();
          await removeMetaFile(tauriFileSystem, notesDirectory, noteId, { strict: true });
          assertCurrent();
          persistState.writtenMeta.delete(noteId);
        },
        finalizeNoteMeta: (noteId, options) => {
          validateNoteId(noteId);
          const intentBaseline = intentBaselines.get(noteId)!;
          stagedFinalizers.push(() => {
            if (options?.acknowledgeFields) {
              const fields = options.acknowledgeFields;
              acknowledgeNoteMetadataClock(noteId, intentBaseline.clock, {
                title: fields.title === true,
                pinned: fields.pinned === true,
                color: fields.color === true,
              });
            }
            if (
              options?.acknowledgeGroupMembership
              && intentBaseline.pendingGroup != null
              && persistState.pendingGroupMembership.get(noteId) === intentBaseline.pendingGroup
            ) {
              persistState.pendingGroupMembership.delete(noteId);
            }
          });
        },
        discardNoteIntents: (noteId) => {
          validateNoteId(noteId);
          const intentBaseline = intentBaselines.get(noteId)!;
          stagedFinalizers.push(() => {
            if (noteMetadataMutationClocks.get(noteId) === intentBaseline.mutationClock) {
              noteMetadataMutationClocks.delete(noteId);
              ackedNoteMetadataMutationClocks.delete(noteId);
            }
            if (
              intentBaseline.pendingGroup != null
              && persistState.pendingGroupMembership.get(noteId) === intentBaseline.pendingGroup
            ) persistState.pendingGroupMembership.delete(noteId);
          });
        },
      });
      if (!isCurrent()) return { status: "invalidated" } as const;
      const committed = await publish(result, directoryGeneration);
      if (
        !committed
        || committed.directoryGeneration !== directoryGeneration
        || !isCurrent()
      ) {
        return { status: "invalidated" } as const;
      }
      try {
        const callbackResult: unknown = afterCommit?.(result, committed);
        if (callbackResult !== undefined) {
          const contractError = new Error("Persistence transaction afterCommit callbacks must be synchronous");
          void logNotenError(new NotenError(
            "PERSIST_FAILED",
            "recoverable",
            contractError.message,
            { context: { stage: "persistenceTransaction.afterCommit", source }, cause: contractError },
          ));
          if (
            typeof callbackResult === "object"
            && callbackResult !== null
            && "then" in callbackResult
          ) {
            void Promise.resolve(callbackResult).catch(() => {});
          }
        }
      } catch (error) {
        void logNotenError(new NotenError(
          "PERSIST_FAILED",
          "recoverable",
          error instanceof Error ? error.message : String(error),
          { context: { stage: "persistenceTransaction.afterCommit", source }, cause: error },
        ));
      }
      for (const finalize of stagedFinalizers) finalize();
      let followupPersisted = false;
      try {
        followupPersisted = await persistLatestLibrarySnapshot({
          revision: committed.revision,
          directoryGeneration,
          source,
        }, { force: true });
      } catch {
        // The lifecycle and canonical state are already committed. Keep the
        // persisted watermarks behind so flushPersistence retries this debt.
      }
      return { status: "committed", value: result, followupPersisted } as const;
    })
    .catch((err) => {
      if (err instanceof PersistenceTransactionInvalidatedError) {
        return { status: "invalidated" } as const;
      }
      if (import.meta.env.DEV) console.warn(`[PERSIST_TRANSACTION_FAILED] ${source}`, err);
      void logNotenError(new NotenError(
        "PERSIST_FAILED",
        "fatal",
        err instanceof Error ? err.message : String(err),
        { context: { source }, cause: err },
      ));
      throw err;
    });
  persistChain = job;
  return job;
}

/**
 * Persist metadata changed by a successful body autosave without replaying an
 * unrelated full-library snapshot. Returns the effective metadata after
 * merging independently-owned disk fields, or null when the note is no longer
 * live at execution time.
 */
export async function saveNoteMetadata(
  doc: NoteDoc,
  _fallbackGroupId: string | null,
  source = "autosave",
  publish?: (
    persisted: NoteMeta,
    executionBase: NoteDoc,
    changedDuringWrite: { title: boolean; pinned: boolean; color: boolean },
  ) => void,
): Promise<NoteMeta | null> {
  if (migrationInProgress) return null;
  const requested = libraryStore.getSnapshot();
  if (requested.notesDirectory == null) return null;
  const requestedBase = requested.docs.find((entry) => entry.id === doc.id);
  if (!requestedBase) return null;
  const requestedClock = noteMetadataClock(doc.id);
  const job = persistChain
    .catch(() => undefined)
    .then(async () => {
      const latest = libraryStore.getSnapshot();
      const executionBase = latest.docs.find((entry) => entry.id === doc.id);
      if (
        latest.directoryGeneration !== requested.directoryGeneration
        || latest.notesDirectory == null
        || !executionBase
      ) return null;
      const executionCandidate: NoteDoc = {
        ...executionBase,
        content: doc.content,
        fileName: executionBase.customName ? executionBase.fileName : doc.fileName,
        updatedAt: doc.updatedAt,
      };
      const executionGroupId = latest.groups.find(
        (group) => group.noteIds.includes(doc.id),
      )?.id ?? null;
      const executionClock = noteMetadataClock(doc.id);
      const executionAck = ackedNoteMetadataClock(doc.id);
      const canonicalFields = {
        title: executionBase.fileName !== requestedBase.fileName
          || !!executionBase.customName !== !!requestedBase.customName
          || executionClock.title !== requestedClock.title
          || executionClock.title > executionAck.title,
        pinned: (executionBase.pinned === true) !== (requestedBase.pinned === true)
          || executionClock.pinned !== requestedClock.pinned
          || executionClock.pinned > executionAck.pinned,
        color: executionBase.color !== requestedBase.color
          || executionClock.color !== requestedClock.color
          || executionClock.color > executionAck.color,
      };
      const persisted = await persistSavedNoteMetadata(
        executionCandidate,
        executionGroupId,
        latest.notesDirectory,
        source,
        {
          title: canonicalFields.title,
          createdAt: executionBase.createdAt !== requestedBase.createdAt,
          pinned: canonicalFields.pinned,
          color: canonicalFields.color,
        },
      );
      if (!persisted) return null;
      const afterWrite = libraryStore.getSnapshot();
      if (
        afterWrite.directoryGeneration !== requested.directoryGeneration
        || afterWrite.notesDirectory !== latest.notesDirectory
      ) return null;
      acknowledgeNoteMetadataClock(doc.id, executionClock, canonicalFields);
      // This callback must commit through useNotesLoader's adapter before the
      // queue advances. That keeps canonical and React projections aligned and
      // ensures a full-library job queued behind this patch sees its result.
      const afterWriteClock = noteMetadataClock(doc.id);
      publish?.(persisted, executionBase, {
        title: afterWriteClock.title !== executionClock.title,
        pinned: afterWriteClock.pinned !== executionClock.pinned,
        color: afterWriteClock.color !== executionClock.color,
      });
      return persisted;
    });
  persistChain = job;
  return job;
}

export function useNotesLoader(
  locale: Locale,
  notesSortOrder: NotesSortOrder,
  enabled = true,
  reloadKey = 0,
  reconcileState?: ReconcileState,
) {
  const reconcileStateRef = useRef<ReconcileState>(reconcileState ?? createReconcileState());
  if (reconcileState && reconcileStateRef.current !== reconcileState) {
    reconcileStateRef.current = reconcileState;
  }
  const [docs, setDocsState] = useState<NoteDoc[]>([]);
  const [activeIndex, setActiveIndexState] = useState(0);
  const [groups, setGroupsState] = useState<NoteGroup[]>([]);
  const [trashedNotes, setTrashedNotesState] = useState<TrashedNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);

  const activeIndexFromSnapshot = useCallback((snapshot: LibrarySnapshot) => (
    snapshot.activeNoteId
      ? Math.max(snapshot.docs.findIndex((doc) => doc.id === snapshot.activeNoteId), 0)
      : 0
  ), []);

  const syncAllReactState = useCallback((snapshot: LibrarySnapshot) => {
    setDocsState([...snapshot.docs]);
    setGroupsState(snapshot.groups.map((group) => ({
      ...group,
      noteIds: [...group.noteIds],
    })));
    const nextTrashed = [...snapshot.trashedNotes];
    setTrashedNotesCache(nextTrashed);
    setTrashedNotesState(nextTrashed);
    setActiveIndexState(activeIndexFromSnapshot(snapshot));
  }, [activeIndexFromSnapshot]);

  const commitWholeLibrary = useCallback((
    data: LibraryData,
    origin: LibraryCommitOrigin,
    token?: LibraryCommitToken,
  ) => {
    const committed = token == null
      ? libraryStore.commit(data, origin)
      : libraryStore.commitIfCurrent(token, data, origin);
    if (!committed) return null;
    syncAllReactState(committed);
    return committed;
  }, [syncAllReactState]);

  const commitLibraryForGeneration = useCallback((
    directoryGeneration: number,
    update: LibraryUpdater,
    origin: LibraryCommitOrigin = "local",
  ) => {
    const committed = libraryStore.commitForGeneration(directoryGeneration, update, origin);
    if (!committed) return null;
    syncAllReactState(committed);
    return committed;
  }, [syncAllReactState]);

  // Direct store commit for observed (peer window) state: one updater may
  // change docs, groups, trash, and active identity together, so callers no
  // longer need to nest setActiveIndex inside a setDocs updater. Returns null
  // when nothing changed so callers can skip editor side effects.
  const commitLibraryFromRemote = useCallback((update: LibraryUpdater) => {
    const before = libraryStore.getSnapshot();
    const committed = libraryStore.commit(update, "remote");
    if (committed === before) return null;
    syncAllReactState(committed);
    return committed;
  }, [syncAllReactState]);

  const commitDocsUpdate = useCallback((
    updater: SetStateAction<NoteDoc[]>,
    origin: LibraryCommitOrigin,
  ) => {
    const current = libraryStore.getSnapshot();
    const previous = [...current.docs];
    const next = typeof updater === "function" ? updater(previous) : updater;
    if (next === previous) return;
    // Active identity is an id, so it survives a docs-only commit; callers that
    // change docs and active together use a store updater (commitLibraryFromRemote
    // / commitLibraryForGeneration) rather than nesting setters.
    const committed = libraryStore.commit({ docs: next }, origin);
    setDocsState([...committed.docs]);
    setActiveIndexState(activeIndexFromSnapshot(committed));
  }, [activeIndexFromSnapshot]);
  const setDocs = useCallback<Dispatch<SetStateAction<NoteDoc[]>>>(
    (updater) => commitDocsUpdate(updater, "local"),
    [commitDocsUpdate],
  );
  const setDocsFromReconcile = useCallback<Dispatch<SetStateAction<NoteDoc[]>>>(
    (updater) => commitDocsUpdate(updater, "reconcile"),
    [commitDocsUpdate],
  );

  const commitGroupsUpdate = useCallback((
    updater: SetStateAction<NoteGroup[]>,
    origin: LibraryCommitOrigin,
  ) => {
    const current = libraryStore.getSnapshot();
    const previous = current.groups.map((group) => ({
      ...group,
      noteIds: [...group.noteIds],
    }));
    const next = typeof updater === "function" ? updater(previous) : updater;
    if (next === previous) return;
    const committed = libraryStore.commit({ groups: next }, origin);
    setGroupsState(committed.groups.map((group) => ({
      ...group,
      noteIds: [...group.noteIds],
    })));
  }, []);
  const setGroups = useCallback<Dispatch<SetStateAction<NoteGroup[]>>>(
    (updater) => commitGroupsUpdate(updater, "local"),
    [commitGroupsUpdate],
  );
  const setGroupsFromReconcile = useCallback<Dispatch<SetStateAction<NoteGroup[]>>>(
    (updater) => commitGroupsUpdate(updater, "reconcile"),
    [commitGroupsUpdate],
  );

  const commitTrashedNotesUpdate = useCallback((
    updater: TrashedNote[] | ((prev: TrashedNote[]) => TrashedNote[]),
    origin: LibraryCommitOrigin,
  ) => {
    const current = libraryStore.getSnapshot();
    const previous = [...current.trashedNotes];
    const next = typeof updater === "function" ? updater(previous) : updater;
    if (next === previous) return;
    const committed = libraryStore.commit({ trashedNotes: next }, origin);
    const nextTrashed = [...committed.trashedNotes];
    setTrashedNotesCache(nextTrashed);
    setTrashedNotesState(nextTrashed);
  }, []);
  const setTrashedNotes = useCallback((
    updater: TrashedNote[] | ((prev: TrashedNote[]) => TrashedNote[]),
  ) => commitTrashedNotesUpdate(updater, "local"), [commitTrashedNotesUpdate]);

  const commitActiveIndexUpdate = useCallback((
    updater: SetStateAction<number>,
    origin: LibraryCommitOrigin,
  ) => {
    const current = libraryStore.getSnapshot();
    const previousIndex = activeIndexFromSnapshot(current);
    const requestedIndex = typeof updater === "function" ? updater(previousIndex) : updater;
    const boundedIndex = current.docs.length > 0
      ? Math.min(Math.max(requestedIndex, 0), current.docs.length - 1)
      : 0;
    const committed = libraryStore.commit({
      activeNoteId: current.docs[boundedIndex]?.id ?? null,
    }, origin);
    setActiveIndexState(activeIndexFromSnapshot(committed));
  }, [activeIndexFromSnapshot]);
  const setActiveIndex = useCallback<Dispatch<SetStateAction<number>>>(
    (updater) => commitActiveIndexUpdate(updater, "local"),
    [commitActiveIndexUpdate],
  );
  const setActiveIndexFromReconcile = useCallback<Dispatch<SetStateAction<number>>>(
    (updater) => commitActiveIndexUpdate(updater, "reconcile"),
    [commitActiveIndexUpdate],
  );

  useEffect(() => {
    if (reloadKey > 0) {
      initialized.current = false;
      setIsLoading(true);
      resetWriteSnapshots();
      // bodyMissing counters belong to reconcileState (not PersistState),
      // so resetWriteSnapshots leaves them stale. Without clearing, a
      // sidecar that was bodyless on pass N-1 would be deleted on the
      // very next reload pass — bypassing the 2-pass cloud-sync grace.
      clearReconcileState(reconcileStateRef.current);
    }
  }, [reloadKey]);

  // Deps are deliberately limited to enabled/reloadKey: locale and sort order
  // are read once at load start, and re-running on their change would tear
  // down an in-flight load (the cleanup below) without restarting it.
  useEffect(() => {
    if (!enabled || initialized.current) return;
    initialized.current = true;
    let effectActive = true;
    let finished = false;

    (async () => {
      // Keep autosave out while load/reload paths touch multiple disk files.
      setMigrationInProgress(true);
      setHydrationInProgress(true);
      // Snapshot of the best valid state we've reached so far. If a later
      // step throws, the outer catch falls back to this instead of nuking
      // the user's visible notes down to a single blank stub. On reload,
      // seed from current hook state so an early throw (before any new
      // checkpoint is reached) still preserves what the user already sees.
      let safeDocs: NoteDoc[] | null = docs.length > 0 ? docs : null;
      let safeGroups: NoteGroup[] | null = docs.length > 0 ? groups : null;
      let safeActiveId: string | null = docs[activeIndex]?.id ?? null;
      let hydrationGeneration: number | null = null;
      // Every doc id the loader itself put in the store this epoch. A doc the
      // store holds outside this set was created by a peer while we loaded and
      // must survive the final commit; one inside it is a projection entry
      // that the disk result replaces or drops.
      const seededIds = new Set<string>();
      // Ids whose store entry is still the body-less manifest-cache placeholder.
      const projectionIds = new Set<string>();
      // Ids a non-loader commit removed from the store this epoch.
      const deletedIds = new Set<string>();
      // The same three questions for groups and trash. A peer that trashes,
      // restores, or regroups a note while we load commits only to the store;
      // the disk read that started before it knows nothing about the change.
      const seededGroupIds = new Set<string>();
      const touchedGroupIds = new Set<string>();
      const removedGroupIds = new Set<string>();
      const seededTrashIds = new Set<string>();
      const trashRemovals = new Map<string, number>();
      const epoch: HydrationEpochState = {
        seededIds,
        projectionIds,
        deletedIds,
        seededGroupIds,
        touchedGroupIds,
        removedGroupIds,
        seededTrashIds,
        trashRemovals,
      };
      // Watch every commit in this generation so the final rebase can tell a
      // peer deletion from an entity that simply had not been projected yet,
      // and a real (possibly empty) peer body from the cache placeholder.
      // Neither is recoverable from the hydrated result alone.
      let observedDocs = new Map<string, NoteDoc>();
      let observedGroups = new Map<string, LibraryData["groups"][number]>();
      let observedTrash = new Map<string, LibraryData["trashedNotes"][number]>();
      let unwatchEpoch: (() => void) | null = null;
      const watchEpoch = () => {
        const snapshot = libraryStore.getSnapshot();
        if (snapshot.directoryGeneration !== hydrationGeneration) return;
        const next = new Map(snapshot.docs.map((doc) => [doc.id, doc]));
        const nextGroups = new Map(snapshot.groups.map((group) => [group.id, group]));
        const nextTrash = new Map(snapshot.trashedNotes.map((note) => [note.id, note]));
        if (snapshot.origin === "hydrate") {
          // Whatever the loader publishes is the loader's own seed: a later
          // disk result may drop it without that reading as a peer addition.
          for (const id of nextGroups.keys()) seededGroupIds.add(id);
          for (const id of nextTrash.keys()) seededTrashIds.add(id);
        } else {
          for (const [id, doc] of observedDocs) {
            const live = next.get(id);
            // A peer/local/watcher write to a projected id supersedes the
            // placeholder, including one that clears the body to "".
            if (!live) deletedIds.add(id);
            else if (live !== doc) projectionIds.delete(id);
          }
          for (const [id, group] of observedGroups) {
            const live = nextGroups.get(id);
            if (!live) removedGroupIds.add(id);
            else if (live !== group) touchedGroupIds.add(id);
          }
          for (const id of nextGroups.keys()) {
            if (!observedGroups.has(id)) touchedGroupIds.add(id);
          }
          for (const [id, note] of observedTrash) {
            if (nextTrash.has(id)) continue;
            // Record which incarnation was retired: a note restored and
            // trashed again is a newer entry the stale read may legitimately
            // carry.
            const retiredAt = trashRemovals.get(id);
            if (retiredAt == null || note.trashedAt > retiredAt) {
              trashRemovals.set(id, note.trashedAt);
            }
          }
        }
        // A re-created id is live again; its tombstone no longer applies.
        for (const id of next.keys()) deletedIds.delete(id);
        for (const id of nextGroups.keys()) removedGroupIds.delete(id);
        for (const [id, note] of nextTrash) {
          const retiredAt = trashRemovals.get(id);
          if (retiredAt != null && note.trashedAt > retiredAt) trashRemovals.delete(id);
        }
        observedDocs = next;
        observedGroups = nextGroups;
        observedTrash = nextTrash;
      };
      const commitHydration = (data: LibraryData) => {
        if (hydrationGeneration == null) return null;
        return commitLibraryForGeneration(
          hydrationGeneration,
          (current) => mergeHydratedLibrary(current, data, epoch, notesSortOrder, locale),
          "hydrate",
        );
      };
      try {
        await getMachineId();
        await loadUiState();

        const dir = await ensureNotesDir();
        await ensureSharedDirs(tauriFileSystem, dir);
        // Start a new hydration epoch before any cache projection is exposed.
        // Async work captured for an older load can no longer commit into this
        // generation, even when the directory path is unchanged.
        const seeded = libraryStore.seedDirectory(dir, {
          docs: safeDocs ?? [],
          groups: safeGroups ?? [],
          trashedNotes: trashedNotesCache,
          activeNoteId: safeActiveId,
        }, "hydrate");
        hydrationGeneration = seeded.directoryGeneration;
        for (const doc of seeded.docs) seededIds.add(doc.id);
        observedDocs = new Map(seeded.docs.map((doc) => [doc.id, doc]));
        observedGroups = new Map(seeded.groups.map((group) => [group.id, group]));
        observedTrash = new Map(seeded.trashedNotes.map((note) => [note.id, note]));
        for (const group of seeded.groups) seededGroupIds.add(group.id);
        for (const note of seeded.trashedNotes) seededTrashIds.add(note.id);
        unwatchEpoch = libraryStore.subscribe(watchEpoch);

        const cache = await readLocalCache(dir);
        if (cache && cache.notes.length > 0) {
          const cachedDocs: NoteDoc[] = cache.notes.map((n) => ({
            ...n,
            isDirty: false,
            content: "",
          } as NoteDoc));
          for (const doc of cachedDocs) {
            seededIds.add(doc.id);
            projectionIds.add(doc.id);
          }
          const before = libraryStore.getSnapshot();
          const cached = commitHydration({
            docs: cachedDocs,
            groups: cache.groups ?? before.groups,
            trashedNotes: before.trashedNotes,
            activeNoteId: getUiStateCached().activeNoteId ?? before.activeNoteId,
          });
          if (!cached || !effectActive) return;
          safeDocs = cachedDocs;
          safeGroups = cache.groups ?? [];
          safeActiveId = getUiStateCached().activeNoteId ?? null;
        }

        const legacy = await readLegacyManifestFile(dir);
        if (legacy && Array.isArray(legacy.notes)) {
          await decomposeLegacyManifest(dir, legacy);
          await retireLegacyManifest(tauriFileSystem, dir);
        }

        try {
          await scanAndAbsorbConflicts(tauriFileSystem, dir);
        } catch { /* best-effort */ }

        const state = await loadDecomposedState(dir);
        await seedWriteSnapshots(dir);
        let docsLoaded = await attachDocContents(state.docs);
        if (state.docs.length > 0 && docsLoaded.length === 0) {
          throw new NotenError(
            "BODY_READ_FAILED",
            "recoverable",
            "useNotesLoader: all persisted note bodies were unreadable; deferring blank-note creation",
            { context: { dir, docCount: state.docs.length } },
          );
        }
        if (docsLoaded.length > 0) {
          safeDocs = docsLoaded;
          safeGroups = state.groups;
          safeActiveId = state.activeNoteId ?? null;
        }

        if (!imageAssetMigrationV1CompletedAtCache) {
          const noteFilePaths = docsLoaded.map((d) => d.filePath).filter(Boolean);
          const imageMigration = await migrateDataUrlImagesToAssets(Array.from(new Set(noteFilePaths)));
          if (imageMigration.changedFiles > 0) {
            docsLoaded = await attachDocContents(docsLoaded);
            if (docsLoaded.length > 0) safeDocs = docsLoaded;
          }
          imageAssetMigrationV1CompletedAtCache = Date.now();
        }

        const purgedTrashed = await purgeExpiredTrash(state.trashedNotes);
        const trashChanged = purgedTrashed.length !== state.trashedNotes.length;
        const withTrash = commitLibraryForGeneration(
          hydrationGeneration,
          () => ({ trashedNotes: purgedTrashed }),
          "hydrate",
        );
        if (!withTrash || !effectActive) return;

        let reconciled: NoteDoc[];
        let reconciledGroups: NoteGroup[];
        let reconcileChanged: boolean;
        try {
          const result = await reconcileFolder(tauriFileSystem, reconcileStateRef.current, dir, docsLoaded, state.groups, locale, persistState.pendingGroupMembership);
          reconciled = result.docs;
          reconciledGroups = result.groups;
          reconcileChanged = result.changed;
        } catch (err) {
          if (import.meta.env.DEV) console.warn("[RECONCILE_FAILED:loader]", err);
          void logNotenError(new NotenError(
            "RECONCILE_FAILED",
            "fatal",
            err instanceof Error ? err.message : String(err),
            { context: { dir, docCount: docsLoaded.length, source: "loader" }, cause: err },
          ));
          throw err;
        }

        let finalDocs = reconcileChanged ? reconciled : docsLoaded;
        let finalGroups = reconcileChanged ? reconciledGroups : state.groups;

        if (finalDocs.length === 0) {
          const id = crypto.randomUUID();
          const filePath = `${dir}/${id}.md`;
          const timestamp = Date.now();
          markOwnWrite(filePath, "");
          await writeTextFile(filePath, "");
          await writeMetaFile(tauriFileSystem, dir, {
            version: 2,
            id,
            fileName: getDefaultDocumentTitle(locale),
            createdAt: timestamp,
            updatedAt: timestamp,
            groupId: null,
            groupUpdatedAt: timestamp,
            trashedAt: null,
          }, getMachineIdCached());
          finalDocs = [{
            id,
            filePath,
            fileName: getDefaultDocumentTitle(locale),
            isDirty: false,
            content: "",
            createdAt: timestamp,
            updatedAt: timestamp,
          }];
        }

        const sorted = sortNotes(finalDocs, notesSortOrder, locale);
        const activeId = state.activeNoteId && sorted.some((d) => d.id === state.activeNoteId)
          ? state.activeNoteId
          : sorted[0]?.id ?? null;
        const committed = commitHydration({
          docs: sorted,
          groups: finalGroups,
          trashedNotes: purgedTrashed,
          activeNoteId: activeId,
        });
        if (!committed || !effectActive) return;

        safeDocs = sorted;
        safeGroups = finalGroups;
        safeActiveId = activeId;

        // The loader owns the migration guard, so use the ungated writer here.
        // Persist the merged canonical result, not the pre-merge arrays.
        if (reconcileChanged || trashChanged) {
          const activeNoteId = committed.activeNoteId;
          await persistDecomposedState(
            committed.docs.map((doc) => ({ ...doc })),
            activeNoteId,
            committed.groups.map((group) => ({ ...group, noteIds: [...group.noteIds] })),
          ).catch(() => {});
        } else {
          const cachePath = await getLocalCachePath();
          await writeLocalCacheImpl(tauriFileSystem, cachePath, {
            version: 2,
            notesDirectory: dir,
            notes: committed.docs.map(({ id, filePath, fileName, createdAt, updatedAt, customName, pinned, color }) => ({
              id, filePath, fileName, createdAt, updatedAt,
              ...(customName ? { customName } : {}),
              ...(pinned ? { pinned } : {}),
              ...(color ? { color } : {}),
            })),
            groups: finalGroups.length > 0 ? finalGroups : undefined,
            trashedNotes: purgedTrashed.length > 0 ? purgedTrashed : undefined,
            imageAssetMigrationV1CompletedAt: imageAssetMigrationV1CompletedAtCache ?? undefined,
          });
        }
      } catch (err) {
        if (!effectActive) return;
        if (
          hydrationGeneration != null
          && libraryStore.getSnapshot().directoryGeneration !== hydrationGeneration
        ) return;
        if (import.meta.env.DEV) {
          console.warn("Notes loader failed:", err);
        }
        // Preserve whatever we'd already loaded. The stub is only a sane
        // fallback when we have nothing — wiping a populated list to a
        // single blank note loses the user's notes visually even though
        // they are still on disk.
        let fallback: LibraryData;
        if (safeDocs && safeDocs.length > 0) {
          const sorted = sortNotes(safeDocs, notesSortOrder, locale);
          const idx = safeActiveId
            ? Math.max(sorted.findIndex((d) => d.id === safeActiveId), 0)
            : 0;
          fallback = {
            docs: sorted,
            groups: safeGroups ?? [],
            trashedNotes: trashedNotesCache,
            activeNoteId: sorted[idx]?.id ?? null,
          };
        } else {
          const timestamp = Date.now();
          const stub: NoteDoc = {
            // A fresh id per stub: a fixed sentinel could collide with a note
            // another window/session persisted after provisioning ITS stub,
            // reopening the remote-deletion race for that id.
            id: crypto.randomUUID(),
            filePath: "",
            fileName: getDefaultDocumentTitle(locale),
            isDirty: false,
            content: "",
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          fallback = {
            docs: [stub],
            groups: [],
            trashedNotes: trashedNotesCache,
            activeNoteId: stub.id,
          };
        }
        if (hydrationGeneration == null) commitWholeLibrary(fallback, "hydrate");
        else commitHydration(fallback);
      } finally {
        finished = true;
        unwatchEpoch?.();
        // A torn-down load must not drop the flags a newer load has raised.
        if (effectActive) {
          setMigrationInProgress(false);
          setHydrationInProgress(false);
          setIsLoading(false);
        }
      }
    })();
    return () => {
      effectActive = false;
      setMigrationInProgress(false);
      setHydrationInProgress(false);
      // A load torn down mid-flight (unmount, StrictMode replay) must be
      // restartable by the next effect run; a finished one stays initialized.
      if (!finished) initialized.current = false;
    };
  }, [enabled, reloadKey, commitLibraryForGeneration, commitWholeLibrary]);

  return {
    docs,
    setDocs,
    setDocsFromReconcile,
    activeIndex,
    setActiveIndex,
    setActiveIndexFromReconcile,
    groups,
    setGroups,
    setGroupsFromReconcile,
    trashedNotes,
    setTrashedNotes,
    commitLibraryForGeneration,
    commitLibraryFromRemote,
    isLoading,
  };
}

export { metaPathFor, metaDirFor, groupsPathFor };
