// Track local writes by short timestamp and optional content hash. Hash checks
// keep shared-folder latency from hiding real remote edits on the same path.

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

export function markOwnWrite(filePath: string, content?: string): void {
  const key = normalizePath(filePath);
  timestamps.set(key, Date.now());
  if (content !== undefined) {
    // Watch events are delayed, so this hash should land before we compare.
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

export async function isOwnWriteContentMatch(filePath: string, content: string): Promise<boolean> {
  const key = normalizePath(filePath);
  const set = hashes.get(key);
  if (!set || set.size === 0) return false;
  const hash = await sha256Hex(content);
  if (!set.has(hash)) return false;
  // Consume the hash so a later identical remote write is not swallowed.
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

export function __resetOwnWriteTrackerForTests(): void {
  timestamps.clear();
  hashes.clear();
  hashTimestamps.clear();
}
