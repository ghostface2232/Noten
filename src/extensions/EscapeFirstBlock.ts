import { Extension, type Editor } from "@tiptap/core";

// A code block (which in Noten includes Mermaid — a `codeBlock` with
// language=mermaid) holds a text cursor but offers no way to move above it. When
// one is the very first node in a document, a user cannot add text before it:
// ArrowUp does nothing and Enter just inserts a newline inside the block. This
// extension makes ArrowUp / ArrowLeft on the first line of a leading code block
// insert an empty paragraph above and move the cursor into it.
//
// Tables and images are deliberately NOT handled here: they are block-selectable
// and already escapable via gapcursor and TableNodeSelect. Only text-holding
// blocks that trap the caret need this.
const TRAPPING_FIRST_NODES = new Set(["codeBlock"]);

/** Exported for unit testing; returns true when it handled the key. */
export function escapeLeadingBlock(
  editor: Editor,
  opts: { requireBlockStart?: boolean } = {},
): boolean {
  const { selection, doc } = editor.state;
  if (!selection.empty) return false;

  const firstChild = doc.firstChild;
  if (!firstChild || !TRAPPING_FIRST_NODES.has(firstChild.type.name)) return false;

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
      ArrowUp: ({ editor }) => escapeLeadingBlock(editor),
      ArrowLeft: ({ editor }) => escapeLeadingBlock(editor, { requireBlockStart: true }),
    };
  },
});

export default EscapeFirstBlock;
