import { describe, it, expect, afterEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import MermaidCodeBlock from "./MermaidCodeBlock";
import { common, createLowlight } from "lowlight";
import { NotenTable } from "./NotenTable";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import {
  MAX_LIST_SEGMENTS,
  alphaAttrsForAmbiguousMarkers,
  listItemMarker,
  listSegmentStarts,
  selectedOrderedListStyle,
} from "./NotenOrderedList";

function nodesOf(doc: JSONContent, type: string): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === type) out.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return out;
}

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

function createEditor(markdown: string | JSONContent): Editor {
  const editor = new Editor({
    extensions: [
      NotenStarterKit.configure({ codeBlock: false, underline: false, link: false }),
      Markdown.configure({ marked: createFastMarked() }),
      CodeSpanFence,
      TaskList,
      TaskItem.configure({ nested: true }),
      MermaidCodeBlock.configure({ lowlight: createLowlight(common) }),
      NotenTable,
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: markdown,
    contentType: typeof markdown === "string" ? "markdown" : "json",
  } as ConstructorParameters<typeof Editor>[0]);
  editors.push(editor);
  return editor;
}

function markdownOf(editor: Editor): string {
  return editor.getMarkdown().trimEnd();
}

/** Put the caret at the end of the first text block whose text is `text`. */
function caretAt(editor: Editor, text: string): void {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target === -1 && node.isTextblock && node.textContent === text) target = pos + node.nodeSize - 1;
    return target === -1;
  });
  if (target === -1) throw new Error(`no text block "${text}"`);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target)));
}

// Input rules run from the view's text-input handler, as typing does.
function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(ch, from, to);
    const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, insert));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

