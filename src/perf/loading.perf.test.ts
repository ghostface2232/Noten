import { describe, it, expect, vi } from "vitest";
import { createInMemoryFileSystem, type InMemoryFileSystem } from "../utils/fs.test-utils";
import {
  reconcileFolder,
  createReconcileState,
  type ReconcileState,
} from "../utils/reconcileFolder";
import { ensureMetaDir, writeMeta, type NoteMeta } from "../utils/metadataIO";
import { sortSignature } from "../utils/docsSignature";
import { deriveTitle, stripMarkdownContent } from "../utils/noteText";
import { createLibraryStore } from "../utils/libraryStore";
import type { NoteDoc } from "../utils/noteTypes";
import {
  bestOfRuns,
  bestOfRunsAsync,
  makeLibraryDocs,
  makeMarkdownBody,
} from "./perf.test-utils";

// Startup / hydration / watcher-pass performance guards. Everything here runs
// on the cold-load path (sidebar appears) or on every watcher event, so a
// complexity regression turns directly into a slow app start or a laggy
// sidebar on large libraries. Budgets are ~10x a dev-machine measurement —
// see perf.test-utils.ts.

vi.mock("../utils/crashLog", () => ({
  logNotenError: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/machineId", () => ({
  getMachineId: vi.fn(async () => "perf-machine"),
  getMachineIdCached: vi.fn(() => "perf-machine"),
}));

// useNotesLoader pulls in Tauri-facing modules at import time; stub the
// runtime surface so the pure exports (sortNotes, mergeHydratedLibrary) load.
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

// vi.mock calls hoist above static imports, so the stubs above are in place
// before useNotesLoader's module graph loads.
import {
  sortNotes,
  mergeHydratedLibrary,
  type HydrationEpochState,
} from "../hooks/useNotesLoader";

const LIBRARY_SIZE = 5_000;

describe("sidebar sort (runs on every docs commit)", () => {
  const docs = makeLibraryDocs(LIBRARY_SIZE);

  it("sorts a 5k-doc library in every order within budget", () => {
    const orders = [
      "updated-desc", "updated-asc", "created-desc", "created-asc", "title-asc", "title-desc",
    ] as const;
    const elapsed = bestOfRuns(() => {
      for (const order of orders) sortNotes(docs, order, "en");
    });
    // ~20ms measured for all six orders (title orders dominate via
    // localeCompare); a per-compare allocation or an accidental O(n²) blows
    // straight through this.
    expect(elapsed).toBeLessThan(400);
  });

  it("computes the sort signature of a 5k-doc library within budget", () => {
    // sortSignature exists precisely so the per-commit change check allocates
    // nothing per document; 50 calls approximate a burst of autosave commits.
    const elapsed = bestOfRuns(() => {
      for (let i = 0; i < 50; i++) sortSignature(docs, "updated-desc", "en");
    });
    expect(elapsed).toBeLessThan(800);
  });
});

describe("hydration rebase (mergeHydratedLibrary)", () => {
  it("rebases a 5k-doc disk read onto a 5k-doc live store within budget", () => {
    const hydrated = makeLibraryDocs(LIBRARY_SIZE);
    // The live store holds the manifest-cache projection of the same ids plus
    // a peer-created tail — the shape a real load races against.
    const projection = hydrated.map((doc) => ({ ...doc, content: "" }));
    const peerCreated = makeLibraryDocs(100).map((doc) => ({ ...doc, id: `peer-${doc.id}` }));
    const store = createLibraryStore({ docs: [...projection, ...peerCreated] });
    const epoch: HydrationEpochState = {
      seededIds: new Set(projection.map((d) => d.id)),
      projectionIds: new Set(projection.map((d) => d.id)),
      deletedIds: new Set(),
      seededGroupIds: new Set(),
      touchedGroupIds: new Set(),
      removedGroupIds: new Set(),
      seededTrashIds: new Set(),
      trashRemovals: new Map(),
    };

    let docsOut = 0;
    const elapsed = bestOfRuns(() => {
      const patch = mergeHydratedLibrary(
        store.getSnapshot(),
        { docs: hydrated, groups: [], activeNoteId: null, trashedNotes: [] },
        epoch,
        "updated-desc",
        "en",
      );
      docsOut = patch.docs?.length ?? 0;
    });

    expect(docsOut).toBe(LIBRARY_SIZE + peerCreated.length);
    // ~10ms measured. The maps make this O(n); a nested-scan rewrite would be
    // 5k × 5k comparisons and multi-second.
    expect(elapsed).toBeLessThan(300);
  });
});

