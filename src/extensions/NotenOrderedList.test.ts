import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import { alphaAttrsForAmbiguousMarkers, selectedOrderedListStyle } from "./NotenOrderedList";

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

function createEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: [
      NotenStarterKit.configure({ codeBlock: false, underline: false, link: false }),
      Markdown.configure({ marked: createFastMarked() }),
      CodeSpanFence,
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: markdown,
    contentType: "markdown",
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

  it("reads a lone ambiguous letter as a letter, except i", () => {
    expect(createEditor("c. x").getJSON().content?.[0].attrs).toMatchObject({ type: "a", start: 3 });
    expect(createEditor("i. x").getJSON().content?.[0].attrs).toMatchObject({ type: "i", start: 1 });
    expect(alphaAttrsForAmbiguousMarkers("x", null)).toEqual({ type: "a", start: 24 });
    expect(alphaAttrsForAmbiguousMarkers("I", "II")).toBeNull();
    expect(alphaAttrsForAmbiguousMarkers("I", "J")).toEqual({ type: "A", start: 9 });
    expect(alphaAttrsForAmbiguousMarkers("iv", null)).toBeNull();
  });

  it("marks each styled list for the stylesheet, and leaves numbered lists bare", () => {
    const html = createEditor("a. one\n   I. sub\n\ntext\n\n1. n").getHTML();
    expect(html).toContain('<ol type="a" data-list-style="lower-alpha">');
    expect(html).toContain('<ol type="I" data-list-style="upper-roman">');
    expect(html).toContain("<ol><li><p>n</p></li></ol>");
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
