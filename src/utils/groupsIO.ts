import type { FileSystem } from "./fs";
import { atomicWriteText } from "./atomicWrite";
import { markOwnWrite } from "../hooks/ownWriteTracker";
import { normalizeSep } from "./pathUtils";

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
  const path = groupsPathFor(notesDir);
  if (!(await fs.exists(path))) return { version: 1, groups: {} };

  const raw = await fs.readTextFile(path);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid groups file: ${path}`);
  }
  const p = parsed as { groups?: unknown };
  if (!p.groups || typeof p.groups !== "object") {
    throw new Error(`Invalid groups file: ${path}`);
  }
  const groups: Record<string, SharedGroupEntry> = {};
  for (const [k, v] of Object.entries(p.groups as Record<string, unknown>)) {
    if (isValidEntry(v) && v.id === k) groups[k] = v;
  }
  return { version: 1, groups };
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
  // Fail closed like a note body. This file is the ONLY index of every group
  // and every deletion tombstone, so the relaxed mode's direct overwrite is
  // the worst possible trade here: an interrupted non-atomic write leaves
  // truncated JSON, and readGroupsFile rejects the whole library rather than
  // one note. The caller in persistDecomposedState already treats a rejection
  // as retryable and keeps the in-memory snapshot and tombstone intent pending.
  await atomicWriteText(fs, path, serialized, { failClosed: true });
  return merged;
}

// Fractional group ordering over a 36-char alphabet. Pathological keys fall
// back to a fresh time key instead of growing without bound.
//
// Each generator returns a key strictly on the requested side of its inputs,
// with two inherent exceptions the alphabet cannot express: nothing sorts
// before a bare "0", and nothing fits between a key and that same key plus
// "0". Both need the caller to renormalize the list rather than a cleverer
// key; `genOrderKeyBefore` reaching "0" is what leads there, and only a list
// dragged repeatedly to its minimum gets that far. The length clamp is a third
// exception, since its time key has no relation to the inputs. A caller that
// places a key between neighbours checks `isOrderKeyBetween` and rekeys the
// whole list with `genSpreadOrderKeys` when it fails. `groupsIO.test.ts` fuzzes
// the invariant and pins the first two as known-unsatisfiable.

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
  // The last digit is already the minimum, so it cannot be decremented.
  // Dropping it yields a shorter key that sorts BEFORE the input ("4l0" ->
  // "4l"); appending, as this used to do, returned a key after it.
  const trimmed = before.slice(0, -1);
  if (trimmed) return clampKey(trimmed);
  // A bare minimum digit has nothing before it in this alphabet.
  return clampKey(`${before}${FI_MID}`);
}

export function genOrderKeyBetween(a?: string, b?: string): string {
  if (!a && !b) return FI_MID;
  if (!a) return genOrderKeyBefore(b);
  if (!b) return genOrderKeyAfter(a);
  if (a >= b) return genOrderKeyAfter(a);

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;

  // a is a prefix of b (a = "o", b = "o0sm"): every key between them is a
  // followed by something strictly inside b's remaining suffix. Treating a's
  // missing digit as -1 and falling through sent this down the adjacent-digit
  // branch, which appended to a and overshot b.
  if (i >= a.length) return clampKey(a + genOrderKeyBefore(b.slice(i)));

  const aDigit = charToDigit(a[i]);
  const bDigit = i < b.length ? charToDigit(b[i]) : FI_BASE;

  if (bDigit - aDigit > 1) {
    const mid = Math.floor((aDigit + bDigit) / 2);
    return clampKey(a.slice(0, i) + digitToChar(mid));
  }

  // Adjacent digits at position i: every key between a and b must reuse a's
  // digits through i, because anything lower sorts at or below a and anything
  // higher reaches b's digit. Sharing that prefix already puts the result
  // below b (it differs at i with the lower digit), so all that remains is to
  // clear a's REMAINING suffix — appending FI_MID ignored it and returned a
  // key below a whenever a had one (genOrderKeyBetween("hz", "i") gave "hi").
  const prefix = a.slice(0, i) + digitToChar(aDigit);
  return clampKey(`${prefix}${genOrderKeyAfter(a.slice(i + 1))}`);
}

/**
 * Whether `key` sorts strictly between the neighbours, in the order the group
 * comparator uses (a missing key compares as ""). A missing neighbour is an
 * open end.
 */
export function isOrderKeyBetween(key: string, before?: { orderKey?: string }, after?: { orderKey?: string }): boolean {
  if (before && !((before.orderKey ?? "") < key)) return false;
  if (after && !(key < (after.orderKey ?? ""))) return false;
  return true;
}

/**
 * `count` ascending keys of one fixed width spread evenly across the key
 * space, so the list they are assigned to has room on both sides of every
 * entry again. Equal widths also mean no key is a prefix of another.
 */
export function genSpreadOrderKeys(count: number): string[] {
  let width = 2;
  while (FI_BASE ** width <= count + 1) width++;
  const space = FI_BASE ** width;
  const keys: string[] = [];
  for (let i = 1; i <= count; i++) {
    let n = Math.floor((i * space) / (count + 1));
    let key = "";
    for (let d = 0; d < width; d++) {
      key = FI_ALPHABET[n % FI_BASE] + key;
      n = Math.floor(n / FI_BASE);
    }
    keys.push(key);
  }
  return keys;
}

export { TOMBSTONE_TTL_MS };