describe("NotenOrderedList Markdown", () => {
  it.each([
    "a. one\nb. two\nc. three",
    "A. one\nB. two",
    "i. one\nii. two\niii. three",
    "I. one\nII. two",
    "1. one\n2. two\n   a. sub\n   b. sub\n3. three",
    "a. one\n   i. sub\n   ii. sub\nb. two",
    "- bullet\n  a. alpha\n  b. beta",
  ])("keeps %j byte for byte", (markdown) => {
    expect(markdownOf(createEditor(markdown))).toBe(markdown);
  });

  // Tiptap reads `c`, `d`, `i`, `l`, `m`, `v`, `x` as roman first; the second
  // marker used to be rewritten on save (`c. / d.` became `c. / ci.`).
  it.each([
    "c. x\nd. y",
    "C. x\nD. y",
    "d. x\ne. y",
    "i. x\nj. y",
    "l. x\nm. y",
    "v. x\nw. y",
    "h. x\ni. y\nj. z",
    "1. top\n   c. x\n   d. y",
  ])("keeps a letter list starting on an ambiguous letter: %j", (markdown) => {
    const first = markdownOf(createEditor(markdown));
    expect(first).toBe(markdown);
    expect(markdownOf(createEditor(first))).toBe(markdown);
  });

  // Only `i` → `ii` counted as a roman reading at first, so an outline
  // resuming at `V.` split in two and a nested `vi.` was saved as `w.`.
  it.each([
    "v. five\nvi. six\nvii. seven",
    "V. Five\nVI. Six",
    "X. Ten\nXI. Eleven\nXII. Twelve",
    "l. fifty\nli. fifty-one",
    "c. x\nci. y",
    "M. x\nMI. y",
    "> v. q\n> vi. r",
    "1. a\n   v. nested\n   vi. nested2\n2. b",
    "I. u0\n   v. s1\n   vi. s2",
  ])("keeps a roman list starting past i: %j", (markdown) => {
    const first = markdownOf(createEditor(markdown));
    expect(first).toBe(markdown);
    expect(markdownOf(createEditor(first))).toBe(markdown);
  });

  it("reads a lone ambiguous letter as a letter, except i", () => {
    expect(createEditor("c. x").getJSON().content?.[0].attrs).toMatchObject({ type: "a", start: 3 });
    expect(createEditor("i. x").getJSON().content?.[0].attrs).toMatchObject({ type: "i", start: 1 });
    expect(alphaAttrsForAmbiguousMarkers("x", null)).toEqual({ type: "a", start: 24 });
    expect(alphaAttrsForAmbiguousMarkers("I", "II")).toBeNull();
    expect(alphaAttrsForAmbiguousMarkers("I", "J")).toEqual({ type: "A", start: 9 });
    expect(alphaAttrsForAmbiguousMarkers("iv", null)).toBeNull();
  });

  // Tiptap's tokenizer takes every following item line into the first list, so
  // a letter list after a numbered one (blank line between, as saved) came back
  // as one numbered list and its `a.` was saved as `3.`.
  it.each([
    "1. one\n2. two\n\na. x\nb. y",
    "a. x\nb. y\n\n1. one",
    "a. x\n\nA. y",
    "i. x\n\n1. y\n\nI. z",
    "1. one\n   a. sub\n2. two\n\na. x",
    "a. x\nb. y\n\ni. one\nii. two",
    "i. one\nii. two\n\na. x",
    "c. x\n\ni. y",
    "A. x\nB. y\n\nI. z",
    // A lone letter list after a roman one merged into it: `V.` saved as `II.`.
    "I. para\n\nV. x",
    "i. intro\n\nx. ten",
    "iv. four\nv. five\n\nc. letter",
  ])("keeps a change of marker kind at the top level as separate lists: %j", (markdown) => {
    const first = markdownOf(createEditor(markdown));
    expect(first).toBe(markdown);
    expect(markdownOf(createEditor(first))).toBe(markdown);
  });

  // Inside a list item, sibling lists are written a single newline apart, so
  // the tokenizer-level split (top level only) let `a.` come back as `2.`.
  it.each([
    "1. outer\n   1. x\n   a. para",
    "- bullet\n  1. x\n  a. y\n  i. z",
    "1. q\na. opt\nb. opt\n2. q\na. opt",
  ])("splits nested and flat runs of mixed markers the same way: %j", (markdown) => {
    const first = markdownOf(createEditor(markdown));
    expect(markdownOf(createEditor(first))).toBe(first);
    expect(first.match(/^\s*(\d+|[a-z]+)\./gm)?.map((m) => m.trim())).toEqual(
      markdown.match(/^\s*(\d+|[a-z]+)\./gm)?.map((m) => m.trim()),
    );
  });

  // One list per segment, spread by Tiptap into call arguments, overflowed the
  // stack for a long nested run (`a.`/`A.` alternating 70,000 times).
  it("opens a nested run with more segments than the cap as one list", () => {
    const run = "  a. x\n  A. y\n".repeat(MAX_LIST_SEGMENTS / 2 + 1);
    const lists = (markdown: string) => nodesOf(createEditor(markdown).getJSON(), "orderedList").length;
    expect(lists(`- outer\n${run}`)).toBe(1);
    expect(lists("- outer\n" + "  a. x\n  A. y\n".repeat(50))).toBe(100);
    expect(() => createEditor("- outer\n" + "  a. x\n  A. y\n".repeat(70_000))).not.toThrow();
  }, 60_000);

  it("finds list boundaries from markers alone", () => {
    expect(listSegmentStarts(["1", "2", "a", "b", "3"])).toEqual([0, 2, 4]);
    expect(listSegmentStarts(["a", "b", "i", "ii"])).toEqual([0, 2]);
    expect(listSegmentStarts(["h", "i", "j"])).toEqual([0]);
    expect(listSegmentStarts(["v", "vi", "a"])).toEqual([0, 2]);
    expect(listSegmentStarts(["iv", "v", "vi", "x"])).toEqual([0, 3]);
    expect(listSegmentStarts(["ix", "x", "xi"])).toEqual([0]);
    expect(listSegmentStarts(["a", "A"])).toEqual([0, 1]);
    expect(listSegmentStarts(["1", null, "a"])).toEqual([0, 2]);
    expect(listSegmentStarts([])).toEqual([0]);
    // Tiptap reads these as numbered items.
    expect(listSegmentStarts(["1", "IIII", "mid", "Civil", "2"])).toEqual([0]);
  });

  it.each([
    "1. x\nIIII. y",
    "1. x\nmid. y",
    "iiii. x\n1. y",
    "Civil. a\n1) b",
    // The stock reading drops `x. deep` (indented past its siblings) but kept
    // its style on the nested token, so the first segment became roman.
    "1. top\n      x. deep\n   1. y\n   a. z",
    "ab. item 1\n      iiii) item 2\n  A) item 3\n  3) item 4",
  ])(
    "saves %j the same on every reload",
    (markdown) => {
      const first = markdownOf(createEditor(markdown));
      expect(markdownOf(createEditor(first))).toBe(first);
    },
  );

  it("still separates letters from numbers", () => {
    expect(listSegmentStarts(["1", "a", "b", "iv", "I"])).toEqual([0, 1, 3, 4]);
  });

  // Loading and saving twice must give the same Markdown as once: a list that
  // splits or merges differently on each reading rewrites markers every save.
  it("saves mixed-marker lists stably across reloads (seeded fuzz)", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const markers = ["1.", "2.", "10.", "a.", "b.", "c.", "h.", "i.", "ii.", "v.", "vi.", "x.", "A.", "B.", "I.", "II.", "V."];
    const indents = ["", "", "   ", "      "];
    for (let n = 0; n < 300; n++) {
      // In a quote, later lines may drop the `>` (lazy continuation).
      const quoteMode = pick(["none", "none", "all", "lazy"] as const);
      const lines: string[] = [];
      const count = 2 + Math.floor(random() * 7);
      for (let k = 0; k < count; k++) {
        const quote = quoteMode === "all" || (quoteMode === "lazy" && k === 0) ? "> " : "";
        const roll = random();
        if (roll < 0.12) lines.push(quote.trimEnd());
        else if (roll < 0.2) lines.push(`${quote}text ${k}`);
        else lines.push(`${quote}${pick(indents)}${pick(markers)} item ${k}`);
      }
      const once = markdownOf(createEditor(lines.join("\n")));
      const twice = markdownOf(createEditor(once));
      expect(twice, JSON.stringify(lines.join("\n"))).toBe(once);
      while (editors.length > 0) editors.pop()!.destroy();
    }
    // 600 editors: about 2.5 s alone, past the 5 s default under a full run.
  }, 30_000);

  it("keeps a letter list whose markers run into roman letters as one list", () => {
    const markdown = "h. x\ni. y\nj. z\nk. w\nl. v\nm. u";
    const editor = createEditor(markdown);
    expect(editor.getJSON().content?.filter((node) => node.type === "orderedList")).toHaveLength(1);
    expect(markdownOf(editor)).toBe(markdown);
  });

  it("marks each styled list for the stylesheet, and leaves numbered lists bare", () => {
    const html = createEditor("a. one\n   I. sub\n\ntext\n\n1. n").getHTML();
    expect(html).toContain('<ol type="a" data-list-style="lower-alpha">');
    expect(html).toContain('<ol type="I" data-list-style="upper-roman">');
    expect(html).toContain("<ol><li><p>n</p></li></ol>");
  });
});

