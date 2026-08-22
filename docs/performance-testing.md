# Performance test coverage

Noten's promise is "fast and light": instant startup, instant note switching,
saves that never block typing, and a memory footprint that stays flat over a
long session. This document defines what that means as testable coverage, what
is automated today, and what stays a manual protocol.

## Principles

- **Guards, not benchmarks.** The automated suite (`src/perf/`, run via
  `npm run test:perf` and as part of `npm test`) asserts complexity class, not
  absolute speed. Every budget is ~10x a dev-machine measurement and each test
  takes the best of three runs (`bestOfRuns` in `perf.test-utils.ts`), so CI
  noise cannot fail a healthy build, while an O(n) → O(n²) regression or a
  dropped cache still fails loudly. `fastMarkdownLexer.test.ts` set this
  pattern; `src/perf/` extends it to the other hot paths.
- **Memory is asserted structurally.** Heap measurement is too noisy for CI,
  so "light on memory" is tested the way it is engineered: session-lifetime
  structures must be pruned, stay empty in the steady state, or reuse objects
  instead of allocating. See `memoryBounds.perf.test.ts`.
- **jsdom bounds CPU work only.** The suite measures the pure/TS layer against
  the in-memory FS. Real disk latency, webview rendering, and Rust-side cost
  are covered by the manual protocol below, not by budgets in jsdom.

## Coverage map

### 1. Loading (startup → sidebar visible) — `loading.perf.test.ts`

| Item | Why it is hot | Guard |
| --- | --- | --- |
| `sortNotes` on a 5k-doc library | Runs on every docs commit and at load | All six sort orders within budget |
| `sortSignature` on a 5k-doc library | The per-commit "did order move?" check; exists to avoid per-commit allocation | 50-call burst within budget |
| `mergeHydratedLibrary` 5k → 5k | Hydration rebase gating first real content | O(n) rebase within budget, output count exact |
| `reconcileFolder` cold pass, 1k notes | Gates first paint on a fresh/changed folder | Adoption within budget on a fresh FS per run |
| `reconcileFolder` steady-state pass, 1k notes | Re-runs on every watcher event | Repeat pass within budget |
| `deriveTitle` on 1MB bodies | Per note at load and on save | Early-exit behavior bounded regardless of body size |
| `stripMarkdownContent` on a 1MB body | Sidebar preview text | Linear line-oriented pass within budget |

### 2. Saving (autosave / commit path) — `saving.perf.test.ts`

| Item | Why it is hot | Guard |
| --- | --- | --- |
| `markdownEqual` on 4MB CRLF-vs-LF bodies | Save/watcher conflict comparison worst case | Full double normalization within budget |
| `normalizeMarkdown` with a 100k trailing-newline run | `\n+$` must not backtrack | Within budget |
| `libraryStore` commit ×200 on a 5k-doc library | Every keystroke burst commits | Within budget; plus reference-identity check that unchanged docs are not re-cloned |
| `diffGroupsDelta` on 1k groups / 50k memberships | Every group persist broadcasts a delta | Map-based diff within budget, delta exact |

### 3. Screen transitions (note switch / per-frame UI) — `switching.perf.test.ts`

| Item | Why it is hot | Guard |
| --- | --- | --- |
| `extractHeadings` + `headingsSignature` on a 3k-block doc | Once per rAF while the outline panel is open | Within budget |
| `activeHeadingIndex` ×1k caret positions | Selection-follow in the outline | Within budget |
| `buildHeadingAnchors` + `filterHeadingAnchors` | Wiki-link `#` autocomplete on large notes | Within budget |
| `buildLineIndex` + 2k `posToLine`/`lineToPos` | Status bar and Go To Line | Index build is one walk, lookups stay binary search |
| `countWords` on 2MB text | Status bar per update | Single linear scan within budget |
| `isProbablyMarkdown` on 1MB paste | Gates every large paste | Both verdicts within budget |
| Markdown lexing of multi-MB single blocks | Editor load/paste parse | Already guarded in `fastMarkdownLexer.test.ts` (kept there, not duplicated) |

### 4. Memory (bounded growth over a session) — `memoryBounds.perf.test.ts`

| Item | Why it matters | Guard |
| --- | --- | --- |
| Own-write tracker maps | Grow with every autosave across every note | 2k expired markers prune to zero; re-marking one path holds size 1 |
| `ReconcileState.bodyMissing` | Grows per watcher pass if leaked | Stays empty across repeated passes over a healthy folder |
| Store snapshot copy layer | A clone-per-commit regression allocates a library's worth of garbage per keystroke burst | Unchanged entities stay reference-identical across commits |
| Tiptap document session cache | Bounded at `DOC_SESSION_CACHE_LIMIT` (20) in `TiptapEditor.tsx` | Not automated — component-internal; covered by code review and the manual protocol |

## Not automated (manual protocol)

These need the real app on Windows; measure them against a synthetic library
from `node scripts/gen-notes.mjs --out <dir> --count 2000 [--groups 20]`
before releases that touch startup, persistence, or the editor:

- **Cold startup time** to interactive sidebar and editor, at 100 / 1,000 /
  5,000 notes.
- **Working set (Task Manager)** after startup and after an hour of mixed
  editing/switching — flat, not creeping.
- **Note switch latency** between two multi-MB notes (exercises the real
  `openDocument` session cache).
- **Watcher storm behavior**: bulk-modify the notes folder externally
  (cloud-sync simulation) and confirm the UI stays responsive during
  reconcile.
- **Webview frame rate** while typing in a very large note with the outline
  panel open.

## Adding a new guard

Put cross-module performance guards in `src/perf/`, colocate a
single-module guard with its module (like `fastMarkdownLexer.test.ts`), and in
either case: generate data deterministically (`createRng`), measure with
`bestOfRuns`, set the budget ~10x your local measurement, and write one
comment saying which user-visible path the guard protects and what regression
would trip it.
