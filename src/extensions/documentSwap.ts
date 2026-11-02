import type { Editor } from "@tiptap/core";

/**
 * Tells everything following the editor that its document was swapped.
 * `view.updateState` emits no transaction, so the status bar kept the previous
 * note's counts, and at startup, where its effect runs before App's first
 * openDocument, read 0 until the first edit or click. A key from React cannot
 * cover that case: the note id does not change between the two. The transaction
 * has no steps, so it does not mark the note edited or touch undo history.
 */
export function announceDocumentSwap(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
}
