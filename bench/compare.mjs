// Before/after Markdown table between two result sets.
//   node bench/compare.mjs <before-tag>[,<before-tag>...] <after-tag>[,...]
// Each tag selects the newest `*-<tag>.json` in <cache>/results; several tags
// are merged (e.g. "base-100k,base-1m").

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CACHE = process.env.NOTEN_BENCH_CACHE ?? join(process.env.LOCALAPPDATA, "noten-bench");
const dir = join(CACHE, "results");

function load(tags) {
  const out = new Map();
  for (const tag of tags.split(",")) {
    const file = readdirSync(dir).filter((f) => f.endsWith(`-${tag}.json`)).sort().at(-1);
    if (!file) throw new Error(`no results for tag ${tag}`);
    for (const r of JSON.parse(readFileSync(join(dir, file), "utf8"))) out.set(r.doc, r);
  }
  return out;
}

const [beforeTags, afterTags] = process.argv.slice(2);
const before = load(beforeTags);
const after = load(afterTags);

const f = (v) => (v == null || Number.isNaN(v) ? "–" : v >= 100 ? Math.round(v).toString() : v.toFixed(1));
const pair = (a, b) => `${f(a)} → ${f(b)}`;
const s = (ms) => (ms == null ? null : ms);

console.log("| doc | load ready ms | type p50 ms | type p95 ms | enter p95 ms | IME p50 ms | autosave longest ms | scroll p95 ms |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [doc, b] of before) {
  const a = after.get(doc);
  if (!a || b.error || a.error || !b.typing || !a.typing) continue;
  console.log(`| ${doc} | ${pair(s(b.loadMedian.readyMs), s(a.loadMedian.readyMs))} `
    + `| ${pair(b.typing.latency?.p50, a.typing.latency?.p50)} `
    + `| ${pair(b.typing.latency?.p95, a.typing.latency?.p95)} `
    + `| ${pair(b.enter.latency?.p95, a.enter.latency?.p95)} `
    + `| ${pair(b.ime?.latency?.p50, a.ime?.latency?.p50)} `
    + `| ${pair(b.typing.autosave?.longest, a.typing.autosave?.longest)} `
    + `| ${pair(b.scroll.frame?.p95, a.scroll.frame?.p95)} |`);
}
