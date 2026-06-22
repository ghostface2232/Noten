import type { FileSystem } from "./fs";
import type { Locale } from "../hooks/useSettings";
import type { NoteDoc, NoteGroup } from "./noteTypes";
import { deriveTitle, getFileBaseName } from "./noteText";
import { getDefaultDocumentTitle } from "./documentTitle";
import {
  readAllMeta,
  writeMeta as writeMetaFile,
  removeMeta as removeMetaFile,
  metaPathFor,
  type NoteMeta,
} from "./metadataIO";
import { getMachineIdCached } from "./machineId";
import { getFileTimestamps } from "./fileTimestamps";
import { backupRemoteVersion } from "./conflictBackup";
import { markOwnWrite } from "../hooks/ownWriteTracker";
import { isValidNoteId } from "./noteId";
import { normalizeSep } from "./pathUtils";
import { NotenError } from "./notenError";
import { logNotenError } from "./crashLog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileNameToId(name: string): string {
  // Legacy notes may have non-UUID stems; preserve them.
  return name.replace(/\.md$/i, "");
}

/** See useNotesLoader.readFileContent for the rationale on `null` vs `""`. */
async function readFileContent(fs: FileSystem, path: string): Promise<string | null> {
  try {
    return await fs.readTextFile(path);
  } catch (err) {
    void logNotenError(new NotenError(
      "BODY_READ_FAILED",
      "recoverable",
      "reconcileFolder: body read failed; deferring file until next reconcile",
      { context: { filePath: path }, cause: err },
    ));
    return null;
  }
}

function sameNoteIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hydrateGroupMembershipFromMeta(
  groups: NoteGroup[],
  allMeta: Map<string, NoteMeta>,
  liveDocIds: Set<string>,
): { groups: NoteGroup[]; changed: boolean } {
  const idsByGroup = new Map<string, string[]>();
  for (const meta of allMeta.values()) {
    if (meta.trashedAt != null) continue;
    if (!meta.groupId || !liveDocIds.has(meta.id)) continue;
    const ids = idsByGroup.get(meta.groupId) ?? [];
    ids.push(meta.id);
    idsByGroup.set(meta.groupId, ids);
  }

  // A reconcile pass can race a still-in-flight saveManifest: a freshly
  // created note already lives in the in-memory groups state (newNote called
  // setGroups synchronously) but its sidecar hasn't been written yet. If we
  // strip every id absent from `allMeta`, the note gets yanked out of its
  // group, and the very next newNote inherits inheritedGroupId=null because
  // groupsRef no longer shows the previous active doc as a member. Track
  // which live docs have *any* meta on disk so we can drop only when disk
  // disagrees, not when disk hasn't caught up.
  const docHasMeta = new Set<string>();
  for (const meta of allMeta.values()) {
    if (liveDocIds.has(meta.id)) docHasMeta.add(meta.id);
  }

  let changed = false;
  const hydrated = groups.map((group) => {
    const metaIds = idsByGroup.get(group.id) ?? [];
    const metaIdSet = new Set(metaIds);
    const noteIds = [
      ...group.noteIds.filter((id) => {
        if (metaIdSet.has(id)) return true;          // disk confirms membership
        if (docHasMeta.has(id)) return false;        // disk says different group → drop
        return liveDocIds.has(id);                   // mid-creation, trust in-memory
      }),
      ...metaIds.filter((id) => !group.noteIds.includes(id)),
    ];
    if (sameNoteIds(group.noteIds, noteIds)) return group;
    changed = true;
    return { ...group, noteIds };
  });
  return { groups: hydrated, changed };
}

/**
 * Per-note observation record for bodyless meta sidecars. Orphan-meta
 * deletion must wait BOTH a full reconcile pass and a minimum wall-clock age
 * (cloud sync sidecars sometimes arrive before bodies, and two watcher passes
 * can land seconds apart). Lives on a state object instead of a module
 * singleton so each call site can hold its own and tests stay isolated.
 */
