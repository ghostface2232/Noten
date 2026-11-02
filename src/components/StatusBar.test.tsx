import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { undoDepth } from "@tiptap/pm/history";
import type { Editor as ReactEditor } from "@tiptap/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { announceDocumentSwap } from "../extensions/documentSwap";
import { STATS_MAX_WAIT_MS, STATS_SETTLE_MS, StatusBar } from "./StatusBar";

let active: Editor | null = null;

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  active?.destroy();
  active = null;
});

function makeEditor() {
  const editor = new Editor({
    extensions: [StarterKit],
    content: "<p>alpha</p><p>beta</p>",
  });
  active = editor;
  return editor;
}

function status(editor: Editor, hidden = false) {
  return (
    <FluentProvider theme={webLightTheme}>
      <StatusBar editor={editor as unknown as ReactEditor} hidden={hidden} locale="en" />
    </FluentProvider>
  );
}

/** Swaps the document as openDocument does: a new EditorState, no transaction. */
function swapDocument(editor: Editor, text: string) {
  const doc = editor.schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins }));
}

describe("StatusBar after a document swap", () => {
  it("shows the new note's counts once the swap is announced", async () => {
    const editor = makeEditor();
    render(status(editor));
    await waitFor(() => expect(screen.getByText(/^9/)).toBeTruthy());

    swapDocument(editor, "twelve chars");
    act(() => { announceDocumentSwap(editor); });

    await waitFor(() => expect(screen.getByText(/^12/)).toBeTruthy());
  });

  it("announces without editing the note or adding an undo step", async () => {
    const editor = makeEditor();
    act(() => { editor.view.dispatch(editor.state.tr.insertText("!", 6)); });
    const doc = editor.state.doc;
    const depth = undoDepth(editor.state);
    const onUpdate = vi.fn();
    editor.on("update", onUpdate);

    announceDocumentSwap(editor);

    expect(editor.state.doc).toBe(doc);
    expect(undoDepth(editor.state)).toBe(depth);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("is announced by openDocument after every way it replaces the document", () => {
    const source = readFileSync(resolve(__dirname, "TiptapEditor.tsx"), "utf8");
    const open = source.slice(source.indexOf("const openDocument = useCallback"));
    const body = open.slice(0, open.indexOf("const invalidateDocumentSession"));
    const announced = body.indexOf("announceDocumentSwap(editor)");
    expect(announced).toBeGreaterThan(body.lastIndexOf("updateState("));
    expect(announced).toBeGreaterThan(body.lastIndexOf("setContent("));
    // The session cache keeps editor.state, so it must hold the announced one.
    expect(announced).toBeLessThan(body.lastIndexOf("touchDocumentSession(resolvedKey"));
  });
});

describe("StatusBar subscriptions and document work", () => {
  it("does not subscribe while hidden and refreshes when shown", async () => {
    const editor = makeEditor();
    const onSpy = vi.spyOn(editor, "on");
    const offSpy = vi.spyOn(editor, "off");
    const view = render(status(editor, true));

    expect(onSpy).not.toHaveBeenCalledWith("transaction", expect.any(Function));

    view.rerender(status(editor, false));
    await waitFor(() => expect(screen.getByText(/9/)).toBeTruthy());
    expect(onSpy).toHaveBeenCalledWith("transaction", expect.any(Function));

    view.rerender(status(editor, true));
    expect(offSpy).toHaveBeenCalledWith("transaction", expect.any(Function));
  });

  it("reuses document-wide counts for a selection-only transaction", async () => {
    const editor = makeEditor();
    render(status(editor));
    await waitFor(() => expect(screen.getByText(/9/)).toBeTruthy());

    const doc = editor.state.doc;
    const textContentSpy = vi.spyOn(doc, "textContent", "get");

    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8)),
      );
    });

    await waitFor(() => expect(screen.getByText(/Line 2/)).toBeTruthy());
    expect(textContentSpy).not.toHaveBeenCalled();
  });

  it("waits for a pause in typing, then updates counts and caret row together", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
    const editor = makeEditor();
    render(status(editor));
    expect(screen.getByText(/9/)).toBeTruthy();
    expect(screen.getByText(/Line 1/)).toBeTruthy();

    const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
    act(() => { editor.view.dispatch(editor.state.tr.insertText("!", 6)); });
    advance(STATS_SETTLE_MS - 100);
    // Still typing: the next edit restarts the wait.
    act(() => { editor.view.dispatch(editor.state.tr.insertText("?", 7)); });
    // A caret move meanwhile waits too; its row needs the new line index.
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 10)));
    });
    advance(STATS_SETTLE_MS - 100);
    expect(screen.getByText(/9/)).toBeTruthy();
    expect(screen.getByText(/Line 1/)).toBeTruthy();

    advance(200);
    expect(screen.getByText(/11/)).toBeTruthy();
    expect(screen.getByText(/Line 2/)).toBeTruthy();
  });

  it("updates at least once per STATS_MAX_WAIT_MS while typing never pauses", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
    const editor = makeEditor();
    render(status(editor));
    expect(screen.getByText(/9/)).toBeTruthy();

    // One key every 100 ms from t = 0 to t = 900, faster than the pause the
    // counts wait for: only the cap, at t = 1000, lets them update.
    for (let t = 0; t < STATS_MAX_WAIT_MS; t += 100) {
      act(() => { editor.view.dispatch(editor.state.tr.insertText("!", 6)); });
      act(() => { vi.advanceTimersByTime(t + 100 < STATS_MAX_WAIT_MS ? 100 : 90); });
    }
    expect(screen.getByText(/^9/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(40); });
    expect(screen.getByText(/^19/)).toBeTruthy();
  });
});
