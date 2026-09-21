import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import type { EditorState, Plugin } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { TextSelection } from "@tiptap/pm/state";
import { createIncrementalLowlightPlugin, incrementalLowlightKey, isStockLowlightPlugin } from "./incrementalLowlight";
import MermaidCodeBlock from "./MermaidCodeBlock";

const lowlight = createLowlight(common);

const Incremental = CodeBlockLowlight.extend({
  addProseMirrorPlugins() {
    const inherited = (this.parent?.() ?? []).filter((plugin) => !isStockLowlightPlugin(plugin));
    return [...inherited, createIncrementalLowlightPlugin({ name: this.name, lowlight: this.options.lowlight })];
  },
});

let editors: Editor[] = [];
afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors = [];
});

function makeEditor(content: string, extension = Incremental) {
  const editor = new Editor({
    extensions: [StarterKit.configure({ codeBlock: false }), extension.configure({ lowlight })],
    content,
  });
  editors.push(editor);
  return editor;
}

// The stock plugin's init is its from-scratch highlighter; it is the oracle.
const stockEditor = () => makeEditor("<p></p>", CodeBlockLowlight);
function stockPluginOf(editor: Editor): Plugin {
  return editor.state.plugins.find(isStockLowlightPlugin)!;
}

function flatten(set: DecorationSet, state: EditorState): string[] {
  return set
    .find(0, state.doc.content.size)
    .map((d) => `${d.from}-${d.to}:${(d as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`)
    .sort();
}

function expectFreshHighlight(editor: Editor, oracle: Plugin) {
  const incremental = incrementalLowlightKey.getState(editor.state)!;
  const fresh = (oracle.spec.state!.init as (c: unknown, s: EditorState) => DecorationSet)({}, editor.state);
  expect(flatten(incremental, editor.state)).toEqual(flatten(fresh, editor.state));
}

const DOC = [
  "<p>intro</p>",
  "<pre><code class=\"language-ts\">const a = 1;\nfunction f() { return a; }</code></pre>",
  "<p>between</p>",
  "<ul><li><p>item</p><pre><code class=\"language-python\">def g():\n    return 2</code></pre></li></ul>",
  "<blockquote><pre><code class=\"language-json\">{\"k\": [1, 2]}</code></pre></blockquote>",
  "<pre><code>no language here = auto</code></pre>",
  "<p>outro</p>",
].join("");

