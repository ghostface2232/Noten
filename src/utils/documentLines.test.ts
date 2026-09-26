import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import {
  buildLineIndex,
  countWords,
  lineToPos,
  posToLine,
  selectionForLinePos,
} from "./documentLines";

let active: Editor | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

function makeEditor(content: string) {
  const editor = new Editor({
    extensions: [
      StarterKit, Image, TaskList, TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }), TableRow, TableCell, TableHeader,
    ],
    content,
  });
  active = editor;
  return editor;
}

function lineIndexOf(content: string) {
  return buildLineIndex(makeEditor(content).state.doc);
}

describe("buildLineIndex", () => {
  it("counts one line per paragraph", () => {
    expect(lineIndexOf("<p>one</p><p>two</p><p>three</p>").total).toBe(3);
  });

  it("counts each list item as its own line, unlike doc.childCount", () => {
    const editor = makeEditor("<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>");
    const index = buildLineIndex(editor.state.doc);
    // The whole list is a single top-level block — the old metric said "1".
    expect(editor.state.doc.childCount).toBe(1);
    expect(index.total).toBe(3);
  });

  it("counts every line inside a code block", () => {
    const editor = makeEditor("<pre><code>a\nb\nc\nd</code></pre>");
    expect(editor.state.doc.childCount).toBe(1);
    expect(buildLineIndex(editor.state.doc).total).toBe(4);
  });

  it("counts a leaf block such as a horizontal rule as one line", () => {
    expect(lineIndexOf("<p>a</p><hr><p>b</p>").total).toBe(3);
  });

  it("exposes block starts in document order, matching cumulative node sizes", () => {
    const editor = makeEditor("<p>one</p><ul><li><p>two</p></li></ul><p>three</p>");
    const index = buildLineIndex(editor.state.doc);
    const expected: number[] = [];
    let pos = 0;
    editor.state.doc.forEach((node) => {
      expected.push(pos);
      pos += node.nodeSize;
    });
    // Compared positionally, not by membership: `posToLine` indexes `starts`
    // by block index, so a reversed or shuffled array must fail here.
    expect(index.starts).toEqual(expected);
    expect(pos).toBe(editor.state.doc.content.size);
  });
});

describe("posToLine", () => {
  it("tracks the caret across paragraphs", () => {
    const editor = makeEditor("<p>alpha</p><p>beta</p><p>gamma</p>");
    const index = buildLineIndex(editor.state.doc);
    expect(posToLine(index, 1)).toBe(1);
    expect(posToLine(index, 8)).toBe(2);
    expect(posToLine(index, 15)).toBe(3);
  });

  it("tracks the caret line by line inside a code block", () => {
    const editor = makeEditor("<pre><code>aa\nbb\ncc</code></pre>");
    const index = buildLineIndex(editor.state.doc);
    const start = 1;
    expect(posToLine(index, start)).toBe(1);
    expect(posToLine(index, start + 3)).toBe(2); // just past the first newline
    expect(posToLine(index, start + 6)).toBe(3);
  });

  it("distinguishes list items, which share one top-level block", () => {
    const editor = makeEditor("<p>intro</p><ul><li><p>a</p></li><li><p>b</p></li></ul>");
    const index = buildLineIndex(editor.state.doc);
    const first = lineToPos(index, 2);
    const second = lineToPos(index, 3);
    expect(second).toBeGreaterThan(first);
    expect(posToLine(index, first)).toBe(2);
    expect(posToLine(index, second)).toBe(3);
  });

  it("descends into blockquotes", () => {
    const editor = makeEditor("<blockquote><p>one</p><p>two</p></blockquote><p>after</p>");
    const index = buildLineIndex(editor.state.doc);
    expect(index.total).toBe(3);
    expect(posToLine(index, lineToPos(index, 2))).toBe(2);
    expect(posToLine(index, lineToPos(index, 3))).toBe(3);
  });

  it("clamps out-of-range positions instead of throwing", () => {
    const index = lineIndexOf("<p>one</p><p>two</p>");
    expect(posToLine(index, -50)).toBe(1);
    expect(posToLine(index, 9999)).toBe(index.total);
  });
});

