import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
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

export interface IncrementalSerializer {
  /** The document's Markdown, identical to the stock serializer's. */
  serialize(): string;
  /**
   * Render uncached blocks until `deadline` runs out, continuing where the
   * previous call stopped (from the start if the document changed since).
   * Returns true once every block of the current document is cached.
   */
  warm(deadline: { timeRemaining(): number }): boolean;
}

export function createIncrementalSerializer(
  getManager: () => MarkdownManagerLike,
  getDoc: () => ProseMirrorNode,
): IncrementalSerializer {
  const cache = new WeakMap<ProseMirrorNode, CachedBlock>();

  const render = (doc: ProseMirrorNode, block: ProseMirrorNode, index: number, previous: ProseMirrorNode | null): string => {
    let cached = cache.get(block);
    if (!cached || cached.previous !== previous) {
      // The parent the full serializer passes is the doc's JSON; renderers
      // read only its type, attrs and the previous sibling from it.
      const siblings: JSONContent[] = [];
      siblings.length = index;
      if (previous) siblings[index - 1] = previous.toJSON();
      const parent: JSONContent = { type: doc.type.name, content: siblings };
      if (Object.keys(doc.attrs).length) parent.attrs = doc.attrs;
      cached = { previous, markdown: getManager().renderNodeToMarkdown(block.toJSON(), parent, index, 0) };
      cache.set(block, cached);
    }
    return cached.markdown;
  };

  // Where warm() stopped: blocks before `index` of `doc` are cached.
  let warmDoc: ProseMirrorNode | null = null;
  let warmIndex = 0;

  return {
    serialize() {
      const doc = getDoc();
      const parts: string[] = [];
      let previous: ProseMirrorNode | null = null;
      doc.forEach((block, _offset, index) => {
        parts.push(render(doc, block, index, previous));
        previous = block;
      });
      const markdown = parts.join("\n\n");
      return getManager().isEmptyOutput(markdown) ? "" : markdown;
    },

    warm(deadline) {
      const doc = getDoc();
      if (doc !== warmDoc) {
        warmDoc = doc;
        warmIndex = 0;
      }
      while (warmIndex < doc.childCount) {
        if (deadline.timeRemaining() < 1) return false;
        render(doc, doc.child(warmIndex), warmIndex, warmIndex > 0 ? doc.child(warmIndex - 1) : null);
        warmIndex += 1;
      }
      return true;
    },
  };
}

// After an edit settles, fill the cache in idle time, so the first
// getMarkdown after opening a note (autosave, or leaving the note) finds the
// blocks rendered instead of paying for the whole document at once — ~120 ms
// for 1 MB. Waits a little less than the autosave debounce (1 s) so a burst of
// typing does not restart it on every key.
const WARM_DELAY_MS = 300;

function warmUpPlugin(editor: Editor, warm: IncrementalSerializer["warm"]): Plugin {
  return new Plugin({
    key: new PluginKey("incrementalMarkdownWarmUp"),
    view: () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let idle: number | null = null;
      const cancel = () => {
        if (timer !== null) clearTimeout(timer);
        if (idle !== null) cancelIdleCallback(idle);
        timer = idle = null;
      };
      const step = (deadline: IdleDeadline) => {
        idle = warm(deadline) ? null : requestIdleCallback(step);
      };
      const schedule = () => {
        if (typeof requestIdleCallback === "undefined") return;
        cancel();
        timer = setTimeout(() => {
          timer = null;
          idle = requestIdleCallback(step);
        }, WARM_DELAY_MS);
      };
      schedule();
      return {
        update: (view, prev) => {
          if (view.state.doc !== prev.doc && !editor.isDestroyed) schedule();
        },
        destroy: cancel,
      };
    },
  });
}

const serializers = new WeakMap<Editor, IncrementalSerializer>();

function install(editor: Editor): void {
  if (!editor.markdown || serializers.has(editor)) return;
  const serializer = createIncrementalSerializer(
    () => editor.markdown as unknown as MarkdownManagerLike,
    () => editor.state.doc,
  );
  serializers.set(editor, serializer);
  editor.getMarkdown = () => serializer.serialize();
}

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

  addProseMirrorPlugins() {
    const editor = this.editor;
    // Plugins are collected before onBeforeCreate installs the serializer;
    // look it up when warming.
    return [warmUpPlugin(editor, (deadline) => serializers.get(editor)?.warm(deadline) ?? true)];
  },
});

export default IncrementalMarkdown;
