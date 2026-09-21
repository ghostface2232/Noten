# Editor performance bench

Measures the real app — release Rust, production frontend, WebView2 — through
the Chrome DevTools Protocol. Nothing here ships or runs in CI.

```bash
node bench/corpus.mjs             # download public-domain text, generate the corpus
node bench/run.mjs --build        # build the isolated bench app + frontends
node bench/run.mjs --build-web x  # working tree frontend -> web-x / web-x-nomin (compare with --web web-x)
node bench/run.mjs --sizes 100k,1m --loads 3 --tag baseline
node bench/report.mjs             # newest result file as a Markdown table
node bench/compare.mjs base final # before -> after table between two tags
```

## Isolation

The bench binary is compiled with identifier `com.noten.bench` (via
`TAURI_CONFIG`), so it reads and writes `%APPDATA%\com.noten.bench` and its own
WebView2 profile — never the `com.noten.app` library, settings, or updater
state. Its version is pinned to 99.0.0 so the updater never offers a release.
`run.mjs` refuses to touch any app-data directory without the bench identifier.

The cache (corpus, release build, frontends, results) lives in
`%LOCALAPPDATA%\noten-bench` (override with `NOTEN_BENCH_CACHE`), outside the
repository, which may sit in a synced folder.

## Corpus

`corpus.mjs` writes each kind at 100 KiB, 1 MiB and 10 MiB:

| kind | content |
|---|---|
| `novel-en` | Project Gutenberg: War and Peace, Pride and Prejudice, Sherlock Holmes (unwrapped paragraphs, chapter headings) |
| `wiki-en`, `wiki-ko` | English / Korean Wikipedia article extracts, section headings as `##` |
| `paragraphs` | hundreds of thousands of one-sentence paragraphs |
| `one-paragraph` | the whole note is one paragraph (soft line breaks, inline marks) |
| `one-line` | the whole note is one line |
| `lists` | nested bullet / ordered / task lists |
| `headings` | every other block a heading |
| `code` | fenced code blocks in five languages |
| `tables` | 3–10 row tables between paragraphs |
| `mixed` | all of the above, like a working note |
| `images` | prose with one distinct image asset per ~2 KiB |

Image references are hard-linked onto four generated PNGs (138 KiB – 1.9 MiB),
so every reference is a distinct file at no extra disk cost.

## What is measured

Per document, after one warm-up boot (manifest cache and image migration done):

- **load** — `Page.reload` to the frame where the note is visible (`readyMs`),
  and to the end of the last long task (`settledMs`); median of `--loads`.
  For `images`, also when every `<img>` has a source and has decoded.
- **typing** — 35 key presses in the middle block of the kind (paragraph, code
  block, list item, table cell), 110 ms apart. Latency is the key event's
  timestamp to the task after the next rendered frame, so it includes vsync
  wait (≈ 0–17 ms) and everything the frame had to do.
- **enter** — Enter/letter pairs (block splits).
- **ime** — Hangul composed the way a Windows IME delivers it
  (`Input.imeSetComposition` per jamo, `Input.insertText` per syllable).
- **autosave** — long tasks in the 2.5 s after typing stops (debounce is 1 s).
- **scroll** — 40 wheel ticks; rAF frame intervals.

`--profile` records V8 CPU profiles (use `--web web-nomin` for readable
names), `--trace` records main-thread self time per trace event (paint, GC,
layout, input plumbing — work a JS profile cannot see).

Experiment flags: `--micro` times `getMarkdown()`, `getJSON()` and
`markdown.parse()` inside the app instead of running the input scenarios;
`--css "<rules>"` injects a stylesheet into every load (how the
`content-visibility` variants in docs/2026-09-21-editor-performance.md were
measured); `--trace-categories` overrides the trace categories.

Checks that a change keeps the page correct rather than fast (each replaces the
input scenarios):

- `--nav` — outline jumps, go-to-line and find driven through the real UI;
  reports where each target lands relative to the scroll viewport. A layout
  change that estimates off-screen sizes shows up here as jumps landing off
  screen.
- `--geometry` — every top-level block's height. Two builds with the same
  document should agree to rounding (compare the `geometry` arrays).
- `--visual "<css>"` — heights and screenshots of sampled blocks before and
  after injecting `css` into the same page; differing screenshots go to
  `<cache>/results/visual`, and `node bench/pngdiff.mjs` reports how many
  pixels differ and whether the difference is a whole-pixel shift.
- `--eval "<js>"` runs a script once after the loads (e.g. to strip a kind of
  DOM node and see whether a cost depends on it); `--doc-file <path.md>` runs
  any Markdown file instead of the corpus.
