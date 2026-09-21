// Drives the real Noten app (release Rust + production frontend in WebView2)
// through the Chrome DevTools Protocol and measures load, typing, autosave and
// scroll cost for each corpus document.
//
//   node bench/corpus.mjs                     # once: build the corpus
//   node bench/run.mjs --build                # build the isolated bench app
//   node bench/run.mjs --build-web fix1       # frontend of the working tree -> web-fix1
//   node bench/run.mjs [--docs a,b] [--sizes 100k,1m] [--web web|web-nomin]
//                      [--loads 3] [--profile]
//
// Isolation: the app is compiled with identifier `com.noten.bench`, so it
// reads and writes %APPDATA%\com.noten.bench only — never the user's
// com.noten.app notes, settings or WebView2 profile. The frontend is served
// from a local static server on the devUrl port, which a binary built without
// the `custom-protocol` feature loads.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const CACHE = process.env.NOTEN_BENCH_CACHE ?? join(process.env.LOCALAPPDATA, "noten-bench");
const DOCS = join(CACHE, "docs");
const TARGET = join(CACHE, "target");
const EXE = join(TARGET, "release", "noten.exe");
const APPDATA_DIR = join(process.env.APPDATA, "com.noten.bench");
const NOTES_DIR = join(APPDATA_DIR, "notes");
const IDENTIFIER_GUARD = "com.noten.bench";
const CDP_PORT = 9333;
const WEB_PORT = 5173;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const docFile = opt("doc-file", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ build

// Build the current working tree's frontend into web-<name> (minified, for
// timing) and web-<name>-nomin (readable names, for profiles).
function buildWeb(name) {
  for (const [dir, extra] of [[`web-${name}`, []], [`web-${name}-nomin`, ["--minify", "false"]]]) {
    const v = spawnSync("npx", ["vite", "build", "--outDir", join(CACHE, dir), "--emptyOutDir", ...extra],
      { cwd: REPO, stdio: "inherit", shell: true });
    if (v.status !== 0) process.exit(v.status ?? 1);
  }
}

function buildApp() {
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: TARGET,
    // Merged over tauri.conf.json at compile time. The version is pinned high
    // so the updater can never consider a published release newer.
    TAURI_CONFIG: JSON.stringify({ identifier: IDENTIFIER_GUARD, productName: "NotenBench", version: "99.0.0" }),
  };
  const r = spawnSync("cargo", ["build", "--release"], { cwd: join(REPO, "src-tauri"), env, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  for (const [dir, extra] of [["web", []], ["web-nomin", ["--minify", "false"]]]) {
    const v = spawnSync("npx", ["vite", "build", "--outDir", join(CACHE, dir), "--emptyOutDir", ...extra],
      { cwd: REPO, stdio: "inherit", shell: true });
    if (v.status !== 0) process.exit(v.status ?? 1);
  }
}

// ------------------------------------------------------------------ static server

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json",
  ".map": "application/json",
};

function serve(dir) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(dir, url);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(WEB_PORT, "127.0.0.1", () => resolve(server)));
}

// ------------------------------------------------------------------ notes fixture

const NOTE_ID = "bench-note";
const SMALL_ID = "bench-small";

function writeNote(id, title, body, updatedAt) {
  writeFileSync(join(NOTES_DIR, `${id}.md`), body, "utf8");
  writeFileSync(join(NOTES_DIR, ".meta", `${id}.json`), JSON.stringify({
    version: 2, id, fileName: title, customName: true, createdAt: updatedAt - 1000, updatedAt,
    pinned: false, groupId: null, groupUpdatedAt: updatedAt, trashedAt: null,
  }));
}

