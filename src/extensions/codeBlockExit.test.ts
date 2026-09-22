import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import MermaidCodeBlock from "./MermaidCodeBlock";

const lowlight = createLowlight(common);

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

// Same order as TiptapEditor: StarterKit (with HardBreak's Shift-Enter and
// Mod-Enter bindings and TrailingNode) first, the code block after it.
function make(content: string): Editor {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false, gapcursor: false }),
      MermaidCodeBlock.configure({ lowlight }),
    ],
    content,
  });
  return editor;
}

function press(e: Editor, key: string, init: KeyboardEventInit = {}) {
  e.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

const types = (e: Editor) => {
  const names: string[] = [];
  e.state.doc.forEach((node) => names.push(node.type.name));
  return names;
};

const cursorBlock = (e: Editor) => e.state.selection.$from.parent;

// A code block that ends the note: TrailingNode appends an empty paragraph
// after it on the first transaction (the setTextSelection here).
function lastCodeBlock(code: string): Editor {
  const e = make(`<pre><code>${code}</code></pre>`);
  e.commands.setTextSelection(1 + code.length);
  expect(types(e)).toEqual(["codeBlock", "paragraph"]);
  return e;
}

const exits: Array<[string, KeyboardEventInit]> = [
  ["Shift-Enter", { shiftKey: true }],
  ["Mod-Enter", { ctrlKey: true }],
];

describe("leaving a code block", () => {
  it.each(exits)("%s steps into the trailing paragraph instead of adding one", (_, init) => {
    const e = lastCodeBlock("x");

    press(e, "Enter", init);

    expect(types(e)).toEqual(["codeBlock", "paragraph"]);
    expect(e.state.doc.child(0).textContent).toBe("x");
    expect(cursorBlock(e)).toBe(e.state.doc.child(1));
  });

  it("a third Enter at the end steps into the trailing paragraph", () => {
    const e = lastCodeBlock("x");

    press(e, "Enter");
    press(e, "Enter");
    expect(e.state.doc.child(0).textContent).toBe("x\n\n");
    press(e, "Enter");

    expect(types(e)).toEqual(["codeBlock", "paragraph"]);
    expect(e.state.doc.child(0).textContent).toBe("x");
    expect(cursorBlock(e)).toBe(e.state.doc.child(1));
  });

  it.each(exits)("%s still inserts a paragraph when the next block has content", (_, init) => {
    const e = make("<pre><code>line1\nline2</code></pre><p>after</p>");
    e.commands.setTextSelection(3); // inside "line1"

    press(e, "Enter", init);

    expect(types(e)).toEqual(["codeBlock", "paragraph", "paragraph"]);
    expect(e.state.doc.child(0).textContent).toBe("line1\nline2");
    expect(e.state.doc.child(1).textContent).toBe("");
    expect(e.state.doc.child(2).textContent).toBe("after");
    expect(cursorBlock(e)).toBe(e.state.doc.child(1));
  });

  it("does not step into an empty heading below", () => {
    const e = make("<pre><code>x</code></pre><h2></h2><p>after</p>");
    e.commands.setTextSelection(2);

    press(e, "Enter", { shiftKey: true });

    expect(types(e)).toEqual(["codeBlock", "paragraph", "heading", "paragraph"]);
    expect(cursorBlock(e)).toBe(e.state.doc.child(1));
  });

  it("Enter still adds a line inside the block", () => {
    const e = lastCodeBlock("ab");
    e.commands.setTextSelection(2);

    press(e, "Enter");

    expect(e.state.doc.child(0).textContent).toBe("a\nb");
    expect(cursorBlock(e)).toBe(e.state.doc.child(0));
  });

  it("leaves Shift-Enter in paragraphs alone", () => {
    const e = make("<p>ab</p>");
    e.commands.setTextSelection(2);

    press(e, "Enter", { shiftKey: true });

    expect(e.state.doc.child(0).child(1).type.name).toBe("hardBreak");
  });
});
