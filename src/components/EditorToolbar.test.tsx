import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor as ReactEditor } from "@tiptap/react";
import { EditorToolbar } from "./EditorToolbar";

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
function setup(content: string) {
  const editor = new Editor({ extensions: [StarterKit], content });
  active = editor;
  const commits = { n: 0 };
  render(
    <FluentProvider theme={webLightTheme}>
      <Profiler id="toolbar" onRender={() => { commits.n++; }}>
        <EditorToolbar
          editor={editor as unknown as ReactEditor}
          sidebarOpen={false}
          hidden={false}
          locale="en"
          onOpenSearch={noop}
          onOpenGoToLine={noop}
          outlineOpen={false}
          onToggleOutline={noop}
        />
      </Profiler>
    </FluentProvider>,
  );
  return { editor, commits };
}

// One transaction, then the frame the toolbar's subscription waits for.
async function transact(run: () => void) {
  await act(async () => {
    run();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

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
});
