import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { EditorView } from "@tiptap/pm/view";
import AnchorLink, { ANCHOR_LINK_PLUGIN_KEY } from "./AnchorLink";
import { extractHeadings } from "../utils/outline";

let active: Editor | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

function makeEditor(content: string) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false }),
      AnchorLink,
    ],
    content,
  });
  active = editor;
  return editor;
}

function fakeClick(
  target: Element | null,
  overrides: Partial<MouseEvent> = {},
): MouseEvent {
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as MouseEvent;
}

function clickPlugin(editor: Editor) {
  const plugin = ANCHOR_LINK_PLUGIN_KEY.get(editor.state);
  if (!plugin?.props.handleClick) throw new Error("anchorLink plugin not found");
  const handleClick = plugin.props.handleClick.bind(plugin) as (
    view: EditorView,
    pos: number,
    event: MouseEvent,
  ) => boolean;
  return (event: MouseEvent) => handleClick(editor.view, 0, event);
}

describe("AnchorLink handleClick", () => {
  it("jumps to the matching heading pos and prevents default", () => {
    const editor = makeEditor(
      '<h1>Intro</h1><p>body</p><p><a href="#intro">go</a></p>',
    );
    const onJump = vi.fn();
    editor.storage.anchorLink.onJump = onJump;

    const event = fakeClick(editor.view.dom.querySelector("a"));
    expect(clickPlugin(editor)(event)).toBe(true);

    const introPos = extractHeadings(editor.state.doc)[0].pos;
    expect(onJump).toHaveBeenCalledWith(introPos);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("resolves duplicate-slug suffixes to the later heading", () => {
    const editor = makeEditor(
      '<h2>Same</h2><h2>Same</h2><p><a href="#same-1">go</a></p>',
    );
    const onJump = vi.fn();
    editor.storage.anchorLink.onJump = onJump;

    expect(clickPlugin(editor)(fakeClick(editor.view.dom.querySelector("a")))).toBe(true);

    const secondPos = extractHeadings(editor.state.doc)[1].pos;
    expect(onJump).toHaveBeenCalledWith(secondPos);
  });

  it("reports a missing target and still handles the click", () => {
    const editor = makeEditor('<h1>Intro</h1><p><a href="#ghost">go</a></p>');
    const onJump = vi.fn();
    const onMissing = vi.fn();
    editor.storage.anchorLink.onJump = onJump;
    editor.storage.anchorLink.onMissing = onMissing;

    const event = fakeClick(editor.view.dom.querySelector("a"));
    expect(clickPlugin(editor)(event)).toBe(true);
    expect(onMissing).toHaveBeenCalledOnce();
    expect(onJump).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("ignores modifier clicks and non-primary buttons", () => {
    const editor = makeEditor('<h1>Intro</h1><p><a href="#intro">go</a></p>');
    const onJump = vi.fn();
    editor.storage.anchorLink.onJump = onJump;
    const anchor = editor.view.dom.querySelector("a");

    expect(clickPlugin(editor)(fakeClick(anchor, { ctrlKey: true }))).toBe(false);
    expect(clickPlugin(editor)(fakeClick(anchor, { button: 1 }))).toBe(false);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("leaves non-fragment links untouched", () => {
    const editor = makeEditor(
      '<h1>Intro</h1><p><a href="https://example.com">web</a></p>',
    );
    const onJump = vi.fn();
    const onMissing = vi.fn();
    editor.storage.anchorLink.onJump = onJump;
    editor.storage.anchorLink.onMissing = onMissing;

    const event = fakeClick(editor.view.dom.querySelector("a"));
    expect(clickPlugin(editor)(event)).toBe(false);
    expect(onJump).not.toHaveBeenCalled();
    expect(onMissing).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores clicks that are not on an anchor element", () => {
    const editor = makeEditor('<h1>Intro</h1><p><a href="#intro">go</a></p>');
    const onJump = vi.fn();
    editor.storage.anchorLink.onJump = onJump;

    const paragraph = editor.view.dom.querySelector("p");
    expect(clickPlugin(editor)(fakeClick(paragraph))).toBe(false);
    expect(onJump).not.toHaveBeenCalled();
  });
});
