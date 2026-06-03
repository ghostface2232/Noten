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
