import { describe, it, expect } from "vitest";
import { markdownEqual, normalizeMarkdown } from "../utils/markdownEqual";
import { diffGroupsDelta } from "../utils/groupsDelta";
import { createLibraryStore } from "../utils/libraryStore";
import { bestOfRuns, makeGroups, makeLibraryDocs, makeMarkdownBody } from "./perf.test-utils";

// Autosave / commit-path performance guards. These run on every keystroke
// burst (store commit), every save comparison, and every group persist, so
// they must stay cheap on large libraries and multi-megabyte notes. Budgets
// are ~10x a dev-machine measurement — see perf.test-utils.ts.

describe("body comparison on the save/watcher path", () => {
  it("compares two 4MB bodies differing only by line endings within budget", () => {
    // Worst case for markdownEqual: not reference-equal and not byte-equal, so
    // both bodies are fully normalized (CRLF → LF) before comparing.
    const lf = makeMarkdownBody(4_000_000);
    const crlf = lf.replace(/\n/g, "\r\n");
    let equal = false;
    const elapsed = bestOfRuns(() => {
      equal = markdownEqual(lf, crlf);
    });
    expect(equal).toBe(true);
    expect(elapsed).toBeLessThan(1_500);
  });

  it("normalizes a body ending in a 100k-newline run within budget", () => {
    // The `\n+$` trailing-blank-line strip must not backtrack: a pathological
    // trailing run is exactly what an editor holding the End key produces.
    const body = `${makeMarkdownBody(100_000)}${"\n".repeat(100_000)}`;
    let out = "";
    const elapsed = bestOfRuns(() => {
      out = normalizeMarkdown(body);
    });
    expect(out.endsWith("\n")).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("library store commit throughput", () => {
  it("applies 200 single-doc commits against a 5k-doc library within budget", () => {
    const docs = makeLibraryDocs(5_000);
    const store = createLibraryStore({ docs });

    // Each autosave commit maps the full docs array through the store's copy
    // layer. The WeakSet ownership check makes an unchanged doc a no-op; this
    // bounds a regression that re-clones (and re-freezes) all 5k docs per
    // commit, which turns fast typing into visible jank on big libraries.
    const elapsed = bestOfRuns(() => {
      for (let i = 0; i < 200; i++) {
        store.commit((current) => {
          const target = current.docs[i % current.docs.length];
          const next = current.docs.map((doc) =>
            doc === target
              ? { ...doc, content: `edit ${i}`, updatedAt: doc.updatedAt + 1, isDirty: true }
              : doc,
          );
          return { docs: next };
        }, "local");
      }
    });
    expect(elapsed).toBeLessThan(2_000);
  });

  it("keeps unchanged docs identical by reference across commits", () => {
    // Allocation guard for the same path: the copy layer must hand back the
    // exact frozen objects it already owns, not fresh clones, or every commit
    // allocates a library's worth of garbage.
    const store = createLibraryStore({ docs: makeLibraryDocs(1_000) });
    const before = store.getSnapshot().docs;
    store.commit((current) => {
      const next = [...current.docs];
      next[0] = { ...next[0], content: "changed", isDirty: true };
      return { docs: next };
    }, "local");
    const after = store.getSnapshot().docs;

    expect(after[0]).not.toBe(before[0]);
    for (let i = 1; i < before.length; i++) {
      expect(after[i]).toBe(before[i]);
    }
  });
});

describe("group delta computation on persist", () => {
  it("diffs 1k groups (50k memberships) with a small change set within budget", () => {
    const prev = makeGroups(1_000, 50);
    const next = prev.map((group, i) =>
      i % 100 === 0
        ? { ...group, name: `${group.name} renamed`, updatedAt: (group.updatedAt ?? 0) + 1 }
        : group,
    );
    // Move one note between groups so the membership containment diff runs.
    next[0] = { ...next[0], noteIds: [...next[0].noteIds, next[1].noteIds[0]] };
    next[1] = { ...next[1], noteIds: next[1].noteIds.slice(1) };

    let upserted = 0;
    let membership = 0;
    const elapsed = bestOfRuns(() => {
      const delta = diffGroupsDelta(prev, next, 1_700_000_000_000);
      upserted = delta.upserted.length;
      membership = delta.membership.length;
    });

    expect(upserted).toBe(10); // the renames; membership travels separately
    expect(membership).toBe(1);
    // ~10ms measured; the map-based containment diff is O(total memberships).
    expect(elapsed).toBeLessThan(500);
  });
});
