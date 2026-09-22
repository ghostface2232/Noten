import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults } from "./fs.fault.test-utils";
import {
  reconcileFolder,
  createReconcileState,
  ORPHAN_META_GRACE_MS,
  type ReconcileState,
} from "./reconcileFolder";
import {
  writeMeta,
  readMeta,
  ensureMetaDir,
  metaPathFor,
  invalidateReadAllMetaCache,
  type NoteMeta,
} from "./metadataIO";
import { NotenError } from "./notenError";
import type { NoteDoc, NoteGroup } from "./noteTypes";

vi.mock("./crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

async function getMockedLogger() {
  const { logNotenError } = await import("./crashLog");
  return logNotenError as unknown as ReturnType<typeof vi.fn>;
}

const DIR = "/notes";
const LOCALE = "en" as const;
const MACHINE = "test-machine";

function makeMeta(id: string, overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    version: 2,
    id,
    fileName: id,
    createdAt: 1000,
    updatedAt: 1000,
    groupId: null,
    trashedAt: null,
    ...overrides,
  };
}

function makeDoc(id: string, overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    id,
    filePath: `${DIR}/${id}.md`,
    fileName: id,
    isDirty: false,
    content: "",
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    ...overrides,
  };
}

async function seedMeta(fs: InMemoryFileSystem, meta: NoteMeta): Promise<void> {
  await ensureMetaDir(fs, DIR);
  await writeMeta(fs, DIR, meta, MACHINE);
}

let fs: InMemoryFileSystem;
let state: ReconcileState;

beforeEach(async () => {
  // Orphan-meta deletion is gated on wall-clock age, so the suite pins time.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  fs = createInMemoryFileSystem();
  state = createReconcileState();
  fs.seedDir(DIR);
  (await getMockedLogger()).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileFolder — live meta with trash-only body (crashed delete)", () => {
  it("flips the sidecar to trashed only after a prior pass and the grace period", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    await seedMeta(fs, makeMeta(id));
    fs.seedDir(`${DIR}/.trash`);
    fs.seedTextFile(`${DIR}/.trash/${id}.md`, "deleted body");

    // First sight: record only. The same disk state is transient during an
    // in-progress restoreNote, so a first-pass flip would re-trash it.
    const first = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(first.changed).toBe(false);
    expect((await readMeta(fs, DIR, id))!.trashedAt).toBeNull();

    // Within the grace window: still no flip.
    vi.advanceTimersByTime(5_000);
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect((await readMeta(fs, DIR, id))!.trashedAt).toBeNull();

    // Grace elapsed: the crashed-delete repair lands.
    vi.advanceTimersByTime(ORPHAN_META_GRACE_MS);
    const third = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(third.changed).toBe(true);
    expect(third.docs).toHaveLength(0);
    const repaired = await readMeta(fs, DIR, id);
    expect(repaired!.trashedAt).toBe(Date.now());
    expect(repaired!.trashedFromPath).toBe(`${DIR}/${id}.md`);
    // Repaired, not an orphan candidate — the sidecar must never age toward
    // the orphan-meta delete while its body sits in trash.
    expect(state.bodyMissing.has(id)).toBe(false);
    expect(state.trashOnlyLiveMeta.has(id)).toBe(false);
  });

  it("a restore completing within the grace clears the observation instead of re-trashing", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    await seedMeta(fs, makeMeta(id));
    fs.seedDir(`${DIR}/.trash`);
    fs.seedTextFile(`${DIR}/.trash/${id}.md`, "restoring body");

    // Pass 1 observes the transient restore window (meta already live, body
    // copy still in flight).
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect((await readMeta(fs, DIR, id))!.trashedAt).toBeNull();

    // The restore finishes: root body lands, trash body removed.
    fs.seedTextFile(`${DIR}/${id}.md`, "restoring body");
    await fs.remove(`${DIR}/.trash/${id}.md`);

    vi.advanceTimersByTime(ORPHAN_META_GRACE_MS + 1_000);
    const after = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    // The note is ingested live and the stale observation is dropped, so a
    // later recurrence restarts the grace clock.
    expect(after.docs.some((d) => d.id === id)).toBe(true);
    expect((await readMeta(fs, DIR, id))!.trashedAt).toBeNull();
    expect(state.trashOnlyLiveMeta.has(id)).toBe(false);
  });

  it("leaves the sidecar alone while a dirty in-memory doc still holds the id", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    await seedMeta(fs, makeMeta(id));
    fs.seedDir(`${DIR}/.trash`);
    fs.seedTextFile(`${DIR}/.trash/${id}.md`, "old body");
    const dirty = makeDoc(id, { isDirty: true, content: "unsaved edits" });

    const result = await reconcileFolder(fs, state, DIR, [dirty], [], LOCALE);

    // Autosave is about to recreate the root body; flipping to trashed here
    // would fight it. Not even an observation is recorded.
    const meta = await readMeta(fs, DIR, id);
    expect(meta!.trashedAt).toBeNull();
    expect(result.docs.some((d) => d.id === id)).toBe(true);
    expect(state.trashOnlyLiveMeta.has(id)).toBe(false);
  });
});

