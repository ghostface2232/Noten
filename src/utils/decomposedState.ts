import type { FileSystem } from "./fs";
import type { NoteDoc, NoteGroup, TrashedNote } from "./noteTypes";
import type { NoteColorId } from "./noteColors";
import { getFileBaseName } from "./noteText";
import { normalizeSep } from "./pathUtils";
import {
  readAllMeta,
  writeMeta as writeMetaFile,
} from "./metadataIO";
import {
  readGroupsFile,
  writeGroupsWithMerge,
  genOrderKeyAfter,
  type SharedGroupEntry,
} from "./groupsIO";

/** Last-written per-note meta; identical snapshots skip the sidecar write. */
export interface MetaSnapshot {
  fileName: string;
  customName: boolean;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  color: NoteColorId | null;
  groupId: string | null;
  groupUpdatedAt: number;
  trashedAt: number | null;
}

export interface SharedGroupSnapshot {
  name: string;
  orderKey: string;
  orderUpdatedAt: number;
  updatedAt: number;
}

/**
 * Diff caches and pending writes used to avoid redundant disk IO and to
 * preserve tombstone/membership intent across persist calls. Held on an
 * explicit object so tests can inject fresh isolated instances instead of
 * fighting a module-level singleton.
 */
export interface PersistState {
  writtenMeta: Map<string, MetaSnapshot>;
  writtenGroups: Map<string, SharedGroupSnapshot>;
  /**
   * Group id → deletion sequence (a monotonic logical clock stamped by
   * `markGroupAsDeleted`). A pending tombstone may only be cancelled by a save
   * whose groups snapshot is at least as new as this sequence — i.e. a genuine
   * resurrection. A stale in-flight save that captured the group while it was
   * still alive (snapshotSeq < deletion sequence) must NOT cancel it, otherwise
   * a slow cloud write silently revives a just-deleted group (P0-4).
   */
  pendingTombstones: Map<string, number>;
  pendingGroupMembership: Map<string, { groupId: string | null; updatedAt: number }>;
  /** Last successfully-written local cache JSON. Skip the write when the
   *  serialized payload matches — autosaves driven by body-only edits
   *  produce an identical cache and the OneDrive write is pure waste. */
  lastWrittenLocalCache?: string;
}

export function createPersistState(): PersistState {
  return {
    writtenMeta: new Map(),
    writtenGroups: new Map(),
    pendingTombstones: new Map(),
    pendingGroupMembership: new Map(),
    lastWrittenLocalCache: undefined,
  };
}

export function clearPersistState(state: PersistState): void {
  state.writtenMeta.clear();
  state.writtenGroups.clear();
  state.pendingTombstones.clear();
  state.pendingGroupMembership.clear();
  state.lastWrittenLocalCache = undefined;
}

export function metaSnapshotEqual(a: MetaSnapshot, b: MetaSnapshot): boolean {
  return a.fileName === b.fileName
    && a.customName === b.customName
    && a.createdAt === b.createdAt
    && a.updatedAt === b.updatedAt
    && a.pinned === b.pinned
    && a.color === b.color
    && a.groupId === b.groupId
    && a.groupUpdatedAt === b.groupUpdatedAt
    && a.trashedAt === b.trashedAt;
}

export function groupSnapshotEqual(a: SharedGroupSnapshot, b: SharedGroupSnapshot): boolean {
  return a.name === b.name
    && a.orderKey === b.orderKey
    && a.orderUpdatedAt === b.orderUpdatedAt
    && a.updatedAt === b.updatedAt;
}

export function buildGroupsFromShared(
  shared: Record<string, SharedGroupEntry>,
  metaByGroup: Map<string, string[]>,
  collapsedMap: Record<string, boolean>,
): NoteGroup[] {
  const out: NoteGroup[] = [];
  for (const entry of Object.values(shared)) {
    if (entry.deletedAt != null) continue;
    out.push({
      id: entry.id,
      name: entry.name,
      noteIds: metaByGroup.get(entry.id) ?? [],
      collapsed: !!collapsedMap[entry.id],
      createdAt: entry.createdAt,
      orderKey: entry.orderKey,
      orderUpdatedAt: entry.orderUpdatedAt,
      updatedAt: entry.updatedAt,
    });
  }
  out.sort((a, b) => {
    const ak = a.orderKey ?? "";
    const bk = b.orderKey ?? "";
    if (ak === bk) return a.createdAt - b.createdAt;
    return ak < bk ? -1 : 1;
  });
  return out;
}

