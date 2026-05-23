import type { FileSystem } from "./fs";
import { atomicWriteText } from "./atomicWrite";
import { markOwnWrite } from "../hooks/ownWriteTracker";

// `.groups.json` stores shared group metadata only. Membership comes from
// per-note `groupId`; collapsed state is per-machine UI state.

export interface SharedGroupEntry {
  id: string;
  name: string;
  orderKey: string;
  orderUpdatedAt: number;
  updatedAt: number;
  createdAt: number;
  deletedAt: number | null;
}

interface GroupsFile {
  version: 1;
  groups: Record<string, SharedGroupEntry>;
}

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function normalizeSep(dir: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
}

export function groupsPathFor(notesDir: string): string {
  return `${normalizeSep(notesDir)}.groups.json`;
}

function isValidEntry(obj: unknown): obj is SharedGroupEntry {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  return typeof e.id === "string"
    && typeof e.name === "string"
    && typeof e.orderKey === "string"
    && typeof e.orderUpdatedAt === "number"
    && typeof e.updatedAt === "number"
    && typeof e.createdAt === "number"
    && (e.deletedAt === null || typeof e.deletedAt === "number");
}

export async function readGroupsFile(fs: FileSystem, notesDir: string): Promise<GroupsFile> {
  try {
    const raw = await fs.readTextFile(groupsPathFor(notesDir));
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { version: 1, groups: {} };
    const p = parsed as { groups?: unknown };
    if (!p.groups || typeof p.groups !== "object") return { version: 1, groups: {} };
    const groups: Record<string, SharedGroupEntry> = {};
    for (const [k, v] of Object.entries(p.groups as Record<string, unknown>)) {
      if (isValidEntry(v) && v.id === k) groups[k] = v;
    }
    return { version: 1, groups };
  } catch {
    return { version: 1, groups: {} };
  }
}

export function mergeGroupEntries(
  a: SharedGroupEntry | undefined,
  b: SharedGroupEntry | undefined,
): SharedGroupEntry | undefined {
  if (!a) return b;
  if (!b) return a;

  const nameWinner = b.updatedAt > a.updatedAt ? b : a;
  const orderWinner = b.orderUpdatedAt > a.orderUpdatedAt ? b : a;
  const deletedAt =
    a.deletedAt != null && b.deletedAt != null
      ? Math.max(a.deletedAt, b.deletedAt)
      : (a.deletedAt ?? b.deletedAt ?? null);

  return {
    id: a.id,
    name: nameWinner.name,
    updatedAt: nameWinner.updatedAt,
    orderKey: orderWinner.orderKey,
    orderUpdatedAt: orderWinner.orderUpdatedAt,
    createdAt: Math.min(a.createdAt, b.createdAt),
    deletedAt,
  };
}

export function mergeGroupMaps(
  a: Record<string, SharedGroupEntry>,
  b: Record<string, SharedGroupEntry>,
): Record<string, SharedGroupEntry> {
  const out: Record<string, SharedGroupEntry> = { ...a };
  for (const [id, entry] of Object.entries(b)) {
    out[id] = mergeGroupEntries(out[id], entry) ?? entry;
  }
  return out;
}

export function compactTombstones(
  groups: Record<string, SharedGroupEntry>,
  now: number = Date.now(),
): Record<string, SharedGroupEntry> {
  const out: Record<string, SharedGroupEntry> = {};
  for (const [id, entry] of Object.entries(groups)) {
    if (entry.deletedAt != null && now - entry.deletedAt > TOMBSTONE_TTL_MS) continue;
    out[id] = entry;
  }
  return out;
}

export async function writeGroupsWithMerge(
  fs: FileSystem,
  notesDir: string,
  localGroups: Record<string, SharedGroupEntry>,
): Promise<Record<string, SharedGroupEntry>> {
  const existing = await readGroupsFile(fs, notesDir);
  const merged = compactTombstones(mergeGroupMaps(existing.groups, localGroups));
  const file: GroupsFile = { version: 1, groups: merged };
  const serialized = JSON.stringify(file, null, 2);
  const path = groupsPathFor(notesDir);
  markOwnWrite(path, serialized);
  await atomicWriteText(fs, path, serialized);
  return merged;
}

// Fractional group ordering over a 36-char alphabet. Pathological keys fall
// back to a fresh time key instead of growing without bound.

const FI_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const FI_BASE = FI_ALPHABET.length;
const FI_MID = FI_ALPHABET[Math.floor(FI_BASE / 2)];
const MAX_KEY_LEN = 32;

function charToDigit(c: string): number {
  const i = FI_ALPHABET.indexOf(c);
  return i < 0 ? 0 : i;
}

function digitToChar(d: number): string {
  if (d < 0) return FI_ALPHABET[0];
  if (d >= FI_BASE) return FI_ALPHABET[FI_BASE - 1];
  return FI_ALPHABET[d];
}

function timeKey(): string {
  return Date.now().toString(36);
}

function clampKey(key: string): string {
  return key.length <= MAX_KEY_LEN ? key : timeKey();
}

export function genOrderKeyAfter(after?: string): string {
  if (!after) return FI_MID;
  const last = after[after.length - 1] ?? FI_ALPHABET[0];
  const next = charToDigit(last) + 1;
  if (next < FI_BASE) {
    return clampKey(after.slice(0, -1) + digitToChar(next));
  }
  return clampKey(`${after}${FI_MID}`);
}

export function genOrderKeyBefore(before?: string): string {
  if (!before) return FI_MID;
  const last = before[before.length - 1] ?? FI_ALPHABET[FI_BASE - 1];
  const prev = charToDigit(last) - 1;
  if (prev >= 0) {
    return clampKey(before.slice(0, -1) + digitToChar(prev));
  }
  return clampKey(`${before}${FI_MID}`);
}

export function genOrderKeyBetween(a?: string, b?: string): string {
  if (!a && !b) return FI_MID;
  if (!a) return genOrderKeyBefore(b);
  if (!b) return genOrderKeyAfter(a);
  if (a >= b) return genOrderKeyAfter(a);

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;

  const aDigit = i < a.length ? charToDigit(a[i]) : -1;
  const bDigit = i < b.length ? charToDigit(b[i]) : FI_BASE;

  if (bDigit - aDigit > 1) {
    const mid = Math.floor((aDigit + bDigit) / 2);
    return clampKey(a.slice(0, i) + digitToChar(mid));
  }

  // Adjacent keys: extend and clamp rather than growing without bound.
  const prefix = a.slice(0, i) + (aDigit >= 0 ? digitToChar(aDigit) : "");
  return clampKey(`${prefix}${FI_MID}`);
}

export { TOMBSTONE_TTL_MS };
