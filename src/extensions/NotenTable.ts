import { Table } from "@tiptap/extension-table";

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
});
