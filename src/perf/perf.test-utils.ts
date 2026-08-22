import type { NoteDoc, NoteGroup } from "../utils/noteTypes";

// Shared helpers for the performance guard suite (src/perf/).
//
// These tests are regression tripwires, not benchmarks. Every budget is set an
// order of magnitude above the time measured on a development machine, so a
// failure means "this path changed complexity class or got dramatically
// slower", never "this CI runner is slow today". Follow the calibration rule
// from fastMarkdownLexer.test.ts: generous absolute thresholds that still
// catch an O(n) → O(n²) regression.

/**
 * Runs `fn` several times and returns the fastest wall-clock time. A single
 * run is at the mercy of GC pauses and cold JIT on shared CI hardware; the
 * minimum of a few runs is what the code is actually capable of, which is the
 * quantity the budgets bound.
 */
export function bestOfRuns(fn: () => void, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/** Async variant of bestOfRuns. `setup` (untimed) rebuilds per-run state so a
 *  cache warmed by run 1 cannot make runs 2-3 measure a different code path. */
export async function bestOfRunsAsync(
  fn: () => Promise<void>,
  runs = 3,
  setup?: () => Promise<void> | void,
): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    await setup?.();
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

// Deterministic PRNG so every run sorts/merges the exact same data. Perf
// budgets and data-shape assertions must not depend on Math.random.
export function createRng(seed = 0x2f6e2b1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function makeDoc(id: string, overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    id,
    filePath: `/notes/${id}.md`,
    fileName: id,
    isDirty: false,
    content: "",
    createdAt: 1_000,
    updatedAt: 1_000,
    pinned: false,
    ...overrides,
  };
}

/**
 * A library-sized docs array with shuffled timestamps, mixed-case titles, and
 * a pinned subset — enough field variety that sorting and signature hashing
 * cannot take degenerate shortcuts (all-equal keys collapse comparison sorts
 * to a single pass).
 */
export function makeLibraryDocs(count: number): NoteDoc[] {
  const rng = createRng();
  const docs: NoteDoc[] = [];
  for (let i = 0; i < count; i++) {
    const id = `note-${i.toString(36).padStart(6, "0")}`;
    docs.push(
      makeDoc(id, {
        fileName: `${rng() < 0.5 ? "Note" : "note"} ${Math.floor(rng() * count)} ${id}`,
        createdAt: 1_700_000_000_000 + Math.floor(rng() * 1_000_000_000),
        updatedAt: 1_700_000_000_000 + Math.floor(rng() * 1_000_000_000),
        pinned: rng() < 0.1,
        content: `# Heading ${i}\n\nbody line one\nbody line two\n`,
      }),
    );
  }
  return docs;
}

export function makeGroups(count: number, notesPerGroup: number): NoteGroup[] {
  const groups: NoteGroup[] = [];
  for (let i = 0; i < count; i++) {
    const noteIds: string[] = [];
    for (let j = 0; j < notesPerGroup; j++) {
      noteIds.push(`note-${(i * notesPerGroup + j).toString(36).padStart(6, "0")}`);
    }
    groups.push({
      id: `group-${i.toString(36).padStart(4, "0")}`,
      name: `Group ${i}`,
      noteIds,
      collapsed: false,
      createdAt: 1_700_000_000_000 + i,
      orderKey: i.toString(36).padStart(8, "0"),
      orderUpdatedAt: 1_700_000_000_000 + i,
      updatedAt: 1_700_000_000_000 + i,
    });
  }
  return groups;
}

/**
 * A realistic mixed-structure Markdown body of roughly `approxChars`
 * characters: headings, prose with inline marks, lists, and fenced code — the
 * shape a long-lived real note converges to, as opposed to the adversarial
 * single-block inputs fastMarkdownLexer.test.ts covers.
 */
export function makeMarkdownBody(approxChars: number): string {
  const section = [
    "## Section heading with *emphasis* and `code`",
    "",
    "A paragraph with a [link](https://example.com/page) and **bold** text,",
    "an inline `code span`, and a [[Wiki Link]] to another note.",
    "",
    "- list item one",
    "- list item two with ~~strikethrough~~",
    "1. numbered item",
    "",
    "```ts",
    "const x = compute(1, 2);",
    "```",
    "",
  ].join("\n");
  let out = "# Document title\n\n";
  while (out.length < approxChars) out += section;
  return out.slice(0, approxChars);
}