describe("reconcileFolder", () => {
  it("picks up a new .md file and creates its meta sidecar", async () => {
    fs.seedTextFile(`${DIR}/note-alpha.md`, "# Hello\n");

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.changed).toBe(true);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].id).toBe("note-alpha");
    expect(result.docs[0].content).toBe("# Hello\n");

    const written = await readMeta(fs, DIR, "note-alpha");
    expect(written).not.toBeNull();
    expect(written!.fileName).toBe("Hello");
  });

  it("graces a bodyless meta until both a prior pass and the wall-clock grace have elapsed", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await seedMeta(fs, makeMeta(id));

    const first = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(first.changed).toBe(false);
    expect(state.bodyMissing.get(id)?.passes).toBe(1);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);

    // A second pass seconds later must NOT delete: OneDrive can deliver the
    // sidecar before the body, and two watcher passes can land seconds apart.
    vi.advanceTimersByTime(5_000);
    const second = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(second.changed).toBe(false);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);

    // Once the grace age has passed, the next pass deletes.
    vi.advanceTimersByTime(ORPHAN_META_GRACE_MS);
    const third = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(third.changed).toBe(false);
    expect(state.bodyMissing.has(id)).toBe(false);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(false);
  });

  it("resets the bodyMissing counter when the body arrives, restoring the full grace on a later disappearance", async () => {
    // OneDrive can drop and re-hydrate placeholders multiple times during a
    // sync. If the counter were sticky, the second disappearance would skip
    // straight to deletion — the user's note vanishes despite the body just
    // having been seen on disk. This pins the counter-reset path on the
    // body-arrival branch (reconcileFolder.ts:305-310).
    const id = "11111111-1111-1111-1111-111111111aaa";
    const filePath = `${DIR}/${id}.md`;
    await seedMeta(fs, makeMeta(id));

    // Pass 1: bodyless → grace recorded.
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(state.bodyMissing.get(id)?.passes).toBe(1);

    // Body arrives between passes (cloud-sync hydration completes).
    fs.seedTextFile(filePath, "hydrated body");

    // Pass 2: body present → observation must reset, sidecar must stay.
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(state.bodyMissing.has(id)).toBe(false);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);

    // Body disappears again (placeholder re-virtualized) well after the
    // original observation's grace would have expired — the reset must also
    // refresh firstSeenAt, not just the pass count.
    vi.advanceTimersByTime(ORPHAN_META_GRACE_MS + 1_000);
    await fs.remove(filePath);

    // Pass 3: bodyless → fresh observation, no delete on first sight.
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(state.bodyMissing.get(id)?.passes).toBe(1);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);

    // Pass 4: a prior pass exists but the fresh observation is still inside
    // its own grace window → must NOT delete. A sticky firstSeenAt would
    // delete here.
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);

    // After the fresh observation ages past the grace, deletion proceeds.
    vi.advanceTimersByTime(ORPHAN_META_GRACE_MS);
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(state.bodyMissing.has(id)).toBe(false);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(false);
  });

  it("graces a trashed meta whose trash body is missing across two passes", async () => {
    // Trashed sidecars take the same path through the bodyMissing guard,
    // but via the `meta.trashedAt != null` branch at reconcileFolder.ts:284
    // — the body is expected at `.trash/{id}.md`, not at root. If that
    // branch ever drops out of the grace, a synced PC with a momentarily
    // missing trash placeholder would wipe the trash sidecar (and thus the
    // trash entry) on every other machine through the .meta sync.
    const id = "33333333-3333-3333-3333-333333333aaa";
    await seedMeta(fs, makeMeta(id, {
      trashedAt: 5000,
      trashedFromPath: `${DIR}/${id}.md`,
    }));

    const first = await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(first.changed).toBe(false);
    expect(state.bodyMissing.get(id)?.passes).toBe(1);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);

    vi.advanceTimersByTime(ORPHAN_META_GRACE_MS);
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    expect(state.bodyMissing.has(id)).toBe(false);
    expect(await fs.exists(metaPathFor(DIR, id))).toBe(false);
  });

  it("skips bodyless deletion when bulk guard trips (>=3 ids and >=25%)", async () => {
    for (let i = 0; i < 8; i += 1) {
      const id = `aaaaaaaa-aaaa-aaaa-aaaa-${i.toString().padStart(12, "0")}`;
      await seedMeta(fs, makeMeta(id));
      if (i >= 3) {
        fs.seedTextFile(`${DIR}/${id}.md`, `body ${i}`);
      }
    }

    // Advance past the wall-clock grace between passes so this pins that the
    // BULK guard (not age) is what blocks deletion.
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    vi.advanceTimersByTime(ORPHAN_META_GRACE_MS);
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    for (let i = 0; i < 3; i += 1) {
      const id = `aaaaaaaa-aaaa-aaaa-aaaa-${i.toString().padStart(12, "0")}`;
      expect(await fs.exists(metaPathFor(DIR, id))).toBe(true);
    }
  });

  it("restores trashed note when root mtime is newer than trashedAt", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const trashedAt = 5000;
    await seedMeta(fs, makeMeta(id, { trashedAt, trashedFromPath: `${DIR}/${id}.md` }));
    // Root body present and newer than trashedAt.
    fs.seedTextFile(`${DIR}/${id}.md`, "restored content");

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.changed).toBe(true);
    const meta = await readMeta(fs, DIR, id);
    expect(meta).not.toBeNull();
    expect(meta!.trashedAt).toBeNull();
    expect(await fs.exists(`${DIR}/.trash/${id}.md`)).toBe(false);
  });

  it("keeps note trashed when stat fails on the root body (cloud-sync placeholder)", async () => {
    const id = "22222222-2222-2222-2222-22222222aaaa";
    const trashedAt = 5000;
    await seedMeta(fs, makeMeta(id, { trashedAt, trashedFromPath: `${DIR}/${id}.md` }));
    const rootPath = `${DIR}/${id}.md`;
    fs.seedTextFile(rootPath, "ghost body");

    // Simulate a transient stat failure on the root path only (OneDrive/Dropbox
    // placeholders can EBUSY/EPERM on stat while readDir still lists them).
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "stat",
      path: rootPath,
      throwError: new Error("EBUSY: simulated cloud-sync lock"),
    });

    const result = await reconcileFolder(faultFs, state, DIR, [], [], LOCALE);

    const meta = await readMeta(faultFs, DIR, id);
    expect(meta).not.toBeNull();
    // Must NOT be restored: unknown mtime defaults to "keep in trash".
    expect(meta!.trashedAt).toBe(trashedAt);
    // Stale root body should have been moved to .trash/, not left to mislead later passes.
    expect(await faultFs.exists(`${DIR}/.trash/${id}.md`)).toBe(true);
    expect(await faultFs.exists(rootPath)).toBe(false);
    expect(result.docs.find((d) => d.id === id)).toBeUndefined();
  });

  it("keeps note trashed when stat returns null mtime", async () => {
    const id = "22222222-2222-2222-2222-22222222bbbb";
    const trashedAt = 5000;
    await seedMeta(fs, makeMeta(id, { trashedAt, trashedFromPath: `${DIR}/${id}.md` }));
    const rootPath = `${DIR}/${id}.md`;
    fs.seedTextFile(rootPath, "ghost body");

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "stat",
      path: rootPath,
      transformResult: (s) => ({ ...(s as object), mtime: null }),
    });

    await reconcileFolder(faultFs, state, DIR, [], [], LOCALE);

    const meta = await readMeta(faultFs, DIR, id);
    expect(meta!.trashedAt).toBe(trashedAt);
    expect(await faultFs.exists(`${DIR}/.trash/${id}.md`)).toBe(true);
    expect(await faultFs.exists(rootPath)).toBe(false);
  });

  it("moves root body to trash when trashedAt is newer than root mtime", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    fs.seedTextFile(`${DIR}/${id}.md`, "stale root");

    // Stat the file we just seeded so trashedAt can be set well in the future.
    const rootStat = await fs.stat(`${DIR}/${id}.md`);
    const rootMtime = rootStat.mtime!.getTime();
    await seedMeta(fs, makeMeta(id, { trashedAt: rootMtime + 60_000, trashedFromPath: `${DIR}/${id}.md` }));

    const startingDoc = makeDoc(id);
    const result = await reconcileFolder(fs, state, DIR, [startingDoc], [], LOCALE);

    expect(result.changed).toBe(true);
    expect(result.docs.find((d) => d.id === id)).toBeUndefined();
    expect(await fs.exists(`${DIR}/.trash/${id}.md`)).toBe(true);
    expect(await fs.exists(`${DIR}/${id}.md`)).toBe(false);
  });

  it("backs up the stale root and keeps the trash body when trash wins with a body conflict", async () => {
    const id = "33333333-3333-3333-3333-3333333344aa";
    const rootPath = `${DIR}/${id}.md`;
    const trashPath = `${DIR}/.trash/${id}.md`;
    fs.seedTextFile(rootPath, "stale root");
    fs.seedTextFile(trashPath, "fresh trash");

    // Root was NOT modified after trashing → trash wins, and the trash body is
    // authoritative. The stale root must be preserved (backed up) and removed,
    // never copied over the winning trash body.
    const rootMtime = (await fs.stat(rootPath)).mtime!.getTime();
    await seedMeta(fs, makeMeta(id, { trashedAt: rootMtime + 60_000, trashedFromPath: rootPath }));

    const result = await reconcileFolder(fs, state, DIR, [makeDoc(id)], [], LOCALE);

    expect(result.changed).toBe(true);
    expect(result.docs.find((d) => d.id === id)).toBeUndefined();
    // Trash body survives untouched; stale root is gone.
    expect(await fs.readTextFile(trashPath)).toBe("fresh trash");
    expect(await fs.exists(rootPath)).toBe(false);
    // The losing root body is preserved in .conflicts/, not dropped.
    const conflicts = await fs.readDir(`${DIR}/.conflicts`);
    const backups = conflicts.filter((e) => e.name?.startsWith(`${id}-`) && e.name?.endsWith(".md"));
    expect(backups).toHaveLength(1);
    expect(await fs.readTextFile(`${DIR}/.conflicts/${backups[0].name}`)).toBe("stale root");
  });

  it("leaves both bodies untouched when an existing trash body is temporarily unreadable", async () => {
    const id = "33333333-3333-3333-3333-3333333344bb";
    const rootPath = `${DIR}/${id}.md`;
    const trashPath = `${DIR}/.trash/${id}.md`;
    fs.seedTextFile(rootPath, "stale root");
    fs.seedTextFile(trashPath, "authoritative trash");
    const rootMtime = (await fs.stat(rootPath)).mtime!.getTime();
    await seedMeta(fs, makeMeta(id, { trashedAt: rootMtime + 60_000, trashedFromPath: rootPath }));

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: trashPath,
      throwError: new Error("EBUSY: trash placeholder is hydrating"),
    });

    const result = await reconcileFolder(faultFs, state, DIR, [makeDoc(id)], [], LOCALE);

    expect(result.docs.find((d) => d.id === id)).toBeUndefined();
    expect(await fs.readTextFile(rootPath)).toBe("stale root");
    expect(await fs.readTextFile(trashPath)).toBe("authoritative trash");
    expect(faultFs.callCount("copyFile", rootPath)).toBe(0);
    expect(faultFs.callCount("remove", rootPath)).toBe(0);
  });

  it("keeps the divergent root when its conflict backup cannot be written", async () => {
    const id = "33333333-3333-3333-3333-3333333344cc";
    const rootPath = `${DIR}/${id}.md`;
    const trashPath = `${DIR}/.trash/${id}.md`;
    fs.seedTextFile(rootPath, "unique stale root");
    fs.seedTextFile(trashPath, "authoritative trash");
    const rootMtime = (await fs.stat(rootPath)).mtime!.getTime();
    await seedMeta(fs, makeMeta(id, { trashedAt: rootMtime + 60_000, trashedFromPath: rootPath }));

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "writeTextFile",
      path: new RegExp(`/\\.conflicts/${id}-\\d+-.+\\.md$`),
      throwError: new Error("ENOSPC: cannot preserve conflict body"),
    });

    const result = await reconcileFolder(faultFs, state, DIR, [makeDoc(id)], [], LOCALE);

    expect(result.docs.find((d) => d.id === id)).toBeUndefined();
    expect(await fs.readTextFile(rootPath)).toBe("unique stale root");
    expect(await fs.readTextFile(trashPath)).toBe("authoritative trash");
    expect(faultFs.callCount("remove", rootPath)).toBe(0);
  });

  it("keeps dirty docs even when the disk file vanishes", async () => {
    const dirty = makeDoc("dirty-id", { isDirty: true, content: "unsaved" });

    const result = await reconcileFolder(fs, state, DIR, [dirty], [], LOCALE);

    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].id).toBe("dirty-id");
  });

  it("returns changed: false when disk matches docs", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    fs.seedTextFile(`${DIR}/${id}.md`, "stable");
    await seedMeta(fs, makeMeta(id));

    const existing = makeDoc(id, { content: "stable", filePath: `${DIR}/${id}.md` });
    const result = await reconcileFolder(fs, state, DIR, [existing], [], LOCALE);

    expect(result.changed).toBe(false);
  });

  it("preserves pinned, color, and customName from existing meta when rediscovering body", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    fs.seedTextFile(`${DIR}/${id}.md`, "body");
    await seedMeta(fs, makeMeta(id, {
      fileName: "Manual Title",
      pinned: true,
      color: "blue",
      customName: true,
    }));

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.changed).toBe(true);
    expect(result.docs).toHaveLength(1);
    const doc = result.docs[0];
    expect(doc.fileName).toBe("Manual Title");
    expect(doc.pinned).toBe(true);
    expect(doc.color).toBe("blue");
    expect(doc.customName).toBe(true);
  });

  it("flags a non-UUID filename stem as customName when seeding meta from disk", async () => {
    fs.seedTextFile(`${DIR}/legacy-note.md`, "# Legacy\n");

    const result = await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].customName).toBe(true);
    const meta = await readMeta(fs, DIR, "legacy-note");
    expect(meta?.customName).toBe(true);
  });

  it("skips bodyMissing recording entirely during a bulk-guard pass", async () => {
    for (let i = 0; i < 8; i += 1) {
      const id = `bbbbbbbb-bbbb-bbbb-bbbb-${i.toString().padStart(12, "0")}`;
      await seedMeta(fs, makeMeta(id));
      if (i >= 3) {
        fs.seedTextFile(`${DIR}/${id}.md`, `body ${i}`);
      }
    }

    await reconcileFolder(fs, state, DIR, [], [], LOCALE);
    // Bulk guard short-circuits BEFORE the recording loop, so neither
    // bodyless nor bodied ids should ever land in the observations map.
    expect(state.bodyMissing.size).toBe(0);
  });

  it("skips a .md file whose body read fails transiently and reports BODY_READ_FAILED", async () => {
    // Models a cloud-sync placeholder that lists in readDir but errors on
    // readTextFile. A previous bug returned "" on this path, which would
    // have created a doc with empty content and written a meta sidecar
    // derived from the empty body — overwriting the real file on next save.
    const id = "88888888-8888-8888-8888-888888888888";
    const filePath = `${DIR}/${id}.md`;
    fs.seedTextFile(filePath, "real body the user does not want destroyed");

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: filePath,
      throwError: new Error("EBUSY: cloud-sync hydration in progress"),
    });

    const result = await reconcileFolder(faultFs, state, DIR, [], [], LOCALE);

    // No doc constructed from the unreadable file.
    expect(result.docs.find((d) => d.id === id)).toBeUndefined();
    // No meta sidecar created — next reconcile retries the read instead of
    // freezing wrong metadata to disk.
    expect(await faultFs.exists(metaPathFor(DIR, id))).toBe(false);
    // The real body must remain untouched on disk. Read past the fault by
    // going through the bare in-memory FS.
    expect(await fs.readTextFile(filePath)).toBe("real body the user does not want destroyed");

    // Degradation must be observable.
    const logger = await getMockedLogger();
    expect(logger).toHaveBeenCalledTimes(1);
    const reported = logger.mock.calls[0][0] as NotenError;
    expect(reported).toBeInstanceOf(NotenError);
    expect(reported.code).toBe("BODY_READ_FAILED");
    expect(reported.severity).toBe("recoverable");
    expect(reported.context).toMatchObject({ filePath });
  });

  it("fails closed when the meta directory is unreadable instead of rebuilding absent metadata", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    await seedMeta(fs, makeMeta(id, {
      fileName: "Remote Title",
      groupId: "remote-group",
      groupUpdatedAt: 5000,
      pinned: true,
    }));
    fs.seedTextFile(`${DIR}/${id}.md`, "body");

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readDir",
      path: `${DIR}/.meta`,
      throwError: new Error("EBUSY: meta directory locked"),
    });

    await expect(reconcileFolder(faultFs, state, DIR, [], [], LOCALE)).rejects.toThrow("meta directory locked");

    const meta = await readMeta(fs, DIR, id);
    expect(meta).not.toBeNull();
    expect(meta!.fileName).toBe("Remote Title");
    expect(meta!.groupId).toBe("remote-group");
    expect(meta!.pinned).toBe(true);
  });

  it("does not emit BODY_READ_FAILED on the canonical read-succeeds path", async () => {
    fs.seedTextFile(`${DIR}/canonical.md`, "ok");
    await reconcileFolder(fs, state, DIR, [], [], LOCALE);

    const logger = await getMockedLogger();
    expect(logger).not.toHaveBeenCalled();
  });

  it("logs META_WRITE_FAILED when meta sidecar write fails during ingest of an unmanaged .md", async () => {
    // Previously the meta-write catch silently swallowed. The in-memory doc
    // still appeared this session, but next reconcile re-entered the ingest
    // branch and rebuilt meta from fresh stat — silent sort-order /
    // groupUpdatedAt drift on every retry. Logging makes the drift visible.
    const id = "99999999-9999-9999-9999-999999999999";
    const mdPath = `${DIR}/${id}.md`;
    fs.seedTextFile(mdPath, "body content");

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "writeTextFile",
      path: metaPathFor(DIR, id),
      throwError: new Error("EPERM: meta dir read-only"),
    });
    // The tmp-then-rename path of atomicWriteText writes to the .tmp first.
    faultFs.injectFault({
      op: "writeTextFile",
      path: `${metaPathFor(DIR, id)}.tmp`,
      throwError: new Error("EPERM: meta dir read-only"),
    });

    const result = await reconcileFolder(faultFs, state, DIR, [], [], LOCALE);

    // Doc still appears in memory so the user can keep working.
    expect(result.docs.find((d) => d.id === id)).toBeDefined();
    // Meta sidecar absent on disk — next reconcile will retry.
    expect(await faultFs.exists(metaPathFor(DIR, id))).toBe(false);

    const logger = await getMockedLogger();
    // atomicWriteText emits its own META_WRITE_FAILED on tmp/rename failure
    // before our explicit log fires, so we may see multiple entries; the
    // reconcile-stage one is the contract we care about.
    const reconcileEntry = (logger.mock.calls as Array<[NotenError]>)
      .map((args) => args[0])
      .find((e) => e.message.includes("reconcileFolder"));
    expect(reconcileEntry).toBeInstanceOf(NotenError);
    expect(reconcileEntry!.code).toBe("META_WRITE_FAILED");
    expect(reconcileEntry!.severity).toBe("recoverable");
    expect(reconcileEntry!.context).toMatchObject({ noteId: id });
  });

  it("drops removed-doc ids from every group's noteIds", async () => {
    const liveId = "55555555-5555-5555-5555-555555555555";
    const goneId = "66666666-6666-6666-6666-666666666666";
    fs.seedTextFile(`${DIR}/${liveId}.md`, "live");
    await seedMeta(fs, makeMeta(liveId, { groupId: "g1" }));
    // goneId has neither a body nor a meta sidecar — it's purely a stale ref in the group.

    const docs: NoteDoc[] = [
      makeDoc(liveId, { filePath: `${DIR}/${liveId}.md` }),
      makeDoc(goneId, { filePath: `${DIR}/${goneId}.md` }),
    ];
    const groups: NoteGroup[] = [
      { id: "g1", name: "G1", collapsed: false, noteIds: [liveId, goneId], createdAt: 1000 },
    ];

    const result = await reconcileFolder(fs, state, DIR, docs, groups, LOCALE);

    expect(result.docs.find((d) => d.id === goneId)).toBeUndefined();
    expect(result.groups[0].noteIds).toEqual([liveId]);
    expect(result.groups[0].noteIds).not.toContain(goneId);
  });
});