function prepareNotes(docName) {
  if (!APPDATA_DIR.includes(IDENTIFIER_GUARD)) throw new Error("refusing to touch a non-bench app data dir");
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(join(NOTES_DIR, ".meta"), { recursive: true });
  const body = readFileSync(docFile ?? join(DOCS, `${docName}.md`), "utf8");
  const now = Date.now();
  writeNote(NOTE_ID, docName, body, now);
  writeNote(SMALL_ID, "small note", "# Small\n\nA short note used as the other end of a switch.\n", now - 60_000);
  // Every image reference gets its own file, hard-linked onto one of the four
  // generated PNGs: distinct paths (no cache sharing) at zero extra disk.
  for (const m of body.matchAll(/\]\(\.assets\/bench-note\/([0-9a-f]+-v(\d)\.png)\)/g)) {
    const dir = join(NOTES_DIR, ".assets", NOTE_ID);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, m[1]);
    if (!existsSync(dest)) linkSync(join(DOCS, "img", `v${m[2]}.png`), dest);
  }
  // Open the benchmark note at startup; the manifest cache is dropped so the
  // first (warm-up) launch rebuilds it for this library.
  writeFileSync(join(APPDATA_DIR, "ui-state.json"), JSON.stringify({ activeNoteId: NOTE_ID, lastOpenedNoteId: NOTE_ID, groupCollapsed: {} }));
  rmSync(join(APPDATA_DIR, "manifest-cache.json"), { force: true });
  return { bytes: Buffer.byteLength(body, "utf8") };
}

// ------------------------------------------------------------------ CDP

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return new Cdp(ws);
  }
  send(method, params = {}, timeoutMs = 600_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  async eval(expression, timeoutMs) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() { this.ws.close(); }
}

// Injected before every document: long-task log, "content visible" frame, and
// an input-to-next-frame latency probe for keyboard input.
const INSTRUMENT = String.raw`
(() => {
  const B = window.__bench = { longtasks: [], ready: null, readyPainted: null, keys: [], frames: null };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) B.longtasks.push([e.startTime, e.duration]); })
      .observe({ type: "longtask", buffered: true });
  } catch {}
  const poll = () => {
    const pm = document.querySelector(".ProseMirror");
    if (pm && (pm.childElementCount > 1 || (pm.firstElementChild && pm.firstElementChild.textContent.length > 200))) {
      B.ready = performance.now();
      setTimeout(() => { B.readyPainted = performance.now(); }, 0);
      return;
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
  // Images load asynchronously (the browser fetches their noten-asset URL).
  // Record when every <img> in the editor has a source and has decoded.
  B.images = { total: 0, withSrc: 0, decoded: 0, allSrcAt: null, allDecodedAt: null };
  const imgTimer = setInterval(() => {
    const imgs = document.querySelectorAll(".ProseMirror img");
    if (!imgs.length) return;
    let withSrc = 0, decoded = 0;
    for (const im of imgs) { if (im.getAttribute("src")) { withSrc++; if (im.complete && im.naturalWidth) decoded++; } }
    Object.assign(B.images, { total: imgs.length, withSrc, decoded });
    const tl = B.images.timeline ??= [];
    if (!tl.length || performance.now() - tl[tl.length - 1][0] >= 1000) tl.push([Math.round(performance.now()), withSrc, decoded]);
    if (withSrc === imgs.length && B.images.allSrcAt == null) B.images.allSrcAt = performance.now();
    if (decoded === imgs.length && B.images.allDecodedAt == null) { B.images.allDecodedAt = performance.now(); clearInterval(imgTimer); }
  }, 50);
  // Object URLs the page creates and revokes, with their Blob bytes.
  B.objectUrls = { created: 0, createdMB: 0, revoked: 0 };
  const createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (obj) => { B.objectUrls.created++; B.objectUrls.createdMB += (obj?.size ?? 0) / 1048576; return createObjectURL.call(URL, obj); };
  URL.revokeObjectURL = (url) => { B.objectUrls.revoked++; return revokeObjectURL.call(URL, url); };
  // Latency = input event timestamp -> task after the next rendered frame.
  // IME composition updates emit no keydown, so they are probed separately.
  const probe = (e) => {
    const rec = { key: e.key ?? e.type, t0: e.timeStamp, handlerStart: performance.now() };
    B.keys.push(rec);
    requestAnimationFrame(() => {
      rec.raf = performance.now();
      setTimeout(() => { rec.painted = performance.now(); }, 0);
    });
  };
  window.addEventListener("keydown", probe, true);
  window.addEventListener("compositionupdate", probe, true);
})();
`;

async function waitForTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes(`localhost:${WEB_PORT}`));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error("no WebView2 page target");
}

function launchApp() {
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
    stdio: "ignore",
  });
  return child;
}

async function killApp(child) {
  try { child.kill(); } catch {}
  spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  await sleep(1500);
}

