import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import type { Editor as ReactEditor } from "@tiptap/react";
import { OutlinePanel } from "./OutlinePanel";

let active: Editor | null = null;
afterEach(() => {
  cleanup();
  active?.destroy();
  active = null;
});

function makeEditor(content: string) {
  const editor = new Editor({ extensions: [StarterKit], content });
  active = editor;
  return editor;
}

/**
 * Swap the editor's document the way TiptapEditor's openDocument does on a
 * note switch: a whole-EditorState replacement via view.updateState, which
 * emits NO transaction. The outline must refresh regardless.
 */
function swapDocument(editor: Editor, content: string) {
  const tmp = new Editor({ extensions: [StarterKit], content });
  const doc = editor.schema.nodeFromJSON(tmp.state.doc.toJSON());
  tmp.destroy();
  editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins }));
}

function renderPanel(editor: Editor, docKey: string) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <OutlinePanel
        editor={editor as unknown as ReactEditor}
        locale="en"
        docKey={docKey}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    </FluentProvider>,
  );
}

function rerenderPanel(
  view: ReturnType<typeof renderPanel>,
  editor: Editor,
  docKey: string,
) {
  view.rerender(
    <FluentProvider theme={webLightTheme}>
      <OutlinePanel
        editor={editor as unknown as ReactEditor}
        locale="en"
        docKey={docKey}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    </FluentProvider>,
  );
}

describe("OutlinePanel — document loading and note switches", () => {
  it("lists the headings of a document that was already loaded at mount", async () => {
    const editor = makeEditor("<h1>Alpha</h1><p>body</p><h2>Beta</h2>");
    renderPanel(editor, "note-a");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
    });
  });

  it("refreshes after an updateState-based note switch that emits no transaction", async () => {
    const editor = makeEditor("<h1>Old heading</h1>");
    const view = renderPanel(editor, "note-a");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Old heading" })).toBeTruthy();
    });

    swapDocument(editor, "<h1>New heading</h1><h2>New section</h2>");
    rerenderPanel(view, editor, "note-b");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New heading" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "New section" })).toBeTruthy();
      expect(screen.queryByText("Old heading")).toBeNull();
    });
  });

  it("shows the empty state after switching to a note without headings", async () => {
    const editor = makeEditor("<h1>Old heading</h1>");
    const view = renderPanel(editor, "note-a");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Old heading" })).toBeTruthy();
    });

    swapDocument(editor, "<p>plain paragraphs only</p>");
    rerenderPanel(view, editor, "note-b");

    await waitFor(() => {
      expect(screen.getByText("No headings in this note")).toBeTruthy();
      expect(screen.queryByText("Old heading")).toBeNull();
    });
  });
});