describe("letter lists past zz", () => {
  // Tiptap has no letter marker past `zz` (702) and wrote `undefineda.`,
  // which reads back as text of item 702, so the items were lost.
  it("numbers the items past 702 and keeps every item across saves", () => {
    const count = 705;
    const editor = createEditor(Array.from({ length: count }, (_, k) => `${k + 1}. item ${k + 1}`).join("\n"));
    caretAt(editor, "item 1");
    editor.commands.setOrderedListStyle("a");
    const first = markdownOf(editor);
    expect(first).not.toContain("undefined");
    const lines = first.split("\n");
    expect(lines[701]).toBe("zz. item 702");
    expect(lines[702]).toBe("703. item 703");
    const reloaded = createEditor(first);
    const texts = nodesOf(reloaded.getJSON(), "paragraph").map((p) => p.content?.[0]?.text);
    expect(texts).toEqual(Array.from({ length: count }, (_, k) => `item ${k + 1}`));
    expect(markdownOf(createEditor(markdownOf(reloaded)))).toBe(markdownOf(reloaded));
  });

  it("marks the positions each style can spell", () => {
    expect(listItemMarker("a", 701)).toBe("zz. ");
    expect(listItemMarker("A", 702)).toBe("703. ");
    expect(listItemMarker("i", 999)).toBe("m. ");
    expect(listItemMarker(null, 4)).toBe("5. ");
  });
});

