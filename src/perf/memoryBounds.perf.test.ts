import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  markOwnWrite,
  pruneOwnWrites,
  __resetOwnWriteTrackerForTests,
  __ownWriteTrackerSizesForTests,
} from "../hooks/ownWriteTracker";
import { createInMemoryFileSystem } from "../utils/fs.test-utils";
import { reconcileFolder, createReconcileState } from "../utils/reconcileFolder";
import { ensureMetaDir, writeMeta } from "../utils/metadataIO";
import { createLibraryStore } from "../utils/libraryStore";
import { makeLibraryDocs } from "./perf.test-utils";

// Memory-boundedness guards. Direct heap measurement is too noisy for CI, so
// "light on memory" is asserted the way it is actually engineered: every
// session-lifetime structure that grows with activity must either be pruned
// (own-write tracker), stay empty in the steady state (reconcile
// observations), or reuse existing objects instead of allocating
// (store snapshots). A leak in any of these grows without bound over an
// editing session, which is what turns a lightweight tray app into a heavy
// one after a day of use.

vi.mock("../utils/crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/machineId", () => ({
  getMachineId: vi.fn(async () => "perf-machine"),
  getMachineIdCached: vi.fn(() => "perf-machine"),
}));

/** Waits (bounded) until every in-flight crypto.subtle hash has landed. */
async function flushPendingHashes(expectedHashTimestamps: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (__ownWriteTrackerSizesForTests().hashTimestamps >= expectedHashTimestamps) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("own-write tracker stays bounded over a long session", () => {
  beforeEach(() => __resetOwnWriteTrackerForTests());
  afterEach(() => vi.useRealTimers());

  it("prunes 2k expired write markers and their hashes completely", async () => {
    // A day of autosaves across many notes: every marker must age out. Hashes
    // are registered under real timers because crypto.subtle resolution does
    // not advance under fake ones.
    for (let i = 0; i < 2_000; i++) {
      markOwnWrite(`C:\\notes\\note-${i}.md`, `content of note ${i}`);
    }
    await flushPendingHashes(2_000);
    const before = __ownWriteTrackerSizesForTests();
    expect(before.timestamps).toBe(2_000);
    expect(before.hashTimestamps).toBe(2_000);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000); // past TIME_GRACE_MS and HASH_TTL_MS
    pruneOwnWrites();

    expect(__ownWriteTrackerSizesForTests()).toEqual({
      timestamps: 0,
      hashes: 0,
      hashTimestamps: 0,
    });
  });

  it("re-marking the same path does not grow the marker maps", async () => {
    for (let i = 0; i < 500; i++) {
      markOwnWrite("C:\\notes\\same.md"); // timestamp-only marks: no hash set
    }
    const sizes = __ownWriteTrackerSizesForTests();
    expect(sizes.timestamps).toBe(1);
    expect(sizes.hashTimestamps).toBe(0);
  });
});

describe("reconcile observation state stays empty on a healthy folder", () => {
  it("does not accumulate body-missing observations across repeated passes", async () => {
    const fs = createInMemoryFileSystem();
    fs.seedDir("/notes");
    await ensureMetaDir(fs, "/notes");
    for (let i = 0; i < 200; i++) {
      const id = `note-${i.toString(36).padStart(4, "0")}`;
      fs.seedTextFile(`/notes/${id}.md`, `body ${i}`);
      await writeMeta(fs, "/notes", {
        version: 2, id, fileName: id, createdAt: 1_000, updatedAt: 1_000,
        groupId: null, trashedAt: null,
      }, "perf-machine");
    }

    // The watcher re-runs this on every folder event; per-id observations are
    // only for orphan-meta grace tracking and must not pile up when every
    // body is present.
    const state = createReconcileState();
    let docs: Awaited<ReturnType<typeof reconcileFolder>>["docs"] = [];
    for (let pass = 0; pass < 5; pass++) {
      ({ docs } = await reconcileFolder(fs, state, "/notes", docs, [], "en"));
    }
    expect(docs).toHaveLength(200);
    expect(state.bodyMissing.size).toBe(0);
  });
});

describe("store snapshots reuse owned objects instead of allocating", () => {
  it("keeps every unchanged entity reference-identical across 50 commits", () => {
    // The WeakSet ownership check in the copy layer is the store's allocation
    // bound: without it, 50 commits on a 2k-doc library clone 100k frozen
    // objects. Reference identity is the observable form of that bound.
    const store = createLibraryStore({ docs: makeLibraryDocs(2_000) });
    const initial = store.getSnapshot().docs;
    for (let i = 0; i < 50; i++) {
      store.commit((current) => {
        const next = [...current.docs];
        next[0] = { ...next[0], content: `edit ${i}`, updatedAt: next[0].updatedAt + 1 };
        return { docs: next };
      }, "local");
    }
    const final = store.getSnapshot().docs;
    for (let i = 1; i < initial.length; i++) {
      expect(final[i]).toBe(initial[i]);
    }
  });
});