describe("reconcileFolder over a large notes directory", () => {
  const NOTE_COUNT = 1_000;

  function makeMeta(id: string, overrides: Partial<NoteMeta> = {}): NoteMeta {
    return {
      version: 2,
      id,
      fileName: id,
      createdAt: 1_000,
      updatedAt: 1_000,
      groupId: null,
      trashedAt: null,
      ...overrides,
    };
  }

  async function seedFolder(fs: InMemoryFileSystem): Promise<void> {
    fs.seedDir("/notes");
    await ensureMetaDir(fs, "/notes");
    for (let i = 0; i < NOTE_COUNT; i++) {
      const id = `note-${i.toString(36).padStart(6, "0")}`;
      fs.seedTextFile(`/notes/${id}.md`, `# Note ${i}\n\nbody of note ${i}\n`);
      await writeMeta(fs, "/notes", makeMeta(id), "perf-machine");
    }
  }

  it("adopts 1k on-disk notes into an empty library within budget", async () => {
    let fs!: InMemoryFileSystem;
    let state!: ReconcileState;
    let adopted: NoteDoc[] = [];
    const elapsed = await bestOfRunsAsync(
      async () => {
        const result = await reconcileFolder(fs, state, "/notes", [], [], "en");
        adopted = result.docs;
      },
      3,
      async () => {
        // Fresh FS per run: readAllMeta caches by FileSystem identity, and the
        // cold pass is the one that gates first paint.
        fs = createInMemoryFileSystem();
        state = createReconcileState();
        await seedFolder(fs);
      },
    );

    expect(adopted).toHaveLength(NOTE_COUNT);
    // ~120ms measured against the in-memory FS. This bounds the CPU side of
    // the pass (meta parsing, id validation, doc assembly) — real disk latency
    // is on top and is not what this guard is about.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("re-runs a steady-state watcher pass over 1k known notes within budget", async () => {
    const fs = createInMemoryFileSystem();
    const state = createReconcileState();
    await seedFolder(fs);
    const { docs } = await reconcileFolder(fs, state, "/notes", [], [], "en");
    expect(docs).toHaveLength(NOTE_COUNT);

    // Watcher events repeat this pass with the library already in memory; it
    // must stay cheap because a busy cloud-sync folder fires it constantly.
    const elapsed = await bestOfRunsAsync(async () => {
      await reconcileFolder(fs, state, "/notes", docs, [], "en");
    });
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("per-note text derivation on load", () => {
  it("derives a title from a 1MB body within budget", () => {
    // deriveTitle must stay early-exit: it stops at the first contentful line
    // regardless of body size. Both placements guard that.
    const titleFirst = `First line title\n${makeMarkdownBody(1_000_000)}`;
    const titleBuried = `${"![](image.png)\n".repeat(10_000)}Buried title\n`;
    const elapsed = bestOfRuns(() => {
      expect(deriveTitle(titleFirst)).toBe("First line title");
      expect(deriveTitle(titleBuried)).toBe("Buried title");
    });
    expect(elapsed).toBeLessThan(200);
  });

  it("strips a 1MB body to preview text within budget", () => {
    const body = makeMarkdownBody(1_000_000);
    let preview = "";
    const elapsed = bestOfRuns(() => {
      preview = stripMarkdownContent(body);
    });
    expect(preview.length).toBeGreaterThan(0);
    // ~25ms measured; the line-oriented pass is linear, and a backtracking
    // regex regression on this input is what would break the budget.
    expect(elapsed).toBeLessThan(800);
  });
});