describe("lineToPos", () => {
  it("round-trips every line of a mixed document", () => {
    const editor = makeEditor(
      "<p>intro</p><ul><li><p>a</p></li><li><p>b</p></li></ul><pre><code>x\ny</code></pre><p>tail</p>",
    );
    const index = buildLineIndex(editor.state.doc);
    for (let line = 1; line <= index.total; line++) {
      expect(posToLine(index, lineToPos(index, line))).toBe(line);
    }
  });

  it("clamps below 1 and past the last line", () => {
    const index = lineIndexOf("<p>one</p><p>two</p>");
    expect(lineToPos(index, 0)).toBe(lineToPos(index, 1));
    expect(lineToPos(index, 999)).toBe(lineToPos(index, index.total));
  });
});

// Every construct the editor can produce, exercised against the whole-index
// contract rather than one hand-picked assertion each.
const NODE_CASES: Record<string, string> = {
  empty: "",
  singleEmptyParagraph: "<p></p>",
  table: "<table><tr><th><p>h1</p></th><th><p>h2</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></table>",
  tableWithEmptyCells: "<table><tr><th><p></p></th><th><p></p></th></tr><tr><td><p></p></td><td><p>x</p></td></tr></table>",
  hardBreaks: "<p>one<br>two<br>three</p>",
  blockImage: '<p>before</p><img src="data:image/png;base64,iVBORw0KGgo=" ><p>after</p>',
  nestedList: "<ul><li><p>a</p><ul><li><p>a1</p></li><li><p>a2</p></li></ul></li><li><p>b</p></li></ul>",
  taskList: '<ul data-type="taskList"><li data-checked="false"><p>t1</p></li><li data-checked="true"><p>t2</p></li></ul>',
  codeThenList: "<pre><code>x\ny\nz</code></pre><ul><li><p>a</p></li></ul>",
  trailingEmpty: "<p>text</p><p></p><p></p>",
  deepQuote: "<blockquote><blockquote><p>deep</p><p>deeper</p></blockquote></blockquote>",
  hrOnly: "<hr>",
  mixed: "<h1>T</h1><p>p</p><hr><ul><li><p>a</p></li></ul><pre><code>1\n2</code></pre><blockquote><p>q</p></blockquote>",
};

describe("line index invariants across node types", () => {
  it.each(Object.keys(NODE_CASES))("%s: every line round-trips to a usable selection", (name) => {
    const editor = makeEditor(NODE_CASES[name]);
    const index = buildLineIndex(editor.state.doc);

    expect(index.total).toBeGreaterThanOrEqual(1);
    expect(index.prefix.length).toBe(editor.state.doc.childCount + 1);
    expect(index.starts.length).toBe(editor.state.doc.childCount);

    for (let line = 1; line <= index.total; line++) {
      const pos = lineToPos(index, line);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(editor.state.doc.content.size);
      expect(posToLine(index, pos), `${name} line ${line} round-trip`).toBe(line);
      // Whatever the line lands on, the selection must be one the editor can
      // actually hold — a text position or a selectable node.
      const selection = selectionForLinePos(editor.state.doc, pos);
      expect(
        selection instanceof NodeSelection || selection.$head.parent.inlineContent,
        `${name} line ${line} selection`,
      ).toBe(true);
    }
  });

  it.each(Object.keys(NODE_CASES))("%s: posToLine is monotonic and bounded everywhere", (name) => {
    const editor = makeEditor(NODE_CASES[name]);
    const index = buildLineIndex(editor.state.doc);
    let previous = 0;
    for (let pos = 0; pos <= editor.state.doc.content.size; pos++) {
      const line = posToLine(index, pos);
      expect(line).toBeGreaterThanOrEqual(1);
      expect(line).toBeLessThanOrEqual(index.total);
      expect(line, `${name} pos ${pos} monotonic`).toBeGreaterThanOrEqual(previous);
      previous = line;
    }
  });
});

describe("hard breaks", () => {
  it("counts a hard break as a line break", () => {
    // Two visible lines, and two lines in the serialized Markdown, even though
    // the block's text content holds no newline character.
    expect(lineIndexOf("<p>a<br>b</p>").total).toBe(2);
    expect(lineIndexOf("<p>one<br>two<br>three</p>").total).toBe(3);
  });

  it("places the caret line correctly around a hard break", () => {
    const editor = makeEditor("<p>a<br>b</p>");
    const index = buildLineIndex(editor.state.doc);
    expect(posToLine(index, 1)).toBe(1); // before "a"
    expect(posToLine(index, 2)).toBe(1); // after "a", before the break
    expect(posToLine(index, 3)).toBe(2); // after the break
    expect(posToLine(index, 4)).toBe(2); // after "b"
  });
});

