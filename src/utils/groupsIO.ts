import { readTextFile } from "@tauri-apps/plugin-fs";
import type { NoteGroup } from "../hooks/useNotesLoader";
import { writeJsonAtomic } from "./atomicJson";
import type { NoteMeta } from "./metadataIO";
import { groupsFilePath } from "./storagePaths";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MID_CHAR = ALPHABET[Math.floor(ALPHABET.length / 2)];

export interface StoredGroup {
  id: string;
  name: string;
  orderKey: string;
  orderUpdatedAt: number;
  updatedAt: number;
  deletedAt?: number;
  createdAt: number;
}

interface GroupsFile {
  version: 2;
  groups: StoredGroup[];
}

export function genOrderKeyBetween(before?: string | null, after?: string | null): string {
  const left = before ?? "";
  const right = after ?? "";
  let index = 0;
  let prefix = "";

  while (true) {
    const leftCode = index < left.length ? ALPHABET.indexOf(left[index]) : -1;
    const rightCode = index < right.length ? ALPHABET.indexOf(right[index]) : ALPHABET.length;
    const min = leftCode < 0 ? -1 : leftCode;
    const max = right ? rightCode : ALPHABET.length;

    if (max - min > 1) {
      return `${prefix}${ALPHABET[Math.floor((min + max) / 2)]}`;
    }

    prefix += index < left.length ? left[index] : MID_CHAR;
    index += 1;
  }
}

export function groupsToStored(groups: NoteGroup[], previous: StoredGroup[] = []): StoredGroup[] {
  const previousById = new Map(previous.map((group) => [group.id, group]));
  return groups.map((group, index) => {
    const prev = previousById.get(group.id);
    const now = Date.now();
    const orderKey = index.toString(36).padStart(8, "0");
    return {
      id: group.id,
      name: group.name,
      orderKey,
      orderUpdatedAt: prev?.orderKey === orderKey ? prev.orderUpdatedAt : now,
      updatedAt: prev?.name === group.name ? prev.updatedAt : now,
      createdAt: group.createdAt,
    };
  });
}

export function deriveNoteGroups(
  storedGroups: StoredGroup[],
  metas: NoteMeta[],
  collapsedById: Record<string, boolean> = {},
): NoteGroup[] {
  const noteIdsByGroup = new Map<string, string[]>();
  for (const meta of metas) {
    if (!meta.groupId || meta.trashedAt) continue;
    const ids = noteIdsByGroup.get(meta.groupId) ?? [];
    ids.push(meta.id);
    noteIdsByGroup.set(meta.groupId, ids);
  }

  return storedGroups
    .filter((group) => !group.deletedAt)
    .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.createdAt - b.createdAt)
    .map((group) => ({
      id: group.id,
      name: group.name,
      noteIds: noteIdsByGroup.get(group.id) ?? [],
      collapsed: collapsedById[group.id] ?? false,
      createdAt: group.createdAt,
    }));
}

export function mergeStoredGroups(left: StoredGroup[], right: StoredGroup[]): StoredGroup[] {
  const ids = new Set([...left.map((group) => group.id), ...right.map((group) => group.id)]);
  const merged: StoredGroup[] = [];

  for (const id of ids) {
    const a = left.find((group) => group.id === id);
    const b = right.find((group) => group.id === id);
    if (!a) {
      merged.push({ ...b! });
      continue;
    }
    if (!b) {
      merged.push({ ...a });
      continue;
    }

    const deletedAt = Math.max(a.deletedAt ?? 0, b.deletedAt ?? 0) || undefined;
    const textWinner = (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a;
    const orderWinner = (b.orderUpdatedAt ?? 0) > (a.orderUpdatedAt ?? 0) ? b : a;
    merged.push({
      ...textWinner,
      orderKey: orderWinner.orderKey,
      orderUpdatedAt: orderWinner.orderUpdatedAt,
      deletedAt,
      createdAt: Math.min(a.createdAt, b.createdAt),
    });
  }

  return merged.sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.createdAt - b.createdAt);
}

export async function readStoredGroups(notesDir: string): Promise<StoredGroup[]> {
  try {
    const raw = await readTextFile(groupsFilePath(notesDir));
    const parsed = JSON.parse(raw) as GroupsFile | StoredGroup[];
    const groups = Array.isArray(parsed) ? parsed : parsed.groups;
    return (groups ?? []).filter((group) => group.id && group.name);
  } catch {
    return [];
  }
}

export async function writeStoredGroups(notesDir: string, groups: StoredGroup[]): Promise<void> {
  await writeJsonAtomic(groupsFilePath(notesDir), { version: 2, groups });
}

export async function mergeAndWriteStoredGroups(notesDir: string, incoming: StoredGroup[]): Promise<StoredGroup[]> {
  const current = await readStoredGroups(notesDir);
  const merged = mergeStoredGroups(current, incoming);
  await writeStoredGroups(notesDir, merged);
  return merged;
}
