import { ListItem, getListMarker } from "@tiptap/extension-list";

type RenderListItem = NonNullable<typeof ListItem.config.renderMarkdown>;
type RenderContext = Parameters<RenderListItem>[2];

const TAB_STOP = 4;

// Width in Markdown columns, a tab running to the next tab stop; as in
// @tiptap/core's renderNestedMarkdownContent.
function columnWidth(text: string): number {
  let width = 0;
  for (const character of text) width = character === "\t" ? width + TAB_STOP - (width % TAB_STOP) : width + 1;
  return width;
}

// The stock listItem renderer's marker.
function itemPrefix(ctx: RenderContext): string {
  if (ctx?.parentType !== "orderedList") return "- ";
  const attrs = ctx.meta?.parentAttrs as { start?: number; type?: string } | undefined;
  return getListMarker(attrs?.type, (attrs?.start || 1) - 1 + (ctx.index || 0), ". ");
}

/**
 * The stock listItem renderer, indenting every line of a first child that is
 * not a paragraph.
 *
 * `renderNestedMarkdownContent` writes an item's first child right after the
 * marker and indents only the children after it. A paragraph's later lines
 * read back as lazy continuations, but any other block's do not: an item
 * whose first child is a task list, a quote or a nested list (Markdown puts
 * `1. - [ ] t1` / `   - [x] t2` there) was saved as `1. - [ ] t1` / `- [x] t2`,
 * which reloads as a second list after the item, and a fence there ended the
 * item at its first code line. Such an item's first line stays on the marker
 * line, as CommonMark reads it; paragraph-first items are left to the stock
 * renderer, byte for byte.
 */
export const renderListItemMarkdown: RenderListItem = function (this: unknown, node, h, ctx) {
  const stock = ListItem.config.renderMarkdown!;
  const output = stock.call(this, node, h, ctx);
  const first = node.content?.[0];
  if (!first || first.type === "paragraph") return output;
  const prefix = itemPrefix(ctx);
  const rendered = h.renderChildren([first]);
  // Anything else means the stock renderer changed shape; keep its output.
  if (!rendered.includes("\n") || !output.startsWith(prefix + rendered)) return output;
  const configured = h.indent("");
  const width = columnWidth(prefix);
  // The indent the stock renderer gives the item's later children.
  const indentLine = (line: string) =>
    ctx?.parentType === "orderedList"
      ? (columnWidth(configured) >= width ? configured : " ".repeat(width)) + line
      : h.indent(line);
  const [head, ...rest] = rendered.split("\n");
  return prefix + [head, ...rest.map(indentLine)].join("\n") + output.slice(prefix.length + rendered.length);
};

export const NotenListItem = ListItem.extend({
  renderMarkdown: renderListItemMarkdown,
});
