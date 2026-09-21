import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { common, createLowlight } from "lowlight";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import MermaidCodeBlock from "./MermaidCodeBlock";
import WikiLink from "./WikiLink";
import IncrementalMarkdown, { createIncrementalSerializer } from "./IncrementalMarkdown";
import { serializeImageMarkdown } from "../utils/imageMarkdownSerialize";

// The incremental getMarkdown must be byte-identical to @tiptap/markdown's
// own serializer after any sequence of edits.

const lowlight = createLowlight(common);

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(content: string): Editor {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false, underline: false, link: false }),
      Markdown.configure({ marked: createFastMarked() }),
      Link.configure({ openOnClick: false }),
      MermaidCodeBlock.configure({ lowlight }),
      Image.configure({ allowBase64: true }).extend({
        renderMarkdown(node) {
          return serializeImageMarkdown({ src: node.attrs?.src, alt: node.attrs?.alt, title: node.attrs?.title, width: node.attrs?.width, height: node.attrs?.height });
        },
      }),
      Underline,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table,
      TableRow,
      TableCell,
      TableHeader,
      WikiLink,
      IncrementalMarkdown,
    ],
    content,
    contentType: "markdown",
  } as ConstructorParameters<typeof Editor>[0]);
  return editor;
}

const stock = (e: Editor) => e.markdown!.serialize(e.getJSON());

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "src", "extensions", "__fixtures__", "markdown", name), "utf8").replace(/\r\n?/g, "\n");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random edit of the kinds that change top-level blocks and their order. */
function randomEdit(e: Editor, rand: () => number) {
  const { state } = e;
  const size = state.doc.content.size;
  const pos = Math.floor(rand() * (size + 1));
  const tr = state.tr;
  const kind = Math.floor(rand() * 7);
  try {
    if (kind === 0) {
      const $pos = state.doc.resolve(pos);
      if ($pos.parent.inlineContent) tr.insertText(rand() < 0.3 ? "*x* " : "typed", pos);
    } else if (kind === 1) {
      tr.delete(pos, Math.min(size, pos + 1 + Math.floor(rand() * 40)));
    } else if (kind === 2) {
      const $pos = state.doc.resolve(pos);
      if ($pos.parent.isTextblock) tr.split(pos);
    } else if (kind === 3) {
      // An empty paragraph at a top-level boundary (renders as &nbsp; after
      // another empty paragraph — the one previous-sibling dependency).
      let at = 0;
      const target = Math.floor(rand() * state.doc.childCount);
      for (let i = 0; i < target; i++) at += state.doc.child(i).nodeSize;
      tr.insert(at, state.schema.nodes.paragraph.create());
    } else if (kind === 4) {
      // Move a top-level block elsewhere (the same node object reappears
      // after a different previous sibling).
      const from = Math.floor(rand() * state.doc.childCount);
      let start = 0;
      for (let i = 0; i < from; i++) start += state.doc.child(i).nodeSize;
      const node = state.doc.child(from);
      tr.delete(start, start + node.nodeSize);
      let at = 0;
      const to = Math.floor(rand() * tr.doc.childCount);
      for (let i = 0; i < to; i++) at += tr.doc.child(i).nodeSize;
      tr.insert(at, node);
    } else if (kind === 5) {
      tr.setSelection(TextSelection.near(state.doc.resolve(pos)));
      e.view.dispatch(tr);
      e.commands.joinBackward();
      return;
    } else {
      tr.replace(pos, pos, new Slice(Fragment.from(state.schema.nodes.horizontalRule.create()), 0, 0));
    }
    if (tr.docChanged) e.view.dispatch(tr);
  } catch {
    // Positions that do not admit this edit are skipped.
  }
}

