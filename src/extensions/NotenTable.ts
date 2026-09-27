import type { MarkdownRendererHelpers } from "@tiptap/core";
import { Table, renderTableToMarkdown } from "@tiptap/extension-table";

/**
 * Escape every `|` in one cell's rendered Markdown that is not already escaped.
 *
 * GFM splits a table row on each `|` not preceded by a backslash before any
 * inline parsing, so a pipe inside a code span, a link, or plain text still
 * ends the cell there, and it turns `\|` back into `|` before the cell's inline
 * content is parsed. Stock `renderTableToMarkdown` escapes nothing: Tiptap's
 * own table tokenizer reads code spans as atomic, so Noten reloaded the file
 * while GitHub showed a broken table, and a pipe in plain text shifted every
 * later cell of the row even in Noten.
 *
 * A pipe behind an even run of backslashes is unescaped (the backslashes
 * escape each other); an odd run already escapes it. The text renderer doubles
 * every literal backslash, so only code content can reach an odd run, and a
 * literal `\|` inside a code span has no GFM spelling: it reads back as `|`.
 */
export function escapeCellPipes(markdown: string): string {
  if (!markdown.includes("|")) return markdown;
  return markdown.replace(/(\\*)\|/g, (match, run: string) =>
    run.length % 2 === 0 ? `${run}\\|` : match,
  );
}

function withEscapedCellPipes(h: MarkdownRendererHelpers): MarkdownRendererHelpers {
  return {
    ...h,
    renderChildren: (nodes, separator) => escapeCellPipes(h.renderChildren(nodes, separator)),
  };
}

// `lastColumnResizable: false` pins the rightmost edge so dragging an inner
// column redistributes width between siblings instead of growing the whole
// table past the editor width.
export const NotenTable = Table.extend({
  // renderTableToMarkdown renders cell content only through renderChildren, so
  // wrapping it escapes each cell's Markdown before the row is assembled.
  renderMarkdown: (node, h) => renderTableToMarkdown(node, withEscapedCellPipes(h)),
}).configure({
  resizable: true,
  handleWidth: 6,
  cellMinWidth: 48,
  lastColumnResizable: false,
});

export default NotenTable;
