import type { MarkdownRendererHelpers } from "@tiptap/core";
import { Table, renderTableToMarkdown } from "@tiptap/extension-table";

// Older serializers wrote an empty table cell as a literal `&nbsp;`. Table's
// parseMarkdown feeds cell tokens straight to parseInline, bypassing the
// paragraph's empty-marker rule, so such a file would load with visible
// "&nbsp;" text and save it back escaped as `&amp;nbsp;`.
//
// Clearing those cells here, on lexer tokens, rather than on the Markdown
// string means block structure is already resolved: a fenced block that draws
// a table never reaches this, and an inline-code `&nbsp;` is a codespan token,
// not text. Only a cell made of nothing but the entity is emptied.
const PLACEHOLDER = /^(?:&nbsp;)+$/;

interface InlineToken {
  type: string;
  raw: string;
}

interface CellToken {
  tokens?: InlineToken[];
}

function isPlaceholderCell(cell: CellToken): boolean {
  const tokens = cell.tokens ?? [];
  return (
    tokens.length > 0 &&
    tokens.every((t) => t.type === "text") &&
    PLACEHOLDER.test(tokens.map((t) => t.raw).join("").trim())
  );
}

// The lexer's tokens may be cached for reuse, so the cleared cell is a copy.
function clearPlaceholder<T extends CellToken>(cell: T): T {
  return isPlaceholderCell(cell) ? { ...cell, tokens: [] } : cell;
}

const parseTableMarkdown = Table.config.parseMarkdown!;

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

export const NotenTable = Table.extend({
  parseMarkdown(token, helpers) {
    const header = token.header as CellToken[] | undefined;
    const rows = token.rows as CellToken[][] | undefined;
    return parseTableMarkdown(
      {
        ...token,
        header: header?.map(clearPlaceholder),
        rows: rows?.map((row) => row.map(clearPlaceholder)),
      },
      helpers,
    );
  },

  // renderTableToMarkdown renders cell content only through renderChildren, so
  // wrapping it escapes each cell's Markdown before the row is assembled.
  renderMarkdown: (node, h) => renderTableToMarkdown(node, withEscapedCellPipes(h)),
});
