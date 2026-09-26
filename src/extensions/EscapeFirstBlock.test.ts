import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EscapeFirstBlock, escapeLeadingBlock } from "./EscapeFirstBlock";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

// StarterKit ships a `codeBlock` node, the same node Noten's Mermaid block
// extends, so it exercises the real trapping case.
function make(content: string): Editor {
  // GapCursor's vertical-motion handler needs browser layout APIs that jsdom
  // does not implement. It is unrelated to this code-block keymap contract.
  editor = new Editor({
    extensions: [StarterKit.configure({ gapcursor: false }), EscapeFirstBlock],
    content,
  });
  return editor;
}

const firstType = (e: Editor) => e.state.doc.firstChild?.type.name;

function pressKey(e: Editor, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  e.view.dom.dispatchEvent(event);
  return event;
}

describe("escapeLeadingBlock", () => {
  it("inserts a paragraph above a leading code block from its first line", () => {
    const e = make("<pre><code>const x = 1</code></pre>");
    expect(firstType(e)).toBe("codeBlock");
    e.commands.setTextSelection(1); // start of the code block

    expect(escapeLeadingBlock(e)).toBe(true);
    expect(firstType(e)).toBe("paragraph");
    expect(e.state.doc.firstChild?.childCount).toBe(0); // empty paragraph
    expect(e.state.doc.child(1).type.name).toBe("codeBlock");
    expect(e.state.doc.child(1).textContent).toBe("const x = 1");
  });

  it("does nothing when the cursor is past the first line of the code block", () => {
    const e = make("<pre><code>line1\nline2</code></pre>");
    // pos 1 = start; "line1\n" is 6 chars, so pos 7 = start of line2.
    e.commands.setTextSelection(7);
    expect(escapeLeadingBlock(e)).toBe(false);
    expect(firstType(e)).toBe("codeBlock");
  });

  it("does nothing when the document starts with a paragraph", () => {
    const e = make("<p>hello</p><pre><code>x</code></pre>");
    e.commands.setTextSelection(1);
    const before = e.state.doc.childCount;
    expect(escapeLeadingBlock(e)).toBe(false);
    expect(e.state.doc.childCount).toBe(before); // unchanged
    expect(firstType(e)).toBe("paragraph");
  });

  it("does nothing when the cursor is outside the leading code block", () => {
    const e = make("<pre><code>code</code></pre><p>after</p>");
    const afterStart = e.state.doc.child(0).nodeSize + 1;
    e.commands.setTextSelection(afterStart);
    const before = e.state.doc.childCount;
    expect(escapeLeadingBlock(e)).toBe(false);
    expect(e.state.doc.childCount).toBe(before);
  });

  it("does nothing when there is a non-empty selection", () => {
    const e = make("<pre><code>const x = 1</code></pre>");
    e.commands.setTextSelection({ from: 1, to: 4 });
    expect(escapeLeadingBlock(e)).toBe(false);
    expect(firstType(e)).toBe("codeBlock");
  });

  it("handles an empty leading code block", () => {
    const e = make("<pre><code></code></pre>");
    e.commands.setTextSelection(1);
    expect(escapeLeadingBlock(e)).toBe(true);
    expect(firstType(e)).toBe("paragraph");
  });
});

// ArrowLeft binds with requireBlockStart: mid-line it must keep its normal
// caret-movement meaning. The regression being pinned: pressing ArrowLeft at
// offset 5 of a leading code block's first line inserted an empty paragraph
// (dirty + undo step + autosave) instead of moving the caret left.
describe("escapeLeadingBlock — requireBlockStart (ArrowLeft binding)", () => {
  it("does nothing mid-line so ArrowLeft falls through to caret movement", () => {
    const e = make("<pre><code>const x = 1</code></pre>");
    e.commands.setTextSelection(6); // offset 5 inside the first line
    const before = e.state.doc.childCount;
    expect(escapeLeadingBlock(e, { requireBlockStart: true })).toBe(false);
    expect(e.state.doc.childCount).toBe(before);
    expect(firstType(e)).toBe("codeBlock");
  });

  it("still escapes from the very start of the block", () => {
    const e = make("<pre><code>const x = 1</code></pre>");
    e.commands.setTextSelection(1); // parentOffset === 0
    expect(escapeLeadingBlock(e, { requireBlockStart: true })).toBe(true);
    expect(firstType(e)).toBe("paragraph");
  });
});

describe("Tiptap 3.29 code-block ArrowUp integration", () => {
  it("upstream inserts a paragraph at the exact start without Noten's extension", () => {
    editor = new Editor({
      extensions: [StarterKit.configure({ gapcursor: false })],
      content: "<pre><code>const x = 1</code></pre>",
    });
    editor.commands.setTextSelection(1);
    const before = editor.state.doc.childCount;

    expect(pressKey(editor, "ArrowUp").defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(before + 1);
    expect(firstType(editor)).toBe("paragraph");
    expect(editor.state.doc.child(1).type.name).toBe("codeBlock");
  });

  it("delegates offset-zero ArrowUp to upstream without double-inserting", () => {
    const e = make("<pre><code>const x = 1</code></pre>");
    e.commands.setTextSelection(1);
    const before = e.state.doc.childCount;

    expect(pressKey(e, "ArrowUp").defaultPrevented).toBe(true);
    expect(e.state.doc.childCount).toBe(before + 1);
    expect(firstType(e)).toBe("paragraph");
    expect(e.state.doc.child(1).type.name).toBe("codeBlock");
  });

  it("keeps Noten's broader first-line ArrowUp behavior", () => {
    const e = make("<pre><code>const x = 1</code></pre>");
    e.commands.setTextSelection(6);
    const before = e.state.doc.childCount;

    expect(pressKey(e, "ArrowUp").defaultPrevented).toBe(true);
    expect(e.state.doc.childCount).toBe(before + 1);
    expect(firstType(e)).toBe("paragraph");
  });
});