// Wait until the document is visible and the main thread has been free of long
// tasks for `quietMs`.
const SETTLE_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 300_000);

async function waitSettled(cdp, { quietMs = 1500, timeoutMs = SETTLE_TIMEOUT_MS, needReady = true } = {}) {
  const start = Date.now();
  for (;;) {
    const s = await cdp.eval(`(() => { const B = window.__bench; if (!B) return null;
      const last = B.longtasks.reduce((m, [s, d]) => Math.max(m, s + d), 0);
      return { now: performance.now(), ready: B.ready, readyPainted: B.readyPainted, last, pm: document.querySelectorAll(".ProseMirror").length, c: document.querySelector(".ProseMirror")?.childElementCount }; })()`, timeoutMs);
    if (s && (!needReady || s.readyPainted != null)) {
      const since = s.now - Math.max(s.last, s.readyPainted ?? 0);
      if (since >= quietMs) return s;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`did not settle: ${JSON.stringify(s)}`);
    if (process.env.BENCH_DEBUG && (Date.now() - start) % 5000 < 110) console.log(JSON.stringify(s));
    await sleep(100);
  }
}

// Images finish after the text; wait (bounded) until every <img> decoded or
// progress stalls for 10s, and report how far it got.
async function waitImages(cdp, timeoutMs = 300_000) {
  const start = Date.now();
  let last = null;
  let lastChange = Date.now();
  for (;;) {
    const im = await cdp.eval("window.__bench.images", timeoutMs);
    const sig = `${im.withSrc}/${im.decoded}`;
    if (sig !== last) { last = sig; lastChange = Date.now(); }
    if (im.allDecodedAt != null || Date.now() - lastChange > 10_000 || Date.now() - start > timeoutMs) {
      const heap = await cdp.send("Runtime.getHeapUsage");
      // What stays alive, as opposed to garbage not yet collected.
      await cdp.send("HeapProfiler.collectGarbage");
      const live = await cdp.send("Runtime.getHeapUsage");
      return { ...im, heapMB: +(heap.usedSize / 1048576).toFixed(1), liveHeapMB: +(live.usedSize / 1048576).toFixed(1) };
    }
    await sleep(250);
  }
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

function metricDelta(a, b) {
  const keys = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"];
  return Object.fromEntries(keys.map((k) => [k, +(((b[k] ?? 0) - (a[k] ?? 0)) * (k.endsWith("Duration") ? 1000 : 1)).toFixed(1)]));
}

// ------------------------------------------------------------------ profiles

function summarizeProfile(profile, top = 25) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const cf = node.callFrame;
    const file = cf.url ? cf.url.replace(/^.*\/assets\//, "").replace(/-[\w-]{8}\.js$/, ".js") : "";
    const key = `${cf.functionName || "(anon)"} ${file}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  return {
    totalMs: +total.toFixed(1),
    top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => [k, +v.toFixed(1)]),
  };
}

// ------------------------------------------------------------------ traces

const TRACE_CATEGORIES = [
  "toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "v8.execute",
  "blink", "cc", "gpu", "latencyInfo", "input",
].join(",");

async function startTrace(cdp) {
  const events = [];
  const onData = (p) => { for (const e of p.value) events.push(e); };
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", { categories: opt("trace-categories", TRACE_CATEGORIES), transferMode: "ReportEvents" });
  return async () => {
    const done = new Promise((resolve) => cdp.on("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    await done;
    return summarizeTrace(events);
  };
}

// Task events are only meaningful with the code that posted them.
function traceLabel(e) {
  if (!/RunTask$/.test(e.name)) return e.name;
  const a = e.args ?? {};
  const src = a.src_func ?? a.data?.src_func ?? a.posted_from?.function_name;
  const file = (a.src_file ?? a.data?.src_file ?? a.posted_from?.file_name ?? "").split(/[\/]/).pop();
  return src || file ? `${e.name}(${file}:${src})` : e.name;
}

// Self time per event name on the renderer main thread, so non-JS work (paint,
// GC, layout, hit testing, IME/text input plumbing) is attributed too.
function summarizeTrace(events, top = 30) {
  const threadName = new Map();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = [...threadName.entries()].filter(([, n]) => n === "CrRendererMain").map(([k]) => k);
  // Pick the renderer main thread that did the most work.
  const busy = new Map();
  for (const e of events) if (e.ph === "X" && main.includes(`${e.pid}:${e.tid}`)) busy.set(`${e.pid}:${e.tid}`, (busy.get(`${e.pid}:${e.tid}`) ?? 0) + (e.dur ?? 0));
  const key = [...busy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const xs = events.filter((e) => e.ph === "X" && `${e.pid}:${e.tid}` === key && e.dur != null).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const self = new Map();
  const stack = [];
  let totalTop = 0;
  for (const e of xs) {
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
    const parent = stack.at(-1);
    const label = traceLabel(e);
    if (parent) self.set(parent.label, (self.get(parent.label) ?? 0) - e.dur);
    else totalTop += e.dur;
    self.set(label, (self.get(label) ?? 0) + e.dur);
    stack.push({ ts: e.ts, dur: e.dur, label });
  }
  return {
    mainThreadBusyMs: +(totalTop / 1000).toFixed(1),
    selfMs: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => [k, +(v / 1000).toFixed(1)]),
  };
}

// ------------------------------------------------------------------ scenarios

const CARET_TARGETS = {
  code: ".ProseMirror pre code",
  lists: ".ProseMirror li p",
  tables: ".ProseMirror td p",
  default: ".ProseMirror > p",
};

// Put the caret inside the middle matching block by a real mouse click.
async function clickMiddle(cdp, selector, fraction = 0.5) {
  const pt = await cdp.eval(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    if (!els.length) return null;
    const el = els[Math.floor(els.length * ${fraction})];
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const y = Math.min(Math.max(innerHeight / 2, r.top + 6), r.bottom - 6);
    return { x: Math.min(r.left + 24, r.right - 4), y, count: els.length };
  })()`);
  if (!pt) return null;
  await sleep(300);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  }
  await sleep(300);
  return pt;
}