describe("IncrementalMarkdown", () => {
  it("matches the stock serializer on the fixtures", () => {
    for (const name of ["kitchen-sink.md", "list-boundaries.md", "images-and-tables.md", "international-and-links.md"]) {
      const e = makeEditor(fixture(name));
      expect(e.getMarkdown()).toBe(stock(e));
      e.destroy();
      editor = null;
    }
  });

  it("stays identical to the stock serializer through random edits", () => {
    const rand = mulberry32(0xbeef);
    for (const name of ["kitchen-sink.md", "list-boundaries.md", "images-and-tables.md"]) {
      const e = makeEditor(fixture(name));
      for (let i = 0; i < 250; i++) {
        randomEdit(e, rand);
        if (rand() < 0.1) e.commands.undo();
        expect(e.getMarkdown(), `${name} after edit ${i}`).toBe(stock(e));
      }
      e.destroy();
      editor = null;
    }
  }, 60_000);

  it("renders an empty paragraph after another empty one as &nbsp; only while it follows one", () => {
    const e = makeEditor("one\n\ntwo");
    const empty = () => e.state.schema.nodes.paragraph.create();
    e.view.dispatch(e.state.tr.insert(e.state.doc.child(0).nodeSize, [empty(), empty()]));
    expect(e.getMarkdown()).toBe(stock(e));
    expect(e.getMarkdown()).toContain("&nbsp;");
    // Remove the first empty paragraph: the second keeps its node object but
    // now follows "one", so its cached "&nbsp;" must not survive.
    const at = e.state.doc.child(0).nodeSize;
    e.view.dispatch(e.state.tr.delete(at, at + 2));
    expect(e.getMarkdown()).toBe(stock(e));
  });

  it("returns an empty string for an empty document", () => {
    const e = makeEditor("");
    expect(e.getMarkdown()).toBe("");
    expect(stock(e)).toBe("");
  });

  it("re-renders only the blocks that changed", () => {
    const e = makeEditor(Array.from({ length: 50 }, (_, i) => `paragraph ${i}`).join("\n\n"));
    e.getMarkdown();
    let rendered = 0;
    const manager = e.markdown as unknown as { renderNodeToMarkdown: (...args: unknown[]) => string };
    const original = manager.renderNodeToMarkdown.bind(manager);
    manager.renderNodeToMarkdown = (...args: unknown[]) => {
      rendered++;
      return original(...args);
    };
    e.view.dispatch(e.state.tr.insertText("!", 3));
    const md = e.getMarkdown();
    manager.renderNodeToMarkdown = original;
    expect(md).toBe(stock(e));
    // The edited paragraph, and the one after it (its previous sibling
    // changed); each render recurses into its text node.
    expect(rendered).toBeLessThanOrEqual(4);
  });

  function countRenders(e: Editor) {
    const manager = e.markdown as unknown as { renderNodeToMarkdown: (...args: unknown[]) => string };
    const original = manager.renderNodeToMarkdown.bind(manager);
    const counter = { n: 0, restore: () => { manager.renderNodeToMarkdown = original; } };
    manager.renderNodeToMarkdown = (...args: unknown[]) => {
      counter.n++;
      return original(...args);
    };
    return counter;
  }

  it("fills the cache in idle time after an edit, a slice at a time", () => {
    vi.useFakeTimers();
    const idle: Array<(deadline: IdleDeadline) => void> = [];
    vi.stubGlobal("requestIdleCallback", (cb: (deadline: IdleDeadline) => void) => idle.push(cb));
    vi.stubGlobal("cancelIdleCallback", () => {});
    try {
      const e = makeEditor(Array.from({ length: 30 }, (_, i) => `paragraph ${i}`).join("\n\n"));
      e.view.dispatch(e.state.tr.insertText("!", 3));
      const renders = countRenders(e);

      vi.advanceTimersByTime(299);
      expect(idle).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(idle).toHaveLength(1);

      // Each idle slice renders until its deadline runs out, then yields.
      let budget = 0;
      const deadline = { didTimeout: false, timeRemaining: () => (budget-- > 0 ? 10 : 0) };
      budget = 10;
      idle.shift()!(deadline);
      expect(renders.n).toBeGreaterThan(0);
      expect(renders.n).toBeLessThan(30);
      expect(idle).toHaveLength(1);
      while (idle.length) {
        budget = 10;
        idle.shift()!(deadline);
      }

      renders.n = 0;
      const md = e.getMarkdown();
      // Everything but the block holding the caret, which is left to the
      // save so continued typing does not waste idle work on it.
      expect(renders.n).toBe(1);
      renders.restore();
      expect(md).toBe(stock(e));
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("restarts warming for a changed document without losing correctness", () => {
    const e = makeEditor(Array.from({ length: 20 }, (_, i) => `p ${i}`).join("\n\n"));
    const serializer = createIncrementalSerializer({ getManager: () => e.markdown as never, getDoc: () => e.state.doc });
    let budget = 5;
    const deadline = { timeRemaining: () => (budget-- > 0 ? 10 : 0) };
    expect(serializer.warm(deadline)).toBe(false);
    // An edit mid-warm: the next pass starts over on the new document.
    e.view.dispatch(e.state.tr.insert(0, e.state.schema.nodes.paragraph.create()));
    budget = 1000;
    expect(serializer.warm(deadline)).toBe(true);
    expect(serializer.serialize()).toBe(stock(e));
  });
});
