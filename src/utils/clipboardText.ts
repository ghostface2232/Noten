import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";

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

export function createPlainTextSlice(schema: Schema, text: string): Slice {
  const normalized = text.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const paragraph = schema.nodes.paragraph;
  const hardBreak = schema.nodes.hardBreak;

  const nodes = blocks.map((block) => {
    const lines = block.split("\n");
    const content = lines.flatMap((line, index) => {
      const parts = [];
      if (line.length > 0) {
        parts.push(schema.text(line));
      }
      if (index < lines.length - 1 && hardBreak) {
        parts.push(hardBreak.create());
      }
      return parts;
    });

    return paragraph.create(null, content);
  });

  return new Slice(Fragment.fromArray(nodes), 0, 0);
}
