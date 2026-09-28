import type { JSONContent } from "@tiptap/core";
import { ListItem, getListMarker } from "@tiptap/extension-list";

type ParseListItem = NonNullable<typeof ListItem.config.parseMarkdown>;
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

const INLINE_TYPES = new Set(["text", "hardBreak"]);

function isEmptyParagraph(node: JSONContent | undefined): boolean {
  return node?.type === "paragraph" && (node.content ?? []).length === 0;
}

/**
 * A list item's content made valid for the schema's `paragraph block*`.
 *
 * The stock parse makes a block on the marker line (`- - [ ] a`, and in
 * Noten `1. - [ ] a`) the item's first child, and a marked `text` token after
 * it (`- - [ ] a` / blank / `  para`) a bare text node beside the blocks.
 * ProseMirror does not check content on load, but it does on edits: Enter,
 * Backspace or a deletion in the item, or Tab on the next item, threw
 * "Called contentMatchAt on a node with invalid content" or "Invalid content
 * for node listItem". Inline runs are wrapped in a paragraph, and an item
 * that still does not start with one gets an empty paragraph first, which
 * the renderer writes back as the block on the marker line.
 */
export function normalizeListItemContent(content: JSONContent[]): JSONContent[] {
  const blocks: JSONContent[] = [];
  let inline: JSONContent[] | null = null;
  for (const node of content) {
    if (node.type && INLINE_TYPES.has(node.type)) {
      if (!inline) {
        inline = [];
        blocks.push({ type: "paragraph", content: inline });
      }
      inline.push(node);
    } else {
      inline = null;
      blocks.push(node);
    }
  }
  if (blocks[0]?.type !== "paragraph") blocks.unshift({ type: "paragraph", content: [] });
  return blocks;
}

export const parseListItemMarkdown: ParseListItem = function (this: unknown, token, helpers) {
  const parsed = ListItem.config.parseMarkdown!.call(this, token, helpers);
  if (!parsed || Array.isArray(parsed) || !("type" in parsed) || parsed.type !== "listItem") return parsed;
  return { ...parsed, content: normalizeListItemContent(parsed.content ?? []) };
};

/**
 * The stock listItem renderer, writing a leading block on the marker line
 * with all of its lines inside the item.
 *
 * `renderNestedMarkdownContent` writes an item's first child right after the
 * marker and indents only the children after it. A paragraph's later lines
 * read back as lazy continuations, but any other block's do not: an item
 * whose first child is a task list, a quote or a nested list (Markdown puts
 * `1. - [ ] t1` / `   - [x] t2` there) was saved as `1. - [ ] t1` / `- [x] t2`,
 * which reloads as a second list after the item, and a fence there ended the
 * item at its first code line. The parse gives such an item an empty first
 * paragraph (`normalizeListItemContent`), and an empty paragraph followed by
 * a block is written as that block on the marker line, so the Markdown round-
 * trips. A first child that is itself not a paragraph (from HTML or older
 * JSON) is written the same way. Other items are left to the stock renderer,
 * byte for byte.
 *
 * Every child is rendered once. Rendering the first child again beside the
 * stock renderer's own pass doubled the work at each level of `- - - a`
 * nesting, 2^depth in all.
 */
export const renderListItemMarkdown: RenderListItem = function (this: unknown, node, h, ctx) {
  const content: JSONContent[] = Array.isArray(node.content) ? node.content : [];
  const lead = isEmptyParagraph(content[0]) && content[1] && content[1].type !== "paragraph" ? 1 : 0;
  if (!content[lead] || content[lead].type === "paragraph") return ListItem.config.renderMarkdown!.call(this, node, h, ctx);
  // From here on renderNestedMarkdownContent, transcribed, but for the lead
  // block's later lines.
  const prefix = itemPrefix(ctx);
  const configured = h.indent("");
  const width = columnWidth(prefix);
  // The stock `alignNestedToPrefix` is set for ordered items only.
  const indentLine = (line: string) =>
    ctx?.parentType === "orderedList"
      ? (columnWidth(configured) >= width ? configured : " ".repeat(width)) + line
      : h.indent(line);
  const [head, ...rest] = h.renderChildren([content[lead]]).split("\n");
  let output = prefix + [head, ...rest.map(indentLine)].join("\n");
  for (let index = lead + 1; index < content.length; index++) {
    const child = content[index];
    const rendered = h.renderChild?.(child, index) ?? h.renderChildren([child]);
    if (rendered === undefined || rendered === null) continue;
    output += (child.type === "paragraph" ? "\n\n" : "\n") + rendered.split("\n").map(indentLine).join("\n");
  }
  return output;
};

export const NotenListItem = ListItem.extend({
  parseMarkdown: parseListItemMarkdown,
  renderMarkdown: renderListItemMarkdown,
});
