// End-to-end smoke tests for the persistence + sync core.
//
// Two windows, one shared folder, real modules throughout (see
// windowHarness.test-utils.ts). Each test is a short session a user could actually
// perform, and the assertion is always the same property: nothing a window
// committed is silently lost, and the store converges with disk.
//
// Scope: the Tauri-bound layers (useNotesLoader's metadata mutation clocks,
// useWindowSync's event channel, React state projection) cannot be imported
// outside Tauri and are not modelled here. So these tests assert membership,
// group metadata, and note existence — not title/pin/colour LWW.
import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "../utils/fs.test-utils";
import { readGroupsFile } from "../utils/groupsIO";
import { readAllMeta } from "../utils/metadataIO";
import { createSmokeWindow, makeDoc, makeGroup, DIR, type SmokeWindow } from "./windowHarness.test-utils";

const NOTE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let fs: InMemoryFileSystem;
let winA: SmokeWindow;
let winB: SmokeWindow;

beforeEach(() => {
  fs = createInMemoryFileSystem();
  fs.seedDir(DIR);
  winA = createSmokeWindow(fs, "window-a");
  winB = createSmokeWindow(fs, "window-b");
});

/** Seed a folder with one note in one group, then load both windows from it. */
async function seedSharedLibrary(): Promise<void> {
  fs.seedTextFile(`${DIR}/${NOTE_A}.md`, `# ${NOTE_A}\n`);
  winA.commitDocs(() => [makeDoc(NOTE_A)]);
  winA.commitGroups(() => [makeGroup("g1", { noteIds: [NOTE_A] })]);
  await winA.persist();
  await winA.loadDiscardingLocal();
  await winB.loadDiscardingLocal();
}

describe("smoke: a single window's session round-trips through disk", () => {
  it("creates, persists, and reloads notes and groups without drift", async () => {
    await seedSharedLibrary();

    expect(winA.docs().map((d) => d.id)).toEqual([NOTE_A]);
    expect(winA.groups().map((g) => g.id)).toEqual(["g1"]);
    expect(winA.membership()).toEqual({ g1: [NOTE_A] });

    // A second persist of unchanged state must not rewrite anything, or every
    // idle pass would churn sidecars a cloud client then re-syncs. Content
    // equality alone cannot see that churn — a rewrite with identical bytes
    // passes it — so the mutation log must stay quiet too.
    const readable = (snap: Map<string, Uint8Array | "<dir>">) => [...snap]
      .map(([k, v]) => [k, typeof v === "string" ? v : new TextDecoder().decode(v)])
      .sort();
    const before = readable(fs.snapshot());
    const mutationsBefore = fs.mutationLog.length;
    await winA.persist();
    expect(readable(fs.snapshot())).toEqual(before);
    expect(fs.mutationLog.slice(mutationsBefore)).toEqual([]);
  });

  it("a reconcile over an unchanged folder is a no-op", async () => {
    await seedSharedLibrary();
    const revisionBefore = winA.store.getSnapshot().revision;

    const first = await winA.reconcile();
    const second = await winA.reconcile();

    // changed:false is the point — committed:false alone would also be true of
    // a pass that drifted, which is the opposite situation.
    expect(first).toEqual({ changed: false, committed: false });
    expect(second).toEqual({ changed: false, committed: false });
    expect(winA.store.getSnapshot().revision).toBe(revisionBefore);
    expect(winA.membership()).toEqual({ g1: [NOTE_A] });
  });

  it("adopts a note another window added to the folder", async () => {
    await seedSharedLibrary();
    // window-b creates a note and writes it out.
    fs.seedTextFile(`${DIR}/${NOTE_B}.md`, `# ${NOTE_B}\n`);
    winB.commitDocs((prev) => [...prev, makeDoc(NOTE_B)]);
    await winB.persist();
    const peerSidecarPath = `${DIR}/.meta/${NOTE_B}.json`;
    const peerSidecarBefore = await fs.readTextFile(peerSidecarPath);

    const { committed } = await winA.reconcile();

    expect(committed).toBe(true);
    expect(winA.docs().map((d) => d.id).sort()).toEqual([NOTE_A, NOTE_B].sort());
    // Adoption must come from the peer's sidecar, not the unmanaged-file ingest
    // branch: ingest would re-derive timestamps from file stat (≈ now, not the
    // 1000 the peer stamped) and rewrite the sidecar the peer just wrote —
    // exactly the peer-erasure class this suite exists to catch.
    const adopted = winA.docs().find((d) => d.id === NOTE_B)!;
    expect(adopted.createdAt).toBe(1000);
    expect(adopted.updatedAt).toBe(1000);
    expect(await fs.readTextFile(peerSidecarPath)).toBe(peerSidecarBefore);
  });
});

