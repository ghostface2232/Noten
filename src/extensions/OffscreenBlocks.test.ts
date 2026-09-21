import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import OffscreenBlocks, { SKIP_OFFSCREEN_CLASS } from "./OffscreenBlocks";

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

const LIST_DOC = "<p>intro</p><ul><li><p>one</p></li><li><p>two</p></li></ul><p>middle</p><ul><li><p>far</p></li></ul>";

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
    expect(observers[0].disconnected).toBe(true);
  });
});
