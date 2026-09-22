import type { FileSystem } from "./fs";
import { atomicWriteText } from "./atomicWrite";
import { isValidNoteId } from "./noteId";
import { normalizeSep } from "./pathUtils";
import { markdownEqual } from "./markdownEqual";

// Per-machine record of edits that are NOT yet durable in the notes folder, so
// they survive the process rather than living only in memory.
//
// Lives in AppData, never in the notes directory: it is per-machine state (a
// cloud client would sync half-written recovery files between devices and the
// records describe THIS machine's unsaved work).
//
// Shape is a file per note, not an append-only log. The Tauri fs facade has no
// append, so a log would cost a full read-concat-write per entry, and recovery
// needs only each dirty note's LATEST body — there is no value in the history
// between. Each record is written through atomicWriteText, so a torn record
// cannot exist; a crashed write leaves either the old record or the new one.
//
// Records are written when a body write FAILS and at the lifecycle points
// where the process may be about to end (focus loss, close drain, update
// install), not before every save. A body write is already fail-closed
// temp+rename, so a crash mid-write leaves the previous body intact on disk —
// what a hard crash costs is the last debounce window of typing, not the note.
// Every reported loss came from an edit that stayed in memory after its save
// failed, which these points cover. Moving to full write-ahead later is a
// matter of calling writeRecoveryRecord before performBodyWrite.

export interface RecoveryRecord {
  version: 1;
  docId: string;
  filePath: string;
  content: string;
  /**
   * The disk body this edit was made against — `getKnownDiskContent` at the
   * time the record was written, or null when this session had never read or
   * written that file.
   *
   * Recovery is decided by this field, not by timestamps. Null means the same
   * thing it means everywhere else since the projection fix: we do not know
   * what is on disk, so the record must never be applied over it.
   */
  baseContent: string | null;
  editSerial: number;
  updatedAt: number;
}

const RECOVERY_DIRNAME = "recovery";

/** Window labels become a path segment, so hold them to the same rule note
 *  ids follow. Tauri's own labels are simple identifiers; anything else is a
 *  configuration mistake and must not escape the recovery directory. */
export function isValidWindowLabel(label: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(label);
}

