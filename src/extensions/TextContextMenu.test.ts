import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createTiptapTextContextMenuContext } from "./TextContextMenu";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
  ?? Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalClipboardEvent = globalThis.ClipboardEvent;

function createEditor(content: string): Editor {
  return new Editor({
    extensions: [StarterKit],
    content,
  });
}

function findTextRange(editor: Editor, needle: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const index = node.text.indexOf(needle);
    if (index < 0) return true;
    range = { from: pos + index, to: pos + index + needle.length };
    return false;
  });
  if (!range) throw new Error(`Text not found: ${needle}`);
  return range;
}

function selectText(editor: Editor, needle: string): void {
  const range = findTextRange(editor, needle);
  editor.commands.setTextSelection(range);
}

function placeCursorAfter(editor: Editor, needle: string): void {
  editor.commands.setTextSelection(findTextRange(editor, needle).to);
}

function installClipboard(text: string, html: string | null = null): void {
  const clipboard = {
    read: vi.fn(async () => (
      html
        ? [{
            types: ["text/html"],
            getType: vi.fn(async () => new Blob([html], { type: "text/html" })),
          }]
        : []
    )),
    readText: vi.fn(async () => text),
    write: vi.fn(),
    writeText: vi.fn(),
  };

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
}

function ensureClipboardEvent(): void {
  if (globalThis.ClipboardEvent) return;
  Object.defineProperty(globalThis, "ClipboardEvent", {
    configurable: true,
    value: class ClipboardEvent extends Event {},
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }

  if (originalClipboardEvent) {
    Object.defineProperty(globalThis, "ClipboardEvent", {
      configurable: true,
      value: originalClipboardEvent,
    });
  } else {
    Reflect.deleteProperty(globalThis, "ClipboardEvent");
  }
});

describe("TextContextMenu paste", () => {
  it("pastes an internal partial HTML slice inline instead of as a new paragraph", async () => {
    ensureClipboardEvent();

    const source = createEditor("<p>Hello world</p>");
    const target = createEditor("<p>Hello</p>");
    try {
      selectText(source, "world");
      const { dom, text } = source.view.serializeForClipboard(source.state.selection.content());
      installClipboard(text, dom.innerHTML);

      placeCursorAfter(target, "Hello");
      const ctx = createTiptapTextContextMenuContext(target);
      await ctx.paste(false);

      expect(target.getHTML()).toBe("<p>Helloworld</p>");
    } finally {
      source.destroy();
      target.destroy();
    }
  });

  it("pastes plain text as literal text with stable single-newline handling", async () => {
    const target = createEditor("<p></p>");
    try {
      installClipboard("<strong>b</strong>\nnext");

      const ctx = createTiptapTextContextMenuContext(target);
      await ctx.paste(true);

      expect(target.getHTML()).toBe("<p>&lt;strong&gt;b&lt;/strong&gt;<br>next</p>");
    } finally {
      target.destroy();
    }
  });
});
