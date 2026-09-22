import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import OffscreenBlocks, { MAX_TEXT_SKIP_BLOCKS, SKIP_OFFSCREEN_CLASS, SKIP_TEXT_CLASS } from "./OffscreenBlocks";

// jsdom has no layout, ResizeObserver or frames: fake all three so the tests
// drive width changes, frame boundaries and on/off-screen positions directly.

let frames: Array<() => void> = [];
let observers: FakeResizeObserver[] = [];
let offscreen = new WeakSet<Element>();

class FakeResizeObserver {
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  fire(width: number) {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function flushFrames() {
  // Each pass runs only the callbacks queued before it, like real frames.
  for (let i = 0; i < 4 && frames.length; i++) {
    const batch = frames;
    frames = [];
    for (const f of batch) f();
  }
}

let active: Editor | null = null;

beforeEach(() => {
  frames = [];
  observers = [];
  offscreen = new WeakSet();
  let id = 0;
  const pending = new Map<number, () => void>();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const handle = ++id;
    const run = () => {
      if (pending.delete(handle)) cb(0);
    };
    pending.set(handle, run);
    frames.push(run);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    pending.delete(handle);
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = offscreen.has(this) ? 5000 : 100;
    return { top, bottom: top + 50, left: 0, right: 100, width: 100, height: 50, x: 0, y: top, toJSON() {} } as DOMRect;
  });
});