describe("smoke: concurrent windows do not erase each other", () => {
  // The 7b4c50e class: window-a's group reload reads the folder for seconds
  // while a local rename commits. An absolute commit of the read result would
  // revert the rename in-store, and — because the write snapshot was reset to
  // disk state first — persistence would then find nothing to write.
  it("keeps a local rename that lands during a slow group reload", async () => {
    await seedSharedLibrary();

    const reload = winA.reloadGroups();
    winA.commitGroups((prev) => prev.map((g) => (
      g.id === "g1" ? { ...g, name: "Renamed locally", updatedAt: 9000 } : g
    )));
    await reload;

    expect(winA.groups()[0].name).toBe("Renamed locally");

    await winA.persist();
    const onDisk = await readGroupsFile(fs, DIR);
    expect(onDisk.groups.g1.name).toBe("Renamed locally");
  });

  it("keeps a group created during a slow reload, and still adopts a peer rename", async () => {
    await seedSharedLibrary();
    // window-b renames g1 with a newer clock and writes it out.
    winB.commitGroups((prev) => prev.map((g) => (
      g.id === "g1" ? { ...g, name: "Renamed by peer", updatedAt: 8000 } : g
    )));
    await winB.persist();

    const reload = winA.reloadGroups();
    winA.commitGroups((prev) => [...prev, makeGroup("g-local", { orderKey: "z", createdAt: 4000 })]);
    await reload;

    expect(winA.groups().map((g) => g.id).sort()).toEqual(["g-local", "g1"]);
    expect(winA.groups().find((g) => g.id === "g1")!.name).toBe("Renamed by peer");
  });

  it("does not resurrect a group deleted while its tombstone is unwritten", async () => {
    await seedSharedLibrary();

    // A reload is already reading the folder — .groups.json still shows g1
    // alive — when the local delete lands: the group leaves the store and the
    // tombstone is only marked, not yet written. The merge reads pending
    // tombstones after its awaits, so it must see this one and not resurrect
    // g1 from the stale file.
    const reload = winA.reloadGroups();
    winA.markGroupDeleted("g1", 1);
    winA.commitGroups((prev) => prev.filter((g) => g.id !== "g1"));
    await reload;
    expect(winA.groups()).toEqual([]);

    // And the delete survives all the way to disk.
    await winA.persist();
    const onDisk = await readGroupsFile(fs, DIR);
    expect(onDisk.groups.g1.deletedAt).toEqual(expect.any(Number));
  });

  // The fec0574 class: a peer commit that lands mid-reconcile must not be
  // erased by the pass's absolute commit; the retry then merges both.
  it("abandons a reconcile whose result went stale, and converges on retry", async () => {
    await seedSharedLibrary();
    fs.seedTextFile(`${DIR}/${NOTE_B}.md`, `# ${NOTE_B}\n`);

    // A peer always writes the body before broadcasting, so the note exists on
    // disk by the time its delta lands here.
    const peerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    fs.seedTextFile(`${DIR}/${peerId}.md`, `# ${peerId}\n`);
    winB.commitDocs((prev) => [...prev, makeDoc(peerId)]);
    await winB.persist();

    const pass = winA.reconcile();
    // The peer's delta arrives in the store while the folder read is in flight.
    winA.store.commit(
      { docs: [...winA.store.getSnapshot().docs, makeDoc(peerId)] },
      "remote",
    );
    const result = await pass;

    // The pass DID have a result to commit; the drift guard is what stopped it.
    expect(result).toEqual({ changed: true, committed: false });
    expect(winA.docs().map((d) => d.id)).toEqual([NOTE_A, peerId]);

    const retry = await winA.reconcile();
    expect(retry.committed).toBe(true);
    // The retry sees both the peer's note and the folder's new body.
    expect(winA.docs().map((d) => d.id).sort()).toEqual([NOTE_A, NOTE_B, peerId].sort());
  });
});

