// Builds the benchmark corpus: real public-domain text (Project Gutenberg
// novels, English and Korean Wikipedia) and synthetic extreme documents, each
// at 100 KiB / 1 MiB / 10 MiB of UTF-8 Markdown.
//
//   node bench/corpus.mjs            # download what is missing, then generate
//   node bench/corpus.mjs --offline  # generate from the cached downloads only
//
// Downloads land in <cache>/raw, documents in <cache>/docs, where <cache> is
// $NOTEN_BENCH_CACHE or %LOCALAPPDATA%
oten-bench. Generation is deterministic (seeded PRNG), so two machines that
// hold the same downloads produce byte-identical documents.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const ROOT = dirname(fileURLToPath(import.meta.url));
// Outside the repository: the repo may live in a synced folder (OneDrive), and
// the corpus plus a release build are several GB.
export const CACHE = process.env.NOTEN_BENCH_CACHE
  ?? join(process.env.LOCALAPPDATA ?? join(ROOT, ".."), "noten-bench");
const RAW = join(CACHE, "raw");
const OUT = join(CACHE, "docs");
const OFFLINE = process.argv.includes("--offline");

export const SIZES = { "100k": 100 * 1024, "1m": 1024 * 1024, "10m": 10 * 1024 * 1024 };

const GUTENBERG = [
  { id: 2600, file: "pg2600_war_and_peace.txt" },
  { id: 1342, file: "pg1342_pride.txt" },
  { id: 1661, file: "pg1661_sherlock.txt" },
];
const WIKI_EN = [
  "World War II", "United States", "Computer", "History of China", "Roman Empire",
  "Linux", "JavaScript", "Albert Einstein", "Climate change", "COVID-19 pandemic",
  "Mathematics", "Byzantine Empire", "Python (programming language)", "Isaac Newton", "India",
];
const WIKI_KO = [
  "대한민국", "조선", "세종", "고려", "한국어", "서울특별시", "임진왜란", "한국 전쟁",
  "훈민정음", "삼국시대", "일본", "중국", "미국", "컴퓨터", "수학", "제2차 세계 대전",
];
const UA = "NotenBench/1.0 (performance corpus; contact via github.com/ghostface2232)";

function wikiFile(lang, title) {
  return join(RAW, "wiki", `${lang}_${title.replace(/[ ()]/g, "_")}.json`);
}

