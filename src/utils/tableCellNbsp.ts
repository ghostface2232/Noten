/**
 * When an empty table cell round-trips through the markdown serializer it can
 * surface as a literal `&nbsp;` placeholder: an empty paragraph rendered as a
 * non-breaking-space entity. Table.parseMarkdown feeds cell text straight to
 * parseInline and bypasses the empty-cell rule, so left in place that entity
 * becomes visible text on the next load.
 *
 * The fix must strip that placeholder WITHOUT touching a `&nbsp;` that is real
 * cell content — most importantly an inline-code span like `` `&nbsp;` `` that
 * documents the HTML entity, but also any text that merely contains `&nbsp;`.
 * A blanket line-level `replace(/&nbsp;/g, "")` corrupts those cells on every
 * load/save. So we tokenize each table row into cells (honoring backslash
 * escapes and inline-code spans, inside which `|` is not a delimiter) and clear
 * only the cells whose entire content is one or more `&nbsp;` placeholders.
 */

const TABLE_ROW = /^\|[^\n]*\|[ \t]*$/gm;
const PLACEHOLDER_CELL = /^(?:&nbsp;)+$/;

export function stripTableCellNbsp(md: string): string {
  return md.replace(TABLE_ROW, stripPlaceholderCellsInRow);
}

function stripPlaceholderCellsInRow(line: string): string {
  // Fast path: a row with no placeholder entity never needs rewriting, which
  // keeps the common case (and every separator/header row) allocation-free.
  if (!line.includes("&nbsp;")) return line;

  let result = "";
  let cellStart = 0;
  let i = 0;

  const flushCell = (end: number) => {
    const cell = line.slice(cellStart, end);
    if (PLACEHOLDER_CELL.test(cell.trim())) {
      // Cell is only placeholder entities — drop them, keep the surrounding
      // whitespace so column alignment (and round-trip stability) is unchanged.
      result += cell.replace(/&nbsp;/g, "");
    } else {
      result += cell;
    }
  };

  while (i < line.length) {
    const ch = line[i];

    // An inline-code span is atomic: a backtick run opens it, and a matching
    // run of the SAME length closes it (CommonMark). Skip the whole span so a
    // `|` inside it is treated as literal cell content, and — crucially — so a
    // backslash inside it stays literal (backslashes do not escape in code).
    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const close = findClosingBackticks(line, i + run, run);
      if (close !== -1) {
        i = close + run;
        continue;
      }
      // No matching closer: the backticks are literal text, not a span opener.
      i += run;
      continue;
    }

    // Outside code, a backslash escapes the next character (e.g. an escaped
    // `\|` pipe in cell text), so that character can never be a delimiter.
    if (ch === "\\" && i + 1 < line.length) {
      i += 2;
      continue;
    }

    if (ch === "|") {
      flushCell(i);
      result += "|";
      cellStart = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  // Trailing text after the final delimiter (normally just padding whitespace).
  result += line.slice(cellStart);
  return result;
}

/**
 * Return the start index of the first run of EXACTLY `length` backticks at or
 * after `from`, or -1 if none exists. A longer or shorter run does not close a
 * code span, so it is skipped and scanning continues.
 */
function findClosingBackticks(line: string, from: number, length: number): number {
  let j = from;
  while (j < line.length) {
    if (line[j] !== "`") {
      j += 1;
      continue;
    }
    let run = 1;
    while (line[j + run] === "`") run++;
    if (run === length) return j;
    j += run;
  }
  return -1;
}
