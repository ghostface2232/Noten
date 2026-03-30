/** Per-path tracking of our own writes — used to ignore self-triggered watch events */

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

const ownWrites = new Map<string, number>();
const OWN_WRITE_GRACE_MS = 2000;

export function markOwnWrite(filePath: string) {
  ownWrites.set(normalizePath(filePath), Date.now());
}

export function isOwnWrite(filePath: string): boolean {
  const ts = ownWrites.get(normalizePath(filePath));
  return ts !== undefined && Date.now() - ts < OWN_WRITE_GRACE_MS;
}

export function pruneOwnWrites() {
  const now = Date.now();
  for (const [p, ts] of ownWrites) {
    if (now - ts >= OWN_WRITE_GRACE_MS) ownWrites.delete(p);
  }
}
