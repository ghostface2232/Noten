import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "./fs.test-utils";
import { wrapWithFaults } from "./fs.fault.test-utils";
import {
  persistDecomposedState,
  loadDecomposedState,
  seedWriteSnapshots,
  readLocalCache,
  writeLocalCache,
  createPersistState,
  type PersistState,
  type UiStateInput,
  type LocalCache,
} from "./decomposedState";
import { metaPathFor, readMeta } from "./metadataIO";
import { readGroupsFile } from "./groupsIO";
import type { NoteDoc, NoteGroup, TrashedNote } from "./noteTypes";

const DIR = "/notes";
const CACHE_PATH = "/cache/manifest-cache.json";
const MACHINE = "test-machine";
const EMPTY_UI: UiStateInput = {
  activeNoteId: null,
  lastOpenedNoteId: null,
  groupCollapsed: {},
};

let fs: InMemoryFileSystem;
let state: PersistState;

beforeEach(() => {
  fs = createInMemoryFileSystem();
  state = createPersistState();
  fs.seedDir(DIR);
  fs.seedDir("/cache");
});

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

function makeGroup(id: string, overrides: Partial<NoteGroup> = {}): NoteGroup {
  return {
    id,
    name: id,
    noteIds: [],
    collapsed: false,
    createdAt: 1000,
    orderKey: "m",
    orderUpdatedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function persistOpts(overrides: Partial<Parameters<typeof persistDecomposedState>[6]> = {}) {
  return {
    trashedNotes: [] as TrashedNote[],
    machineId: MACHINE,
    cachePath: CACHE_PATH,
    imageAssetMigrationCompletedAt: null,
    ...overrides,
  };
}

describe("persist/loadDecomposedState round-trip", () => {
  it("preserves docs/groups/trashedNotes through persist + load", async () => {
    const doc = makeDoc("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
      fileName: "Alpha",
      pinned: true,
      color: "blue",
    });
    const trashed: TrashedNote = {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      fileName: "Bravo",
      originalFilePath: `${DIR}/bravo-original.md`,
      trashFilePath: `${DIR}/.trash/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.md`,
      trashedAt: 2000,
      groupId: null,
      createdAt: 500,
      updatedAt: 1500,
      pinned: false,
    };
    const group = makeGroup("g-1", { name: "Work", noteIds: [doc.id] });

    await persistDecomposedState(
      fs,
      DIR,
      state,
      [doc],
      doc.id,
      [group],
      persistOpts({ trashedNotes: [trashed] }),
    );

    const loaded = await loadDecomposedState(fs, DIR, {
      ...EMPTY_UI,
      activeNoteId: doc.id,
    });

    expect(loaded.docs).toHaveLength(1);
    expect(loaded.docs[0].id).toBe(doc.id);
    expect(loaded.docs[0].fileName).toBe("Alpha");
    expect(loaded.docs[0].pinned).toBe(true);
    expect(loaded.docs[0].color).toBe("blue");

    expect(loaded.trashedNotes).toHaveLength(1);
    expect(loaded.trashedNotes[0].id).toBe(trashed.id);
    expect(loaded.trashedNotes[0].trashedAt).toBe(2000);
    expect(loaded.trashedNotes[0].originalFilePath).toBe(trashed.originalFilePath);

    expect(loaded.groups).toHaveLength(1);
    expect(loaded.groups[0].id).toBe("g-1");
    expect(loaded.groups[0].noteIds).toEqual([doc.id]);

    expect(loaded.activeNoteId).toBe(doc.id);
  });
});

describe("persistDecomposedState diff cache", () => {
  it("skips the meta sidecar write when the snapshot is unchanged", async () => {
    const doc = makeDoc("cccccccc-cccc-cccc-cccc-cccccccccccc", { fileName: "Stable" });

    await persistDecomposedState(fs, DIR, state, [doc], null, [], persistOpts());
    const path = metaPathFor(DIR, doc.id);
    const firstMtime = (await fs.stat(path)).mtime!.getTime();

    // Force enough clock drift that any mtime touch would be observable.
    await new Promise((r) => setTimeout(r, 10));

    await persistDecomposedState(fs, DIR, state, [doc], null, [], persistOpts());
    const secondMtime = (await fs.stat(path)).mtime!.getTime();

    expect(secondMtime).toBe(firstMtime);
  });
});

describe("group tombstone propagation", () => {
  it("writes a tombstone entry and clears the pending mark after success", async () => {
    const group = makeGroup("g-doomed", { name: "Doomed" });
    await persistDecomposedState(fs, DIR, state, [], null, [group], persistOpts());

    // User deletes the group; pendingTombstones records the intent.
    state.pendingTombstones.add("g-doomed");

    // Subsequent persist no longer includes the group in `groups`.
    await persistDecomposedState(fs, DIR, state, [], null, [], persistOpts());

    const file = await readGroupsFile(fs, DIR);
    const entry = file.groups["g-doomed"];
    expect(entry).toBeDefined();
    expect(entry.deletedAt).not.toBeNull();
    expect(state.pendingTombstones.has("g-doomed")).toBe(false);
  });

  it("drops a pending tombstone when the group is alive in the current snapshot", async () => {
    // Simulates: a prior delete left an entry in pendingTombstones (e.g.,
    // because the write failed or was raced by reloadGroupsFromDisk), and
    // the group has since been resurrected in the local snapshot.
    const group = makeGroup("g-resurrected", { name: "Back" });
    await persistDecomposedState(fs, DIR, state, [], null, [group], persistOpts());

    state.pendingTombstones.add("g-resurrected");

    // Persist with the group still present must not write a tombstone, and
    // must clear the stale intent so it cannot fire later.
    await persistDecomposedState(fs, DIR, state, [], null, [group], persistOpts());

    const file = await readGroupsFile(fs, DIR);
    expect(file.groups["g-resurrected"].deletedAt).toBeNull();
    expect(state.pendingTombstones.has("g-resurrected")).toBe(false);
  });
});

describe("pendingGroupMembership consumption", () => {
  it("clears the pending entry once persist writes (or skips) the affected meta", async () => {
    const doc = makeDoc("dddddddd-dddd-dddd-dddd-dddddddddddd");
    // Pending group move recorded by an earlier UI action; persist must apply
    // and then clear it.
    state.pendingGroupMembership.set(doc.id, { groupId: "g-x", updatedAt: 5000 });

    await persistDecomposedState(fs, DIR, state, [doc], null, [], persistOpts());

    expect(state.pendingGroupMembership.has(doc.id)).toBe(false);
    const written = await readMeta(fs, DIR, doc.id);
    expect(written?.groupId).toBe("g-x");
    expect(written?.groupUpdatedAt).toBe(5000);
  });

  it("clears the pending entry even when the meta snapshot is unchanged (no disk write)", async () => {
    const doc = makeDoc("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    await persistDecomposedState(fs, DIR, state, [doc], null, [], persistOpts());

    // After first persist, snapshot is filled. Now stage a pending membership
    // write that matches what the snapshot already implies — persist takes the
    // skip path but still consumes the pending entry.
    state.pendingGroupMembership.set(doc.id, { groupId: null, updatedAt: Date.now() });

    await persistDecomposedState(fs, DIR, state, [doc], null, [], persistOpts());

    expect(state.pendingGroupMembership.has(doc.id)).toBe(false);
  });
});

describe("local cache", () => {
  it("writes the manifest cache and round-trips it back", async () => {
    const doc = makeDoc("ffffffff-ffff-ffff-ffff-ffffffffffff", { fileName: "Cached" });
    await persistDecomposedState(fs, DIR, state, [doc], doc.id, [], persistOpts());

    const cache = await readLocalCache(fs, CACHE_PATH, DIR);
    expect(cache).not.toBeNull();
    expect(cache!.notes).toHaveLength(1);
    expect(cache!.notes[0].id).toBe(doc.id);
    expect(cache!.notesDirectory).toBe(DIR);
  });

  it("returns null when the cached notesDirectory does not match the requested dir", async () => {
    const otherCache: LocalCache = {
      version: 2,
      notesDirectory: "/other-dir",
      notes: [],
    };
    await writeLocalCache(fs, CACHE_PATH, otherCache);

    const cache = await readLocalCache(fs, CACHE_PATH, DIR);
    expect(cache).toBeNull();
  });

  it("skips the cache write when cachePath is null", async () => {
    const doc = makeDoc("11111111-1111-1111-1111-111111111111");
    await persistDecomposedState(fs, DIR, state, [doc], null, [], persistOpts({ cachePath: null }));

    expect(await fs.exists(CACHE_PATH)).toBe(false);
  });
});

describe("writtenGroups commit semantics — only update on disk-write success", () => {
  it("does not poison state.writtenGroups when writeGroupsWithMerge throws", async () => {
    const faultFs = wrapWithFaults(fs);
    // Fault both the atomicWrite tmp path and its direct-overwrite fallback so
    // writeGroupsWithMerge actually rejects rather than degrading silently.
    faultFs.injectFault({
      op: "writeTextFile",
      path: /\.groups\.json/,
      throwError: new Error("EBUSY: groups write blocked"),
    });

    const group = makeGroup("g-doomed-write", { name: "First" });
    await persistDecomposedState(faultFs, DIR, state, [], null, [group], persistOpts());

    // The in-memory snapshot must remain empty so the next persist call
    // recognises the group as unwritten and retries. Without the fix, the
    // snapshot would be updated eagerly during iteration, making the next
    // call compare snap-equal-to-prev and skip the write forever.
    expect(state.writtenGroups.has("g-doomed-write")).toBe(false);
  });

  it("retries the write on the next call after a transient failure", async () => {
    const faultFs = wrapWithFaults(fs);
    // Two failures = one full atomicWrite attempt (tmp + direct fallback)
    // gets fully blocked. The next call lands cleanly.
    faultFs.injectFault({
      op: "writeTextFile",
      path: /\.groups\.json/,
      times: 2,
      throwError: new Error("EBUSY"),
    });

    const group = makeGroup("g-flaky", { name: "Flaky" });

    // First call: write fails, groupsPromise.catch swallows the error.
    await persistDecomposedState(faultFs, DIR, state, [], null, [group], persistOpts());
    expect(state.writtenGroups.has("g-flaky")).toBe(false);
    let file = await readGroupsFile(faultFs, DIR);
    expect(file.groups["g-flaky"]).toBeUndefined();

    // Second call: rule retired, write succeeds, snapshot committed.
    await persistDecomposedState(faultFs, DIR, state, [], null, [group], persistOpts());
    file = await readGroupsFile(faultFs, DIR);
    expect(file.groups["g-flaky"]).toBeDefined();
    expect(file.groups["g-flaky"].name).toBe("Flaky");
    expect(state.writtenGroups.has("g-flaky")).toBe(true);
  });

  it("does not poison the tombstone path when the write fails", async () => {
    // Seed a group on disk first (happy path).
    const group = makeGroup("g-tomb-flaky", { name: "Pre" });
    await persistDecomposedState(fs, DIR, state, [], null, [group], persistOpts());
    expect(state.writtenGroups.has("g-tomb-flaky")).toBe(true);

    // Stage the delete intent, then fault future writes.
    state.pendingTombstones.add("g-tomb-flaky");
    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "writeTextFile",
      path: /\.groups\.json/,
      throwError: new Error("EBUSY"),
    });

    await persistDecomposedState(faultFs, DIR, state, [], null, [], persistOpts());

    // Both the snapshot entry and the pending tombstone intent must survive so
    // the next attempt can re-apply the delete. Without the fix, writtenGroups
    // would have been emptied eagerly and the snapshot/disk drift would be
    // invisible to subsequent persist calls.
    expect(state.writtenGroups.has("g-tomb-flaky")).toBe(true);
    expect(state.pendingTombstones.has("g-tomb-flaky")).toBe(true);
  });

  it("does not merge new groups onto an empty file when existing groups are unreadable", async () => {
    const existing = makeGroup("g-existing", { name: "Existing" });
    await persistDecomposedState(fs, DIR, state, [], null, [existing], persistOpts());

    const faultFs = wrapWithFaults(fs);
    faultFs.injectFault({
      op: "readTextFile",
      path: `${DIR}/.groups.json`,
      times: 1,
      throwError: new Error("EBUSY: groups file locked"),
    });

    const incoming = makeGroup("g-incoming", { name: "Incoming" });
    await persistDecomposedState(faultFs, DIR, state, [], null, [incoming], persistOpts());

    const file = await readGroupsFile(fs, DIR);
    expect(file.groups["g-existing"]).toBeDefined();
    expect(file.groups["g-incoming"]).toBeUndefined();
    expect(state.writtenGroups.has("g-incoming")).toBe(false);
  });
});

describe("seedWriteSnapshots", () => {
  it("populates writtenMeta and writtenGroups from disk so subsequent diffs short-circuit", async () => {
    const doc = makeDoc("22222222-2222-2222-2222-222222222222", { fileName: "Seeded" });
    const group = makeGroup("g-seed", { noteIds: [doc.id] });
    await persistDecomposedState(fs, DIR, state, [doc], null, [group], persistOpts());

    // Fresh state simulates an app restart that has not yet seeded snapshots.
    const fresh = createPersistState();
    await seedWriteSnapshots(fs, DIR, fresh);

    expect(fresh.writtenMeta.has(doc.id)).toBe(true);
    expect(fresh.writtenGroups.has("g-seed")).toBe(true);
  });
});
