import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults, type FaultInjectingFileSystem } from "./fs.fault.test-utils";
import {
  backupIfRemoteWroteFirst,
  backupLocalDeletionVersion,
  backupRemoteVersion,
  resetKnownDiskContent,
  setKnownDiskContent,
} from "./conflictBackup";
import { NotenError } from "./notenError";

const DIR = "/notes";
const NOTE_ID = "00000000-0000-0000-0000-000000000001";
const FILE_PATH = `${DIR}/${NOTE_ID}.md`;
const CONFLICTS_DIR_RE = /^\/notes\/\.conflicts\//;

let inner: InMemoryFileSystem;
let fs: InMemoryFileSystem & FaultInjectingFileSystem;

beforeEach(() => {
  inner = createInMemoryFileSystem();
  inner.seedDir(DIR);
  fs = wrapWithFaults(inner);
  resetKnownDiskContent();
});

describe("backupIfRemoteWroteFirst", () => {
  it("throws BACKUP_FAILED when the pre-save disk read fails (cannot verify safety)", async () => {
    // Models the OneDrive/Dropbox placeholder case: file lists in readDir but
    // readTextFile errors transiently. Previously this returned false silently
    // ("no backup needed"), and the caller then overwrote the live body with
    // no recovery surface.
    inner.seedTextFile(FILE_PATH, "remote body the user does not want destroyed");
    setKnownDiskContent(FILE_PATH, "stale baseline");
    fs.injectFault({
      op: "readTextFile",
      path: FILE_PATH,
      throwError: new Error("EBUSY: cloud-sync hydration"),
    });

    await expect(
      backupIfRemoteWroteFirst(fs, DIR, FILE_PATH, NOTE_ID, "intended new content"),
    ).rejects.toMatchObject({
      name: "NotenError",
      code: "BACKUP_FAILED",
      severity: "fatal",
    });
  });

  it("returns false (save proceeds) when the file is simply gone", async () => {
    // Models the remote-delete race: PC B deleted the note and the deletion
    // synced here while this doc is still dirty. There is no remote body to
    // protect, and the body write right after this call recreates the file.
    // Previously this threw BACKUP_FAILED, which made the dirty note
    // permanently unsaveable and silently dropped the session's edits.
    setKnownDiskContent(FILE_PATH, "stale baseline");
    // FILE_PATH intentionally not seeded: readTextFile rejects, exists() is false.

    const result = await backupIfRemoteWroteFirst(fs, DIR, FILE_PATH, NOTE_ID, "dirty content");

    expect(result).toBe(false);
  });

  it("still throws BACKUP_FAILED when the existence check itself fails", async () => {
    // If we can't even stat the path we cannot distinguish "gone" from
    // "unreadable", so the save must stay deferred.
    inner.seedTextFile(FILE_PATH, "remote body");
    setKnownDiskContent(FILE_PATH, "stale baseline");
    fs.injectFault({
      op: "readTextFile",
      path: FILE_PATH,
      throwError: new Error("EBUSY: hydration"),
    });
    fs.injectFault({
      op: "exists",
      path: FILE_PATH,
      throwError: new Error("EBUSY: hydration"),
    });

    await expect(
      backupIfRemoteWroteFirst(fs, DIR, FILE_PATH, NOTE_ID, "intended"),
    ).rejects.toMatchObject({
      name: "NotenError",
      code: "BACKUP_FAILED",
      severity: "fatal",
    });
  });

  it("throws BACKUP_FAILED when the conflict body write fails", async () => {
    // The disk read succeeds and reveals a remote write; we attempt to back up
    // the remote body before overwriting; but the .conflicts/ write itself
    // fails. Caller (autosave) must see this so it can defer the save.
    inner.seedTextFile(FILE_PATH, "remote body");
    setKnownDiskContent(FILE_PATH, "stale baseline");
    fs.injectFault({
      op: "writeTextFile",
      path: CONFLICTS_DIR_RE,
      throwError: new Error("EPERM: conflicts dir unwritable"),
    });

    await expect(
      backupIfRemoteWroteFirst(fs, DIR, FILE_PATH, NOTE_ID, "intended new content"),
    ).rejects.toMatchObject({
      name: "NotenError",
      code: "BACKUP_FAILED",
    });
  });

  it("seeds the baseline and returns false on the first save when read succeeds", async () => {
    inner.seedTextFile(FILE_PATH, "current body");

    const result = await backupIfRemoteWroteFirst(fs, DIR, FILE_PATH, NOTE_ID, "anything");

    expect(result).toBe(false);
  });

  it("returns false when disk matches the intended content (no remote drift)", async () => {
    inner.seedTextFile(FILE_PATH, "same body");
    setKnownDiskContent(FILE_PATH, "previous baseline");

    const result = await backupIfRemoteWroteFirst(fs, DIR, FILE_PATH, NOTE_ID, "same body");

    expect(result).toBe(false);
  });

  it("backs up and returns true when disk differs from baseline and intent", async () => {
    inner.seedTextFile(FILE_PATH, "remote body");
    setKnownDiskContent(FILE_PATH, "stale baseline");

    const result = await backupIfRemoteWroteFirst(fs, DIR, FILE_PATH, NOTE_ID, "intended");

    expect(result).toBe(true);
    // A backup file should now live under .conflicts/.
    const entries = await fs.readDir(`${DIR}/.conflicts`);
    expect(entries.some((e) => e.name?.startsWith(NOTE_ID))).toBe(true);
  });
});

describe("backupRemoteVersion", () => {
  it("throws BACKUP_FAILED when the conflict file write fails", async () => {
    fs.injectFault({
      op: "writeTextFile",
      path: CONFLICTS_DIR_RE,
      throwError: new Error("EPERM"),
    });

    await expect(
      backupRemoteVersion(fs, DIR, NOTE_ID, "doomed remote body"),
    ).rejects.toMatchObject({
      name: "NotenError",
      code: "BACKUP_FAILED",
      severity: "fatal",
    });
  });

  it("returns the backup path on success", async () => {
    const result = await backupRemoteVersion(fs, DIR, NOTE_ID, "remote body");

    expect(result).not.toBeNull();
    expect(result).toMatch(CONFLICTS_DIR_RE);
  });

  it("returns null for an empty body without throwing", async () => {
    const result = await backupRemoteVersion(fs, DIR, NOTE_ID, "");
    expect(result).toBeNull();
  });

  it("BACKUP_FAILED carries filePath and noteId context", async () => {
    fs.injectFault({
      op: "writeTextFile",
      path: CONFLICTS_DIR_RE,
      throwError: new Error("EPERM"),
    });

    try {
      await backupRemoteVersion(fs, DIR, NOTE_ID, "body");
      throw new Error("expected backupRemoteVersion to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotenError);
      const ne = err as NotenError;
      expect(ne.context?.noteId).toBe(NOTE_ID);
      expect(ne.context?.filePath).toMatch(CONFLICTS_DIR_RE);
    }
  });
});

describe("backupLocalDeletionVersion", () => {
  it("writes an artifact even when the dirty local body is empty", async () => {
    const path = await backupLocalDeletionVersion(fs, DIR, NOTE_ID, "");

    expect(path).toMatch(CONFLICTS_DIR_RE);
    expect(await fs.readTextFile(path)).toBe("");
  });
});
