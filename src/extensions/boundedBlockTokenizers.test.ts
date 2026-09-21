import { describe, it, expect, afterAll } from "vitest";
import { Marked } from "marked";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { createFastMarked } from "./fastMarkdownLexer";
import { __test } from "./boundedBlockTokenizers";

// The bounded tokenizers must be observationally identical to Tiptap's own:
// same token tree (marked advances by each token's `raw`, so any difference in
// what a tokenizer consumed shows up here) and same parsed document. The
// reference instance is createFastMarked WITHOUT the bounding, so the only
// variable is the bounding itself.

const editors: Editor[] = [];
function makeEditor(marked: unknown): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ marked: marked as any }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table,
      TableRow,
      TableCell,
      TableHeader,
    ],
  });
  editors.push(editor);
  return editor;
}
afterAll(() => editors.forEach((e) => e.destroy()));

const boundedMarked = createFastMarked();
const referenceMarked = createFastMarked({ boundBlockTokenizers: false });
const bounded = makeEditor(boundedMarked);
const reference = makeEditor(referenceMarked);

function tokens(marked: unknown, md: string) {
  return JSON.parse(JSON.stringify((marked as Marked).lexer(md)));
}

// A throw is an outcome too: both sides must throw the same error or neither.
function outcome<T>(run: () => T): { ok: T } | { error: string } {
  try {
    return { ok: run() };
  } catch (err) {
    return { error: String(err) };
  }
}

function expectEquivalent(md: string) {
  const expected = outcome(() => tokens(referenceMarked, md));
  const actual = outcome(() => tokens(boundedMarked, md));
  if ("error" in expected !== "error" in actual) {
    throw new Error(`divergence on ${JSON.stringify(md)}: ${JSON.stringify(expected).slice(0, 200)} vs ${JSON.stringify(actual).slice(0, 200)}`);
  }
  expect(actual).toEqual(expected);
  expect(outcome(() => bounded.markdown!.parse(md))).toEqual(outcome(() => reference.markdown!.parse(md)));
}

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

// Line shapes that sit on every cut rule's boundary: markers at column 0 and
// indented, markers that almost match, blank lines of every whitespace kind,
// lazy continuations, interrupters, and table rows/separators.
const LINES = [
  "- [ ] task", "- [x] done", "* [X] star task", "+ [ ] plus task", "  - [ ] nested task", "    - [x] deep task",
  "\t- [ ] tab task", "- [] not a task", "-[ ] no space", "- plain bullet", "  - nested bullet", "* star bullet",
  "1. one", "2) two", "10. ten", "  1. nested one", "a. alpha", "B) beta", "iv. roman", "xii) roman2",
  "ab. two letters", "abc. three letters", "1.no space", "Mr. Smith said", "I) interrupt", "(216) 555-1234",
  "Fig. 1 caption", "Vol. 2", "1a. x", "ABC) x",
  "paragraph text", "Another line", "lazy continuation", "   indented text", "\tindented tab",
  "", "", "", "   ", "\t", " ", " 　 ",
  "# Heading", "## Sub", "```", "```ts", "~~~", "> quote", "---", "***",
  "| a | b |", "|---|---|", "| 1 | 2 |", "a | b", "--- | ---", "1 | 2", "| x \\| y | z |", ":--|--:",
  "text with | pipe", "[[wiki link]]", "**bold** start",
];

function randomDoc(rand: () => number, lineCount: number, crlf: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < lineCount; i++) out.push(LINES[Math.floor(rand() * LINES.length)]);
  const doc = out.join(crlf ? "\r\n" : "\n");
  return rand() < 0.5 ? `${doc}\n` : doc;
}

