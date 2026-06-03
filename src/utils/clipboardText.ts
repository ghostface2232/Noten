import type { Node as PMNode, Slice } from "@tiptap/pm/model";

/**
 * Text representation of inline leaf nodes for clipboard serialization.
 * hardBreak (Shift+Enter) becomes a single newline; images contribute their
 * alt text. Other leaves contribute nothing.
 */
function leafText(node: PMNode): string {
  if (node.type.name === "hardBreak") return "\n";
  if (node.type.name === "image") return node.attrs?.alt ?? "";
  return "";
}

/**
 * Serialize a copied selection to plain text for the `text/plain` clipboard
 * channel. Mirrors ProseMirror's default behavior but joins block boundaries
 * with a single "\n" instead of "\n\n" so the pasted line count matches what
 * the user sees on screen (each paragraph break is one line, an explicit blank
 * paragraph is one blank line). The `text/html` channel is left untouched, so
 * rich-text targets (e.g. Notion) keep their formatting.
 */
export function sliceToPlainText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, "\n", leafText);
}
