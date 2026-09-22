import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor as ReactEditor } from "@tiptap/react";
import { TableBubbleMenu } from "./TableBubbleMenu";

let active: Editor | null = null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  active?.destroy();
  active = null;
});

const CONTENT = "<p>before</p><table><tbody><tr><td><p>cell</p></td></tr></tbody></table><p>after</p>";

function setup() {
  const editor = new Editor({ extensions: [StarterKit, Table, TableRow, TableCell, TableHeader], content: CONTENT });
  active = editor;
  const commits = { n: 0 };
  const view = render(
    <FluentProvider theme={webLightTheme}>
      <Profiler id="table-menu" onRender={() => { commits.n++; }}>
        <TableBubbleMenu editor={editor as unknown as ReactEditor} locale="en" />
      </Profiler>
    </FluentProvider>,
  );
  return { editor, commits, view };
}

async function transact(run: () => void) {
  await act(async () => {
    run();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

const select = (editor: Editor, pos: number) =>
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));

// Position inside the table's only cell paragraph.
const cellPos = (editor: Editor) => {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === "tableCell") pos = at + 2;
  });
  return pos;
};

describe("TableBubbleMenu re-renders", () => {
  it("does not re-render while the caret stays outside tables", async () => {
    const { editor, commits } = setup();
    await transact(() => select(editor, 2));
    const before = commits.n;
    for (const ch of "typing") {
      await transact(() => editor.view.dispatch(editor.state.tr.insertText(ch, 3)));
    }
    expect(commits.n).toBe(before);
  });

  it("still opens in a table and closes on leaving it", async () => {
    const { editor, view } = setup();
    await transact(() => select(editor, 2));
    const closed = view.container.innerHTML;

    await transact(() => select(editor, cellPos(editor)));
    // jsdom has no layout, so the menu is found by what it renders.
    expect(document.body.querySelectorAll("button").length).toBeGreaterThan(0);

    await transact(() => select(editor, editor.state.doc.content.size - 2));
    expect(document.body.querySelectorAll("button").length).toBe(0);
    expect(view.container.innerHTML).toBe(closed);
  });
});