export function recoveryRootFor(appDataDir: string): string {
  const base = normalizeSep(appDataDir);
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}${RECOVERY_DIRNAME}`;
}

export function recoveryLabelDirFor(appDataDir: string, windowLabel: string): string {
  return `${recoveryRootFor(appDataDir)}/${windowLabel}`;
}

export function recoveryRecordPathFor(
  appDataDir: string,
  windowLabel: string,
  docId: string,
): string {
  return `${recoveryLabelDirFor(appDataDir, windowLabel)}/${docId}.json`;
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.version === 1
    && typeof r.docId === "string"
    && isValidNoteId(r.docId)
    && typeof r.filePath === "string"
    && typeof r.content === "string"
    && (r.baseContent === null || typeof r.baseContent === "string")
    && typeof r.editSerial === "number"
    && typeof r.updatedAt === "number"
  );
}

export async function writeRecoveryRecord(
  fs: FileSystem,
  appDataDir: string,
  windowLabel: string,
  record: RecoveryRecord,
): Promise<void> {
  if (!isValidWindowLabel(windowLabel) || !isValidNoteId(record.docId)) return;
  const dir = recoveryLabelDirFor(appDataDir, windowLabel);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  await atomicWriteText(
    fs,
    recoveryRecordPathFor(appDataDir, windowLabel, record.docId),
    JSON.stringify(record),
    // Fail closed: a record that silently degraded to a non-atomic write is
    // exactly the one that can be found truncated, and the caller treats a
    // successful write as permission to stop protecting the edit.
    { failClosed: true },
  );
}

/** Every readable record for one window label. An unparseable or truncated
 *  file is skipped rather than failing the sweep — one bad record must not
 *  strand the others, the same rule readAllMeta follows for sidecars. */
export async function readRecoveryRecords(
  fs: FileSystem,
  appDataDir: string,
  windowLabel: string,
): Promise<RecoveryRecord[]> {
  if (!isValidWindowLabel(windowLabel)) return [];
  const dir = recoveryLabelDirFor(appDataDir, windowLabel);
  if (!(await fs.exists(dir))) return [];
  const entries = await fs.readDir(dir);
  const out: RecoveryRecord[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!name || !name.endsWith(".json") || name.endsWith(".tmp.json")) continue;
    try {
      const parsed = JSON.parse(await fs.readTextFile(`${dir}/${name}`)) as unknown;
      // The filename is the id recovery will act on, so refuse a record whose
      // body disagrees with it rather than trusting either.
      if (isRecoveryRecord(parsed) && `${parsed.docId}.json` === name) out.push(parsed);
    } catch { /* unreadable or truncated: skip, the note is still on disk */ }
  }
  return out;
}

export async function clearRecoveryRecord(
  fs: FileSystem,
  appDataDir: string,
  windowLabel: string,
  docId: string,
): Promise<void> {
  if (!isValidWindowLabel(windowLabel) || !isValidNoteId(docId)) return;
  try {
    const path = recoveryRecordPathFor(appDataDir, windowLabel, docId);
    if (await fs.exists(path)) await fs.remove(path);
  } catch { /* best-effort: a stale record costs one extra recovery check */ }
}

/** Window labels that currently hold records. Labels are reused across app
 *  runs, so a window normally finds its own previous run's records; this also
 *  lets one window adopt a label that never reopened. */
export async function listRecoveryLabels(
  fs: FileSystem,
  appDataDir: string,
): Promise<string[]> {
  const root = recoveryRootFor(appDataDir);
  if (!(await fs.exists(root))) return [];
  const entries = await fs.readDir(root);
  return entries
    .filter((e) => e.name && e.isDirectory && isValidWindowLabel(e.name))
    .map((e) => e.name!);
}

/**
 * What to do with one record, given what is on disk now.
 *
 * Only two outcomes touch anything, and neither can destroy: `apply` writes
 * the record over a body we can prove nothing else has moved, and `preserve`
 * leaves disk alone and copies the record into `.conflicts/` so the work is
 * recoverable by hand. Everything uncertain resolves to `preserve`.
 */
export type RecoveryPlan =
  /** Disk already holds this body — the save landed after all, or a later one
   *  did. Nothing to do but drop the record. */
  | { action: "drop" }
  /** Disk still holds exactly what the edit was made against, so replaying it
   *  loses nothing. */
  | { action: "apply" }
  /** Disk moved, is unknown to this session, or the file is gone. Keep the
   *  record's body under .conflicts and leave the note as it is. */
  | { action: "preserve"; reason: "diverged" | "unknown-base" | "missing-file" };

/**
 * @param diskContent The note body now, or null when the file does not exist
 *   (deleted elsewhere, or never provisioned).
 */
export function planRecovery(record: RecoveryRecord, diskContent: string | null): RecoveryPlan {
  if (diskContent !== null && markdownEqual(diskContent, record.content)) {
    return { action: "drop" };
  }
  // No file to compare against. It may have been deleted on another device, or
  // never provisioned at all; either way writing the body back would resurrect
  // or invent a note rather than recover one.
  if (!record.filePath || diskContent === null) {
    return { action: "preserve", reason: "missing-file" };
  }
  // The same rule every destructive path follows since the projection fix: a
  // body this session never read is one we cannot reason about. A record whose
  // base is absent may itself hold a manifest-cache projection's empty body.
  if (record.baseContent === null) {
    return { action: "preserve", reason: "unknown-base" };
  }
  if (markdownEqual(diskContent, record.baseContent)) return { action: "apply" };
  return { action: "preserve", reason: "diverged" };
}
