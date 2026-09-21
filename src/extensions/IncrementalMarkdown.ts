import { Extension, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// `editor.getMarkdown()` that re-renders only the top-level blocks a change
// touched.
//
// @tiptap/markdown serializes the whole document on every call: `getJSON()`
// of the entire doc, then every block's renderer. Autosave, note switches
// and export all call it, so a 1 MB note paid 80-130 ms (10 MB: ~1 s) after
// every pause in typing to re-render text that had not changed.
//
// The document renderer joins its children's output with "\n\n", and a
// top-level block's output depends only on the block itself and on the block
// before it (a paragraph renders differently after an empty paragraph; no
// renderer's output depends on the block's index — the one place the index
// leaks, a table cell's leaf child seeing the table's position through
// `renderChildren`, reaches only paragraph's "previous is a paragraph" test,
// which a table row never passes). ProseMirror nodes are immutable
// and reused while unchanged, so a block's Markdown is cached against the
// pair (block node, previous block node), and a call re-renders only the
// blocks whose pair changed — through the manager's own renderNodeToMarkdown
// with the same parent and index the full serializer would pass. The result
// is byte-identical to the stock serializer; IncrementalMarkdown.test.ts
// fuzzes that. When upgrading @tiptap/markdown, re-check `serialize` and the
// document renderer against the assumptions above.

interface CachedBlock {
  previous: ProseMirrorNode | null;
  markdown: string;
}

interface MarkdownManagerLike {
  renderNodeToMarkdown(node: JSONContent, parentNode: JSONContent, index: number, level: number): string;
  isEmptyOutput(markdown: string): boolean;
}

export function createIncrementalSerializer(getManager: () => MarkdownManagerLike, getDoc: () => ProseMirrorNode) {
  const cache = new WeakMap<ProseMirrorNode, CachedBlock>();
  return (): string => {
    const manager = getManager();
    const doc = getDoc();
    const parts: string[] = [];
    let previous: ProseMirrorNode | null = null;
    doc.forEach((block, _offset, index) => {
      let cached = cache.get(block);
      if (!cached || cached.previous !== previous) {
        // The parent the full serializer passes is the doc's JSON; renderers
        // read only its type, attrs and the previous sibling from it.
        const siblings: JSONContent[] = [];
        siblings.length = index;
        if (previous) siblings[index - 1] = previous.toJSON();
        const parent: JSONContent = { type: doc.type.name, content: siblings };
        if (Object.keys(doc.attrs).length) parent.attrs = doc.attrs;
        cached = { previous, markdown: manager.renderNodeToMarkdown(block.toJSON(), parent, index, 0) };
        cache.set(block, cached);
      }
      parts.push(cached.markdown);
      previous = block;
    });
    const markdown = parts.join("\n\n");
    return manager.isEmptyOutput(markdown) ? "" : markdown;
  };
}

function install(editor: import("@tiptap/core").Editor): void {
  if (!editor.markdown || installed.has(editor)) return;
  installed.add(editor);
  editor.getMarkdown = createIncrementalSerializer(
    () => editor.markdown as unknown as MarkdownManagerLike,
    () => editor.state.doc,
  );
}

const installed = new WeakSet<object>();

export const IncrementalMarkdown = Extension.create({
  name: "incrementalMarkdown",

  // The Markdown extension assigns getMarkdown in its own onBeforeCreate.
  // Replace it right after (extensions run in order), so no caller ever sees
  // the stock one; onCreate — which Tiptap emits asynchronously — covers an
  // order where Markdown had not run yet.
  onBeforeCreate() {
    install(this.editor);
  },

  onCreate() {
    install(this.editor);
  },
});

export default IncrementalMarkdown;
