import type { Editor } from "@tiptap/core";

/**
 * Tells everything following the editor that its document was swapped.
 * `view.updateState` emits no transaction, so the status bar kept the previous
 * note's counts, and at startup, where its effect runs before App's first
 * openDocument, read 0 until the first edit or click. A key from React cannot
 * cover that case: the note id does not change between the two.
 *
 * The transaction has no steps of its own, but it is the first one the new
 * state sees, so TrailingNode appends its paragraph to a note ending in a list,
 * heading, code block or table. Tiptap emits `update` for an appended change,
 * which read as an edit: the file was rewritten a second later with nothing
 * typed, and the conversion's losses became permanent. On a switch the same
 * update marked the leaving note edited, which invalidated its in-flight save.
 * `preventUpdate` keeps the paragraph while saying nothing was edited.
 */
export function announceDocumentSwap(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr.setMeta("addToHistory", false).setMeta("preventUpdate", true),
  );
}