afterEach(() => {
  active?.destroy();
  active = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeEditor(content: string) {
  const editor = new Editor({ extensions: [StarterKit, OffscreenBlocks], content });
  active = editor;
  return editor;
}

/** Editor laid out at a real width, skipping switched on. */
function readyEditor(content: string) {
  const editor = makeEditor(content);
  observers[0].fire(800);
  flushFrames();
  expect(skipping(editor)).toBe(true);
  return editor;
}

const skipping = (editor: Editor) => editor.view.dom.classList.contains(SKIP_OFFSCREEN_CLASS);

/** Position just inside the index-th top-level block. */
function insideBlock(editor: Editor, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  return pos;
}

function topLevelDom(editor: Editor, index: number) {
  return editor.view.nodeDOM(insideBlock(editor, index)) as HTMLElement;
}

const LIST_DOC = "<p>intro</p><ul><li><p>one</p></li><li><p>two</p></li></ul><blockquote><p>middle</p></blockquote><ul><li><p>far</p></li></ul>";

const skipsText = (editor: Editor) => editor.view.dom.classList.contains(SKIP_TEXT_CLASS);
const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `<p>p${i}</p>`).join("");

describe("OffscreenBlocks", () => {
  it("turns skipping on only after a measuring frame at a real width", () => {
    const editor = makeEditor(LIST_DOC);
    flushFrames();
    // No width reported yet: nothing has been laid out to remember.
    expect(skipping(editor)).toBe(false);

    observers[0].fire(800);
    expect(skipping(editor)).toBe(false);
    frames.shift()?.();
    // One frame is the measuring layout; the class returns on the next.
    expect(skipping(editor)).toBe(false);
    flushFrames();
    expect(skipping(editor)).toBe(true);
  });

  it("stays off while the editor has no width", () => {
    const editor = makeEditor(LIST_DOC);
    observers[0].fire(0);
    flushFrames();
    expect(skipping(editor)).toBe(false);
  });

  it("re-measures when the width changes, not when it repeats", () => {
    const editor = readyEditor(LIST_DOC);
    observers[0].fire(800);
    expect(skipping(editor)).toBe(true);

    observers[0].fire(600);
    expect(skipping(editor)).toBe(false);
    flushFrames();
    expect(skipping(editor)).toBe(true);
  });

  it("leaves skipping on for edits to on-screen blocks", () => {
    const editor = readyEditor(LIST_DOC);
    editor.commands.insertContentAt(insideBlock(editor, 1) + 3, "x");
    editor.commands.insertContentAt(insideBlock(editor, 0) + 1, "y");
    expect(skipping(editor)).toBe(true);
  });

  it("leaves skipping on for edits to off-screen blocks that are never skipped", () => {
    const editor = readyEditor(LIST_DOC);
    offscreen.add(topLevelDom(editor, 2));
    editor.commands.insertContentAt(insideBlock(editor, 2) + 1, "z");
    expect(skipping(editor)).toBe(true);
  });

  it("re-measures when an off-screen skippable block changes", () => {
    const editor = readyEditor(LIST_DOC);
    offscreen.add(topLevelDom(editor, 3));
    editor.commands.insertContentAt(insideBlock(editor, 3) + 3, "far edit");
    expect(skipping(editor)).toBe(false);
    flushFrames();
    expect(skipping(editor)).toBe(true);
  });

  it("does not re-measure for an off-screen list that is never skipped", () => {
    // A list holding a rule keeps its normal layout (see tiptap-editor.css).
    const editor = readyEditor("<p>intro</p><ul><li><p>one</p><hr></li></ul>");
    offscreen.add(topLevelDom(editor, 1));
    editor.commands.insertContentAt(insideBlock(editor, 1) + 3, "x");
    expect(skipping(editor)).toBe(true);
  });

  it("re-measures when a skippable block is created off screen", () => {
    const editor = readyEditor(LIST_DOC);
    offscreen = new WeakSet();
    // Every element is off screen from here on, including the new one.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: 5000, bottom: 5050, left: 0, right: 100, width: 100, height: 50, x: 0, y: 5000, toJSON() {} }) as DOMRect,
    );
    editor.commands.insertContentAt(editor.state.doc.content.size, "<ol><li><p>new</p></li></ol>");
    expect(skipping(editor)).toBe(false);
  });

  it("re-measures when a replacement with equal-looking content shifts blocks into other elements", () => {
    // Window sync / file reload replace the document with new node objects.
    // For node views that accept updates (like the app's code blocks)
    // ProseMirror reuses the old elements in order, so after an insertion
    // each later block lands in its predecessor's element. A content diff
    // sees only the insertion (on screen); the shifted blocks below are off
    // screen and must still be re-measured.
    const CodeBlockView = CodeBlock.extend({
      addNodeView() {
        return () => {
          const dom = document.createElement("div");
          dom.className = "noten-code-block";
          const code = document.createElement("code");
          dom.append(code);
          return { dom, contentDOM: code, update: (node) => node.type.name === "codeBlock" };
        };
      },
    });
    const editor = new Editor({ extensions: [StarterKit.configure({ codeBlock: false }), CodeBlockView, OffscreenBlocks] });
    active = editor;
    const { schema } = editor.state;
    const code = (text: string) => schema.nodes.codeBlock.create(null, schema.text(text));
    editor.commands.setContent([schema.nodes.paragraph.create(null, schema.text("top")), code("a"), code("b"), code("c"), code("d")].map((n) => n.toJSON()));
    observers[0].fire(800);
    flushFrames();
    expect(skipping(editor)).toBe(true);

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const index = Array.prototype.indexOf.call(this.parentElement?.children ?? [], this);
      const top = index >= 3 ? 5000 : 100;
      return { top, bottom: top + 50, left: 0, right: 100, width: 100, height: 50, x: 0, y: top, toJSON() {} } as DOMRect;
    });
    const fresh = [schema.nodes.paragraph.create(null, schema.text("top")), code("new"), code("a"), code("b"), code("c"), code("d")];
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, fresh));
    expect(skipping(editor)).toBe(false);
  });

  it("re-measures after a whole-document replacement without inspecting blocks", () => {
    const editor = readyEditor(LIST_DOC);
    const rect = vi.mocked(Element.prototype.getBoundingClientRect);
    rect.mockClear();
    const many = Array.from({ length: 40 }, (_, i) => `<p>p${i}</p>`).join("");
    editor.commands.setContent(many);
    expect(skipping(editor)).toBe(false);
    expect(rect).not.toHaveBeenCalled();
  });

  it("ignores transactions that leave the document unchanged", () => {
    const editor = readyEditor(LIST_DOC);
    offscreen.add(topLevelDom(editor, 3));
    editor.commands.setTextSelection(insideBlock(editor, 3) + 3);
    expect(skipping(editor)).toBe(true);
  });

  it("exposes remeasure through storage", () => {
    const editor = readyEditor(LIST_DOC);
    editor.storage.offscreenBlocks.remeasure();
    expect(skipping(editor)).toBe(false);
    flushFrames();
    expect(skipping(editor)).toBe(true);
  });

  it("cleans up on destroy", () => {
    const editor = readyEditor(LIST_DOC);
    const dom = editor.view.dom;
    editor.destroy();
    active = null;
    expect(dom.classList.contains(SKIP_OFFSCREEN_CLASS)).toBe(false);
    expect(dom.classList.contains(SKIP_TEXT_CLASS)).toBe(false);
    expect(observers[0].disconnected).toBe(true);
  });

  describe("prose", () => {
    it("skips paragraphs and headings in a note within the limit", () => {
      const editor = readyEditor(LIST_DOC);
      expect(skipsText(editor)).toBe(true);
    });

    it("re-measures when an off-screen paragraph or heading changes", () => {
      const editor = readyEditor("<p>top</p><p>far</p><h2>far heading</h2>");
      offscreen.add(topLevelDom(editor, 1));
      editor.commands.insertContentAt(insideBlock(editor, 1) + 1, "x");
      expect(skipping(editor)).toBe(false);
      flushFrames();
      expect(skipping(editor)).toBe(true);

      offscreen.add(topLevelDom(editor, 2));
      editor.commands.insertContentAt(insideBlock(editor, 2) + 1, "y");
      expect(skipping(editor)).toBe(false);
    });

    it("leaves skipping on for edits to an on-screen paragraph", () => {
      const editor = readyEditor("<p>top</p><p>here</p>");
      editor.commands.insertContentAt(insideBlock(editor, 1) + 1, "x");
      expect(skipping(editor)).toBe(true);
    });

    it("keeps prose unskipped past the block limit, where paragraph edits need no re-measure", () => {
      const editor = readyEditor(paragraphs(MAX_TEXT_SKIP_BLOCKS + 1));
      expect(skipsText(editor)).toBe(false);
      offscreen.add(topLevelDom(editor, 10));
      editor.commands.insertContentAt(insideBlock(editor, 10) + 1, "x");
      expect(skipping(editor)).toBe(true);
    });

    it("switches prose skipping with the block count and re-measures", () => {
      const editor = readyEditor(paragraphs(MAX_TEXT_SKIP_BLOCKS));
      expect(skipsText(editor)).toBe(true);

      // One more block crosses the limit.
      editor.commands.insertContentAt(0, "<p>one more</p>");
      expect(skipsText(editor)).toBe(false);
      expect(skipping(editor)).toBe(false);
      flushFrames();
      expect(skipping(editor)).toBe(true);

      // A deletion brings it back under.
      editor.commands.deleteRange({ from: 0, to: editor.state.doc.child(0).nodeSize });
      expect(skipsText(editor)).toBe(true);
      expect(skipping(editor)).toBe(false);
    });
  });
});