describe("selectionForLinePos", () => {
  it("selects a horizontal rule instead of a block position", () => {
    const editor = makeEditor("<p>alpha</p><hr><p>omega</p>");
    const index = buildLineIndex(editor.state.doc);
    const selection = selectionForLinePos(editor.state.doc, lineToPos(index, 2));

    // TextSelection.create at this position does NOT throw — it silently
    // produces a selection whose parent is the doc, and the next keystroke
    // inserts a paragraph the user never asked for.
    expect(selection).toBeInstanceOf(NodeSelection);
    expect((selection as NodeSelection).node.type.name).toBe("horizontalRule");

    // Typing replaces the selected rule, the way clicking it and typing does.
    // The old TextSelection path instead left the rule in place and inserted a
    // paragraph before it, so assert the resulting shape, not just the count.
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.commands.insertContent("X");
    const types = [] as string[];
    editor.state.doc.forEach((node) => types.push(node.type.name));
    expect(types).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(editor.state.doc.child(1).textContent).toBe("X");
  });

  it("returns a plain text selection for ordinary lines", () => {
    const editor = makeEditor("<p>alpha</p><p>omega</p>");
    const index = buildLineIndex(editor.state.doc);
    const selection = selectionForLinePos(editor.state.doc, lineToPos(index, 2));
    expect(selection).toBeInstanceOf(TextSelection);
    expect(selection.$head.parent.type.name).toBe("paragraph");
  });

  it("clamps an out-of-range position", () => {
    const editor = makeEditor("<p>alpha</p>");
    expect(() => selectionForLinePos(editor.state.doc, 9999)).not.toThrow();
    expect(() => selectionForLinePos(editor.state.doc, -10)).not.toThrow();
  });
});

describe("character and word counts", () => {
  it("counts words per block instead of fusing across block boundaries", () => {
    // doc.textContent joins blocks with no separator, so counting from it read
    // "Hello worldSecond paragraph hereThird" — 4 words instead of 6.
    const editor = makeEditor("<p>Hello world</p><p>Second paragraph here</p><p>Third</p>");
    expect(buildLineIndex(editor.state.doc).words).toBe(6);
  });

  it("counts each list item's words", () => {
    const editor = makeEditor("<ul><li><p>milk</p></li><li><p>eggs</p></li><li><p>bread</p></li></ul>");
    expect(buildLineIndex(editor.state.doc).words).toBe(3);
  });

  it("does not fuse words across a hard break", () => {
    expect(buildLineIndex(makeEditor("<p>alpha<br>beta</p>").state.doc).words).toBe(2);
  });

  it("keeps a single word split across marks as one word", () => {
    const editor = makeEditor("<p><strong>bold</strong>face and more</p>");
    expect(buildLineIndex(editor.state.doc).words).toBe(3);
  });

  it("counts Korean 어절 per block", () => {
    const editor = makeEditor("<p>오늘 회의 내용</p><p>정리 완료</p>");
    expect(buildLineIndex(editor.state.doc).words).toBe(5);
  });

  it("counts an inline atom's leafText, keeping chars aligned with textContent", () => {
    // No node in the app's schema declares `leafText` today, so this guards the
    // invariant against a future one rather than current behavior. Built on a
    // raw ProseMirror schema because Tiptap's node builder has no passthrough
    // for that spec field.
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
        emoji: { group: "inline", inline: true, atom: true, leafText: () => ":)" },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("a "),
        schema.node("emoji"),
        schema.text(" b"),
      ]),
    ]);

    expect(doc.textContent).toBe("a :) b");
    const index = buildLineIndex(doc);
    expect(index.chars).toBe(doc.textContent.length);
    expect(index.words).toBe(3);
  });

  it("reports characters identical to doc.textContent.length", () => {
    for (const [name, html] of Object.entries(NODE_CASES)) {
      const editor = makeEditor(html);
      expect(buildLineIndex(editor.state.doc).chars, name).toBe(editor.state.doc.textContent.length);
      editor.destroy();
      active = null;
    }
  });

  it("counts nothing for a document with no text", () => {
    // Tiptap normalizes "" into a single empty paragraph — the schema is
    // `block+`, so a truly childless doc is unreachable through the editor.
    const index = lineIndexOf("");
    expect(index.doc.childCount).toBe(1);
    expect(index.words).toBe(0);
    expect(index.chars).toBe(0);
    expect(index.total).toBe(1);
  });

  // The word scanner hand-rolls the `\s` class to avoid a regex per character,
  // so these pin the exotic members a future edit could silently drop.
  it.each([
    ["space", "\u0020"],
    ["tab", "\u0009"],
    ["newline", "\u000a"],
    ["vertical tab", "\u000b"],
    ["form feed", "\u000c"],
    ["carriage return", "\u000d"],
    ["no-break space", "\u00a0"],
    ["ogham space mark", "\u1680"],
    ["en quad", "\u2000"],
    ["hair space", "\u200a"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["narrow no-break space", "\u202f"],
    ["medium mathematical space", "\u205f"],
    ["ideographic space", "\u3000"],
    ["zero width no-break space", "\ufeff"],
  ])("treats %s as a word separator, matching the \\s class", (_label, ch) => {
    expect(/\s/.test(ch)).toBe(true);
    expect(countWords(`a${ch}b`)).toBe(2);
  });

  it.each([
    ["zero width joiner", "\u200d"],
    ["zero width non-joiner", "\u200c"],
    ["soft hyphen", "\u00ad"],
  ])("does not treat %s as a separator, matching the \\s class", (_label, ch) => {
    expect(/\s/.test(ch)).toBe(false);
    expect(countWords(`a${ch}b`)).toBe(1);
  });
});