/** Per-machine quick-paint cache. Disk sidecars remain the source of truth. */
export interface LocalCache {
  version: 2;
  notesDirectory?: string;
  notes: Omit<NoteDoc, "isDirty" | "content">[];
  groups?: NoteGroup[];
  trashedNotes?: TrashedNote[];
  imageAssetMigrationV1CompletedAt?: number;
}

export async function readLocalCache(
  fs: FileSystem,
  cachePath: string,
  notesDir: string,
): Promise<LocalCache | null> {
  try {
    const raw = await fs.readTextFile(cachePath);
    const parsed = JSON.parse(raw) as LocalCache;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 2) return null;
    if (parsed.notesDirectory !== notesDir) return null;
    if (!Array.isArray(parsed.notes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeLocalCache(
  fs: FileSystem,
  cachePath: string,
  cache: LocalCache,
): Promise<void> {
  try {
    await fs.writeTextFile(cachePath, JSON.stringify(cache, null, 2));
  } catch { /* best-effort */ }
}

export async function seedWriteSnapshots(
  fs: FileSystem,
  dir: string,
  state: PersistState,
): Promise<void> {
  clearPersistState(state);

  const allMeta = await readAllMeta(fs, dir);
  for (const m of allMeta.values()) {
    state.writtenMeta.set(m.id, {
      fileName: m.fileName,
      customName: !!m.customName,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      pinned: m.pinned === true,
      color: m.color ?? null,
      groupId: m.groupId ?? null,
      groupUpdatedAt: m.groupUpdatedAt ?? m.updatedAt,
      trashedAt: m.trashedAt ?? null,
    });
  }

  await syncGroupsSnapshotFromDisk(fs, dir, state);
}

export async function syncGroupsSnapshotFromDisk(
  fs: FileSystem,
  dir: string,
  state: PersistState,
): Promise<void> {
  const groupsFile = await readGroupsFile(fs, dir);
  const liveOnDisk = new Set<string>();
  for (const g of Object.values(groupsFile.groups)) {
    if (g.deletedAt != null) continue;
    liveOnDisk.add(g.id);
    state.writtenGroups.set(g.id, {
      name: g.name,
      orderKey: g.orderKey,
      orderUpdatedAt: g.orderUpdatedAt,
      updatedAt: g.updatedAt,
    });
  }
  for (const id of Array.from(state.writtenGroups.keys())) {
    if (!liveOnDisk.has(id)) state.writtenGroups.delete(id);
  }
}

export interface UiStateInput {
  activeNoteId: string | null;
  lastOpenedNoteId: string | null;
  groupCollapsed: Record<string, boolean>;
}

export interface DecomposedState {
  docs: NoteDoc[];
  groups: NoteGroup[];
  trashedNotes: TrashedNote[];
  activeNoteId: string | null;
}

export async function loadDecomposedState(
  fs: FileSystem,
  dir: string,
  uiState: UiStateInput,
): Promise<DecomposedState> {
  const base = normalizeSep(dir);
  const trashBase = `${base}.trash/`;

  const allMeta = await readAllMeta(fs, dir);
  const sharedGroupsFile = await readGroupsFile(fs, dir);

  const metaByGroup = new Map<string, string[]>();
  for (const meta of allMeta.values()) {
    if (meta.trashedAt != null) continue;
    if (meta.groupId) {
      const arr = metaByGroup.get(meta.groupId) ?? [];
      arr.push(meta.id);
      metaByGroup.set(meta.groupId, arr);
    }
  }

  const groups = buildGroupsFromShared(
    sharedGroupsFile.groups,
    metaByGroup,
    uiState.groupCollapsed,
  );

  const docs: NoteDoc[] = [];
  const trashed: TrashedNote[] = [];

  for (const meta of allMeta.values()) {
    if (meta.trashedAt != null) {
      const fileName = getFileBaseName(meta.trashedFromPath ?? `${base}${meta.id}.md`);
      const trashFilePath = `${trashBase}${meta.id}.md`;
      trashed.push({
        id: meta.id,
        fileName: meta.fileName,
        originalFilePath: meta.trashedFromPath ?? `${base}${fileName}`,
        trashFilePath,
        trashedAt: meta.trashedAt,
        groupId: meta.groupId ?? null,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        pinned: meta.pinned === true,
        color: meta.color,
      });
    } else {
      docs.push({
        id: meta.id,
        filePath: `${base}${meta.id}.md`,
        fileName: meta.fileName,
        isDirty: false,
        content: "",
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        pinned: meta.pinned === true,
        color: meta.color,
        customName: meta.customName,
      });
    }
  }

  const docIds = new Set(docs.map((d) => d.id));
  let activeId: string | null = null;
  if (uiState.activeNoteId && docIds.has(uiState.activeNoteId)) {
    activeId = uiState.activeNoteId;
  } else if (uiState.lastOpenedNoteId && docIds.has(uiState.lastOpenedNoteId)) {
    activeId = uiState.lastOpenedNoteId;
  } else {
    activeId = docs[0]?.id ?? null;
  }

  return { docs, groups, trashedNotes: trashed, activeNoteId: activeId };
}

export interface PersistOptions {
  trashedNotes: TrashedNote[];
  machineId: string;
  /** null skips the local cache write. */
  cachePath: string | null;
  imageAssetMigrationCompletedAt: number | null;
  /** Optional; tests pass a no-op. Production wires `setActiveNoteIdPersisted`. */
  setActiveNoteId?: (id: string | null) => Promise<void> | void;
  /**
   * Logical sequence of the `groups` snapshot being persisted, captured when
   * this save was ENQUEUED (see `saveManifest`). Compared against each pending
   * tombstone's deletion sequence so a stale in-flight save cannot cancel a
   * tombstone recorded after the snapshot was taken. Omitted by callers that
   * never race tombstones (load/reload paths, tests) — treated as +Infinity,
   * preserving the legacy "cancel whenever the group is present" behaviour.
   */
  groupsSnapshotSeq?: number;
}

export async function persistDecomposedState(
  fs: FileSystem,
  dir: string,
  state: PersistState,
  docs: NoteDoc[],
  activeId: string | null,
  groups: NoteGroup[] | undefined,
  options: PersistOptions,
): Promise<void> {
  const { trashedNotes, machineId, cachePath, imageAssetMigrationCompletedAt, setActiveNoteId } = options;
  const snapshotSeq = options.groupsSnapshotSeq ?? Number.POSITIVE_INFINITY;

  const noteIdToGroupId = new Map<string, string>();
  for (const g of groups ?? []) {
    if (!g.id) continue;
    for (const nid of g.noteIds) noteIdToGroupId.set(nid, g.id);
  }
  const diskMeta = await readAllMeta(fs, dir);

  const resolveGroupSnapshot = (
    noteId: string,
    stateGroupId: string | null,
  ): Pick<MetaSnapshot, "groupId" | "groupUpdatedAt"> => {
    const pending = state.pendingGroupMembership.get(noteId);
    if (pending) {
      return { groupId: pending.groupId, groupUpdatedAt: pending.updatedAt };
    }
    const disk = diskMeta.get(noteId);
    if (disk) {
      return {
        groupId: disk.groupId ?? null,
        groupUpdatedAt: disk.groupUpdatedAt ?? disk.updatedAt,
      };
    }
    return { groupId: stateGroupId, groupUpdatedAt: Date.now() };
  };

  const metaWrites: Promise<unknown>[] = [];
  for (const doc of docs) {
    const groupSnap = resolveGroupSnapshot(doc.id, noteIdToGroupId.get(doc.id) ?? null);
    const snap: MetaSnapshot = {
      fileName: doc.fileName,
      customName: !!doc.customName,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      pinned: doc.pinned === true,
      color: doc.color ?? null,
      groupId: groupSnap.groupId,
      groupUpdatedAt: groupSnap.groupUpdatedAt,
      trashedAt: null,
    };
    const prev = state.writtenMeta.get(doc.id);
    if (prev && metaSnapshotEqual(prev, snap)) {
      state.pendingGroupMembership.delete(doc.id);
      continue;
    }

    metaWrites.push(
      writeMetaFile(fs, dir, {
        version: 2,
        id: doc.id,
        fileName: snap.fileName,
        customName: snap.customName || undefined,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        pinned: snap.pinned,
        color: snap.color ?? undefined,
        groupId: snap.groupId,
        groupUpdatedAt: snap.groupUpdatedAt,
        trashedAt: null,
      }, machineId).then(() => {
        state.writtenMeta.set(doc.id, snap);
        state.pendingGroupMembership.delete(doc.id);
      }),
    );
  }

  for (const t of trashedNotes) {
    const groupSnap = resolveGroupSnapshot(t.id, t.groupId ?? null);
    const snap: MetaSnapshot = {
      fileName: t.fileName,
      customName: false,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      pinned: t.pinned === true,
      color: t.color ?? null,
      groupId: groupSnap.groupId,
      groupUpdatedAt: groupSnap.groupUpdatedAt,
      trashedAt: t.trashedAt,
    };
    const prev = state.writtenMeta.get(t.id);
    if (prev && metaSnapshotEqual(prev, snap)) {
      state.pendingGroupMembership.delete(t.id);
      continue;
    }

    metaWrites.push(
      writeMetaFile(fs, dir, {
        version: 2,
        id: t.id,
        fileName: snap.fileName,
        customName: undefined,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        pinned: snap.pinned,
        color: snap.color ?? undefined,
        groupId: snap.groupId,
        groupUpdatedAt: snap.groupUpdatedAt,
        trashedAt: snap.trashedAt,
        trashedFromPath: t.originalFilePath,
      }, machineId).then(() => {
        state.writtenMeta.set(t.id, snap);
        state.pendingGroupMembership.delete(t.id);
      }),
    );
  }

  const localGroupsMap: Record<string, SharedGroupEntry> = {};
  let lastOrderKey: string | undefined = undefined;
  const orderedGroups = [...(groups ?? [])].sort((a, b) => {
    const ak = a.orderKey ?? "";
    const bk = b.orderKey ?? "";
    if (ak === bk) return a.createdAt - b.createdAt;
    return ak < bk ? -1 : 1;
  });
  const now = Date.now();
  let groupsChanged = false;
  // Stage in-memory snapshot updates; apply them only after the disk write
  // succeeds. Mutating state.writtenGroups before the write would make a
  // failed write look like a successful one to the next persist call, which
  // then compares snap-equal-to-prev and skips the retry — silently dropping
  // the user's change. Mirrors the .then-gated pattern used for writtenMeta.
  const pendingGroupSnapshots = new Map<string, SharedGroupSnapshot>();
  const pendingGroupDeletes = new Set<string>();
  for (const g of orderedGroups) {
    if (!g.id) continue;
    let orderKey = g.orderKey;
    let orderUpdatedAt = g.orderUpdatedAt ?? 0;
    if (!orderKey) {
      orderKey = genOrderKeyAfter(lastOrderKey);
      orderUpdatedAt = now;
    }
    lastOrderKey = orderKey;

    const updatedAt = g.updatedAt ?? now;
    const snap: SharedGroupSnapshot = {
      name: g.name,
      orderKey,
      orderUpdatedAt,
      updatedAt,
    };
    const prev = state.writtenGroups.get(g.id);
    if (!prev || !groupSnapshotEqual(prev, snap)) groupsChanged = true;
    pendingGroupSnapshots.set(g.id, snap);

    localGroupsMap[g.id] = {
      id: g.id,
      name: g.name,
      orderKey,
      orderUpdatedAt,
      updatedAt,
      createdAt: g.createdAt,
      deletedAt: null,
    };
  }

  // Tombstone only explicit local deletes; stale saves can miss remote groups.
  // If a pending id is alive again locally (e.g., reloadGroupsFromDisk or
  // remote sync resurrected it), drop the intent so it cannot fire later when
  // the group disappears for an unrelated reason.
  //
  // The cancel is gated on the deletion's logical clock: a group present in
  // this save's snapshot only counts as a resurrection when the snapshot is at
  // least as new as the deletion (snapshotSeq >= deleteSeq). A slow in-flight
  // save whose groups array was captured BEFORE the delete (snapshotSeq <
  // deleteSeq) still shows the group alive, but must not cancel the tombstone —
  // otherwise it revives a just-deleted group and no deletedAt is ever written,
  // so the group resurrects on restart and the delete never propagates (P0-4).
  const currentIds = new Set(orderedGroups.map((g) => g.id));
  const tombstoneApplied: string[] = [];
  for (const [id, deleteSeq] of Array.from(state.pendingTombstones)) {
    if (currentIds.has(id)) {
      if (snapshotSeq >= deleteSeq) state.pendingTombstones.delete(id);
      // else: stale pre-delete snapshot — leave the intent pending so a later,
      // post-delete save (which excludes the group) can apply the tombstone.
      continue;
    }
    localGroupsMap[id] = {
      id,
      name: "",
      orderKey: "z",
      orderUpdatedAt: now,
      updatedAt: now,
      createdAt: now,
      deletedAt: now,
    };
    pendingGroupDeletes.add(id);
    tombstoneApplied.push(id);
    groupsChanged = true;
  }

  // Captured so a groups-write failure surfaces to the caller AFTER the other
  // writes settle, without aborting them. Swallowing the rejection here made
  // saveManifest / flushManifest / migration-ack / close-drain believe the
  // groups landed when they didn't (silent group/order loss). The in-memory
  // snapshot + tombstone intent stay untouched on failure so the next persist
  // retries.
  let groupsError: unknown;
  const groupsPromise = groupsChanged
    ? writeGroupsWithMerge(fs, dir, localGroupsMap).then(
        () => {
          for (const [id, snap] of pendingGroupSnapshots) state.writtenGroups.set(id, snap);
          for (const id of pendingGroupDeletes) state.writtenGroups.delete(id);
          for (const id of tombstoneApplied) state.pendingTombstones.delete(id);
        },
        (err: unknown) => { groupsError = err; /* keep pending for retry */ },
      )
    : Promise.resolve();

  const activePromise = setActiveNoteId
    ? Promise.resolve(setActiveNoteId(activeId)).catch(() => {})
    : Promise.resolve();

  // Cache payload short-circuit. The local cache mirrors every doc's title/
  // updatedAt/etc, so a body-only autosave (no fileName change, no group
  // change) produces an identical serialized payload. Without this check
  // every 1s autosave wrote the same 10–100 KB JSON back to OneDrive —
  // pure I/O waste plus another fs op queueing into persistChain.
  let cachePromise: Promise<unknown> = Promise.resolve();
  if (cachePath) {
    const cachePayload: LocalCache = {
      version: 2,
      notesDirectory: dir,
      notes: docs.map(({ id, filePath, fileName, createdAt, updatedAt, customName, pinned, color }) => ({
        id, filePath, fileName, createdAt, updatedAt,
        ...(customName ? { customName } : {}),
        ...(pinned ? { pinned } : {}),
        ...(color ? { color } : {}),
      })),
      groups: groups && groups.length > 0 ? groups : undefined,
      trashedNotes: trashedNotes.length > 0 ? trashedNotes : undefined,
      imageAssetMigrationV1CompletedAt: imageAssetMigrationCompletedAt ?? undefined,
    };
    const serialized = JSON.stringify(cachePayload, null, 2);
    if (state.lastWrittenLocalCache !== serialized) {
      cachePromise = writeLocalCache(fs, cachePath, cachePayload).then(
        () => { state.lastWrittenLocalCache = serialized; },
      );
    }
  }

  await Promise.all([
    Promise.all(metaWrites),
    groupsPromise,
    activePromise,
    cachePromise,
  ]);

  // Surface a groups-write failure now that meta/cache have committed, so the
  // overall persist rejects and durable-intent gates (flushManifest, migration
  // ack, close drain) do not falsely report success.
  if (groupsError !== undefined) {
    throw groupsError instanceof Error ? groupsError : new Error(String(groupsError));
  }
}
