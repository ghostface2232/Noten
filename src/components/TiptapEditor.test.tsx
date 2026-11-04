import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { createElement, createRef } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata"), join: vi.fn(async (...parts: string[]) => parts.join("/")) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({ label: "main", onFocusChanged: async () => () => {} })) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn(), message: vi.fn(), confirm: vi.fn(), ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(),
  readTextFile: vi.fn(async () => ""),
  writeTextFile: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  remove: vi.fn(),
  copyFile: vi.fn(),
  rename: vi.fn(),
  readDir: vi.fn(async () => []),
  exists: vi.fn(async () => true),
  stat: vi.fn(),
  watch: vi.fn(async () => () => {}),
}));

import { TiptapEditor, type TiptapEditorHandle } from "./TiptapEditor";

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  g.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  g.requestIdleCallback ??= (cb: (deadline: unknown) => void) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 1 }), 0);
  g.cancelIdleCallback ??= (id: number) => clearTimeout(id);
  g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const doc = document as unknown as Record<string, unknown>;
  doc.elementFromPoint ??= () => document.body;
  doc.fonts ??= { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {}, status: "loaded" };
  const range = Range.prototype as unknown as Record<string, unknown>;
  range.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  range.getBoundingClientRect ??= () => ({ x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView ??= () => {};
});

afterEach(cleanup);

function mountEditor() {
  const ref = createRef<TiptapEditorHandle>();
  const onDirtyChange = vi.fn();
  render(createElement(
    FluentProvider,
    { theme: webLightTheme },
    createElement(TiptapEditor as unknown as React.ComponentType<Record<string, unknown>>, {
      ref,
      initialMarkdown: "",
      editable: true,
      isDarkMode: false,
      locale: "en",
      paragraphSpacing: 0,
      wordWrap: "word",
      keepFormatOnPaste: true,
      spellcheck: false,
      focusMode: false,
      onDirtyChange,
    }),
  ));
  const open = (noteId: string, markdown: string) => act(async () => {
    ref.current!.openDocument({ noteId, filePath: `/notes/${noteId}.md`, markdown, reason: "switch" });
  });
  return { editor: () => ref.current!.getEditor() as Editor, onDirtyChange, open };
}

describe("TiptapEditor: an image beside text", () => {
  it("renders inside its paragraph, and survives an edit next to it", async () => {
    const { editor, open } = mountEditor();
    await open("n", "before ![i](z.png) after");

    const dom = editor().view.dom.querySelector(".tiptap-image-node");
    expect(dom?.tagName).toBe("SPAN");
    expect(dom?.closest("p")).not.toBeNull();

    await act(async () => {
      const e = editor();
      e.view.dispatch(e.state.tr.insertText("x", 1));
    });

    expect(() => editor().state.doc.check()).not.toThrow();
    expect(editor().getMarkdown()).toBe("xbefore ![i](z.png) after");
  });

  it("selects and resizes through its own node type", async () => {
    const { editor, open } = mountEditor();
    await open("n", "before ![i](z.png) after");

    await act(async () => {
      editor().chain().setNodeSelection(8).updateAttributes("inlineImage", { width: 100, height: 50 }).run();
    });

    expect(editor().getMarkdown()).toContain('width="100"');
    expect(editor().view.dom.querySelector(".tiptap-image-node img")?.getAttribute("style")).toContain("width: 100px");
  });

  it("keeps a standalone image a block", async () => {
    const { editor, open } = mountEditor();
    await open("n", "![i](z.png)");

    expect(editor().view.dom.querySelector(".tiptap-image-node")?.tagName).toBe("DIV");
  });
});

// Notes that do not end in a paragraph, where TrailingNode has something to add.
const TAILS = ["# heading", "para\n\n- item", "para\n\n```\ncode\n```", "para\n\n> quote", "| a |\n|---|\n| 1 |", "para\n\n- [ ] task"];

describe("TiptapEditor: opening a note is not an edit", () => {
  it.each(TAILS)("does not report %j edited when it opens", async (markdown) => {
    const { editor, onDirtyChange, open } = mountEditor();
    await open("n", markdown);

    expect(editor().state.doc.lastChild?.type.name).toBe("paragraph");
    expect(onDirtyChange).not.toHaveBeenCalled();
  });

  it("does not report an edit for the first click after opening", async () => {
    const { editor, onDirtyChange, open } = mountEditor();
    await open("n", "para\n\n- item");

    await act(async () => {
      const e = editor();
      e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(1))));
    });

    expect(onDirtyChange).not.toHaveBeenCalled();
  });

  it("does not report an edit when switching to such a note, or back to it", async () => {
    const { onDirtyChange, open } = mountEditor();
    await open("a", "body of a");
    await open("b", "# heading");
    await open("a", "body of a");
    await open("b", "# heading");

    expect(onDirtyChange).not.toHaveBeenCalled();
  });

  it("leaves the trailing paragraph out of undo history", async () => {
    const { editor, open } = mountEditor();
    await open("n", "# heading");

    await act(async () => { editor().commands.undo(); });

    expect(editor().state.doc.childCount).toBe(2);
    expect(editor().state.doc.firstChild?.textContent).toBe("heading");
  });

  it("still reports a real edit", async () => {
    const { editor, onDirtyChange, open } = mountEditor();
    await open("n", "# heading");

    await act(async () => {
      const e = editor();
      e.view.dispatch(e.state.tr.insertText("x", 1));
    });

    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });
});