describe("countWords", () => {
  it("counts whitespace-delimited words", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  padded   spacing  ")).toBe(2);
  });

  it("counts Korean 어절", () => {
    expect(countWords("오늘 회의 내용을 정리한다")).toBe(4);
  });

  it("returns zero for empty or whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });
});

describe("buildLineIndex after edits", () => {
  // The per-node cache must never make an incremental rebuild disagree with a
  // cold one. Rebuild the same content from JSON (fresh nodes, no cache hits)
  // and compare after every random edit.
  it("matches a cold rebuild across random edits", () => {
    const editor = makeEditor(
      "<h1>Title</h1><p>alpha beta</p><ul><li><p>one two</p></li><li><p>three</p></li></ul>"
      + "<pre><code>line1\nline2</code></pre><p>tail words<br>after break</p>",
    );
    let seed = 11;
    const rand = () => { seed = (seed * 48271) % 0x7fffffff; return seed / 0x7fffffff; };
    const pieces = ["x", " ", "word ", "\n", "한글 ", "  "];
    for (let step = 0; step < 300; step++) {
      const doc = editor.state.doc;
      const pos = 1 + Math.floor(rand() * (doc.content.size - 1));
      const $pos = doc.resolve(pos);
      const r = rand();
      if (r < 0.45 && $pos.parent.inlineContent) {
        editor.view.dispatch(editor.state.tr.insertText(pieces[Math.floor(rand() * pieces.length)], pos));
      } else if (r < 0.6 && $pos.parent.inlineContent && $pos.parentOffset > 0) {
        editor.view.dispatch(editor.state.tr.delete(pos - 1, pos));
      } else if (r < 0.7) {
        // Across block boundaries: joins and removes whole blocks.
        const to = Math.min(doc.content.size - 1, pos + 1 + Math.floor(rand() * 12));
        editor.commands.deleteRange({ from: pos, to });
      } else if (r < 0.8 && $pos.parent.inlineContent) {
        editor.chain().setTextSelection(pos).setHardBreak().run();
      } else if (r < 0.85 && $pos.parent.inlineContent) {
        editor.chain().setTextSelection(pos).setHorizontalRule().run();
      } else if ($pos.parent.inlineContent && $pos.parent.type.name === "paragraph") {
        editor.view.dispatch(editor.state.tr.split(pos));
      }
      if (editor.state.doc.content.size < 20) editor.commands.insertContent("<p>refill words here</p><ul><li><p>item</p></li></ul>");
      const warm = buildLineIndex(editor.state.doc);
      const cold = buildLineIndex(editor.schema.nodeFromJSON(editor.state.doc.toJSON()));
      expect({ ...warm, doc: null }).toEqual({ ...cold, doc: null });
      expect(warm.chars).toBe(editor.state.doc.textContent.length);
      // Independent word count: per textblock, hard breaks as spaces.
      let words = 0;
      editor.state.doc.descendants((node) => {
        if (!node.isTextblock) return true;
        words += countWords(node.textBetween(0, node.content.size, undefined, " "));
        return false;
      });
      expect(warm.words).toBe(words);
    }
  });
});