describe("incremental lowlight plugin", () => {
  it("replaces the stock highlighter exactly once in MermaidCodeBlock", () => {
    const editor = makeEditor("<p></p>", MermaidCodeBlock as unknown as typeof Incremental);
    expect(editor.state.plugins.filter(isStockLowlightPlugin)).toHaveLength(0);
    expect(editor.state.plugins.filter((p) => p.spec.key === incrementalLowlightKey)).toHaveLength(1);
  });

  it("matches a from-scratch highlight after every kind of edit", () => {
    const oracle = stockPluginOf(stockEditor());
    const editor = makeEditor(DOC);
    expectFreshHighlight(editor, oracle);

    let seed = 42;
    const rand = () => { seed = (seed * 48271) % 0x7fffffff; return seed / 0x7fffffff; };
    const texts = ["x", " = ", "()", "\n", "return", "\"s\"", "{", "}", "# c"];
    const languages = ["ts", "python", "json", "rust", "", "not-a-language"];

    for (let step = 0; step < 1500; step++) {
      const { state } = editor;
      const size = state.doc.content.size;
      const pos = 1 + Math.floor(rand() * (size - 1));
      const $pos = state.doc.resolve(pos);
      const r = rand();
      const chain = editor.chain().setTextSelection(pos);
      if (r < 0.4 && $pos.parent.inlineContent) {
        editor.view.dispatch(state.tr.insertText(texts[Math.floor(rand() * texts.length)], pos));
      } else if (r < 0.5) {
        const to = Math.min(size - 1, pos + Math.floor(rand() * 30));
        if (to > pos) editor.view.dispatch(state.tr.delete(pos, to));
      } else if (r < 0.6 && $pos.parent.inlineContent) {
        chain.setCodeBlock({ language: languages[Math.floor(rand() * languages.length)] }).run();
      } else if (r < 0.7 && $pos.parent.type.name === "codeBlock") {
        chain.setParagraph().run();
      } else if (r < 0.8 && $pos.parent.type.name === "codeBlock") {
        // An attribute-only step: its step map is empty.
        editor.view.dispatch(state.tr.setNodeAttribute($pos.before(), "language", languages[Math.floor(rand() * languages.length)]));
      } else if (r < 0.85 && $pos.parent.inlineContent) {
        chain.toggleBulletList().run();
      } else if (r < 0.9 && $pos.parent.inlineContent) {
        chain.toggleBlockquote().run();
      } else if (r < 0.93 && $pos.parent.inlineContent && $pos.parent.type.name === "paragraph") {
        editor.view.dispatch(state.tr.split(pos));
      } else if (r < 0.96) {
        // Move a top-level block by deleting it and re-inserting the SAME node
        // object elsewhere, as drag and drop does.
        const index = Math.floor(rand() * state.doc.childCount);
        let from = 0;
        for (let k = 0; k < index; k++) from += state.doc.child(k).nodeSize;
        const node = state.doc.child(index);
        const tr = state.tr.delete(from, from + node.nodeSize);
        const target = Math.floor(rand() * tr.doc.childCount + 1);
        let at = 0;
        for (let k = 0; k < target && k < tr.doc.childCount; k++) at += tr.doc.child(k).nodeSize;
        editor.view.dispatch(tr.insert(at, node));
      } else if (r < 0.98) {
        editor.commands.undo();
      } else if (r < 0.99) {
        editor.commands.redo();
      } else {
        // Selection-only transaction.
        editor.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))));
      }
      if (editor.state.doc.childCount < 3) editor.commands.insertContentAt(editor.state.doc.content.size, DOC);
      expectFreshHighlight(editor, oracle);
    }
  });

  it("re-highlights a code block that was deleted and re-inserted as the same node", () => {
    const oracle = stockPluginOf(stockEditor());
    const editor = makeEditor(DOC);
    const index = 1;
    let from = 0;
    for (let k = 0; k < index; k++) from += editor.state.doc.child(k).nodeSize;
    const block = editor.state.doc.child(index);
    expect(block.type.name).toBe("codeBlock");
    editor.view.dispatch(editor.state.tr.replaceWith(from, from + block.nodeSize, block));
    expect(editor.state.doc.child(index)).toBe(block);
    expectFreshHighlight(editor, oracle);
  });

  it("re-highlights code inside a container re-inserted as the same node", () => {
    const oracle = stockPluginOf(stockEditor());
    const editor = makeEditor(DOC);
    let from = 0;
    let index = 0;
    while (editor.state.doc.child(index).type.name !== "blockquote") from += editor.state.doc.child(index++).nodeSize;
    const quote = editor.state.doc.child(index);
    editor.view.dispatch(editor.state.tr.replaceWith(from, from + quote.nodeSize, quote));
    expect(editor.state.doc.child(index)).toBe(quote);
    expectFreshHighlight(editor, oracle);
  });

  it("keeps highlights through a move and its undo", () => {
    const oracle = stockPluginOf(stockEditor());
    const editor = makeEditor(DOC);
    const block = editor.state.doc.child(1);
    const from = editor.state.doc.child(0).nodeSize;
    const tr = editor.state.tr.delete(from, from + block.nodeSize);
    const after = tr.doc.child(0).nodeSize + tr.doc.child(1).nodeSize;
    editor.view.dispatch(tr.insert(after, block));
    expectFreshHighlight(editor, oracle);
    editor.commands.undo();
    expect(editor.state.doc.child(1)).toBe(block);
    expectFreshHighlight(editor, oracle);
    editor.commands.redo();
    expectFreshHighlight(editor, oracle);
  });

  it("keeps highlights after deleting many blocks at once", () => {
    const oracle = stockPluginOf(stockEditor());
    const editor = makeEditor(`${"<p>para</p>".repeat(8)}${DOC}`);
    let to = 0;
    for (let k = 0; k < 6; k++) to += editor.state.doc.child(k).nodeSize;
    editor.view.dispatch(editor.state.tr.delete(0, to));
    expectFreshHighlight(editor, oracle);
  });

  it("returns the previous set untouched on selection-only transactions", () => {
    const editor = makeEditor(DOC);
    const before = incrementalLowlightKey.getState(editor.state);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    expect(incrementalLowlightKey.getState(editor.state)).toBe(before);
  });
});