// Hangul as a Windows IME delivers it: each jamo updates the composition,
// each finished syllable commits.
const HANGUL = [["ㅎ", "하", "한"], ["ㄱ", "그", "글"], ["ㅇ", "이", "입"], ["ㄹ", "려", "력"], ["ㅁ", "무", "문"], ["ㅈ", "자", "장"]];

async function typeHangul(cdp, gapMs) {
  for (let r = 0; r < 3; r++) {
    for (const steps of HANGUL) {
      for (const text of steps) {
        await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
        await sleep(gapMs);
      }
      await cdp.send("Input.insertText", { text: steps.at(-1) });
      await sleep(gapMs);
    }
  }
}

async function typeKeys(cdp, keys, gapMs) {
  if (keys === "hangul") return typeHangul(cdp, gapMs);
  for (const k of keys) {
    const ev = k === "Enter"
      ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }
      : { key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), text: k };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev, text: undefined });
    await sleep(gapMs);
  }
}

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +v[v.length - 1].toFixed(1) };
}

async function typingScenario(cdp, selector, keys, gapMs, profile, trace = false) {
  const pt = await clickMiddle(cdp, selector);
  if (!pt) return { skipped: `no ${selector}` };
  await cdp.eval("window.__bench.keys.length = 0; window.__bench.longtasks.length = 0; 0");
  const m0 = await metrics(cdp);
  if (profile) await cdp.send("Profiler.start");
  const stopTrace = trace ? await startTrace(cdp) : null;
  await typeKeys(cdp, keys, gapMs);
  await sleep(200);
  const traceSummary = stopTrace ? await stopTrace() : null;
  let prof = null;
  if (profile) prof = summarizeProfile((await cdp.send("Profiler.stop")).profile);
  const m1 = await metrics(cdp);
  const r = await cdp.eval(`(() => { const B = window.__bench;
    return { keys: B.keys.map((k) => ({ lat: (k.painted ?? NaN) - k.t0, queue: k.handlerStart - k.t0 })),
      longtasks: B.longtasks.slice() }; })()`);
  // Autosave fires DEBOUNCE_MS (1s) after the last key; capture it separately.
  await cdp.eval("window.__bench.longtasks.length = 0; 0");
  if (profile) await cdp.send("Profiler.start");
  const mA = await metrics(cdp);
  await sleep(2500);
  const mB = await metrics(cdp);
  let saveProf = null;
  if (profile) saveProf = summarizeProfile((await cdp.send("Profiler.stop")).profile);
  const save = await cdp.eval("window.__bench.longtasks.slice()");
  return {
    blocks: pt.count,
    latency: stats(r.keys.map((k) => k.lat)),
    inputQueue: stats(r.keys.map((k) => k.queue)),
    metrics: metricDelta(m0, m1),
    longtasks: r.longtasks.length,
    autosave: { longtaskMs: +save.reduce((a, [, d]) => a + d, 0).toFixed(1), longest: +Math.max(0, ...save.map(([, d]) => d)).toFixed(1), metrics: metricDelta(mA, mB) },
    profile: prof,
    trace: traceSummary,
    autosaveProfile: saveProf,
  };
}

