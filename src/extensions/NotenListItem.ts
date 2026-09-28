import { renderNestedMarkdownContent, type JSONContent } from "@tiptap/core";
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

// The last position a letter marker can spell: Tiptap reads and writes one
// or two letters, `zz` being 702.
const MAX_LETTER_POSITION = 26 * 27;

/**
 * The stock marker for a list item, except that a letter list's items past
 * `zz.` are numbered. Tiptap has no letter marker there and wrote
 * `undefineda.`, `undefinedb.`, ..., which reads back as text of item 702: a
 * letter list of over 702 items (a toolbar restyle of a long list, or the
 * one-list fallback of a token past MAX_LIST_SEGMENTS) lost its items on save.
 * Numbered, they read back as a numbered list continuing at 703.
 */
export function listItemMarker(type: unknown, index: number): string {
  const position = index + 1;
  // Below 1 no letter or roman marker exists (Tiptap threw on `A` and wrote
  // `undefined.` or `.`), and a negative number is no marker either: all
  // read back as plain paragraphs. `0.` is the lowest marker Markdown has.
  if (position < 1) return `${Math.max(position, 0)}. `;
  if ((type === "a" || type === "A") && position > MAX_LETTER_POSITION) return `${position}. `;
  return getListMarker(type as string | undefined, index, ". ");
}

// The item's marker: the stock one but for `listItemMarker`.
function itemPrefix(ctx: RenderContext): string {
  if (ctx?.parentType !== "orderedList") return "- ";
  const attrs = ctx.meta?.parentAttrs as { start?: number; type?: unknown } | undefined;
  return listItemMarker(attrs?.type, (attrs?.start || 1) - 1 + (ctx.index || 0));
}

const INLINE_TYPES = new Set(["text", "hardBreak"]);

// Blocks both readings take from an item's marker line: marked's for a bullet
// item and orderedListTokenizer.ts's for an ordered one. An ordered list is
// not among them (Tiptap keeps `- 1. a` as text, and so does the ordered
// reading), and a rule only in an ordered item: `- ---` is a rule itself.
const MARKER_LINE_BLOCKS = new Set(["bulletList", "taskList", "blockquote", "heading", "codeBlock"]);
// The block's first line as rendered must still open it there: an empty
// nested item (`- - `, `- - [ ] `) reads back as text.
const MARKER_LINE_HEAD = /^(?:[-+*] +\[[ xX]\] +\S|[-+*] +(?!\[[ xX]\])\S|#{1,6} +\S|>|```|~~~|---$)/;

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
 * a block the next load reads back from the marker line is written as that
 * block on the marker line, so the Markdown round-trips. A first child that
 * is itself not a paragraph (from HTML or older JSON) is written the same way.
 * Any other block stays on the lines below an empty marker line, as the stock
 * renderer writes it after an empty paragraph: an ordered list there
 * (`1. 1. b`) reads back as text, and under a bullet `- ---` is a rule of its
 * own. Paragraph-first items are left to the stock renderer, byte for byte.
 *
 * Every child is rendered once. Rendering the first child again beside the
 * stock renderer's own pass doubled the work at each level of `- - - a`
 * nesting, 2^depth in all.
 */
export const renderListItemMarkdown: RenderListItem = function (this: unknown, node, h, ctx) {
  const content: JSONContent[] = Array.isArray(node.content) ? node.content : [];
  const lead = isEmptyParagraph(content[0]) && content[1] && content[1].type !== "paragraph" ? 1 : 0;
  // The stock renderer, transcribed; only the marker differs.
  if (!content[lead] || content[lead].type === "paragraph") {
    return renderNestedMarkdownContent(node, h, itemPrefix, ctx, { alignNestedToPrefix: ctx?.parentType === "orderedList" });
  }
  // From here on renderNestedMarkdownContent, transcribed, but for the lead
  // block's later lines.
  const ordered = ctx?.parentType === "orderedList";
  const prefix = itemPrefix(ctx);
  const configured = h.indent("");
  const width = columnWidth(prefix);
  // The stock `alignNestedToPrefix` is set for ordered items only.
  const indentLine = (line: string) =>
    ordered ? (columnWidth(configured) >= width ? configured : " ".repeat(width)) + line : h.indent(line);
  const leadRendered = h.renderChildren([content[lead]]);
  const [head, ...rest] = leadRendered.split("\n");
  const onMarkerLine =
    (MARKER_LINE_BLOCKS.has(content[lead].type ?? "") || (ordered && content[lead].type === "horizontalRule")) &&
    MARKER_LINE_HEAD.test(head);
  let output: string;
  let from: number;
  if (onMarkerLine) {
    output = prefix + [head, ...rest.map(indentLine)].join("\n");
    from = lead + 1;
  } else {
    output = prefix + (lead === 1 ? h.renderChildren([content[0]]) : "");
    from = lead;
  }
  for (let index = from; index < content.length; index++) {
    const child = content[index];
    const rendered = index === lead ? leadRendered : (h.renderChild?.(child, index) ?? h.renderChildren([child]));
    if (rendered === undefined || rendered === null) continue;
    output += (child.type === "paragraph" ? "\n\n" : "\n") + rendered.split("\n").map(indentLine).join("\n");
  }
  return output;
};

export const NotenListItem = ListItem.extend({
  parseMarkdown: parseListItemMarkdown,
  renderMarkdown: renderListItemMarkdown,
});
