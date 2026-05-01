/** Per-path tracking of our own writes — used to ignore self-triggered watch events */

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

interface OwnWriteEntry {
  expectedSha256?: string | null;
  markedAt: number;
}

const ownWrites = new Map<string, OwnWriteEntry>();
const OWN_WRITE_TTL_MS = 30_000;

export function markOwnWrite(filePath: string, expectedSha256?: string | null) {
  ownWrites.set(normalizePath(filePath), { expectedSha256, markedAt: Date.now() });
}

export function isOwnWrite(filePath: string, actualSha256?: string | null): boolean {
  const key = normalizePath(filePath);
  const entry = ownWrites.get(key);
  if (!entry) return false;
  if (Date.now() - entry.markedAt >= OWN_WRITE_TTL_MS) {
    ownWrites.delete(key);
    return false;
  }
  if (arguments.length < 2 || entry.expectedSha256 === undefined) return true;
  return entry.expectedSha256 === actualSha256;
}

export function pruneOwnWrites() {
  const now = Date.now();
  for (const [p, entry] of ownWrites) {
    if (now - entry.markedAt >= OWN_WRITE_TTL_MS) ownWrites.delete(p);
  }
}

export function clearOwnWritesForTests() {
  ownWrites.clear();
}
