import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "@tiptap/markdown";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import { NotenTable } from "./NotenTable";
import TableNodeSelect from "./TableNodeSelect";
import { createFastMarked } from "./fastMarkdownLexer";

const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

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
      NotenTable,
      TableRow,
      TableCell,
      TableHeader,
      TableNodeSelect,
    ],
    content: markdown,
    contentType: "markdown",
  } as ConstructorParameters<typeof Editor>[0]);
  editors.push(editor);
  return editor;
}

// Runs the keydown through every plugin's handleKeyDown in priority order, the
// way ProseMirror does; false means the key falls through to the browser,
// which moves the caret natively.
function press(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  return editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event)) ?? false;
}

function tablePos(editor: Editor): number {
  let found = -1;
  editor.state.doc.forEach((node, offset) => {
    if (found < 0 && node.type.name === "table") found = offset;
  });
  return found;
}

// prosemirror-tables normalizes a table NodeSelection into a CellSelection
// over every cell (allowTableNodeSelection is off), which is what the user sees.
function isTableSelected(editor: Editor): boolean {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection) return selection.node.type.name === "table";
  return selection instanceof CellSelection && selection.isRowSelection() && selection.isColSelection();
}

describe("TableNodeSelect", () => {
  describe("in the paragraph above a table", () => {
    // "abcd" occupies positions 1-5; the table starts at 6.
    const source = `abcd\n\n${TABLE}\n\nafter`;

    it.each([1, 3])("leaves ArrowRight at offset %i to the caret", (pos) => {
      const editor = createEditor(source);
      editor.commands.setTextSelection(pos);
      expect(press(editor, "ArrowRight")).toBe(false);
      expect(isTableSelected(editor)).toBe(false);
      expect(editor.state.selection.from).toBe(pos);
    });

    it("selects the table on ArrowRight at the end of the paragraph", () => {
      const editor = createEditor(source);
      editor.commands.setTextSelection(5);
      expect(press(editor, "ArrowRight")).toBe(true);
      expect(isTableSelected(editor)).toBe(true);
      expect(editor.state.selection.$anchor.before(1)).toBe(tablePos(editor));
    });

    it("leaves ArrowDown to the caret until it is on the paragraph's last line", () => {
      const editor = createEditor(source);
      editor.commands.setTextSelection(3);
      const endOfTextblock = vi.spyOn(editor.view, "endOfTextblock").mockReturnValue(false);
      expect(press(editor, "ArrowDown")).toBe(false);
      expect(isTableSelected(editor)).toBe(false);
      expect(endOfTextblock).toHaveBeenCalledWith("down");

      endOfTextblock.mockReturnValue(true);
      expect(press(editor, "ArrowDown")).toBe(true);
      expect(isTableSelected(editor)).toBe(true);
    });

    it("lets ArrowRight exit inline code at the end before selecting the table", () => {
      const editor = createEditor(`ab \`cd\`\n\n${TABLE}`);
      const end = editor.state.doc.firstChild!.nodeSize - 1;
      editor.commands.setTextSelection(end);

      expect(press(editor, "ArrowRight")).toBe(true);
      expect(isTableSelected(editor)).toBe(false);
      expect(editor.state.doc.firstChild!.textContent).toBe("ab cd ");
      expect(editor.state.doc.firstChild!.lastChild!.marks).toHaveLength(0);

      expect(press(editor, "ArrowRight")).toBe(true);
      expect(isTableSelected(editor)).toBe(true);
    });
  });

  describe("in the paragraph below a table", () => {
    const source = `${TABLE}\n\nwxyz`;
    const paragraphStart = (editor: Editor) => editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize + 1;

    it.each([1, 3])("leaves ArrowLeft at offset %i to the caret", (offset) => {
      const editor = createEditor(source);
      const pos = paragraphStart(editor) + offset;
      editor.commands.setTextSelection(pos);
      expect(press(editor, "ArrowLeft")).toBe(false);
      expect(isTableSelected(editor)).toBe(false);
      expect(editor.state.selection.from).toBe(pos);
    });

    it("selects the table on ArrowLeft at the start of the paragraph", () => {
      const editor = createEditor(source);
      editor.commands.setTextSelection(paragraphStart(editor));
      expect(press(editor, "ArrowLeft")).toBe(true);
      expect(isTableSelected(editor)).toBe(true);
      expect(editor.state.selection.$anchor.before(1)).toBe(tablePos(editor));
    });

    it("leaves ArrowUp to the caret until it is on the paragraph's first line", () => {
      const editor = createEditor(source);
      editor.commands.setTextSelection(paragraphStart(editor) + 2);
      const endOfTextblock = vi.spyOn(editor.view, "endOfTextblock").mockReturnValue(false);
      expect(press(editor, "ArrowUp")).toBe(false);
      expect(isTableSelected(editor)).toBe(false);
      expect(endOfTextblock).toHaveBeenCalledWith("up");

      endOfTextblock.mockReturnValue(true);
      expect(press(editor, "ArrowUp")).toBe(true);
      expect(isTableSelected(editor)).toBe(true);
    });
  });
});