describe("bounded block tokenizers", () => {
  it("match the unbounded tokenizers on hand-written boundary cases", () => {
    const cases = [
      "- [ ] a\n- [x] b\n\nparagraph",
      "\n\n- [ ] after leading blanks\n",
      "- [ ] a\n\n  continued after blank\n- [ ] b\nnext",
      "- [ ] a\n\n\n- [ ] after blanks",
      "- [ ] a\n  - [ ] nested\n\n    deep continuation\ntext",
      "1. one\n2. two\n\nparagraph",
      "1. one\nlazy line\n2. two\n\n   indented after blank\ntext",
      "1. one\n\n\n2. two after blanks\n\nend",
      "a. alpha\nb. beta\n\nMr. Smith\n\ntext",
      "iv. four\n\nv) five",
      "| a | b |\n|---|---|\n| 1 | 2 |\n\npara",
      "a | b\n--- | ---\n1 | 2\ntext after table",
      "| x \\| y | z |\n|---|---|\n| 1 | 2 |",
      "para\n| a | b |\n|---|---|",
      "- [ ] a\r\n- [x] b\r\n\r\ntext\r\n",
      "1. one\r\n\r\ntext\r\n",
      "- [ ] a\n \ntext",
      "",
      "\n",
      "\n\n",
    ];
    for (const md of cases) expectEquivalent(md);
  });

  it("match the unbounded tokenizers on fuzzed documents", () => {
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < 1500; i++) {
      expectEquivalent(randomDoc(rand, 1 + Math.floor(rand() * 40), rand() < 0.15));
    }
  });

  it("match the unbounded tokenizers on fuzzed documents without blank lines", () => {
    // Blank lines end most constructs early; without them every cut rule has
    // to find its stopping line among markers, interrupters, and lazy text.
    const nonBlank = LINES.filter((line) => line.trim() !== "");
    const rand = mulberry32(0xb1a4c);
    for (let i = 0; i < 1500; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 40) }, () => nonBlank[Math.floor(rand() * nonBlank.length)]);
      expectEquivalent(lines.join("\n"));
    }
  });

  it("hand each tokenizer only the construct it can parse", () => {
    const tail = "\n\nnext paragraph".repeat(1000);
    expect(__test.boundTaskList(`plain paragraph${tail}`)).toBe("plain paragraph");
    expect(__test.boundTaskList(`- [ ] a\n- bullet${tail}`)).toBe("- [ ] a");
    expect(__test.boundOrderedList(`1. a\n# heading${tail}`)).toBe("1. a");
    expect(__test.boundTable(`a | b\nnot a separator${tail}`)).toBe("a | b\nnot a separator");
    expect(__test.boundTaskList(`- [ ] a\n- [ ] b${tail}`)).toBe("- [ ] a\n- [ ] b");
    expect(__test.boundOrderedList(`plain paragraph${tail}`)).toBe("plain paragraph");
    expect(__test.boundOrderedList(`1. a\n2. b${tail}`)).toBe("1. a\n2. b\n");
    expect(__test.boundTwoLines(`a\nb${tail}`)).toBe("a\nb");
    expect(__test.boundTable(`| a |\n|---|${tail}`)).toBe("| a |\n|---|");
  });

  it("parse many blocks in linear time", () => {
    // Each shape is roughly 0.3–0.7 MB. The unbounded tokenizers re-split the
    // whole remainder at every block (~10^10 characters each); bounded, each
    // parses quickly. The shapes without blank lines keep a tokenizer from
    // stopping early at "\n\n".
    const shapes = {
      paragraphs: Array.from({ length: 20000 }, (_, i) => `Paragraph ${i} with some words in it.`).join("\n\n"),
      headingThenText: "# Heading\ntext under it\n".repeat(15000),
      markerLines: "- a\n+ b\n---\n".repeat(15000),
      orderedThenHeading: "1. item\n# heading\n".repeat(15000),
      nearMissOrdered: "Fig. 1 caption text\n\n".repeat(20000),
    };
    for (const [name, md] of Object.entries(shapes)) {
      const started = performance.now();
      bounded.markdown!.parse(md);
      expect(performance.now() - started, name).toBeLessThan(5000);
    }
  });
});