// Direct timings of the editor's whole-document operations, in the app's own
// V8: serialization (what autosave and a note switch pay), JSON conversion,
// and Markdown parsing (what opening a note pays before rendering).
async function microScenario(cdp) {
  return cdp.eval(`(() => {
    const editor = document.querySelector(".ProseMirror")?.editor;
    if (!editor) return null;
    const time = (fn, n = 3) => {
      const samples = [];
      let out;
      for (let i = 0; i < n; i++) { const t = performance.now(); out = fn(); samples.push(performance.now() - t); }
      samples.sort((a, b) => a - b);
      return { ms: +samples[Math.floor(n / 2)].toFixed(1), out };
    };
    const md = time(() => editor.getMarkdown());
    const json = time(() => editor.getJSON());
    const parse = time(() => editor.markdown.parse(md.out));
    const toNode = time(() => editor.schema.nodeFromJSON(parse.out));
    return {
      getMarkdownMs: md.ms, getJSONMs: json.ms, parseMs: parse.ms, nodeFromJSONMs: toNode.ms,
      markdownChars: md.out.length, topLevelBlocks: editor.state.doc.childCount,
    };
  })()`, 600_000);
}

// Where navigation lands: outline jump, go-to-line and find, driven through
// the real UI. Each target is reported relative to the scroll container's
// viewport (`top` in px from its top edge, `visible` when fully inside), so a
// layout change such as content-visibility can be checked for jumps that land
// off target.
async function navScenario(cdp) {
  const key = async (k, code, vk, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
    }
  };
  const CTRL = 2, SHIFT = 8;
  const where = (expr) => cdp.eval(`(() => {
    const pm = document.querySelector(".ProseMirror");
    let sc = pm; while (sc && !["auto", "scroll"].includes(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    const box = sc.getBoundingClientRect();
    const r = (${expr});
    if (!r) return null;
    return { top: Math.round(r.top - box.top), visible: r.top >= box.top && r.bottom <= box.bottom, scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, width: pm.clientWidth };
  })()`);
  // The editor's own selection, not the DOM one: while the go-to-line input
  // has focus, the DOM selection sits in that input.
  const caretRect = `(() => { const v = document.querySelector(".ProseMirror").editor.view;
    return v.coordsAtPos(v.state.selection.head); })()`;
  const out = { outline: [], line: [], find: [] };

  // Outline: open the panel, click items at fixed fractions of the list.
  await clickMiddle(cdp, ".ProseMirror > *", 0.05);
  await key("O", "KeyO", 79, CTRL | SHIFT);
  await sleep(600);
  for (const f of [0.8, 0.2, 0.95, 0.5]) {
    const label = await cdp.eval(`(() => { const items = document.querySelectorAll("[data-outline-item]");
      if (!items.length) return null; const b = items[Math.min(items.length - 1, Math.floor(items.length * ${f}))];
      b.click(); return b.textContent; })()`);
    if (label == null) break;
    await sleep(1200);
    const landed = await where(caretRect);
    const heading = await cdp.eval(`(() => { const v = document.querySelector(".ProseMirror").editor.view;
      const { node } = v.domAtPos(v.state.selection.head); const el = node.nodeType === 1 ? node : node.parentElement;
      return el?.closest("h1,h2,h3,h4,h5,h6")?.textContent ?? null; })()`);
    out.outline.push({ f, ...landed, sameHeading: heading === label });
  }
  await key("O", "KeyO", 79, CTRL | SHIFT);
  await sleep(300);

  // Go to line: fractions of the status bar's line total.
  const total = await cdp.eval(`(() => { const e = document.querySelector(".ProseMirror").editor; let n = 0;
    e.state.doc.descendants((node) => { if (node.isTextblock) { n++; return false; } return true; }); return n; })()`);
  for (const f of [0.9, 0.3, 0.6]) {
    await clickMiddle(cdp, ".ProseMirror > *", 0.05);
    await key("g", "KeyG", 71, CTRL);
    await sleep(300);
    await cdp.send("Input.insertText", { text: String(Math.max(1, Math.floor(total * f))) });
    await key("Enter", "Enter", 13);
    await sleep(1500);
    out.line.push({ f, ...(await where(caretRect)) });
    await key("Escape", "Escape", 27);
    await sleep(300);
  }

  // Find: a 10-character snippet taken from 85% into the text, so the first
  // match is a long jump from the top.
  const needle = await cdp.eval(`(() => { const t = document.querySelector(".ProseMirror").textContent;
    for (let i = Math.floor(t.length * 0.85); i < t.length - 10; i++) { const s = t.slice(i, i + 10); if (/^[A-Za-z가-힣][\\w가-힣 ]{9}$/.test(s)) return s; }
    return null; })()`);
  if (needle) {
    await clickMiddle(cdp, ".ProseMirror > *", 0.05);
    await key("f", "KeyF", 70, CTRL);
    await sleep(300);
    await cdp.send("Input.insertText", { text: needle });
    await sleep(1500);
    out.find.push({ step: "first", ...(await where(`document.querySelector(".search-match-active")?.getBoundingClientRect()`)) });
    await key("Enter", "Enter", 13, SHIFT);
    await sleep(1500);
    out.find.push({ step: "prev", ...(await where(`document.querySelector(".search-match-active")?.getBoundingClientRect()`)) });
    await key("Escape", "Escape", 27);
    await sleep(300);
  }
  return out;
}

