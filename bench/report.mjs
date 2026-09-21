// Renders a bench/run.mjs result file as Markdown tables.
//   node bench/report.mjs [results.json]   (default: newest file in <cache>/results)

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CACHE = process.env.NOTEN_BENCH_CACHE ?? join(process.env.LOCALAPPDATA, "noten-bench");
const dir = join(CACHE, "results");
const file = process.argv[2] ?? join(dir, readdirSync(dir).filter((f) => f.endsWith(".json")).sort().at(-1));
const rows = JSON.parse(readFileSync(file, "utf8"));

const f = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : `${Math.round(b / 1024)}K`);

console.log(`source: ${file}\n`);
console.log("| doc | size | ready ms | settled ms | longest task | heap MB | DOM nodes | type p50/p95/max | per-key script ms | enter p95 | IME p50/p95 | autosave longest / total | scroll p95 / >50ms |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  if (r.error) {
    console.log(`| ${r.doc} | ${kb(r.bytes)} | ERROR: ${r.error.slice(0, 80)} ||||||||||`);
    continue;
  }
  const L = r.loadMedian;
  const t = r.typing;
  const perKey = t.latency ? t.metrics.ScriptDuration / t.latency.n : null;
  console.log(`| ${r.doc} | ${kb(r.bytes)} | ${f(L.readyMs)} | ${f(L.settledMs)} | ${f(L.longestTaskMs)} | ${f(L.heapMB)} | ${L.nodes} `
    + `| ${f(t.latency?.p50, 1)} / ${f(t.latency?.p95, 1)} / ${f(t.latency?.max, 0)} | ${f(perKey, 1)} `
    + `| ${f(r.enter.latency?.p95, 0)} | ${r.ime ? `${f(r.ime.latency?.p50, 1)} / ${f(r.ime.latency?.p95, 1)}` : "–"} | ${f(t.autosave?.longest)} / ${f(t.autosave?.longtaskMs)} `
    + `| ${f(r.scroll.frame?.p95, 1)} / ${r.scroll.over50ms} |`);
}
