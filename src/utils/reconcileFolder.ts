import type { FileSystem } from "./fs";
import type { Locale } from "../hooks/useSettings";
import type { NoteDoc, NoteGroup } from "./noteTypes";
import { deriveTitle, getFileBaseName } from "./noteText";
import { getDefaultDocumentTitle } from "./documentTitle";
import {
  readAllMeta,
  writeMeta as writeMetaFile,
  removeMeta as removeMetaFile,
  type NoteMeta,
} from "./metadataIO";
import { getMachineIdCached } from "./machineId";
import { getFileTimestamps } from "./fileTimestamps";
import { backupRemoteVersion } from "./conflictBackup";
import { markOwnWrite } from "../hooks/ownWriteTracker";
import { normalizeSep } from "./pathUtils";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileNameToId(name: string): string {
  // Legacy notes may have non-UUID stems; preserve them.
  return name.replace(/\.md$/i, "");
}

async function readFileContent(fs: FileSystem, path: string): Promise<string> {
  try {
    return await fs.readTextFile(path);
  } catch {
    return "";
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

  let changed = false;
  const hydrated = groups.map((group) => {
    const metaIds = idsByGroup.get(group.id) ?? [];
    const metaIdSet = new Set(metaIds);
    const noteIds = [
      ...group.noteIds.filter((id) => metaIdSet.has(id)),
      ...metaIds.filter((id) => !group.noteIds.includes(id)),
    ];
    if (sameNoteIds(group.noteIds, noteIds)) return group;
    changed = true;
    return { ...group, noteIds };
  });
  return { groups: hydrated, changed };
}

/**
 * Per-note observation counter for bodyless meta sidecars. Required because
 * orphan-meta deletion must wait one full reconcile pass (cloud sync sidecars
 * sometimes arrive before bodies). Lives on a state object instead of a
 * module singleton so each call site can hold its own and tests stay isolated.
 */
export interface ReconcileState {
  bodyMissing: Map<string, number>;
}

export function createReconcileState(): ReconcileState {
  return { bodyMissing: new Map<string, number>() };
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
    if (docById.has(id)) continue;
    if (trashedIds.has(id)) continue; // handled in mismatch branch below

    const filePath = `${base}${name}`;
    const content = await readFileContent(fs, filePath);

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
      try { await writeMetaFile(fs, dir, meta, machineId); } catch { /* ignore */ }
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
    let rootMtime = 0;
    try { rootMtime = (await getFileTimestamps(fs, rootPath)).updatedAt; } catch { /* fall back */ }

    let trashBody: string | null = null;
    try {
      if (await fs.exists(trashPath)) {
        trashBody = await fs.readTextFile(trashPath);
      }
    } catch { /* trash unreadable; treat as absent */ }

    let rootBody = "";
    try { rootBody = await fs.readTextFile(rootPath); } catch { /* unreadable root */ }

    if (rootMtime > meta.trashedAt) {
      if (trashBody !== null && trashBody !== rootBody && trashBody.length > 0) {
        try { await backupRemoteVersion(fs, dir, meta.id, trashBody); } catch { /* best-effort */ }
      }
      if (trashBody !== null) {
        try { markOwnWrite(trashPath); await fs.remove(trashPath); } catch { /* ignore */ }
      }
      try {
        await writeMetaFile(fs, dir, { ...meta, trashedAt: null, trashedFromPath: null }, machineId);
      } catch { /* ignore */ }
      changed = true;
    } else {
      if (trashBody !== null && trashBody !== rootBody && trashBody.length > 0) {
        try { await backupRemoteVersion(fs, dir, meta.id, trashBody); } catch { /* best-effort */ }
      }
      try {
        await fs.mkdir(`${base}.trash`, { recursive: true });
        markOwnWrite(rootPath);
        await fs.copyFile(rootPath, trashPath);
        await fs.remove(rootPath);
      } catch { /* ignore */ }
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
  // bodyless across two passes (per-id grace) before removing it.
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

  const missingNow = new Set(missingBodyIds);
  for (const id of Array.from(state.bodyMissing.keys())) {
    if (!missingNow.has(id) || !allMeta.has(id)) {
      state.bodyMissing.delete(id);
    }
  }

  if (!looksMidSync) {
    for (const id of missingBodyIds) {
      const seen = state.bodyMissing.get(id) ?? 0;
      if (seen >= 1) {
        state.bodyMissing.delete(id);
        try { await removeMetaFile(fs, dir, id); } catch { /* ignore */ }
      } else {
        state.bodyMissing.set(id, seen + 1);
      }
    }
  }

  // Rebuild noteIds from sidecars so follow-up persistence cannot erase groupId.
  const liveDocIds = new Set(nextDocs.map((d) => d.id));
  const latestMeta = await readAllMeta(fs, dir);
  const hydratedGroups = hydrateGroupMembershipFromMeta(nextGroups, latestMeta, liveDocIds);
  if (hydratedGroups.changed) {
    nextGroups = hydratedGroups.groups;
    changed = true;
  }

  return { docs: nextDocs, groups: nextGroups, changed };
}
