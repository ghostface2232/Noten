import { Extension, type Editor } from "@tiptap/core";

// Tiptap 3.29 handles ArrowUp at offset 0 of a leading code block. Noten keeps
// this extension for the two broader cases that upstream deliberately leaves
// alone: ArrowUp from elsewhere on the first visual line, and ArrowLeft at the
// exact block start. The offset-0 ArrowUp path must return false here so only
// upstream owns that transformation. Mermaid inherits the same `codeBlock`
// keyboard behavior.
//
// Tables and images are deliberately NOT handled here: they are block-selectable
// and already escapable via gapcursor and TableNodeSelect. Only text-holding
// blocks that trap the caret need this.
// Kept Markdown source traps it as well, but a line above front matter would stop
// it being front matter, so that one stays first.
const TRAPPING_FIRST_NODES = new Set(["codeBlock", "rawBlock"]);

/** Exported for unit testing; returns true when it handled the key. */
export function escapeLeadingBlock(
  editor: Editor,
  opts: { requireBlockStart?: boolean } = {},
): boolean {
  const { selection, doc } = editor.state;
  if (!selection.empty) return false;

  const firstChild = doc.firstChild;
  if (!firstChild || !TRAPPING_FIRST_NODES.has(firstChild.type.name)) return false;
  if (firstChild.attrs.kind === "frontmatter") return false;

  const $from = selection.$from;
  // Cursor must sit inside the first top-level node.
  if ($from.depth < 1 || $from.before(1) !== 0) return false;

  // ArrowLeft only escapes from the very start of the block. Mid-line it must
  // keep its normal caret-movement meaning — hijacking it there inserted an
  // empty paragraph (dirty + undo step + autosave) instead of moving left.
  if (opts.requireBlockStart && $from.parentOffset !== 0) return false;

  // Only act on the first visual line: if there is a newline before the cursor,
  // ArrowUp should move within the block as usual rather than escape.
  if ($from.parent.textContent.slice(0, $from.parentOffset).includes("\n")) {
    return false;
  }

  return editor
    .chain()
    .insertContentAt(0, { type: "paragraph" })
    .setTextSelection(1)
    .run();
}

export const EscapeFirstBlock = Extension.create({
  name: "escapeFirstBlock",

  addKeyboardShortcuts() {
    return {
      ArrowUp: ({ editor }) => (
        editor.state.selection.$from.parentOffset === 0
          ? false
          : escapeLeadingBlock(editor)
      ),
      ArrowLeft: ({ editor }) => escapeLeadingBlock(editor, { requireBlockStart: true }),
    };
  },
});

export default EscapeFirstBlock;