describe("setOrderedListStyle", () => {
  it("wraps a paragraph in a list of the chosen style", () => {
    const editor = createEditor("hello");
    caretAt(editor, "hello");
    expect(editor.commands.setOrderedListStyle("a")).toBe(true);
    expect(markdownOf(editor)).toBe("a. hello");
  });

  it("restyles the list around the caret, and numbers drop the attribute", () => {
    const editor = createEditor("1. one\n2. two");
    caretAt(editor, "two");
    editor.commands.setOrderedListStyle("A");
    expect(markdownOf(editor)).toBe("A. one\nB. two");
    editor.commands.setOrderedListStyle("1");
    expect(markdownOf(editor)).toBe("1. one\n2. two");
    expect(editor.getJSON().content?.[0].attrs?.type).toBeNull();
  });

  it("restyles only the innermost list", () => {
    const editor = createEditor("1. one\n   1. sub\n2. two");
    caretAt(editor, "sub");
    editor.commands.setOrderedListStyle("a");
    expect(markdownOf(editor)).toBe("1. one\n   a. sub\n2. two");
    expect(selectedOrderedListStyle(editor.state.selection)).toBe("a");
  });

  // toggleOrderedList joined the new list into a numbered list next to it
  // before the style was set, so the whole numbered list became letters.
  it("leaves a numbered list next to the new list alone", () => {
    const after = createEditor("1. x\n2. y\n\npara");
    caretAt(after, "para");
    after.commands.setOrderedListStyle("a");
    expect(markdownOf(after)).toBe("1. x\n2. y\n\na. para");

    const before = createEditor("para\n\n1. x\n2. y");
    caretAt(before, "para");
    before.commands.setOrderedListStyle("A");
    expect(markdownOf(before)).toBe("A. para\n\n1. x\n2. y");
  });

  it("joins the new list with a neighbour of the same style", () => {
    const editor = createEditor("a. x\nb. y\n\npara");
    caretAt(editor, "para");
    editor.commands.setOrderedListStyle("a");
    expect(editor.getJSON().content?.filter((node) => node.type === "orderedList")).toHaveLength(1);
    expect(markdownOf(editor)).toBe("a. x\nb. y\nc. para");
  });

  it("converts a task list nested in a numbered item in place, as one undo step", () => {
    // Built from JSON: Tiptap's Markdown reading of a task list nested at
    // three spaces folds `task2` into task1's text.
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const task = (text: string, checked: boolean) => ({ type: "taskItem", attrs: { checked }, content: [paragraph(text)] });
    const editor = createEditor({
      type: "doc",
      content: [{
        type: "orderedList",
        content: [
          { type: "listItem", content: [paragraph("n"), { type: "taskList", content: [task("task1", false), task("task2", true)] }] },
          { type: "listItem", content: [paragraph("m")] },
        ],
      }],
    });
    const markdown = markdownOf(editor);
    expect(markdown).toBe("1. n\n   - [ ] task1\n   - [x] task2\n2. m");
    caretAt(editor, "task1");
    expect(editor.commands.setOrderedListStyle("i")).toBe(true);
    expect(markdownOf(editor)).toBe("1. n\n   i. task1\n   ii. task2\n2. m");
    expect(selectedOrderedListStyle(editor.state.selection)).toBe("i");
    editor.commands.undo();
    expect(markdownOf(editor)).toBe(markdown);
  });

  it("refuses a selected node outside a list without touching the document", () => {
    const editor = createEditor("a\n\n---\n\nb");
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 3)));
    expect(editor.can().setOrderedListStyle("a")).toBe(false);
    expect(editor.commands.setOrderedListStyle("a")).toBe(false);
    expect(markdownOf(editor)).toBe("a\n\n---\n\nb");
  });

  // Refusing every NodeSelection also blocked restyling the list around a
  // selected image or table, while the toolbar showed that list's style.
  it("restyles a selected list, or the list around a selected node", () => {
    const whole = createEditor("1. x\n   - y\n2. z");
    whole.view.dispatch(whole.state.tr.setSelection(NodeSelection.create(whole.state.doc, 0)));
    expect(selectedOrderedListStyle(whole.state.selection)).toBe("1");
    expect(whole.commands.setOrderedListStyle("a")).toBe(true);
    expect(markdownOf(whole)).toBe("a. x\n   - y\nb. z");

    const inside = createEditor("a. text\n\n   ---\nb. two");
    let rule = -1;
    inside.state.doc.descendants((node, pos) => {
      if (node.type.name === "horizontalRule") rule = pos;
    });
    inside.view.dispatch(inside.state.tr.setSelection(NodeSelection.create(inside.state.doc, rule)));
    expect(selectedOrderedListStyle(inside.state.selection)).toBe("a");
    expect(inside.can().setOrderedListStyle("I")).toBe(true);
    expect(inside.commands.setOrderedListStyle("I")).toBe(true);
    expect(selectedOrderedListStyle(inside.state.selection)).toBe("I");
  });

  // Requiring every block to be a textblock refused a rule between them, and
  // Tiptap's clearNodes lifted a heading out of its quote, splitting it.
  it.each([
    // The rule under an item drifts on reload through the stock tokenizer's
    // one-short dedent (fixed on claude/nested-task-in-ordered-list), so its
    // stability is not checked here.
    ["# h\n\n---\n\npara", "h", "para", "a. h\n   ---\nb. para", false],
    ["> a\n>\n> # h\n>\n> b", "h", "h", "> a\n>\n> a. h\n>\n> b", true],
    ["# h\n\n```\ncode\n```", "h", "code", "a. h\nb. code", true],
  ] as const)("wraps %j without lifting or refusing what it can keep", (markdown, fromText, toText, expected, stable) => {
    const editor = createEditor(markdown);
    const at = (text: string, end: boolean) => {
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (found === -1 && node.isTextblock && node.textContent === text) found = end ? pos + node.nodeSize - 1 : pos + 1;
        return found === -1;
      });
      return found;
    };
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at(fromText, false), at(toText, true))));
    expect(editor.can().setOrderedListStyle("a")).toBe(true);
    expect(editor.commands.setOrderedListStyle("a")).toBe(true);
    expect(markdownOf(editor)).toBe(expected);
    if (stable) expect(markdownOf(createEditor(expected))).toBe(expected);
  });

  it("refuses a table cell, whose Markdown cannot hold a list", () => {
    const markdown = "| h1 | h2 |\n| --- | --- |\n| c1 | c2 |";
    const caret = createEditor(markdown);
    caretAt(caret, "c1");
    const before = caret.state.doc;
    expect(caret.can().setOrderedListStyle("a")).toBe(false);
    expect(caret.commands.setOrderedListStyle("a")).toBe(false);
    expect(caret.state.doc.eq(before)).toBe(true);

    const whole = createEditor(markdown);
    const cells: number[] = [];
    whole.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") cells.push(pos);
    });
    whole.view.dispatch(whole.state.tr.setSelection(CellSelection.create(whole.state.doc, cells[0], cells[cells.length - 1])));
    const wholeBefore = whole.state.doc;
    expect(whole.commands.setOrderedListStyle("I")).toBe(false);
    expect(whole.state.doc.eq(wholeBefore)).toBe(true);
  });

  // Clearing a quote, table or list and then failing to wrap left them
  // flattened (a failed chain still dispatches), and can() said true there.
  it("either restyles or leaves the document alone, as can() says (every text selection)", () => {
    const markdown = "| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n\n> q1\n\n# head\n\n```\ncode\n```\n\npara\n\n- b1\n- b2";
    const editor = createEditor(markdown);
    const original = editor.state.doc;
    const positions: number[] = [];
    original.descendants((node, pos) => {
      if (node.isTextblock) positions.push(pos + 1, pos + node.nodeSize - 1);
    });
    let checked = 0;
    for (const from of positions) {
      for (const to of positions) {
        if (to < from) continue;
        editor.commands.setContent(markdown, { contentType: "markdown" } as never);
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
        const before = editor.state.doc;
        const can = editor.can().setOrderedListStyle("a");
        const ran = editor.commands.setOrderedListStyle("a");
        expect(ran, `${from}-${to}`).toBe(can);
        if (!ran) expect(editor.state.doc.eq(before), `${from}-${to}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("answers can() the way running it goes for text selections", () => {
    for (const markdown of ["para", "# heading", "- [ ] task", "- bullet", "1. n"]) {
      const editor = createEditor(markdown);
      caretAt(editor, markdown.replace(/^(# |- \[ \] |- |1\. )/, ""));
      const doc = editor.state.doc;
      expect(editor.can().setOrderedListStyle("a"), markdown).toBe(true);
      expect(editor.state.doc).toBe(doc);
      expect(editor.commands.setOrderedListStyle("a"), markdown).toBe(true);
      expect(selectedOrderedListStyle(editor.state.selection), markdown).toBe("a");
    }
  });

  it("converts a bullet list nested in a numbered one instead of restyling the outer list", () => {
    const editor = createEditor("1. one\n   - sub\n2. two");
    caretAt(editor, "sub");
    expect(selectedOrderedListStyle(editor.state.selection)).toBeNull();
    editor.commands.setOrderedListStyle("i");
    expect(markdownOf(editor)).toBe("1. one\n   i. sub\n2. two");
  });
});

describe("letter input rule", () => {
  it("starts a list from `a. `, `B. ` and `i. `", () => {
    const lower = createEditor("");
    type(lower, "a. x");
    expect(markdownOf(lower)).toBe("a. x");

    const upper = createEditor("");
    type(upper, "B. x");
    expect(markdownOf(upper)).toBe("B. x");

    const roman = createEditor("");
    type(roman, "i. x");
    expect(markdownOf(roman)).toBe("i. x");
  });

  it("continues the letter list above when the letter is its next marker", () => {
    const editor = createEditor("a. one\nb. two\n\nz");
    caretAt(editor, "z");
    editor.commands.deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from });
    type(editor, "c. three");
    expect(editor.getJSON().content?.filter((node) => node.type === "orderedList")).toHaveLength(1);
    expect(markdownOf(editor)).toBe("a. one\nb. two\nc. three");
  });

  it("leaves multi-letter prose alone", () => {
    const editor = createEditor("");
    type(editor, "ii. x");
    expect(markdownOf(editor)).toBe("ii. x");
  });
});