async function download() {
  mkdirSync(join(RAW, "wiki"), { recursive: true });
  for (const { id, file } of GUTENBERG) {
    const path = join(RAW, file);
    if (existsSync(path)) continue;
    const res = await fetch(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`gutenberg ${id}: HTTP ${res.status}`);
    writeFileSync(path, await res.text(), "utf8");
    console.log(`downloaded ${file}`);
  }
  for (const [lang, titles] of [["en", WIKI_EN], ["ko", WIKI_KO]]) {
    for (const title of titles) {
      const path = wikiFile(lang, title);
      if (existsSync(path)) continue;
      const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
      for (const [k, v] of Object.entries({
        action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki",
        format: "json", redirects: "1", titles: title,
      })) url.searchParams.set(k, v);
      let res;
      // Wikipedia rate-limits anonymous API bursts with 429; back off politely.
      for (let attempt = 0; ; attempt++) {
        res = await fetch(url, { headers: { "User-Agent": UA } });
        if (res.status !== 429 || attempt === 5) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
      if (!res.ok) throw new Error(`wikipedia ${lang}:${title}: HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 1000));
      writeFileSync(path, await res.text(), "utf8");
      console.log(`downloaded ${lang}:${title}`);
    }
  }
}

// ---------------------------------------------------------------- real text

function gutenbergToMarkdown(text) {
  const start = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/);
  const end = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/);
  let body = text.slice(start >= 0 ? text.indexOf("\n", start) + 1 : 0, end >= 0 ? end : text.length);
  body = body.replace(/\r\n/g, "\n");
  const blocks = [];
  for (const raw of body.split(/\n{2,}/)) {
    // Gutenberg hard-wraps at ~70 columns; unwrap into one paragraph, which is
    // what a note holding pasted prose looks like.
    const para = raw.split("\n").map((l) => l.trim()).join(" ").trim();
    if (!para) continue;
    if (/^(CHAPTER|BOOK|VOLUME|EPILOGUE|PART)\b[^a-z]{0,60}$/.test(para) || /^Chapter [0-9IVXLC]+\.?$/.test(para)) {
      blocks.push(`## ${para}`);
    } else if (/^[IVXLC]+\. [A-Z][A-Z .'-]+$/.test(para)) {
      blocks.push(`## ${para}`);
    } else {
      // Escape only what would otherwise turn prose into structure.
      blocks.push(para.replace(/^(\d+)\. /, "$1\\. ").replace(/^([-+*#>]) /, "\\$1 "));
    }
  }
  return blocks;
}

function wikiToMarkdown(json) {
  const pages = JSON.parse(json).query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page?.extract) return [];
  const blocks = [`# ${page.title}`];
  for (const raw of page.extract.replace(/\r\n/g, "\n").split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(={2,6})\s*(.*?)\s*\1$/.exec(line);
    if (h) {
      blocks.push(`${"#".repeat(Math.min(6, h[1].length))} ${h[2]}`);
      continue;
    }
    blocks.push(line.replace(/^(\d+)\. /, "$1\\. ").replace(/^([-+*#>]) /, "\\$1 "));
  }
  return blocks;
}

// Repeat a block source until the byte budget is reached. Cuts on a block
// boundary so no Markdown construct is split; the result is within one block
// of the target size.
function fill(target, nextBlock) {
  const parts = [];
  let bytes = 0;
  for (;;) {
    const block = nextBlock();
    const size = Buffer.byteLength(block, "utf8") + 2;
    if (bytes + size > target && bytes > 0) break;
    parts.push(block);
    bytes += size;
  }
  return parts.join("\n\n") + "\n";
}

function cycle(blocks) {
  let i = 0;
  return () => blocks[i++ % blocks.length];
}

// ---------------------------------------------------------------- synthetic

let seed = 0x2f6e2b1;
function reseed(value) { seed = value; }
function rand() {
  seed = (seed * 48271) % 0x7fffffff;
  return seed / 0x7fffffff;
}
function int(lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }
function pick(list) { return list[Math.floor(rand() * list.length) % list.length]; }

const WORDS_EN = ("the quick brown fox jumps over lazy dog editor latency paragraph render state "
  + "transaction schema document markdown parser layout paint frame budget cache token inline block "
  + "selection cursor history undo commit sync folder note window thread memory buffer index").split(" ");
const WORDS_KO = ("문서 편집 지연 문단 렌더링 상태 트랜잭션 스키마 마크다운 파서 레이아웃 페인트 프레임 예산 "
  + "캐시 토큰 인라인 블록 선택 커서 기록 실행취소 커밋 동기화 폴더 노트 창 메모리 버퍼 색인 한글 입력").split(" ");

function sentence(minWords, maxWords, inline = false) {
  const n = int(minWords, maxWords);
  const out = [];
  for (let i = 0; i < n; i++) {
    let w = rand() < 0.3 ? pick(WORDS_KO) : pick(WORDS_EN);
    if (inline) {
      const r = rand();
      if (r < 0.04) w = `**${w}**`;
      else if (r < 0.08) w = `*${w}*`;
      else if (r < 0.11) w = `\`${w}()\``;
      else if (r < 0.13) w = `[${w}](https://example.com/${w})`;
      else if (r < 0.14) w = `[[${w} note]]`;
      else if (r < 0.15) w = `~~${w}~~`;
    }
    out.push(w);
  }
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function paragraph(inline = true) {
  const n = int(2, 6);
  return Array.from({ length: n }, () => sentence(6, 18, inline)).join(" ");
}

const CODE_SNIPPETS = {
  ts: (i) => [
    `export function handle${i}(state: EditorState, tr: Transaction): EditorState {`,
    `  const next = state.apply(tr);`,
    `  if (next.doc.childCount > ${i % 97}) {`,
    `    console.log("blocks", next.doc.childCount, ${JSON.stringify(sentence(3, 6))});`,
    `  }`,
    `  return next;`,
    `}`,
  ],
  python: (i) => [
    `def measure_${i}(samples: list[float]) -> dict:`,
    `    """${sentence(4, 8)}"""`,
    `    ordered = sorted(samples)`,
    `    p95 = ordered[int(len(ordered) * 0.95)]`,
    `    return {"p50": ordered[len(ordered) // 2], "p95": p95, "n": ${i}}`,
  ],
  rust: (i) => [
    `fn atomic_write_${i}(path: &Path, bytes: &[u8]) -> io::Result<()> {`,
    `    let tmp = path.with_extension("tmp");`,
    `    fs::write(&tmp, bytes)?;`,
    `    fs::rename(&tmp, path) // ${sentence(3, 5)}`,
    `}`,
  ],
  json: (i) => [
    `{`,
    `  "id": ${i},`,
    `  "title": ${JSON.stringify(sentence(2, 5))},`,
    `  "tags": ["bench", "noten", "${pick(WORDS_EN)}"],`,
    `  "pinned": ${i % 2 === 0}`,
    `}`,
  ],
  bash: (i) => [
    `for f in notes/*.md; do`,
    `  wc -c "$f" | awk '{ s += $1 } END { print s, ${i} }'`,
    `done`,
  ],
};

function codeBlock(i, lines = int(1, 3)) {
  const lang = pick(Object.keys(CODE_SNIPPETS));
  const body = [];
  for (let k = 0; k < lines; k++) body.push(...CODE_SNIPPETS[lang](i * 10 + k));
  return ["```" + lang, ...body, "```"].join("\n");
}

function list(depth = 0, i = 0) {
  const lines = [];
  const ordered = rand() < 0.3;
  const task = !ordered && rand() < 0.4;
  const n = int(2, 6);
  for (let k = 0; k < n; k++) {
    const marker = ordered ? `${k + 1}.` : task ? `- [${rand() < 0.5 ? "x" : " "}]` : "-";
    lines.push(`${"   ".repeat(depth)}${marker} ${sentence(3, 12, true)}`);
    if (depth < 3 && rand() < 0.35) lines.push(list(depth + 1, i));
  }
  return lines.join("\n");
}

function table(rows = int(3, 10), cols = int(3, 6)) {
  const header = "| " + Array.from({ length: cols }, (_, c) => `Col ${c + 1}`).join(" | ") + " |";
  const sep = "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
  const body = Array.from({ length: rows }, () =>
    "| " + Array.from({ length: cols }, () => sentence(1, 4)).join(" | ") + " |");
  return [header, sep, ...body].join("\n");
}

const NOTE_ID = "bench-note";
export const IMAGE_VARIANTS = [
  { w: 320, h: 200, noise: 2 },
  { w: 800, h: 450, noise: 2 },
  { w: 1280, h: 720, noise: 2 },
  { w: 1600, h: 1000, noise: 3 },
];

function imageRef(i) {
  // Every reference is a distinct asset path (as distinct pastes would be);
  // the bench FS maps each path onto one of IMAGE_VARIANTS by index.
  const hash = createHash("sha1").update(`img${i}`).digest("hex").slice(0, 16);
  return `![image ${i}](.assets/${NOTE_ID}/${hash}-v${i % IMAGE_VARIANTS.length}.png)`;
}

const GENERATORS = {
  paragraphs: () => () => sentence(4, 10),
  "one-paragraph": () => {
    // A single paragraph: soft line breaks, never a blank line.
    return (target) => {
      const lines = [];
      let bytes = 0;
      while (bytes < target) {
        const l = sentence(8, 16, true);
        lines.push(l);
        bytes += Buffer.byteLength(l, "utf8") + 1;
      }
      return lines.join("\n") + "\n";
    };
  },
  "one-line": () => (target) => {
    const parts = [];
    let bytes = 0;
    while (bytes < target) {
      const l = sentence(8, 16, true);
      parts.push(l);
      bytes += Buffer.byteLength(l, "utf8") + 1;
    }
    return parts.join(" ") + "\n";
  },
  lists: () => { let i = 0; return () => list(0, i++); },
  headings: () => {
    let i = 0;
    return () => {
      i++;
      return i % 2 === 0 ? `${"#".repeat(1 + (i % 6))} ${sentence(2, 6)}` : sentence(6, 14, true);
    };
  },
  code: () => { let i = 0; return () => (i++ % 3 === 2 ? sentence(6, 14) : codeBlock(i)); },
  tables: () => { let i = 0; return () => (i++ % 2 === 0 ? table() : sentence(6, 14)); },
  mixed: () => {
    let i = 0;
    return () => {
      i++;
      const r = rand();
      if (i % 25 === 1) return `## ${sentence(2, 6)}`;
      if (r < 0.55) return paragraph();
      if (r < 0.7) return list();
      if (r < 0.8) return codeBlock(i);
      if (r < 0.85) return table(int(2, 5), int(2, 4));
      if (r < 0.92) return `> ${sentence(8, 20, true)}`;
      if (r < 0.95) return "---";
      return `### ${sentence(2, 5)}`;
    };
  },
  images: () => {
    let i = 0;
    let img = 0;
    // One image per ~2 KiB of surrounding prose.
    return () => (i++ % 5 === 4 ? imageRef(img++) : paragraph());
  },
};

// ---------------------------------------------------------------- PNG assets

function crc32(buf) {
  let c;
  const table = crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(w, h, noise) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const n = Math.floor(rand() * noise);
      raw[o++] = (x * 255 / w + n) & 255;
      raw[o++] = (y * 255 / h + n) & 255;
      raw[o++] = (((x >> 5) ^ (y >> 5)) & 1 ? 200 : 60) + n;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- main

async function main() {
  if (!OFFLINE) await download();
  mkdirSync(OUT, { recursive: true });

  const novel = GUTENBERG.flatMap(({ file }) => gutenbergToMarkdown(readFileSync(join(RAW, file), "utf8")));
  const wikiBlocks = (lang, titles) => titles.flatMap((t) => {
    const path = wikiFile(lang, t);
    return existsSync(path) ? wikiToMarkdown(readFileSync(path, "utf8")) : [];
  });
  const wikiEn = wikiBlocks("en", WIKI_EN);
  const wikiKo = wikiBlocks("ko", WIKI_KO);
  if (wikiKo.length === 0) throw new Error("no Korean Wikipedia text; run without --offline");

  const manifest = [];
  const write = (kind, sizeKey, markdown) => {
    const name = `${kind}-${sizeKey}`;
    writeFileSync(join(OUT, `${name}.md`), markdown, "utf8");
    manifest.push({ name, kind, size: sizeKey, bytes: Buffer.byteLength(markdown, "utf8") });
  };

  for (const [sizeKey, target] of Object.entries(SIZES)) {
    write("novel-en", sizeKey, fill(target, cycle(novel)));
    write("wiki-en", sizeKey, fill(target, cycle(wikiEn)));
    write("wiki-ko", sizeKey, fill(target, cycle(wikiKo)));
    for (const [kind, make] of Object.entries(GENERATORS)) {
      reseed(0x2f6e2b1 + kind.length * 7919);
      const gen = make();
      // One-block generators take the byte target directly.
      const markdown = gen.length === 1 ? gen(target) : fill(target, gen);
      write(kind, sizeKey, markdown);
    }
  }

  const imgDir = join(OUT, "img");
  mkdirSync(imgDir, { recursive: true });
  reseed(12345);
  IMAGE_VARIANTS.forEach(({ w, h, noise }, i) => {
    const buf = png(w, h, noise);
    writeFileSync(join(imgDir, `v${i}.png`), buf);
    manifest.push({ name: `img-v${i}`, kind: "image", w, h, bytes: buf.length });
  });

  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const m of manifest) console.log(`${m.name.padEnd(22)} ${(m.bytes / 1024).toFixed(1).padStart(10)} KiB`);
}

await main();
