import { describe, it, expect, afterEach } from "vitest";
import { marked, Lexer } from "marked";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { createFastMarked, fastLex, FastLexer } from "./fastMarkdownLexer";

// FastLexer must produce byte-identical tokens to stock marked — it only
// changes *how fast* the inline mask is built, never *what* is parsed. These
// tests pin that equivalence (and would fail if a marked upgrade reshaped the
// inline loop we transcribe) and verify the O(n²) blowup is gone.

// marked tokens carry the source `raw`, so deep-equal on the token tree is a
// strict check on parsing behavior.
function stockTokens(md: string) {
  return JSON.parse(JSON.stringify(Lexer.lex(md)));
}
function fastTokens(md: string) {
  return JSON.parse(JSON.stringify(fastLex(md)));
}
function expectEquivalent(md: string) {
  expect(fastTokens(md)).toEqual(stockTokens(md));
}

// Deterministic PRNG so fuzz failures reproduce (Math.random would not).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fragments chosen to exercise every masking rule and their adjacencies: the
// block-skip rule (code / links / HTML), escaped punctuation, emphasis,
// strikethrough, autolinks, raw URLs, and boundary cases where one masked span
// abuts the next.
const FRAGMENTS = [
  "plain words ",
  "**bold** ",
  "_em_ ",
  "*em2* ",
  "~~strike~~ ",
  "`code` ",
  "``co`de`` ",
  "[link](http://example.com) ",
  "[ref][1] ",
  "<http://example.com> ",
  "<span class=\"x\">html</span> ",
  "http://raw.example.com/path ",
  "user@example.com ",
  "\\* \\_ \\` \\[ \\] \\( escaped ",
  "a\\*b\\_c ",
  "`code`**bold** ",
  "[a](x)`b`[c](y) ",
  "![img](http://e.com/i.png) ",
  "mix `c` and [l](u) and \\* and <b>t</b> ",
  "trailing backticks ``` ",
  "nested **_bold em_** ",
  "& < > entities ",
  "emoji 😀 and \\😀 ",
  "\n",
  "\n\n",
];

function randomDoc(rand: () => number): string {
  const count = 1 + Math.floor(rand() * 40);
  let out = "";
  for (let i = 0; i < count; i++) {
    out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
  }
  return out;
}

describe("FastLexer equivalence with stock marked", () => {
  it("matches on a set of hand-picked tricky inputs", () => {
    const cases = [
      "",
      "hello world",
      "**bold** and _em_ and `code` and [link](http://x.io)",
      // adjacency: code span immediately followed by code span (block-skip
      // lookbehind boundary)
      "`a``b``c`",
      "[a](1)[b](2)[c](3)",
      "code `x` then <i>html</i> then [l](u) then \\*esc\\*",
      // a single block dense with escapes (the worst quadratic case, small here)
      "\\*".repeat(200),
      "`x`".repeat(200),
      "[a](b)".repeat(200),
      "<b>".repeat(200),
      "reference [a][a]\n\n[a]: http://example.com",
      "> blockquote with `code` and [link](u)\n> more",
      "- item with **bold**\n- item with `code`",
      "| a | b |\n| - | - |\n| `c` | [l](u) |",
      "line with two spaces  \nhard break",
      "autolink <https://x.io> and url https://y.io/a?b=c#d",
    ];
    for (const md of cases) expectEquivalent(md);
  });

  it("matches stock marked across 3000 randomized documents", () => {
    const rand = mulberry32(0x1234abcd);
    for (let i = 0; i < 3000; i++) {
      const md = randomDoc(rand);
      const fast = fastTokens(md);
      const stock = stockTokens(md);
      // Surface the offending document on failure instead of a giant diff.
      if (JSON.stringify(fast) !== JSON.stringify(stock)) {
        throw new Error(`Divergence on document #${i}:\n${JSON.stringify(md)}`);
      }
    }
  });

  it("matches stock marked on large single-block inputs", () => {
    const block =
      "word `code` and [link](http://example.com) and \\*esc\\* and <b>tag</b> ".repeat(2000);
    expectEquivalent(block);
  });
});

describe("FastLexer performance", () => {
  // The whole point: a huge single block that is dense with masked spans must
  // lex in roughly linear time. Stock marked takes ~10s+ on this input; the
  // fast lexer should be well under a second. Generous threshold to stay stable
  // across CI hardware while still catching a regression to O(n²).
  function giantBlock(approxChars: number, unit: string): string {
    let out = "";
    while (out.length < approxChars) out += unit;
    return out.slice(0, approxChars);
  }

  it("lexes a 1M-char code-span block far faster than quadratic", () => {
    const md = giantBlock(1_000_000, "a `code` b ");
    const start = performance.now();
    fastLex(md);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("lexes a 1M-char escape block far faster than quadratic", () => {
    const md = giantBlock(1_000_000, "a \\* b \\_ ");
    const start = performance.now();
    fastLex(md);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("createFastMarked", () => {
  it("exposes a FastLexer-derived instance Lexer and routes lexer()", () => {
    const instance = createFastMarked();
    // The instance Lexer is a FastLexer subclass bound to instance.defaults, so
    // the manager's no-arg `new markedInstance.Lexer()` inherits this instance's
    // configuration (GFM task lists etc.) instead of marked's bare globals.
    const LexerClass = (instance as unknown as { Lexer: new () => unknown }).Lexer;
    expect(new LexerClass()).toBeInstanceOf(FastLexer);
    // The injected instance must lex equivalently to the stock singleton.
    const md = "**b** `c` [l](http://x.io) \\* <b>t</b>";
    const viaInstance = JSON.parse(JSON.stringify(instance.lexer(md)));
    const viaStock = JSON.parse(JSON.stringify(marked.lexer(md)));
    expect(viaInstance).toEqual(viaStock);
  });
});

describe("Markdown extension integration", () => {
  let editors: Editor[] = [];
  afterEach(() => {
    editors.forEach((e) => e.destroy());
    editors = [];
  });

  function parseToDoc(md: string, marked?: ReturnType<typeof createFastMarked>) {
    const editor = new Editor({
      extensions: [
        StarterKit,
        marked ? Markdown.configure({ marked }) : Markdown,
        TaskList,
        TaskItem.configure({ nested: true }),
      ],
      content: md,
      contentType: "markdown",
    } as ConstructorParameters<typeof Editor>[0]);
    editors.push(editor);
    return editor.getJSON();
  }

  it("parses markdown through the injected fast marked identically to the default", () => {
    const fast = createFastMarked();
    const cases = [
      "# Heading\n\nA paragraph with **bold**, _em_, `code`, and [a link](http://example.com).",
      "- one\n- two `code`\n- three [l](u)",
      "> quote with \\*escaped\\* and <http://auto.link>",
      "```\ncode block\n```\n\ntext after",
      "Para one with a `span` and a [ref][r].\n\n[r]: http://example.com",
      "Inline html <strong>x</strong> and an escape \\# here.",
      // Task lists must round-trip to a `taskList` node, not degrade to a
      // `bulletList` with raw text in its `listItem` (schema-invalid, crashes
      // on the first edit). Regression guard for the bound-Lexer fix.
      "- [ ] todo\n- [x] done",
      "- [ ] parent\n  - [ ] nested child",
      "- [ ] first line\n  continuation line",
    ];
    for (const md of cases) {
      expect(parseToDoc(md, fast)).toEqual(parseToDoc(md));
    }
  });
});