// Visual equivalence of a CSS change: every top-level block's height, and
// screenshots of sampled blocks (with a margin, to catch clipped overflow),
// before and after injecting `css` into the same page. Differing shots are
// written to <cache>/results/visual/<doc>-<i>-{before,after}.png.
async function visualScenario(cdp, css, docName) {
  const heights = () => cdp.eval(`[...document.querySelector(".ProseMirror").children]
    .map((k) => [k.tagName.toLowerCase() + (k.className ? "." + String(k.className).split(" ")[0] : ""), +k.getBoundingClientRect().height.toFixed(2)])`);
  const count = await cdp.eval(`document.querySelector(".ProseMirror").childElementCount`);
  const picks = [...new Set(Array.from({ length: 24 }, (_, i) => Math.floor((i * count) / 24)))];
  const shots = async () => {
    const out = [];
    for (const i of picks) {
      const clip = await cdp.eval(`(() => { const k = document.querySelector(".ProseMirror").children[${i}];
        k.scrollIntoView({ block: "start" }); const r = k.getBoundingClientRect();
        return { x: Math.max(0, r.left - 32), y: Math.max(0, r.top - 16), width: r.width + 64, height: Math.max(1, Math.min(r.height + 32, innerHeight - r.top)), scale: 1 }; })()`);
      await sleep(250);
      out.push((await cdp.send("Page.captureScreenshot", { format: "png", clip })).data);
    }
    return out;
  };
  const h0 = await heights();
  const s0 = await shots();
  await cdp.eval(`(() => { const s = document.createElement("style"); s.id = "bench-visual"; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return 0; })()`);
  await sleep(500);
  const h1 = await heights();
  const s1 = await shots();
  const changed = [];
  for (let i = 0; i < h0.length; i++) {
    if (h0[i][1] !== h1[i]?.[1]) changed.push([i, h0[i][0], h0[i][1], h1[i]?.[1]]);
  }
  const dir = join(CACHE, "results", "visual");
  mkdirSync(dir, { recursive: true });
  const pixelDiffs = [];
  s0.forEach((a, k) => {
    if (a === s1[k]) return;
    pixelDiffs.push(picks[k]);
    writeFileSync(join(dir, `${docName}-${picks[k]}-before.png`), Buffer.from(a, "base64"));
    writeFileSync(join(dir, `${docName}-${picks[k]}-after.png`), Buffer.from(s1[k], "base64"));
  });
  return { blocks: h0.length, heightChanged: changed.length, heightSamples: changed.slice(0, 12), shots: picks.length, pixelDiffs };
}