describe("smoke: deletions survive the passes that could undo them", () => {
  it("a trashed note leaves the live set, reaches disk, and comes back on restore", async () => {
    await seedSharedLibrary();
    const doc = winA.docs()[0];

    winA.commitTrash(() => [{
      id: doc.id,
      fileName: doc.fileName,
      originalFilePath: doc.filePath,
      trashFilePath: `${DIR}.trash/${doc.id}.md`,
      trashedAt: 5000,
      groupId: "g1",
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }]);
    winA.commitDocs((prev) => prev.filter((d) => d.id !== doc.id));
    winA.commitGroups((prev) => prev.map((g) => ({ ...g, noteIds: [] })));
    await winA.persist();

    const { byId: metaById } = await readAllMeta(fs, DIR);
    expect(metaById.get(doc.id)!.trashedAt).toBe(5000);

    // A reconcile must not resurrect it into the live set from a stale view.
    await winA.reconcile();
    expect(winA.docs()).toEqual([]);

    // Restore: the live meta wins again and the note returns.
    winA.commitTrash(() => []);
    winA.commitDocs(() => [makeDoc(doc.id)]);
    await winA.persist();

    const winC = createSmokeWindow(fs, "window-c");
    await winC.loadDiscardingLocal();
    expect(winC.docs().map((d) => d.id)).toEqual([doc.id]);
  });

  // performReconcile's own comment names this: committing a stale full-folder
  // view would RESURRECT a note the peer deleted mid-pass.
  it("does not resurrect a note the peer deleted during a reconcile pass", async () => {
    await seedSharedLibrary();
    fs.seedTextFile(`${DIR}/${NOTE_B}.md`, `# ${NOTE_B}\n`);
    winB.commitDocs((prev) => [...prev, makeDoc(NOTE_B)]);
    await winB.persist();
    await winA.reconcile();
    expect(winA.docs().map((d) => d.id).sort()).toEqual([NOTE_A, NOTE_B].sort());

    // A third body appears, so the pass has something to commit — otherwise
    // it would return unchanged and the resurrect path would never be taken.
    const noteC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    fs.seedTextFile(`${DIR}/${noteC}.md`, `# ${noteC}\n`);

    // The peer's delete lands in our store while that pass is in flight, so
    // its result — computed from a baseline that still had NOTE_B — is now a
    // note-resurrecting commit.
    const pass = winA.reconcile();
    winA.store.commit(
      { docs: [...winA.store.getSnapshot().docs].filter((d) => d.id !== NOTE_B) },
      "remote",
    );
    const result = await pass;

    expect(result).toEqual({ changed: true, committed: false });
    expect(winA.docs().map((d) => d.id)).toEqual([NOTE_A]);
  });
});