describe("reconcileFolder — unwritten local membership moves", () => {
  const noteId = "77777777-7777-7777-7777-777777777777";

  function groups(): NoteGroup[] {
    return [
      { id: "g1", name: "G1", collapsed: false, noteIds: [], createdAt: 1000 },
      { id: "g2", name: "G2", collapsed: false, noteIds: [noteId], createdAt: 1000 },
    ];
  }

  // The membership rebuild reads sidecars, which lag an in-flight saveManifest
  // by a full disk pass. Without the pending map a reconcile fired by the very
  // event that revealed the stale sidecar re-confirms the pre-move group, so
  // the note visibly jumps back until the next periodic pass.
  it("keeps a pending move that the sidecar has not caught up with", async () => {
    fs.seedTextFile(`${DIR}/${noteId}.md`, "body");
    await seedMeta(fs, makeMeta(noteId, { groupId: "g1" }));
    const docs = [makeDoc(noteId, { filePath: `${DIR}/${noteId}.md` })];

    const result = await reconcileFolder(
      fs, state, DIR, docs, groups(), LOCALE,
      new Map([[noteId, { groupId: "g2", updatedAt: 5000 }]]),
    );

    expect(result.groups.find((g) => g.id === "g2")!.noteIds).toEqual([noteId]);
    expect(result.groups.find((g) => g.id === "g1")!.noteIds).toEqual([]);
    // The store already matches the intent, so the pass must not report a
    // change — the old code reverted the move and returned true on EVERY pass,
    // driving a commit + saveManifest each time.
    expect(result.groups).toEqual(groups());
    expect(result.changed).toBe(false);

    // Idempotent: a second pass over the first result changes nothing either.
    const again = await reconcileFolder(
      fs, state, DIR, result.docs, result.groups, LOCALE,
      new Map([[noteId, { groupId: "g2", updatedAt: 5000 }]]),
    );
    expect(again.groups.find((g) => g.id === "g2")!.noteIds).toEqual([noteId]);
  });

  // The persistence chain can write the sidecar and clear the intent while the
  // pass is still running. The sidecars this pass read are older than that
  // write, so consulting only the LIVE map would revert the move — and with no
  // store commit involved, performReconcile's drift guard would not catch it.
  it("keeps a move whose intent the persist chain consumed mid-pass", async () => {
    fs.seedTextFile(`${DIR}/${noteId}.md`, "body");
    await seedMeta(fs, makeMeta(noteId, { groupId: "g1" }));
    // An extra body the pass must read AFTER readAllMeta; its read stands in
    // for the persistence chain landing the sidecar and clearing the intent.
    const otherId = "88888888-8888-8888-8888-888888888888";
    fs.seedTextFile(`${DIR}/${otherId}.md`, "other");
    const docs = [makeDoc(noteId, { filePath: `${DIR}/${noteId}.md` })];

    const live = new Map([[noteId, { groupId: "g2", updatedAt: 5000 }]]);
    const racingFs = {
      ...fs,
      readTextFile: async (path: string) => {
        if (path.endsWith(`${otherId}.md`)) live.delete(noteId);
        return fs.readTextFile(path);
      },
    } as typeof fs;

    const result = await reconcileFolder(racingFs, state, DIR, docs, groups(), LOCALE, live);

    expect(live.has(noteId)).toBe(false);   // the intent really was consumed
    expect(result.groups.find((g) => g.id === "g2")!.noteIds).toEqual([noteId]);
    expect(result.groups.find((g) => g.id === "g1")!.noteIds).toEqual([]);
  });

  // Divergence worth pinning: applyMetaChange reloads groups from disk when the
  // target is unknown, while reconcile has no such escape and simply leaves the
  // note ungrouped until persist clears the intent.
  it("leaves the note ungrouped when the pending target is not in the groups array", async () => {
    fs.seedTextFile(`${DIR}/${noteId}.md`, "body");
    await seedMeta(fs, makeMeta(noteId, { groupId: "g1" }));
    const docs = [makeDoc(noteId, { filePath: `${DIR}/${noteId}.md` })];

    const result = await reconcileFolder(
      fs, state, DIR, docs, groups(), LOCALE,
      new Map([[noteId, { groupId: "g-unknown", updatedAt: 5000 }]]),
    );

    expect(result.groups.every((g) => g.noteIds.length === 0)).toBe(true);
  });

  it("a pending move to ungrouped is not overridden by the sidecar's group", async () => {
    fs.seedTextFile(`${DIR}/${noteId}.md`, "body");
    await seedMeta(fs, makeMeta(noteId, { groupId: "g1" }));
    const docs = [makeDoc(noteId, { filePath: `${DIR}/${noteId}.md` })];

    const result = await reconcileFolder(
      fs, state, DIR, docs, groups(), LOCALE,
      new Map([[noteId, { groupId: null, updatedAt: 5000 }]]),
    );

    expect(result.groups.every((g) => g.noteIds.length === 0)).toBe(true);
  });

  it("adopts the sidecar group when no intent is pending (default arg)", async () => {
    fs.seedTextFile(`${DIR}/${noteId}.md`, "body");
    await seedMeta(fs, makeMeta(noteId, { groupId: "g1" }));
    const docs = [makeDoc(noteId, { filePath: `${DIR}/${noteId}.md` })];

    const result = await reconcileFolder(fs, state, DIR, docs, groups(), LOCALE);

    expect(result.groups.find((g) => g.id === "g1")!.noteIds).toEqual([noteId]);
    expect(result.groups.find((g) => g.id === "g2")!.noteIds).toEqual([]);
  });

  it("places a pending move for a note whose sidecar has not been written yet", async () => {
    fs.seedTextFile(`${DIR}/${noteId}.md`, "body");
    const docs = [makeDoc(noteId, { filePath: `${DIR}/${noteId}.md` })];

    const result = await reconcileFolder(
      fs, state, DIR, docs, groups(), LOCALE,
      new Map([[noteId, { groupId: "g2", updatedAt: 5000 }]]),
    );

    expect(result.groups.find((g) => g.id === "g2")!.noteIds).toEqual([noteId]);
  });
});