export interface BodyMissingObservation {
  firstSeenAt: number;
  passes: number;
}

export interface ReconcileState {
  bodyMissing: Map<string, BodyMissingObservation>;
}

/**
 * Minimum wall-clock age of a bodyless-meta observation before its sidecar
 * may be deleted. Covers cloud clients that deliver `.meta` seconds-to-tens-
 * of-seconds before the `.md`; the 60s periodic reconcile guarantees a
 * qualifying pass shortly after the grace expires.
 */
export const ORPHAN_META_GRACE_MS = 90_000;

export function createReconcileState(): ReconcileState {
  return { bodyMissing: new Map<string, BodyMissingObservation>() };
}

export function clearReconcileState(state: ReconcileState): void {
  state.bodyMissing.clear();
}

export async function reconcileFolder(
  fs: FileSystem,
  state: ReconcileState,
  dir: string,
  docs: NoteDoc[],
  groups: NoteGroup[],
  locale: Locale,
): Promise<{ docs: NoteDoc[]; groups: NoteGroup[]; changed: boolean }> {
  let entries: { name?: string; isFile?: boolean; isDirectory?: boolean }[];
  try {
    entries = await fs.readDir(dir);
  } catch {
    return { docs, groups, changed: false };
  }

  const machineId = getMachineIdCached();
  const base = normalizeSep(dir);
  const trashBase = `${base}.trash/`;

  const mdEntries = entries.filter((e) => e.name?.endsWith(".md") && e.isFile);
  const folderFileNames = new Set(mdEntries.map((e) => e.name!));
  const allMeta = await readAllMeta(fs, dir);
  const trashedIds = new Set(
    Array.from(allMeta.values()).filter((m) => m.trashedAt != null).map((m) => m.id),
  );

  let changed = false;
  let nextDocs = [...docs];
  const docById = new Map(nextDocs.map((d) => [d.id, d]));

  for (const entry of mdEntries) {
    const name = entry.name!;
    const id = fileNameToId(name);
    // A body file whose stem is not a path-safe id (e.g. `..md` → `.`) must not
    // be ingested as a note: its id flows into `.assets/<id>/` deletes later.
    if (!isValidNoteId(id)) {
      void logNotenError(new NotenError(
        "INVALID_NOTE_ID",
        "recoverable",
        "reconcileFolder: skipping body file with unsafe filename id",
        { context: { dir, name } },
      ));
      continue;
    }
    if (docById.has(id)) continue;
    if (trashedIds.has(id)) continue; // handled in mismatch branch below

    const filePath = `${base}${name}`;
    const content = await readFileContent(fs, filePath);
    // Body unreadable (transient cloud-sync / placeholder failure). Skip this
    // file for now; do not create a meta or in-memory doc that would later be
    // saved back with empty content. Next reconcile retries.
    if (content === null) continue;

    let meta = allMeta.get(id);
    const fts = await getFileTimestamps(fs, filePath);

    if (!meta) {
      meta = {
        version: 2,
        id,
        fileName: deriveTitle(content) || getDefaultDocumentTitle(locale),
        customName: !UUID_RE.test(id) ? true : undefined,
        createdAt: fts.createdAt,
        updatedAt: fts.updatedAt,
        pinned: false,
        groupId: null,
        groupUpdatedAt: fts.updatedAt,
        trashedAt: null,
      };
      try {
        await writeMetaFile(fs, dir, meta, machineId);
        // Keep the local snapshot in sync with disk so the hydrate pass at the
        // end of this function can reuse it (avoiding a second readAllMeta).
        allMeta.set(id, meta);
      } catch (err) {
        // Meta write failed during ingest of a previously-unmanaged .md file.
        // The in-memory doc still gets built so the user sees the note this
        // session, but next reconcile re-enters this branch and rebuilds meta
        // from fresh stat — causing sort order and groupUpdatedAt drift on
        // every retry until the underlying write becomes possible. Logging
        // surfaces the drift instead of leaving it silent.
        void logNotenError(new NotenError(
          "META_WRITE_FAILED",
          "recoverable",
          "reconcileFolder: meta sidecar write failed during unmanaged-file ingest",
          { context: { filePath: metaPathFor(dir, id), noteId: id }, cause: err },
        ));
      }
    }

    const newDoc: NoteDoc = {
      id,
      filePath,
      fileName: meta.fileName,
      isDirty: false,
      content,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      pinned: meta.pinned === true,
      color: meta.color,
      customName: meta.customName,
    };
    nextDocs.push(newDoc);
    docById.set(id, newDoc);
    changed = true;
  }

  // If root and trash bodies both exist, preserve the losing body before
  // resolving the mismatch.
  for (const meta of allMeta.values()) {
    if (meta.trashedAt == null) continue;
    const rootName = `${meta.id}.md`;
    if (!folderFileNames.has(rootName)) continue;

    const rootPath = `${base}${rootName}`;
    const trashPath = `${trashBase}${rootName}`;
    // stat directly: a failed/missing mtime must NOT be treated as "now",
    // or a transient stat failure (common on OneDrive/Dropbox/GDrive
    // placeholders) would silently restore trashed notes.
    let rootMtime: number | null = null;
    try {
      const info = await fs.stat(rootPath);
      rootMtime = info.mtime ? info.mtime.getTime() : null;
    } catch { /* unknown mtime — keep in trash */ }

    let trashBody: string | null = null;
    try {
      if (await fs.exists(trashPath)) {
        trashBody = await fs.readTextFile(trashPath);
      }
    } catch { /* trash unreadable; treat as absent */ }

    let rootBody = "";
    try { rootBody = await fs.readTextFile(rootPath); } catch { /* unreadable root */ }

    if (rootMtime != null && rootMtime > meta.trashedAt) {
      if (trashBody !== null && trashBody !== rootBody && trashBody.length > 0) {
        try { await backupRemoteVersion(fs, dir, meta.id, trashBody); } catch { /* best-effort */ }
      }
      if (trashBody !== null) {
        try { markOwnWrite(trashPath); await fs.remove(trashPath); } catch { /* ignore */ }
      }
      try {
        const restored = { ...meta, trashedAt: null, trashedFromPath: null };
        await writeMetaFile(fs, dir, restored, machineId);
        allMeta.set(meta.id, restored);
      } catch { /* ignore */ }
      changed = true;
    } else {
      // Trash wins: the note stays deleted and the trash body is authoritative
      // (root was not modified after trashing). The root file is a stale
      // leftover, so fold it into trash WITHOUT clobbering the trash body.
      if (trashBody !== null) {
        // Back up the *root* copy (the loser) when it diverges, then drop the
        // stale root file — never overwrite the winning trash body with it.
        if (trashBody !== rootBody && rootBody.length > 0) {
          try { await backupRemoteVersion(fs, dir, meta.id, rootBody); } catch { /* best-effort */ }
        }
        try { markOwnWrite(rootPath); await fs.remove(rootPath); } catch { /* ignore */ }
      } else {
        // No trash body yet: the root file is the note's only copy, so move it
        // into trash to preserve the content the user deleted.
        try {
          await fs.mkdir(`${base}.trash`, { recursive: true });
          markOwnWrite(rootPath);
          await fs.copyFile(rootPath, trashPath);
          await fs.remove(rootPath);
        } catch { /* ignore */ }
      }
      const beforeLen = nextDocs.length;
      nextDocs = nextDocs.filter((d) => d.id !== meta.id);
      if (nextDocs.length !== beforeLen) changed = true;
    }
  }

  // Keep dirty docs even if disk is gone; autosave can still recreate them.
  const beforeRemoveLen = nextDocs.length;
  const removedIds = new Set<string>();
  nextDocs = nextDocs.filter((d) => {
    if (!d.filePath) return true;
    const name = getFileBaseName(d.filePath);
    if (folderFileNames.has(name)) return true;
    if (d.isDirty) return true;
    removedIds.add(d.id);
    return false;
  });
  if (nextDocs.length !== beforeRemoveLen) changed = true;

  let nextGroups = removedIds.size > 0
    ? groups.map((g) => ({
        ...g,
        noteIds: g.noteIds.filter((id) => !removedIds.has(id)),
      }))
    : groups;

  let trashEntries: { name?: string; isFile?: boolean }[] = [];
  try { trashEntries = await fs.readDir(`${base}.trash`); } catch { trashEntries = []; }
  const trashFileNames = new Set(
    trashEntries.filter((e) => e.name?.endsWith(".md") && e.isFile).map((e) => e.name!),
  );

  // A bodyless meta may be a cloud-sync race — the sidecar can arrive before
  // its body. Deleting it via removeMetaFile propagates to every synced PC,
  // so two guards gate the delete: skip the whole pass when many metas are
  // bodyless at once (bulk = likely mid-sync), and require a meta to stay
  // bodyless across two passes AND at least ORPHAN_META_GRACE_MS of wall
  // clock (per-id grace) before removing it.
  const missingBodyIds: string[] = [];
  for (const meta of allMeta.values()) {
    const rootName = `${meta.id}.md`;
    if (meta.trashedAt == null) {
      if (folderFileNames.has(rootName)) continue;
      if (trashFileNames.has(rootName)) continue;
    } else if (trashFileNames.has(rootName)) {
      continue;
    }
    missingBodyIds.push(meta.id);
  }

  const looksMidSync = missingBodyIds.length >= 3
    && missingBodyIds.length * 4 >= allMeta.size;

  // Drop counters whose id is no longer in missingNow — either the body
  // arrived or the meta itself is gone. The redundant `!allMeta.has(id)`
  // check that used to live here was dead: missingNow ⊆ allMeta by
  // construction, so `!missingNow.has(id)` already covers both.
  //
  // Note on split-read race: if a sidecar is mid-rewrite during the
  // atomicWrite rename fallback (logged via META_WRITE_FAILED), its JSON
  // parse can transiently fail and readAllMeta drops it for this pass.
  // The id then disappears from missingNow and its counter resets. Net
  // effect: deletion is delayed by one pass, never accelerated — which
  // is aligned with the two-pass guard's purpose of being conservative
  // about removeMetaFile, since it propagates to every synced PC.
  const missingNow = new Set(missingBodyIds);
  for (const id of Array.from(state.bodyMissing.keys())) {
    if (!missingNow.has(id)) {
      state.bodyMissing.delete(id);
    }
  }

  if (!looksMidSync) {
    const now = Date.now();
    for (const id of missingBodyIds) {
      const obs = state.bodyMissing.get(id);
      // Both gates must hold: a prior non-bulk pass (split-read tolerance)
      // AND a minimum wall-clock age. Pass count alone is not enough — two
      // watcher passes can fire seconds apart while a cloud client is still
      // uploading the body behind its sidecar.
      if (obs && obs.passes >= 1 && now - obs.firstSeenAt >= ORPHAN_META_GRACE_MS) {
        state.bodyMissing.delete(id);
        try {
          await removeMetaFile(fs, dir, id);
          allMeta.delete(id);
        } catch { /* ignore */ }
      } else {
        state.bodyMissing.set(id, {
          firstSeenAt: obs?.firstSeenAt ?? now,
          passes: (obs?.passes ?? 0) + 1,
        });
      }
    }
  }

  // Rebuild noteIds from sidecars so follow-up persistence cannot erase groupId.
  // Reuse the local allMeta we kept in sync with our writes/removes above
  // instead of paying a second readAllMeta — saves one O(N) disk pass on
  // every reconcile (was the second-largest cost after the initial read).
  const liveDocIds = new Set(nextDocs.map((d) => d.id));
  const hydratedGroups = hydrateGroupMembershipFromMeta(nextGroups, allMeta, liveDocIds);
  if (hydratedGroups.changed) {
    nextGroups = hydratedGroups.groups;
    changed = true;
  }

  return { docs: nextDocs, groups: nextGroups, changed };
}
