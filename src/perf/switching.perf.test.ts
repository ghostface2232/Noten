import { describe, it, expect, afterAll } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  extractHeadings,
  headingsSignature,
  activeHeadingIndex,
} from "../utils/outline";
import { buildHeadingAnchors, filterHeadingAnchors } from "../utils/headingSlug";
import { buildLineIndex, countWords, lineToPos, posToLine } from "../utils/documentLines";
import { isProbablyMarkdown } from "../extensions/isProbablyMarkdown";
import { bestOfRuns, makeMarkdownBody } from "./perf.test-utils";

// Note-switch / per-frame UI performance guards. Switching to a note (or
// opening the outline panel, or moving the caret) recomputes these against the
// full ProseMirror document, and the status bar re-derives line/word state per
// update — on a long note each of them sits on the interaction path. The
// document build itself is untimed setup; jsdom construction cost is not what
// these guards bound. Budgets are ~10x a dev-machine measurement — see
// perf.test-utils.ts.

const SECTIONS = 300;
const PARAGRAPHS_PER_SECTION = 9;

function buildLargeDocHtml(): string {
  const parts: string[] = [];
  for (let i = 0; i < SECTIONS; i++) {
    parts.push(`<h2>Section ${i} heading</h2>`);
    for (let j = 0; j < PARAGRAPHS_PER_SECTION; j++) {
      parts.push(`<p>Paragraph ${j} of section ${i} with enough words to matter.</p>`);
    }
  }
  return parts.join("");
}

const editor = new Editor({ extensions: [StarterKit], content: buildLargeDocHtml() });
afterAll(() => editor.destroy());

describe("outline recomputation on a 3k-block note", () => {
  it("extracts and signs 300 headings within budget", () => {
    let headings: ReturnType<typeof extractHeadings> = [];
    const elapsed = bestOfRuns(() => {
      headings = extractHeadings(editor.state.doc);
      headingsSignature(headings);
    });
    expect(headings).toHaveLength(SECTIONS);
    // The outline effect runs this once per rAF while the panel is open, so
    // it must stay a small fraction of a 16ms frame on real hardware.
    expect(elapsed).toBeLessThan(150);
  });

  it("resolves the active heading for 1k caret positions within budget", () => {
    const headings = extractHeadings(editor.state.doc);
    const docSize = editor.state.doc.content.size;
    const elapsed = bestOfRuns(() => {
      for (let i = 0; i < 1_000; i++) {
        activeHeadingIndex(headings, (i * 131) % docSize);
      }
    });
    expect(elapsed).toBeLessThan(200);
  });

  it("builds and filters heading anchors for wiki-link suggestions within budget", () => {
    const headings = extractHeadings(editor.state.doc);
    let matches = 0;
    const elapsed = bestOfRuns(() => {
      const anchors = buildHeadingAnchors(headings);
      matches = filterHeadingAnchors(anchors, "section 1").length;
    });
    expect(matches).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("status bar derivation on a 3k-block note", () => {
  it("builds the line index and answers 2k position lookups within budget", () => {
    let total = 0;
    const elapsed = bestOfRuns(() => {
      const index = buildLineIndex(editor.state.doc);
      total = index.total;
      for (let line = 1; line <= 1_000; line++) {
        const pos = lineToPos(index, ((line * 7) % total) + 1);
        posToLine(index, pos);
      }
    });
    expect(total).toBe(SECTIONS * (1 + PARAGRAPHS_PER_SECTION));
    // Index build is one doc walk; each lookup must stay a binary search, not
    // a rescan — 2k lookups approximate holding an arrow key on Go To Line.
    expect(elapsed).toBeLessThan(300);
  });

  it("counts words in a 2MB text within budget", () => {
    const text = makeMarkdownBody(2_000_000);
    let words = 0;
    const elapsed = bestOfRuns(() => {
      words = countWords(text);
    });
    expect(words).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(300);
  });
});

describe("paste classification", () => {
  it("classifies a 1MB paste within budget", () => {
    // isProbablyMarkdown gates every large paste before the Markdown parse;
    // both verdicts must come back fast or the paste itself stutters.
    const markdownish = makeMarkdownBody(1_000_000);
    const plain = "Just a plain sentence without any markers. ".repeat(24_000);
    let verdictMd = false;
    let verdictPlain = true;
    const elapsed = bestOfRuns(() => {
      verdictMd = isProbablyMarkdown(markdownish);
      verdictPlain = isProbablyMarkdown(plain);
    });
    expect(verdictMd).toBe(true);
    expect(verdictPlain).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });
});
