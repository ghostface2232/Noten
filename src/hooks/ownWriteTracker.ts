/**
 * Track our own writes so the file watcher doesn't treat them as external changes.
 *
 * Why both time and content hash?
 *   - Timestamp alone is unsafe over shared folders (OneDrive/Dropbox): if the
 *     grace window is long enough to cover sync latency, a real remote change
 *     on the same path would be dropped.
 *   - Content hash alone misses the case where we just marked intent but the
 *     write hasn't landed yet, and also requires reading the file.
 *
 * Strategy:
 *   - `markOwnWrite(path, content?)` records a short (2s) timestamp for every
 *     caller (legacy-compatible) and additionally remembers the content hash
 *     when the caller supplies it. Hashes stay around for 30s.
 *   - `isOwnWrite(path)` is a cheap, sync, time-only check used where the file
 *     hasn't been read yet (e.g. ignoring our own events on manifest*.json).
 *   - `isOwnWriteContentMatch(path, content)` is the definitive check: if the
 *     observed content matches a recorded hash, it is our write. Otherwise it
 *     is a remote change — even if the timestamp window hasn't elapsed.
 */

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

const timestamps = new Map<string, number>();
const hashes = new Map<string, Set<string>>();
const hashTimestamps = new Map<string, number>();

const TIME_GRACE_MS = 2000;
const HASH_TTL_MS = 30_000;

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const view = new Uint8Array(digest);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Record that we are about to perform (or just performed) a write to `path`.
 * Pass `content` when available so the watcher can perform a content-hash
 * match instead of leaning on the coarse timestamp grace window.
 */
export function markOwnWrite(filePath: string, content?: string): void {
  const key = normalizePath(filePath);
  timestamps.set(key, Date.now());
  if (content !== undefined) {
    // Hashing is async; fire-and-forget. A small race is acceptable because
    // the watch event is already delayed by the plugin (1500 ms) so by the
    // time we check, the hash has landed.
    void sha256Hex(content).then((hash) => {
      let set = hashes.get(key);
      if (!set) {
        set = new Set();
        hashes.set(key, set);
      }
      set.add(hash);
      hashTimestamps.set(`${key}#${hash}`, Date.now());
    });
  }
}

export function isOwnWrite(filePath: string): boolean {
  const key = normalizePath(filePath);
  const ts = timestamps.get(key);
  return ts !== undefined && Date.now() - ts < TIME_GRACE_MS;
}

/**
 * Definitive check: compute the content hash and compare against recorded
 * hashes for the path. Returns true iff this exact content was written by us.
 */
export async function isOwnWriteContentMatch(filePath: string, content: string): Promise<boolean> {
  const key = normalizePath(filePath);
  const set = hashes.get(key);
  if (!set || set.size === 0) return false;
  const hash = await sha256Hex(content);
  if (!set.has(hash)) return false;
  // Consume the hash — if the same content is written again externally, we
  // shouldn't silently swallow that second event.
  set.delete(hash);
  hashTimestamps.delete(`${key}#${hash}`);
  if (set.size === 0) hashes.delete(key);
  return true;
}

export function pruneOwnWrites(): void {
  const now = Date.now();
  for (const [p, ts] of timestamps) {
    if (now - ts >= TIME_GRACE_MS) timestamps.delete(p);
  }
  for (const [key, ts] of hashTimestamps) {
    if (now - ts >= HASH_TTL_MS) {
      hashTimestamps.delete(key);
      const hashIdx = key.lastIndexOf("#");
      if (hashIdx > 0) {
        const path = key.slice(0, hashIdx);
        const hash = key.slice(hashIdx + 1);
        const set = hashes.get(path);
        if (set) {
          set.delete(hash);
          if (set.size === 0) hashes.delete(path);
        }
      }
    }
  }
}

/** Test helper — clear all tracking state. */
export function __resetOwnWriteTrackerForTests(): void {
  timestamps.clear();
  hashes.clear();
  hashTimestamps.clear();
}
