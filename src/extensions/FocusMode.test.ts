import { describe, it, expect, afterEach } from "vitest";
import { Editor, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { EditorState, NodeSelection, AllSelection } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import FocusMode, {
  focusModePluginKey,
  syncFocusModeState,
  topLevelBlockRange,
} from "./FocusMode";

let active: Editor | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

function makeEditor(content: string, extra: AnyExtension[] = []) {
  const editor = new Editor({
    extensions: [StarterKit, FocusMode, ...extra],
    content,
  });
  active = editor;
  return editor;
}

interface FocusState {
  active: boolean;
  decorations: DecorationSet;
  from: number;
  to: number;
}

function pluginState(editor: Editor): FocusState {
  return focusModePluginKey.getState(editor.state) as FocusState;
}

function decoRanges(editor: Editor) {
  return pluginState(editor)
    .decorations.find()
    .map((d) => ({ from: d.from, to: d.to }));
}

function setFocusActive(editor: Editor, value: boolean) {
  editor.view.dispatch(
    editor.state.tr.setMeta(focusModePluginKey, { active: value }),
  );
}

/** Boundaries of the doc's index-th top-level block. */
function blockRangeAt(editor: Editor, index: number) {
  const doc = editor.state.doc;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return { from: pos, to: pos + doc.child(index).nodeSize };
}

describe("FocusMode", () => {
  it("keeps exactly one active block as the caret moves between paragraphs", () => {
    const editor = makeEditor("<p>one</p><p>two</p><p>three</p>");
    setFocusActive(editor, true);

    // Initial selection sits in the first paragraph.
    expect(decoRanges(editor)).toEqual([blockRangeAt(editor, 0)]);

    for (const index of [1, 2, 0]) {
      const block = blockRangeAt(editor, index);
      editor.commands.setTextSelection(block.from + 1);
      const ranges = decoRanges(editor);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toEqual(block);
    }
  });

  it("keeps the decoration on the caret's block through document edits (mapping)", () => {
    const editor = makeEditor("<p>one</p><p>two</p><p>three</p>");
    setFocusActive(editor, true);
    editor.commands.setTextSelection(blockRangeAt(editor, 2).from + 1);

    // Edit in ANOTHER block (a raw transaction, so the caret stays put): the
    // decoration must shift with the mapping.
    editor.view.dispatch(editor.state.tr.insertText("XX", 1));
    expect(decoRanges(editor)).toEqual([blockRangeAt(editor, 2)]);

    // Typing INSIDE the active block: the decoration must grow with it.
    editor.commands.insertContent("more text");
    expect(decoRanges(editor)).toEqual([blockRangeAt(editor, 2)]);
  });

  it("reuses the decoration set object for caret moves within the same block", () => {
    const editor = makeEditor("<p>hello world</p><p>other</p>");
    setFocusActive(editor, true);
    editor.commands.setTextSelection(2);

    const before = pluginState(editor);
    editor.commands.setTextSelection(7);
    const after = pluginState(editor);

    expect(after).toBe(before);
    expect(after.decorations).toBe(before.decorations);
  });

  it("marks the whole top-level block for carets inside code blocks and tables", () => {
    const codeEditor = makeEditor("<p>a</p><pre><code>line1\nline2</code></pre>");
    setFocusActive(codeEditor, true);
    const codeBlock = blockRangeAt(codeEditor, 1);
    codeEditor.commands.setTextSelection(codeBlock.from + 4);
    expect(decoRanges(codeEditor)).toEqual([codeBlock]);
    codeEditor.destroy();

    const tableEditor = makeEditor(
      "<p>a</p><table><tr><th>head</th></tr><tr><td>cell</td></tr></table>",
      [Table, TableRow, TableCell, TableHeader],
    );
    setFocusActive(tableEditor, true);
    const tableBlock = blockRangeAt(tableEditor, 1);
    // Find a text position inside the table (deep in a cell).
    let cellTextPos = -1;
    tableEditor.state.doc.nodesBetween(tableBlock.from, tableBlock.to, (node, pos) => {
      if (cellTextPos === -1 && node.isText && node.text === "cell") {
        cellTextPos = pos + 1;
      }
    });
    expect(cellTextPos).toBeGreaterThan(-1);
    tableEditor.commands.setTextSelection(cellTextPos);
    expect(decoRanges(tableEditor)).toEqual([tableBlock]);
  });

  it("carries no decorations while inactive", () => {
    const editor = makeEditor("<p>one</p><p>two</p>");
    expect(pluginState(editor).active).toBe(false);
    expect(decoRanges(editor)).toEqual([]);

    setFocusActive(editor, true);
    expect(decoRanges(editor)).toHaveLength(1);

    setFocusActive(editor, false);
    expect(pluginState(editor).active).toBe(false);
    expect(decoRanges(editor)).toEqual([]);

    // Later selection moves while inactive must not resurrect decorations.
    editor.commands.setTextSelection(blockRangeAt(editor, 1).from + 1);
    expect(decoRanges(editor)).toEqual([]);
  });

  it("handles an empty document without throwing", () => {
    const editor = makeEditor("");
    expect(() => setFocusActive(editor, true)).not.toThrow();
    // The empty doc still holds one empty paragraph — it gets the focus.
    expect(decoRanges(editor)).toEqual([blockRangeAt(editor, 0)]);
    expect(() => editor.commands.insertContent("typed")).not.toThrow();
    expect(decoRanges(editor)).toHaveLength(1);
  });

  it("stays active across a document swap via view.updateState (note switch)", () => {
    const editor = makeEditor("<p>first note</p>");
    setFocusActive(editor, true);
    expect(decoRanges(editor)).toHaveLength(1);

    const doc = editor.schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "swapped" }] },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ],
    });
    editor.view.updateState(
      EditorState.create({ doc, plugins: editor.state.plugins }),
    );

    expect(pluginState(editor).active).toBe(true);
    expect(decoRanges(editor)).toEqual([blockRangeAt(editor, 0)]);
  });

  it("reconciles an inactive cached session restored while focus mode is enabled", () => {
    const editor = makeEditor("<p>cached note</p><p>second block</p>");
    const inactiveCachedState = editor.state;

    setFocusActive(editor, true);
    expect(pluginState(editor).active).toBe(true);
    expect(decoRanges(editor)).toHaveLength(1);

    // openDocument restores the whole cached state, including the plugin's
    // old inactive value. The focusMode prop itself has not changed, so its
    // React effect does not run again.
    editor.view.updateState(inactiveCachedState);
    expect(pluginState(editor).active).toBe(false);
    expect(decoRanges(editor)).toEqual([]);

    syncFocusModeState(editor, true);
    expect(pluginState(editor).active).toBe(true);
    expect(decoRanges(editor)).toEqual([blockRangeAt(editor, 0)]);
  });

  it("covers a top-level NodeSelection and yields null when the head sits past every block", () => {
    const editor = makeEditor("<p>one</p><p>two</p>");
    const block1 = blockRangeAt(editor, 1);
    const nodeSelection = NodeSelection.create(editor.state.doc, block1.from);
    expect(topLevelBlockRange(nodeSelection)).toEqual(block1);

    // AllSelection's head resolves at the document end (depth 0, after the
    // last block) — there is no block to focus there.
    const allSelection = new AllSelection(editor.state.doc);
    expect(topLevelBlockRange(allSelection)).toBeNull();
  });
});
