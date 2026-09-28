import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Editor as ReactEditor } from "@tiptap/react";
import { EditorToolbar } from "./EditorToolbar";
import { NotenStarterKit } from "../extensions/CodeSpanFence";

let active: Editor | null = null;

beforeEach(() => {
  // The toolbar measures its width to choose one or two rows.
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  active?.destroy();
  active = null;
});

const noop = () => {};

/** Renders the toolbar and counts its commits. */
function setup(content: string, extensions = [StarterKit]) {
  const editor = new Editor({ extensions, content });
  active = editor;
  const commits = { n: 0 };
  const ui = (outlineOpen: boolean) => (
    <FluentProvider theme={webLightTheme}>
      <Profiler id="toolbar" onRender={() => { commits.n++; }}>
        <EditorToolbar
          editor={editor as unknown as ReactEditor}
          sidebarOpen={false}
          hidden={false}
          locale="en"
          onOpenSearch={noop}
          onOpenGoToLine={noop}
          outlineOpen={outlineOpen}
          onToggleOutline={noop}
        />
      </Profiler>
    </FluentProvider>
  );
  const view = render(ui(false));
  return { editor, commits, rerender: (outlineOpen: boolean) => view.rerender(ui(outlineOpen)) };
}

// One transaction, then the frame the toolbar's subscription waits for.
async function transact(run: () => void) {
  await act(async () => {
    run();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe("EditorToolbar numbered list split button", () => {
  it("toggles the list with its left half and picks a style from its right half", async () => {
    const { editor } = setup("<p>alpha</p>", [NotenStarterKit]);
    await transact(() => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2))));

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Numbered list" })); });
    expect(editor.isActive("orderedList")).toBe(true);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Numbered list style" })); });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "1. 2. 3.Numbers",
      "a. b. c.Lowercase letters",
      "A. B. C.Uppercase letters",
      "i. ii. iii.Lowercase roman numerals",
      "I. II. III.Uppercase roman numerals",
    ]);
    expect(items[0].getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(items[1]); });
    expect(editor.getAttributes("orderedList").type).toBe("a");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Numbered list" })); });
    expect(editor.isActive("orderedList")).toBe(false);
  });
});

describe("EditorToolbar re-renders", () => {
  it("does not re-render for typing that leaves its state unchanged", async () => {
    const { editor, commits } = setup("<p>alpha</p>");
    // The first edit makes undo available: one render.
    await transact(() => editor.view.dispatch(editor.state.tr.insertText("x", 3)));
    const after = commits.n;
    for (const ch of "more text") {
      await transact(() => editor.view.dispatch(editor.state.tr.insertText(ch, 3)));
    }
    expect(commits.n).toBe(after);
  });

  it("re-renders when a mark becomes active", async () => {
    const { editor, commits } = setup("<p>alpha <strong>bold</strong></p>");
    await transact(() => editor.view.dispatch(editor.state.tr.insertText("x", 3)));
    const before = commits.n;
    await transact(() => editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 10)),
    ));
    expect(commits.n).toBeGreaterThan(before);
  });

  it("re-renders for a selection that is in headings without being at one level", async () => {
    // Caret in the paragraph, then a range across an H1 and an H2: only the
    // heading button's active state changes (its label stays "body").
    const { editor, commits } = setup("<p>para</p><h1>one</h1><h2>two</h2>");
    await transact(() => editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)),
    ));
    expect(editor.isActive("heading")).toBe(false);
    const before = commits.n;
    await transact(() => editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8, 14)),
    ));
    expect(editor.isActive("heading")).toBe(true);
    expect(editor.isActive("heading", { level: 1 })).toBe(false);
    expect(commits.n).toBeGreaterThan(before);
  });

  it("compares against what is on screen after a render the subscription did not cause", async () => {
    const { editor, rerender } = setup("<p>alpha</p>");
    const undo = () => screen.getByRole("button", { name: /undo/i }) as HTMLButtonElement;
    await transact(() => editor.view.dispatch(editor.state.tr.insertText("x", 3)));
    expect(undo().disabled).toBe(false);

    // A note switch: a fresh state without history and without a transaction,
    // then a prop change re-renders the toolbar with undo unavailable.
    act(() => {
      editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins }));
    });
    rerender(true);
    expect(undo().disabled).toBe(true);

    // Typing makes undo available again: the same state the subscription saw
    // before the switch, but not what the toolbar shows.
    await transact(() => editor.view.dispatch(editor.state.tr.insertText("y", 3)));
    expect(undo().disabled).toBe(false);
  });
});