async function scrollScenario(cdp, trace = false) {
  await cdp.eval(`(() => { const s = document.querySelector(".ProseMirror"); let p = s;
    while (p && !(getComputedStyle(p).overflowY === "auto" || getComputedStyle(p).overflowY === "scroll")) p = p.parentElement;
    (p || document.scrollingElement).scrollTop = 0; window.__bench.frames = []; let last = performance.now();
    const tick = () => { const n = performance.now(); window.__bench.frames.push(n - last); last = n; if (window.__bench.frames.length < 400) requestAnimationFrame(tick); };
    requestAnimationFrame(tick); return 0; })()`);
  const m0 = await metrics(cdp);
  const stopTrace = trace ? await startTrace(cdp) : null;
  for (let i = 0; i < 40; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 400 });
    await sleep(50);
  }
  await sleep(500);
  const traceSummary = stopTrace ? await stopTrace() : null;
  const m1 = await metrics(cdp);
  const frames = await cdp.eval("window.__bench.frames.slice(1)");
  return { frame: stats(frames), over50ms: frames.filter((f) => f > 50).length, metrics: metricDelta(m0, m1), trace: traceSummary };
}

// ------------------------------------------------------------------ main

async function runDoc(docName, kind, webDir, loads, profile) {
  const { bytes } = prepareNotes(docName);
  const app = launchApp();
  const result = { doc: docName, bytes };
  let cdp;
  try {
    cdp = await Cdp.connect(await waitForTarget());
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    // Let the launch-time boot finish before the first reload; a reload that
    // interrupts startup can leave the page without an editor.
    const bootDeadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (!(await cdp.eval(`(() => { const pm = document.querySelector(".ProseMirror");
      return !!pm && (pm.childElementCount > 1 || (pm.firstElementChild?.textContent.length ?? 0) > 200); })()`, SETTLE_TIMEOUT_MS))) {
      if (Date.now() > bootDeadline) throw new Error("app never mounted the editor");
      await sleep(200);
    }
    await sleep(1000);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
    // Experiments: extra CSS applied to every load (e.g. content-visibility).
    const css = opt("css", null);
    if (css) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); });`,
      });
    }
    // Warm-up: the first boot builds the manifest cache and runs the one-time
    // image-asset migration, which a returning user does not pay again.
    await cdp.send("Page.reload");
    await sleep(500);
    await waitSettled(cdp);

    const runs = [];
    for (let i = 0; i < loads; i++) {
      const doProfile = profile && i === loads - 1;
      if (doProfile) await cdp.send("Profiler.start");
      await cdp.send("Page.reload");
      await sleep(300);
      const s = await waitSettled(cdp);
      const m = await metrics(cdp);
      const heap = await cdp.send("Runtime.getHeapUsage");
      const lt = await cdp.eval("window.__bench.longtasks.slice()");
      const images = kind === "images" ? await waitImages(cdp) : undefined;
      const run = {
        readyMs: +s.readyPainted.toFixed(1),
        settledMs: +Math.max(s.last, s.readyPainted).toFixed(1),
        longestTaskMs: +Math.max(0, ...lt.map(([, d]) => d)).toFixed(1),
        heapMB: +(heap.usedSize / 1048576).toFixed(1),
        nodes: m.Nodes,
        metrics: metricDelta({}, m),
        images,
      };
      if (doProfile) run.profile = summarizeProfile((await cdp.send("Profiler.stop")).profile, 40);
      runs.push(run);
    }
    result.load = runs;
    result.loadMedian = {
      readyMs: stats(runs.map((r) => r.readyMs)).p50,
      settledMs: stats(runs.map((r) => r.settledMs)).p50,
      longestTaskMs: stats(runs.map((r) => r.longestTaskMs)).p50,
      heapMB: runs.at(-1).heapMB,
      nodes: runs.at(-1).nodes,
    };

    // Experiments: a script run once after the load runs, before any scenario
    // (e.g. strip a kind of DOM node to see what a cost depends on).
    const evalJs = opt("eval", null);
    if (evalJs) result.evalResult = await cdp.eval(evalJs);
    // --shot <file.png>: a screenshot of the page after --eval.
    if (opt("shot", null)) {
      await sleep(500);
      writeFileSync(opt("shot"), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    if (flag("micro")) {
      result.micro = await microScenario(cdp);
      return result;
    }
    // Every top-level block's height as laid out (or, while skipped, as
    // remembered), for comparing two builds' geometry.
    if (flag("geometry")) {
      await sleep(500);
      result.geometry = await cdp.eval(`[...document.querySelector(".ProseMirror").children]
        .map((k) => +k.getBoundingClientRect().height.toFixed(2))`);
      result.skipping = await cdp.eval(`document.querySelector(".ProseMirror").classList.contains("noten-skip-offscreen")`);
      return result;
    }
    if (opt("visual", null)) {
      result.visual = await visualScenario(cdp, opt("visual"), docName);
      return result;
    }
    if (flag("nav")) {
      result.nav = await navScenario(cdp);
      if (opt("eval-after", null)) result.evalAfter = await cdp.eval(opt("eval-after"));
      return result;
    }
    const sel = CARET_TARGETS[kind] ?? CARET_TARGETS.default;
    const letters = "thequickbrownfoxjumpsoverthelazydog".split("");
    const trace = flag("trace");
    result.typing = await typingScenario(cdp, sel, letters, 110, profile, trace);
    result.enter = await typingScenario(cdp, sel, ["Enter", "a", "Enter", "b", "Enter", "c"], 200, false, trace);
    result.ime = await typingScenario(cdp, sel, "hangul", 90, profile, trace);
    result.scroll = await scrollScenario(cdp, trace);
    // Experiments: read back whatever an --eval hook recorded during the run.
    const evalAfter = opt("eval-after", null);
    if (evalAfter) result.evalAfter = await cdp.eval(evalAfter);
  } catch (e) {
    result.error = String(e?.message ?? e);
  } finally {
    cdp?.close();
    await killApp(app);
  }
  return result;
}

async function main() {
  if (flag("build")) { buildApp(); return; }
  if (opt("build-web", null)) { buildWeb(opt("build-web")); return; }
  if (!existsSync(EXE)) throw new Error(`missing ${EXE}; run with --build`);
  const manifest = JSON.parse(readFileSync(join(DOCS, "manifest.json"), "utf8")).filter((m) => m.kind !== "image");
  const kinds = opt("docs", null)?.split(",");
  const sizes = opt("sizes", "100k,1m,10m").split(",");
  const webDir = join(CACHE, opt("web", "web"));
  const loads = Number(opt("loads", "3"));
  const profile = flag("profile");
  // --doc-file runs one Markdown file from anywhere instead of the corpus.
  const selected = docFile
    ? [{ name: basename(docFile, ".md"), kind: "file" }]
    : manifest.filter((m) => (!kinds || kinds.includes(m.kind)) && sizes.includes(m.size));

  const server = await serve(webDir);
  const outDir = join(CACHE, "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}${opt("tag", "") ? "-" + opt("tag") : ""}.json`);
  const all = [];
  try {
    for (const m of selected) {
      process.stdout.write(`${m.name} ... `);
      const r = await runDoc(m.name, m.kind, webDir, loads, profile);
      all.push(r);
      writeFileSync(outFile, JSON.stringify(all, null, 2));
      if (r.error) console.log(`ERROR ${r.error}`);
      else if (r.micro || r.nav || r.visual || r.geometry) console.log(`ready ${r.loadMedian.readyMs}ms | ${JSON.stringify(r.micro ?? r.nav ?? r.visual ?? { blocks: r.geometry.length, skipping: r.skipping })}`);
      else console.log(`ready ${r.loadMedian.readyMs}ms settled ${r.loadMedian.settledMs}ms`
        + ` | type p50 ${r.typing.latency?.p50} p95 ${r.typing.latency?.p95}`
        + ` | enter p95 ${r.enter.latency?.p95} | autosave ${r.typing.autosave?.longest}ms`
        + ` | scroll p95 ${r.scroll.frame?.p95}`);
    }
  } finally {
    server.close();
  }
  console.log(`results: ${outFile}`);
}

await main();
