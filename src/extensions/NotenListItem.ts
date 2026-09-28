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
 *
 * Every child is rendered once. Rendering the first child again beside the
 * stock renderer's own pass doubled the work at each level of `- - - a`
 * nesting, 2^depth in all.
 */
export const renderListItemMarkdown: RenderListItem = function (this: unknown, node, h, ctx) {
  const [first, ...children] = Array.isArray(node.content) ? node.content : [];
  if (!first || first.type === "paragraph") return ListItem.config.renderMarkdown!.call(this, node, h, ctx);
  // From here on renderNestedMarkdownContent, transcribed, but for the first
  // child's later lines.
  const prefix = itemPrefix(ctx);
  const configured = h.indent("");
  const width = columnWidth(prefix);
  // The stock `alignNestedToPrefix` is set for ordered items only.
  const indentLine = (line: string) =>
    ctx?.parentType === "orderedList"
      ? (columnWidth(configured) >= width ? configured : " ".repeat(width)) + line
      : h.indent(line);
  const [head, ...rest] = h.renderChildren([first]).split("\n");
  let output = prefix + [head, ...rest.map(indentLine)].join("\n");
  children.forEach((child, index) => {
    const rendered = h.renderChild?.(child, index + 1) ?? h.renderChildren([child]);
    if (rendered === undefined || rendered === null) return;
    output += (child.type === "paragraph" ? "\n\n" : "\n") + rendered.split("\n").map(indentLine).join("\n");
  });
  return output;
};

export const NotenListItem = ListItem.extend({
  renderMarkdown: renderListItemMarkdown,
});
