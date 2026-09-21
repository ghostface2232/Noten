// Why this file exists
// --------------------
// marked tries every block-level extension tokenizer at every block boundary,
// handing it the ENTIRE remaining document. Three tokenizers registered by
// Tiptap (@tiptap/extension-list `taskList` and `orderedList`,
// @tiptap/extension-table `table.start`) begin with `src.split("\n")` on that
// whole remainder before deciding whether a list or table starts here. A
// document of B blocks and N characters therefore costs O(B · N) to parse:
// a 1 MiB novel spent 8.7 s of a 9.4 s load inside those splits.
//
// Each wrapper below hands its tokenizer a prefix of `src` that ends at a line
// the original is proven to stop at (or before) without consuming it. The
// tokenizer then sees exactly the lines it would have looked at, so its token —
// including `raw`, which marked uses to advance — is identical, while the work
// per call is bounded by the construct it actually parses. The proofs are the
// comments on each cut rule; `boundedBlockTokenizers.test.ts` fuzzes token-tree
// equivalence against the unwrapped tokenizers. When a Tiptap upgrade changes
// one of these tokenizers, re-check its cut rule against the new source.

type BlockTokenizer = (this: unknown, src: string, tokens: unknown[]) => unknown;
type StartFn = (this: unknown, src: string) => number | void;

interface MarkedExtensionLike {
  name?: string;
  level?: string;
  start?: StartFn;
  tokenizer?: BlockTokenizer;
}

const BLANK = /^\s*$/;
const STARTS_WITH_SPACE = /^\s/;

/**
 * Cut `src` just before the line starting at `lineStart`, dropping the newline
 * that ends the previous line: the result splits into exactly the lines before
 * it, with no trailing empty line the tokenizer could mistake for a blank one.
 */
function cutBefore(src: string, lineStart: number): string {
  return lineStart <= 0 ? "" : src.slice(0, lineStart - 1);
}

/**
 * Walk lines until `isCut(line, index, previousBlank)` asks to stop, returning
 * the prefix before that line. Each call is O(length of the returned prefix +
 * the stopping line).
 */
function boundLines(
  src: string,
  isCut: (line: string, index: number, previousBlank: boolean) => boolean,
): string {
  let start = 0;
  let index = 0;
  let previousBlank = false;
  while (start <= src.length) {
    const nl = src.indexOf("\n", start);
    const end = nl < 0 ? src.length : nl;
    const line = src.slice(start, end);
    if (isCut(line, index, previousBlank)) return cutBefore(src, start);
    if (nl < 0) break;
    previousBlank = BLANK.test(line);
    start = nl + 1;
    index++;
  }
  return src;
}

// taskList → @tiptap/core `parseIndentedBlocks` with itemPattern
// /^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$/. TASK_ITEM accepts every line that
// pattern accepts, so failing it is conclusive.
//
// Leading blank lines are skipped and the first non-blank line must be an
// item; if it is not, the original returns undefined without looking further,
// so the input can end after that line. After an item, parsing stops (without
// consuming the line) at:
//  (a) a non-blank line at column 0 that is not a task item: the inner loop
//      breaks because its indent (0) is not greater than any item's indent,
//      and the outer loop breaks because it cannot match itemPattern;
//  (b) the first of a run of blank lines whose next non-blank line is at
//      column 0: the inner loop's lookahead sees indent 0 and breaks on the
//      blank line, which the outer loop then rejects.
// In both cases the truncated input ends at the same index by exhaustion.
const TASK_ITEM = /^\s*[-+*]\s+\[[ xX]\]\s/;

