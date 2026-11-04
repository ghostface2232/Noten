/**
 * Notes in this window whose last save failed and whose edit is still pending. A
 * failed save keeps its snapshot but arms no timer, so with no more typing nothing
 * would try again and nothing would say so: a notice that fades after a few seconds
 * looks exactly like success. The app shows this for as long as it is true.
 */
const failing = new Map<string, number>();
const listeners = new Set<() => void>();
let anyFailing = false;

function publish(): void {
  const next = failing.size > 0;
  if (next === anyFailing) return;
  anyFailing = next;
  for (const listener of listeners) listener();
}

export function markSaveFailed(docId: string, editSerial: number): void {
  failing.set(docId, Math.max(editSerial, failing.get(docId) ?? editSerial));
  publish();
}

/** A slower save of an older edit says nothing about a newer one that failed. */
export function markSaveSettled(docId: string, editSerial: number): void {
  const failedAt = failing.get(docId);
  if (failedAt === undefined || failedAt > editSerial) return;
  failing.delete(docId);
  publish();
}

/** Drops notes with no pending edit left, such as one deleted or superseded. */
export function settleSavesWithoutPending(hasPending: (docId: string) => boolean): void {
  if (failing.size === 0) return;
  for (const docId of failing.keys()) {
    if (!hasPending(docId)) failing.delete(docId);
  }
  publish();
}

export function isSaveFailing(): boolean {
  return anyFailing;
}

export function subscribeSaveFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
