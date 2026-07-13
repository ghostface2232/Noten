import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import WikiLink from "../extensions/WikiLink";
import {
  activeHeadingIndex,
  clampOutlinePos,
  extractHeadings,
  headingsSignature,
  outlineIndentDepth,
} from "./outline";

let active: Editor | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

function makeEditor(content: string) {
  const editor = new Editor({ extensions: [StarterKit, WikiLink], content });
  active = editor;
  return editor;
}

describe("extractHeadings", () => {
  it("extracts text, level, and pos in document order for mixed levels", () => {
    const editor = makeEditor(
      "<h1>Alpha</h1><p>body</p><h2>Beta</h2><h4>Gamma</h4><p>more</p><h1>Delta</h1>",
    );
    const headings = extractHeadings(editor.state.doc);

    expect(headings.map((h) => h.text)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 4, 1]);
    // Positions are strictly ascending and point at heading nodes.
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i].pos).toBeGreaterThan(headings[i - 1].pos);
    }
    for (const h of headings) {
      expect(editor.state.doc.nodeAt(h.pos)?.type.name).toBe("heading");
    }
  });

  it("returns an empty array for a document without headings", () => {
    const editor = makeEditor("<p>just</p><p>paragraphs</p>");
    expect(extractHeadings(editor.state.doc)).toEqual([]);
  });

  it("includes empty headings with empty text", () => {
    const editor = makeEditor("<h1>Title</h1><h2></h2><p>body</p>");
    const headings = extractHeadings(editor.state.doc);
    expect(headings).toHaveLength(2);
    expect(headings[1].text).toBe("");
    expect(headings[1].level).toBe(2);
  });

  it("finds headings nested inside block containers", () => {
    // The traversal skips into non-heading textblocks but must still descend
    // through block containers like blockquote, which can hold headings.
    const editor = makeEditor(
      "<h1>Top</h1><blockquote><p>quote</p><h2>Quoted</h2></blockquote><p>tail</p>",
    );
    const headings = extractHeadings(editor.state.doc);
    expect(headings.map((h) => h.text)).toEqual(["Top", "Quoted"]);
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
    expect(editor.state.doc.nodeAt(headings[1].pos)?.type.name).toBe("heading");
  });

  it("flattens inline marks (bold, code, wiki link) to plain text", () => {
    const editor = makeEditor(
      "<h2>see <strong>bold</strong> and <code>code()</code> and [[Target]]</h2>",
    );
    const headings = extractHeadings(editor.state.doc);
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toBe("see bold and code() and [[Target]]");
  });
});

describe("headingsSignature — setState-skip comparison", () => {
  it("is identical when a doc change leaves every heading's level/text/pos intact", () => {
    // Editing paragraph text *after* the last heading changes the doc but no
    // heading — the panel must be able to detect this and skip setState.
    const before = makeEditor("<h1>One</h1><h2>Two</h2><p>tail</p>");
    const sigBefore = headingsSignature(extractHeadings(before.state.doc));
    before.destroy();
    const after = makeEditor("<h1>One</h1><h2>Two</h2><p>tail edited</p>");
    const sigAfter = headingsSignature(extractHeadings(after.state.doc));
    expect(sigAfter).toBe(sigBefore);
  });

  it("differs when text, level, or pos changes", () => {
    const base = headingsSignature([{ text: "One", level: 1, pos: 0 }]);
    expect(headingsSignature([{ text: "One!", level: 1, pos: 0 }])).not.toBe(base);
    expect(headingsSignature([{ text: "One", level: 2, pos: 0 }])).not.toBe(base);
    expect(headingsSignature([{ text: "One", level: 1, pos: 4 }])).not.toBe(base);
  });

  it("does not collide when adjacent fields shift between entries", () => {
    // Same concatenated characters, different split across headings.
    const a = headingsSignature([{ text: "AB", level: 1, pos: 0 }, { text: "C", level: 1, pos: 5 }]);
    const b = headingsSignature([{ text: "A", level: 1, pos: 0 }, { text: "BC", level: 1, pos: 5 }]);
    expect(a).not.toBe(b);
  });
});

describe("activeHeadingIndex", () => {
  const headings = [
    { text: "One", level: 1, pos: 0 },
    { text: "Two", level: 2, pos: 20 },
    { text: "Three", level: 2, pos: 40 },
  ];

  it("returns -1 when the caret sits before the first heading", () => {
    expect(activeHeadingIndex([], 10)).toBe(-1);
    expect(activeHeadingIndex([{ text: "H", level: 1, pos: 8 }], 3)).toBe(-1);
  });

  it("returns the last heading at or before the selection head", () => {
    expect(activeHeadingIndex(headings, 1)).toBe(0);
    expect(activeHeadingIndex(headings, 19)).toBe(0);
    expect(activeHeadingIndex(headings, 20)).toBe(1);
    expect(activeHeadingIndex(headings, 39)).toBe(1);
    expect(activeHeadingIndex(headings, 999)).toBe(2);
  });
});

describe("clampOutlinePos — stale jump positions never throw", () => {
  it("passes in-range positions through unchanged", () => {
    expect(clampOutlinePos(5, 100)).toBe(5);
    expect(clampOutlinePos(0, 100)).toBe(0);
    expect(clampOutlinePos(100, 100)).toBe(100);
  });

  it("clamps positions beyond the document to doc.content.size", () => {
    expect(clampOutlinePos(250, 100)).toBe(100);
  });

  it("clamps negative positions to 0", () => {
    expect(clampOutlinePos(-3, 100)).toBe(0);
  });

  it("resolves without throwing after a stale-pos clamp against a real doc", () => {
    const editor = makeEditor("<h1>Title</h1><p>body</p>");
    const size = editor.state.doc.content.size;
    const stale = size + 40;
    const clamped = clampOutlinePos(stale, size);
    // The jump path resolves the clamped pos — must not throw.
    expect(() => editor.state.doc.resolve(clamped)).not.toThrow();
  });
});

describe("outlineIndentDepth", () => {
  it("indents h1/h2/h3 progressively and clamps h4-h6 to the h3 depth", () => {
    expect(outlineIndentDepth(1)).toBe(0);
    expect(outlineIndentDepth(2)).toBe(1);
    expect(outlineIndentDepth(3)).toBe(2);
    expect(outlineIndentDepth(4)).toBe(2);
    expect(outlineIndentDepth(6)).toBe(2);
  });
});