describe("reconcileFolder — a body whose sidecar is unreadable is left alone", () => {
  // The other half of the readAllMeta quarantine. Once one unreadable sidecar
  // stops failing the whole aggregate, its note drops out of the metadata map
  // — and a body with no metadata is exactly what reconcile ingests as a fresh
  // unmanaged note. Doing that here would write a new sidecar over the real
  // one and surface the note with a derived title and no group: the same
  // "deleted note reappeared outside its group" failure, reached from the
  // opposite direction. Skip it and retry on the next pass.
  it("does not re-ingest the note or overwrite its sidecar", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await seedMeta(fs, makeMeta(id, { fileName: "Real Title", groupId: "g1" }));
    fs.seedTextFile(`${DIR}/${id}.md`, "# Real body\n");
    const sidecarBefore = await fs.readTextFile(`${DIR}/.meta/${id}.json`);

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: new RegExp(`${id}\\.json$`),
      throwError: new Error("EBUSY: cloud-sync hydration"),
    });

    // The note is not in the live docs — exactly the state after a load that
    // could not read its sidecar either.
    const result = await reconcileFolder(faultFs, state, DIR, [], [], LOCALE);

    expect(result.docs.map((d) => d.id)).not.toContain(id);
    // Its files must be untouched: the body still there, the sidecar still
    // holding the real title and group rather than a reconstructed default.
    expect(await fs.readTextFile(`${DIR}/${id}.md`)).toBe("# Real body\n");
    expect(await fs.readTextFile(`${DIR}/.meta/${id}.json`)).toBe(sidecarBefore);
  });

  it("picks the note up on the next pass once the sidecar reads again", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await seedMeta(fs, makeMeta(id, { fileName: "Real Title" }));
    fs.seedTextFile(`${DIR}/${id}.md`, "# Real body\n");

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: new RegExp(`${id}\\.json$`),
      times: 1,
      throwError: new Error("EBUSY: cloud-sync hydration"),
    });
    await reconcileFolder(faultFs, state, DIR, [], [], LOCALE);

    invalidateReadAllMetaCache(faultFs, DIR);
    const second = await reconcileFolder(faultFs, state, DIR, [], [], LOCALE);

    expect(second.docs.find((d) => d.id === id)?.fileName).toBe("Real Title");
  });
});