describe("smoke: unwritten local moves outrank the sidecars that lag them", () => {
  // The 08f5712 class: window-b rewrites the note's sidecar for an unrelated
  // reason (a rename) and carries the note's OLD groupId with it, because its
  // own persist reads groupId from disk. Neither reconcile nor reload may take
  // that as the truth while our own move is still queued.
  async function seedTwoGroupsAndPendingMove(): Promise<void> {
    fs.seedTextFile(`${DIR}/${NOTE_A}.md`, `# ${NOTE_A}\n`);
    winA.commitDocs(() => [makeDoc(NOTE_A)]);
    winA.commitGroups(() => [
      makeGroup("g1", { noteIds: [NOTE_A], orderKey: "a" }),
      makeGroup("g2", { orderKey: "b" }),
    ]);
    await winA.persist();
    await winA.loadDiscardingLocal();
    await winB.loadDiscardingLocal();

    // Local move g1 → g2, sidecar write not yet done. The `at` here is far
    // OLDER than the disk clock the seed persist stamped (resolveGroupSnapshot
    // uses Date.now() when nothing is pending), so these tests exercise the
    // hard case: pending wins on rule, not on recency.
    winA.markMembership(NOTE_A, "g2", 9000);
    winA.commitGroups((prev) => prev.map((g) => {
      if (g.id === "g1") return { ...g, noteIds: [] };
      if (g.id === "g2") return { ...g, noteIds: [NOTE_A] };
      return g;
    }));

    // The peer renames the note; its sidecar write carries groupId "g1".
    winB.commitDocs((prev) => prev.map((d) => (
      d.id === NOTE_A ? { ...d, fileName: "Renamed by peer", updatedAt: 7000 } : d
    )));
    await winB.persist();
  }

  it("a reconcile triggered by the peer's sidecar keeps the pending move", async () => {
    await seedTwoGroupsAndPendingMove();

    await winA.reconcile();

    expect(winA.membership()).toEqual({ g1: [], g2: [NOTE_A] });
  });

  it("a group reload triggered by the same event also keeps it", async () => {
    await seedTwoGroupsAndPendingMove();

    await winA.reloadGroups();

    expect(winA.membership()).toEqual({ g1: [], g2: [NOTE_A] });
  });

  // The pass reads sidecars at the start but resolves membership at the end,
  // so an intent recorded DURING it must still be honoured — this is why the
  // live map is passed rather than a copy taken up front.
  it("honours a move recorded while the reconcile pass is already running", async () => {
    fs.seedTextFile(`${DIR}/${NOTE_A}.md`, `# ${NOTE_A}\n`);
    winA.commitDocs(() => [makeDoc(NOTE_A)]);
    winA.commitGroups(() => [
      makeGroup("g1", { noteIds: [NOTE_A], orderKey: "a" }),
      makeGroup("g2", { orderKey: "b" }),
    ]);
    await winA.persist();
    await winA.loadDiscardingLocal();
    // A new body appears on disk so the pass has a change to commit; without
    // one it returns changed:false and never resolves membership at all.
    fs.seedTextFile(`${DIR}/${NOTE_B}.md`, `# ${NOTE_B}\n`);

    const pass = winA.reconcile();
    // Only the INTENT lands mid-pass. Its store-side groups commit is
    // deliberately absent: any store commit would trip the token guard and
    // abandon the pass (the abandon-and-retry test above owns that path), and
    // with the store already showing the move, the final assertion would be
    // satisfied whether or not the pass ever consulted the intent.
    winA.markMembership(NOTE_A, "g2", 9000);
    const result = await pass;

    // The pass itself committed, and its result honours the mid-pass intent.
    // (The intent lands before the pass's sidecar read, so reconcileFolder's
    // own at-read copy carries it too — what this pins is the CALLER handing
    // over the live map rather than a copy taken when the pass started. An
    // intent recorded after the sidecar read is honoured via the live map
    // alone and is not covered here.)
    expect(result).toEqual({ changed: true, committed: true });
    expect(winA.docs().map((d) => d.id).sort()).toEqual([NOTE_A, NOTE_B].sort());
    expect(winA.membership()).toEqual({ g1: [], g2: [NOTE_A] });
  });

  it("pending wins even when the peer moved the note somewhere else", async () => {
    fs.seedTextFile(`${DIR}/${NOTE_A}.md`, `# ${NOTE_A}\n`);
    winA.commitDocs(() => [makeDoc(NOTE_A)]);
    winA.commitGroups(() => [
      makeGroup("g1", { noteIds: [NOTE_A], orderKey: "a" }),
      makeGroup("g2", { orderKey: "b" }),
      makeGroup("g3", { orderKey: "c" }),
    ]);
    await winA.persist();
    await winA.loadDiscardingLocal();
    await winB.loadDiscardingLocal();

    // Genuine contention: we move it to g2, the peer moves it to g3 and wins
    // the disk. Our unwritten intent still decides what the store shows until
    // persistence resolves it the same way.
    winA.markMembership(NOTE_A, "g2", 9000);
    winA.commitGroups((prev) => prev.map((g) => (
      { ...g, noteIds: g.id === "g2" ? [NOTE_A] : g.noteIds.filter((id) => id !== NOTE_A) }
    )));
    winB.markMembership(NOTE_A, "g3", 9500);
    winB.commitGroups((prev) => prev.map((g) => (
      { ...g, noteIds: g.id === "g3" ? [NOTE_A] : g.noteIds.filter((id) => id !== NOTE_A) }
    )));
    await winB.persist();

    await winA.reconcile();
    await winA.reloadGroups();

    expect(winA.membership()).toEqual({ g1: [], g2: [NOTE_A], g3: [] });
  });

  it("the move reaches disk, and both windows converge on it", async () => {
    await seedTwoGroupsAndPendingMove();
    await winA.reconcile();
    await winA.reloadGroups();

    await winA.persist();

    const { byId: metaById } = await readAllMeta(fs, DIR);
    expect(metaById.get(NOTE_A)!.groupId).toBe("g2");
    // Only membership is asserted here. Title/pin/colour LWW is decided by the
    // metadata mutation clocks in useNotesLoader, which is Tauri-bound and
    // therefore outside this harness — see the note at the top of the file.

    // A window opening the folder now sees the move. (winB is deliberately not
    // reused here: a running peer learns of the move through the sync event
    // channel, which is Tauri-bound and outside this harness — winC models the
    // one disk-only path a real window has, opening the folder fresh.)
    const winC = createSmokeWindow(fs, "window-c");
    await winC.loadDiscardingLocal();
    expect(winC.membership()).toEqual({ g1: [], g2: [NOTE_A] });
  });
});
