import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  findSearchMatches,
  selectMatchesToDecorate,
  type SearchMatch,
} from "./SearchHighlight";

function docFromText(text: string) {
  const editor = new Editor({ extensions: [StarterKit], content: `<p>${text}</p>` });
  return { editor, doc: editor.state.doc };
}

let active: Editor | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

describe("findSearchMatches", () => {
  it("returns nothing for an empty query", () => {
    const { editor, doc } = docFromText("hello world");
    active = editor;
    expect(findSearchMatches(doc, "")).toEqual([]);
  });

  it("finds every non-overlapping occurrence", () => {
    const { editor, doc } = docFromText("ababab");
    active = editor;
    const matches = findSearchMatches(doc, "ab");
    expect(matches.length).toBe(3);
    expect(matches[0].to - matches[0].from).toBe(2);
  });

  it("is case-insensitive", () => {
    const { editor, doc } = docFromText("Hello HELLO hello");
    active = editor;
    expect(findSearchMatches(doc, "hello").length).toBe(3);
  });

  it("returns the true total count, not a decoration-capped subset", () => {
    // Well above SEARCH_DECORATION_CAP (2000) but below the hard limit.
    const { editor, doc } = docFromText("a ".repeat(2500));
    active = editor;
    expect(findSearchMatches(doc, "a").length).toBe(2500);
  });

  it("reports offsets in original-string space even after length-changing case folding", () => {
    // "İ".toLowerCase() is "i̇" (two code units) — the old lowercase-index
    // implementation shifted every later match by one per İ, so Replace
    // deleted the wrong characters.
    const { editor, doc } = docFromText("İİİ target");
    active = editor;
    const matches = findSearchMatches(doc, "target");
    expect(matches.length).toBe(1);
    // <p> content starts at pos 1; "İİİ " is 4 chars in the original string.
    expect(matches[0].from).toBe(1 + 4);
    expect(matches[0].to).toBe(1 + 4 + "target".length);
    expect(doc.textBetween(matches[0].from, matches[0].to)).toBe("target");
  });

  it("treats regex metacharacters in the query as literals", () => {
    const { editor, doc } = docFromText("price (USD) is 3.50");
    active = editor;
    expect(findSearchMatches(doc, "(USD)").length).toBe(1);
    expect(findSearchMatches(doc, "3.50").length).toBe(1);
    expect(findSearchMatches(doc, "3x50").length).toBe(0);
  });

  it("finds a phrase that spans mark boundaries (mixed formatting)", () => {
    // "quick brown" with "brown" bold splits into two text nodes; per-node
    // search reported 0 matches for the phrase.
    const { editor, doc } = docFromText("the quick <strong>brown</strong> fox");
    active = editor;
    const matches = findSearchMatches(doc, "quick brown");
    expect(matches.length).toBe(1);
    expect(doc.textBetween(matches[0].from, matches[0].to)).toBe("quick brown");
  });

  it("keeps overlapping-match semantics", () => {
    const { editor, doc } = docFromText("aaa");
    active = editor;
    expect(findSearchMatches(doc, "aa").length).toBe(2);
  });
});

describe("selectMatchesToDecorate", () => {
  // Synthetic matches at positions 0,10,20,... so position N maps to index N/10.
  const make = (n: number): SearchMatch[] =>
    Array.from({ length: n }, (_, i) => ({ from: i * 10, to: i * 10 + 1 }));

  it("decorates everything when under the cap", () => {
    const indices = selectMatchesToDecorate(make(5), null, 0, 10);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns at most cap indices when over the cap", () => {
    const indices = selectMatchesToDecorate(make(100), null, 0, 10);
    expect(indices.length).toBe(10);
  });

  it("centres the window on the active match when no viewport is known", () => {
    const indices = selectMatchesToDecorate(make(100), null, 80, 10);
    expect(indices.length).toBe(10);
    expect(indices).toContain(80);
    // Window is centred, so it should straddle the anchor.
    expect(Math.min(...indices)).toBeLessThan(80);
    expect(Math.max(...indices)).toBeGreaterThanOrEqual(80);
  });

  it("tracks the visible range when a viewport is provided", () => {
    // Viewport spans positions 500..520 -> indices ~50..52.
    const indices = selectMatchesToDecorate(make(100), { from: 500, to: 520 }, 0, 10);
    expect(indices.length).toBe(10);
    expect(indices).toContain(50);
    expect(indices).toContain(52);
  });

  it("clamps the window to the end of the list", () => {
    const indices = selectMatchesToDecorate(make(100), { from: 990, to: 1000 }, 0, 10);
    expect(indices.length).toBe(10);
    expect(Math.max(...indices)).toBe(99);
  });
});