function boundTaskList(src: string): string {
  let seenItem = false;
  let blankRunStart = -1;
  let start = 0;
  while (start <= src.length) {
    const nl = src.indexOf("\n", start);
    const end = nl < 0 ? src.length : nl;
    const line = src.slice(start, end);
    if (BLANK.test(line)) {
      if (seenItem && blankRunStart < 0) blankRunStart = start;
    } else if (!seenItem) {
      if (!TASK_ITEM.test(line)) return src.slice(0, end);
      seenItem = true;
    } else {
      const atColumnZero = !STARTS_WITH_SPACE.test(line);
      if (atColumnZero && blankRunStart >= 0) return cutBefore(src, blankRunStart);
      if (atColumnZero && !TASK_ITEM.test(line)) return cutBefore(src, start);
      blankRunStart = -1;
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  return src;
}

// Superset of @tiptap/extension-list's ORDERED_LIST_ITEM_REGEX
// (`^(\s*)(\d+|[ivxlcdmIVXLCDM]+|[a-zA-Z]{1,2})([.)])\s+(.*)$`): every line the
// real pattern accepts matches this one, so "does not match" is conclusive.
const MAYBE_ORDERED_ITEM = /^\s*[0-9A-Za-z]+[.)]\s/;

// Copied verbatim from @tiptap/extension-list's PARAGRAPH_INTERRUPTERS.
const LAZY_INTERRUPTERS = [
  /^#{1,6}(?:\s|$)/,
  /^[-+*]\s+/,
  /^(?:```|~~~)/,
  /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/,
];

// orderedList → `collectOrderedListItems(src.split("\n"))`.
//
// A first line that cannot be an item yields no list, so one line suffices.
// Afterwards, a non-blank line at column 0 that cannot be an item ends the list
// without being consumed when either
//  (a) it directly follows a blank line, which was consumed into the current
//      item and set its `sawBlankLine`; or
//  (b) it is a lazy-continuation interrupter (heading, bullet, fence, break):
// the inner loop's lazy-continuation branch breaks there and the outer loop
// rejects the line. The truncated input stops at the same index by
// exhaustion, and `raw` is `lines.slice(0, consumed)`, identical in both.
// Copied verbatim from @tiptap/extension-list's ORDERED_LIST_ITEM_REGEX, for the
// first line, where an exact verdict lets non-items like "Fig. 1" end the
// input at once instead of scanning on to the next cut.
const ORDERED_ITEM = /^(\s*)(\d+|[ivxlcdmIVXLCDM]+|[a-zA-Z]{1,2})([.)])\s+(.*)$/;

function boundOrderedList(src: string): string {
  return boundLines(src, (line, index, previousBlank) => {
    if (index === 0) return false;
    if (index === 1 && !ORDERED_ITEM.test(src.slice(0, src.indexOf("\n")))) return true;
    if (BLANK.test(line) || STARTS_WITH_SPACE.test(line) || MAYBE_ORDERED_ITEM.test(line)) return false;
    return previousBlank || LAZY_INTERRUPTERS.some((pattern) => pattern.test(line));
  });
}

// table.start reads only lines[0], lines[1], and whether a second line exists.
function boundTwoLines(src: string): string {
  const first = src.indexOf("\n");
  if (first < 0) return src;
  const second = src.indexOf("\n", first + 1);
  return second < 0 ? src : src.slice(0, second);
}

// Copied verbatim from table.start / table.tokenize: a table's second line.
function isTableSeparator(line: string): boolean {
  return /^[ \t|:]*-[ \t|:-]*$/.test(line) && line.includes("|");
}

// table.tokenize works on the text before the first blank line ("\n\n") and
// finally re-splits the whole `src` only to take the table's first
// `lineCount` lines, all of which lie inside that text. It rejects the input
// unless that text's second line is a separator; when `src`'s second line is
// not one (an empty second line included), two lines reach the same verdict
// without scanning ahead for a blank line.
function boundTable(src: string): string {
  const twoLines = boundTwoLines(src);
  const first = twoLines.indexOf("\n");
  if (first >= 0 && !isTableSeparator(twoLines.slice(first + 1))) return twoLines;
  const blank = src.indexOf("\n\n");
  return blank < 0 ? src : src.slice(0, blank);
}

function wrapTokenizer(tokenizer: BlockTokenizer, bound: (src: string) => string): BlockTokenizer {
  return function boundedTokenizer(this: unknown, src, tokens) {
    return tokenizer.call(this, bound(src), tokens);
  };
}

function wrapStart(start: StartFn, bound: (src: string) => string): StartFn {
  return function boundedStart(this: unknown, src) {
    return start.call(this, bound(src));
  };
}

/** Returns the extension with its known whole-document scans bounded. */
export function boundBlockExtension<T extends MarkedExtensionLike>(ext: T): T {
  if (ext.level !== "block") return ext;
  switch (ext.name) {
    case "taskList":
      return ext.tokenizer ? { ...ext, tokenizer: wrapTokenizer(ext.tokenizer, boundTaskList) } : ext;
    case "orderedList":
      return ext.tokenizer ? { ...ext, tokenizer: wrapTokenizer(ext.tokenizer, boundOrderedList) } : ext;
    case "table":
      return {
        ...ext,
        ...(ext.start ? { start: wrapStart(ext.start, boundTwoLines) } : {}),
        ...(ext.tokenizer ? { tokenizer: wrapTokenizer(ext.tokenizer, boundTable) } : {}),
      };
    default:
      return ext;
  }
}

export const __test = { boundTaskList, boundOrderedList, boundTwoLines, boundTable };
