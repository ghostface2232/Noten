// @tiptap/extension-list's orderedList Markdown tokenizer, transcribed with
// these changes: two to how an item's block content is dedented, one to how
// its first line is read, one to how fences in an item are read, one to which
// items a list keeps, one to which markers start an item (see
// matchOrderedItem), one to which lines end it (see
// interruptsLazyContinuation), and a cap on how deep it nests (see
// buildNestedStructure).
//
// The stock `collectOrderedListItems` strips `indent + marker.length + 1`
// columns from each line under an item, one short of its content column
// (`1. ` is 3 wide, the delimiter and the space after the marker both count).
// `buildNestedStructure` then lexes `blockLines.join("\n").trim()`, and the
// trim removes the leftover space from the first line only. So block content
// under an ordered item reached the lexer with its first line at indent 0 and
// the rest at indent 1:
//  - a task list read its second item as the first one's text: `- [x] task2`
//    under `1.` was saved as the text `\[x\] task2` and lost its checkbox;
//  - every line of a fenced code block, and every paragraph after the first,
//    gained a leading space on each save.
//  - a fence that was not the item's first block reached the lexer indented,
//    and CodeBlock drops such a fence: the code block vanished on first save.
// Bullet lists and quotes tolerate the offset, which is why they round-trip.
// Here each line is dedented to the content column CommonMark gives the item
// (marker, delimiter and 1-4 following spaces; 5 or more count as 1), which is
// where the listItem serializer writes it (`alignNestedToPrefix`), and the
// block is then dedented by the indent its lines share instead of trimming
// the first line alone (`dedentBlock`).
// The stock `splitItemContent` also always read the text after the marker as
// a paragraph, so `1. - [ ] t1` became the text `- [ ] t1` (saved as
// `- \[ \] t1`), `1. > q` the text `&gt; q`, and a fence on the marker line a
// paragraph that swallowed its first code line. A marker line whose text opens a
// bullet or task list, a heading, a fence, a quote or a thematic break now
// starts the item's block content, as marked reads a bullet item's first
// line. An ordered marker there stays text, as Tiptap keeps `- 1. a` for a
// bullet item.
// The stock loop also took every line shaped like an ordered marker as a new
// item, inside a fenced code block too: under `1. n`, a fence holding the line
// `   2. x` lost that line to a nested item, and its closing fence opened a
// second, empty code block. A fence opened in the item's own content
// (0-3 columns past its content column, the marker line included, by the
// `fences` rule of the lexer createFastMarked builds) now holds every line
// indented to the content column until its closing fence, so such a line is
// code; a fence after bullet markers, in a bullet nested in the item, holds
// the lines at that bullet's column. A marker-shaped line left of the column
// is still a new item, as CommonMark reads it; where the fence closes follows
// that lexer, which gets every content line dedented to the column.
// The stock `buildNestedStructure` also dropped items less indented than
// their group's first; see its comment.
// Without a fence, the lines an item takes are unchanged except at a marker
// detectMarkerType cannot read and at an unindented quote line the item does
// not hold, and on the lines it takes a list with no indented continuation
// lines, no block on a marker line, no item left of its group's first and no
// line with a marker detectMarkerType cannot read, nested no deeper than the
// cap, tokenizes exactly as before; `orderedListTokenizer.test.ts` compares
// both with the stock one.
// Re-transcribe on an @tiptap/extension-list upgrade, or drop this file if
// the upstream dedent is fixed.

import { ORDERED_LIST_MARKER_PATTERN, detectMarkerType, markerToStart } from "@tiptap/extension-list";

interface BlockLexer {
  inlineTokens(src: string): unknown[];
  blockTokens(src: string): unknown[];
}

interface ListItemLine {
  indent: number;
  number: number;
  type: string | undefined;
  content: string;
  contentLines: string[];
  raw: string;
  /** Where `raw` starts and ends in the tokenizer's `src`. */
  srcStart: number;
  srcEnd: number;
}

/**
 * How many levels of nesting one ordered list token builds. Past it, deeper
 * items are siblings at the deepest level, so their text stays and the list
 * reads the same on the next load.
 */
export const MAX_ORDERED_LIST_DEPTH = 100;

const ORDERED_LIST_ITEM_REGEX = new RegExp(`^(\\s*)(${ORDERED_LIST_MARKER_PATTERN})([.)])\\s+(.*)$`);
const INDENTED_LINE_REGEX = /^\s/;
const PARAGRAPH_INTERRUPTERS = {
  heading: /^#{1,6}(?:\s|$)/,
  bulletItem: /^[-+*]\s+/,
  codeFence: /^(?:```|~~~)/,
  blockMath: /^\$\$/,
  thematicBreak: /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/,
};

// The sixth change: a marker must be one detectMarkerType can read. The
// stock pattern takes any run of roman letters (`Vim`, `IIII`, `Civil`) and
// any one or two letters (`Dr`, `Mr`, `St`) as a marker, detectMarkerType
// reads those that are not a numeral or a single-case letter pair as nothing,
// and the item then counts as number 1 without its marker: `Dr. Smith said`
// was saved as `1. Smith said`. Such a line is text, as it is in CommonMark.
function matchOrderedItem(line: string): RegExpMatchArray | null {
  const match = line.match(ORDERED_LIST_ITEM_REGEX);
  return match && (/^\d+$/.test(match[2]) || detectMarkerType(match[2]) !== undefined) ? match : null;
}

/** Whether `line` starts an ordered list item. */
export function isOrderedItemLine(line: string): boolean {
  return matchOrderedItem(line) !== null;
}

function isOrderedListMarkerLine(line: string): boolean {
  return isOrderedItemLine(line.trimStart());
}

function isBlockContentLine(line: string): boolean {
  const trimmedLine = line.trimStart();
  return (
    PARAGRAPH_INTERRUPTERS.bulletItem.test(trimmedLine) ||
    isOrderedListMarkerLine(trimmedLine) ||
    PARAGRAPH_INTERRUPTERS.heading.test(trimmedLine) ||
    (PARAGRAPH_INTERRUPTERS.thematicBreak.test(trimmedLine) && !trimmedLine.startsWith("-")) ||
    /^>\s?/.test(trimmedLine) ||
    PARAGRAPH_INTERRUPTERS.codeFence.test(trimmedLine) ||
    PARAGRAPH_INTERRUPTERS.blockMath.test(trimmedLine)
  );
}

// The `fences` rule of the lexer createFastMarked builds, which lexes the
// item's content afterwards: 3+ backticks with no backtick after them, or 3+
// tildes, after 0-3 spaces, closed by at least as many of the same character
// and spaces (CommonMark's closer; see commonMarkFence in fastMarkdownLexer.ts).
// The fence may follow bullet markers (`- ````), inside a bullet nested in the
// item; an ordered marker there is text (as Tiptap keeps `- 1. a`), and a
// nested ordered item tracks its own fences.
const FENCE_OPENING = /^( {0,3}(?:[-+*] {1,4})*)(`{3,}(?=[^`]*$)|~{3,})/;

interface OpenFence {
  // Columns past the item's content column where the fence's container
  // content starts: 0 in the item itself, the bullets' width in a bullet.
  indent: number;
  closer: RegExp;
}

// Width in columns, a tab running to the next multiple of 4.
function columnWidth(text: string): number {
  let width = 0;
  for (const character of text) width = character === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

/** The fence a content line (dedented to the item's column) opens, or null. */
function openFence(line: string): OpenFence | null {
  const match = line.match(FENCE_OPENING);
  if (!match) return null;
  const indent = /[-+*]/.test(match[1]) ? match[1].length : 0;
  return { indent, closer: new RegExp(`^ {0,3}${match[2]}${match[2][0]}* *$`) };
}

/**
 * Whether an unindented line ends the item instead of continuing its
 * paragraph lazily.
 *
 * The seventh change: a block quote does, as it interrupts a paragraph in
 * CommonMark. The stock list left it out, so an item took every line after it
 * into its block content, where a quote re-lexed its list through this
 * tokenizer (marked's blockquote → createFastMarked's `list` fallback), which
 * took the rest again: `> a. x` / `foo y` repeated nested one quote deeper per
 * repetition, was saved that deep, and overflowed the stack at a few hundred.
 * Not where the item holds such a line (`holdsQuoteLine`): inside a fence
 * open in the item it is code the lexer keeps in the fence (`>>> print(1)`, a
 * `>>>>>>>` conflict marker), and after a quote line of the item it continues
 * that quote. Ending the item there emptied the fence, and its indented
 * closer opened a fence that held the rest of the note on every save.
 */
function interruptsLazyContinuation(line: string, holdsQuoteLine: boolean): boolean {
  if (!holdsQuoteLine && line.startsWith(">")) return true;
  return Object.values(PARAGRAPH_INTERRUPTERS).some((pattern) => pattern.test(line));
}

// The third change: blocks the text after an item's marker can open.
function opensBlockOnMarkerLine(content: string): boolean {
  return (
    PARAGRAPH_INTERRUPTERS.bulletItem.test(content) ||
    PARAGRAPH_INTERRUPTERS.heading.test(content) ||
    PARAGRAPH_INTERRUPTERS.codeFence.test(content) ||
    PARAGRAPH_INTERRUPTERS.thematicBreak.test(content) ||
    /^>/.test(content)
  );
}

function splitItemContent(contentLines: string[]): { paragraphLines: string[]; blockLines: string[] } {
  if (contentLines.length > 0 && opensBlockOnMarkerLine(contentLines[0])) {
    return { paragraphLines: [], blockLines: contentLines };
  }
  const paragraphLines: string[] = [];
  const blockLines: string[] = [];
  let reachedBlockBoundary = false;
  contentLines.forEach((line) => {
    if (reachedBlockBoundary) {
      blockLines.push(line);
      return;
    }
    if (line.trim() === "") {
      reachedBlockBoundary = true;
      blockLines.push(line);
      return;
    }
    if (paragraphLines.length > 0 && isBlockContentLine(line)) {
      reachedBlockBoundary = true;
      blockLines.push(line);
      return;
    }
    paragraphLines.push(line);
  });
  return { paragraphLines, blockLines };
}

/**
 * The item's content column: indent, marker, delimiter, then 1-4 spaces (5+
 * count as 1, and an item whose first line is blank takes 1).
 */
export function orderedItemContentIndent(line: string): number | null {
  const match = matchOrderedItem(line);
  if (!match) return null;
  const [, indent, marker, , content] = match;
  const spaces = line.length - content.length - indent.length - marker.length - 1;
  return indent.length + marker.length + 1 + (spaces > 4 || content === "" ? 1 : spaces);
}

/**
 * An item's block content, without its leading blank lines and trailing
 * whitespace, dedented by the indent all of its lines share. The stock trim
 * removed the first line's indent alone, so content written deeper than the
 * content column (hand-written 4-space nesting under `1.`) still reached the
 * lexer with its first line one column left of the rest, which the task-list
 * tokenizer reads as that item's continuation, dropping the next checkbox.
 * Relative indentation is kept, so nesting inside the block is unchanged.
 */
function dedentBlock(lines: string[]): string {
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  const content = lines.slice(first);
  const indents = content.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return content
    .map((line) => (line.trim() === "" ? "" : line.slice(shared)))
    .join("\n")
    .trimEnd();
}

/**
 * How many of `lines` the list starting at the first takes. Each step of the
 * walk reads only the line it is on and the lines before it, so a walk that
 * takes fewer than all of `lines` takes the same lines on any input that
 * begins with them; boundedBlockTokenizers.ts relies on that.
 */
export function orderedListLineCount(lines: string[]): number {
  return collectOrderedListItems(lines)[1];
}

function collectOrderedListItems(lines: string[]): [ListItemLine[], number] {
  const listItems: ListItemLine[] = [];
  let currentLineIndex = 0;
  let consumed = 0;
  let offset = 0;
  const lineStarts = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
  while (currentLineIndex < lines.length) {
    const line = lines[currentLineIndex];
    const match = matchOrderedItem(line);
    if (!match) break;
    const [, indent, marker, , content] = match;
    const indentLevel = indent.length;
    const number = parseInt(marker, 10);
    const markerType = isNaN(number) ? detectMarkerType(marker) : undefined;
    const itemNumber = isNaN(number) ? markerToStart(marker) : number;
    const itemContentLines = [content];
    let nextLineIndex = currentLineIndex + 1;
    const itemLines = [line];
    let sawBlankLine = false;
    // The first change: the stock tokenizer used
    // `indentLevel + marker.length + 1`, one column short.
    const contentIndent = orderedItemContentIndent(line)!;
    // The fourth change: a fence open in the item's content.
    let fence = openFence(content);
    while (nextLineIndex < lines.length) {
      const nextLine = lines[nextLineIndex];
      const leadingWhitespace = nextLine.length - nextLine.trimStart().length;
      // Whether a marker-shaped line is code rather than an item is read as
      // CommonMark reads it: at or past the fence's column, a tab running to
      // the next multiple of 4 (Obsidian indents with tabs).
      const inFence =
        fence !== null &&
        nextLine.trim() !== "" &&
        columnWidth(nextLine.slice(0, leadingWhitespace)) >= contentIndent + fence.indent;
      if (!inFence && isOrderedItemLine(nextLine)) break;
      if (nextLine.trim() === "") {
        itemLines.push(nextLine);
        itemContentLines.push("");
        sawBlankLine = true;
        nextLineIndex += 1;
        continue;
      } else if (nextLine.match(INDENTED_LINE_REGEX)) {
        itemLines.push(nextLine);
        itemContentLines.push(nextLine.slice(Math.min(leadingWhitespace, contentIndent)));
        nextLineIndex += 1;
      } else {
        const holdsQuoteLine =
          fence !== null || itemContentLines[itemContentLines.length - 1].trimStart().startsWith(">");
        if (sawBlankLine || interruptsLazyContinuation(nextLine, holdsQuoteLine)) break;
        itemLines.push(nextLine);
        itemContentLines.push(nextLine);
        nextLineIndex += 1;
      }
      // Where the fence closes is read as marked will read it: every line
      // here reaches marked dedented to the item's column, so a line left of
      // that column is code or the closing fence all the same. Judging it by
      // its raw indent opened a second fence at a closer 2 spaces in, and the
      // item's later lines moved on every save. A line left of a nested
      // bullet's column ends that bullet, and its fence.
      const text = itemContentLines[itemContentLines.length - 1];
      if (fence && columnWidth(text.slice(0, text.length - text.trimStart().length)) >= fence.indent) {
        if (fence.closer.test(text.slice(fence.indent))) fence = null;
      } else {
        fence = openFence(text);
      }
    }
    listItems.push({
      indent: indentLevel,
      number: itemNumber,
      type: markerType,
      content: itemContentLines.join("\n").trim(),
      contentLines: itemContentLines,
      raw: itemLines.join("\n"),
      srcStart: lineStarts[currentLineIndex],
      srcEnd: lineStarts[nextLineIndex - 1] + lines[nextLineIndex - 1].length,
    });
    consumed = nextLineIndex;
    currentLineIndex = nextLineIndex;
  }
  return [listItems, consumed];
}

// The fifth change: the stock loop kept only items at exactly `baseIndent`
// and skipped the rest, and a nested group's base was its smallest indent.
// An item less indented than its group's first (` 1. a` / `2. b`, or
// `      2. b` / `   3. c` under `1. a`) was consumed, since its line is in
// the token's `raw`, but never parsed: it vanished on the first save. Here a
// group's base is its first item's indent and an item at or left of it is a
// sibling. At the top level that is CommonMark's reading of a later item
// indented 0-3 spaces. A nested item keeps the stock rule, deeper than its
// group's base nests, where CommonMark goes by the parent's content column:
// under `1. a` / `   2. b` / `      3. c`, `    4. d` is a sibling of `c` here
// and of `b` in CommonMark. Every item is kept either way.
//
// The eighth change: nesting is capped, and a nested list's `raw` is a slice
// of `src`. Every deeper indent nests, so a list indented one more space per
// item nested once per item; Tiptap parses nested lists recursively, and past
// a few hundred levels (about 300 on a cold start) the note did not open. The
// stock `raw`, the nested items' lines joined, copied every deeper line once
// per level: a 1,500-level staircase held gigabytes of strings. A slice of
// `src` is the same string and shares its memory. `items[from..to)` is one
// level's run of items, the first of which sets its base indent.
function buildNestedStructure(
  items: ListItemLine[],
  from: number,
  to: number,
  depth: number,
  src: string,
  lexer: BlockLexer,
): unknown[] {
  const result: unknown[] = [];
  const baseIndent = items[from].indent;
  const nests = depth + 1 < MAX_ORDERED_LIST_DEPTH;
  let currentIndex = from;
  while (currentIndex < to) {
    const item = items[currentIndex];
    const { paragraphLines, blockLines } = splitItemContent(item.contentLines);
    const mainText = paragraphLines.join("\n").trim();
    const tokens: unknown[] = [];
    if (mainText) tokens.push({ type: "paragraph", raw: mainText, tokens: lexer.inlineTokens(mainText) });
    // The second change: the stock `blockLines.join("\n").trim()` strips the
    // first line's indent only; see dedentBlock.
    const additionalContent = dedentBlock(blockLines);
    if (additionalContent) tokens.push(...lexer.blockTokens(additionalContent));
    let lookAheadIndex = currentIndex + 1;
    while (nests && lookAheadIndex < to && items[lookAheadIndex].indent > baseIndent) lookAheadIndex += 1;
    if (lookAheadIndex > currentIndex + 1) {
      const first = items[currentIndex + 1];
      tokens.push({
        type: "list",
        ordered: true,
        start: first.number,
        typeMarker: first.type,
        items: buildNestedStructure(items, currentIndex + 1, lookAheadIndex, depth + 1, src, lexer),
        raw: src.slice(first.srcStart, items[lookAheadIndex - 1].srcEnd),
      });
    }
    result.push({ type: "list_item", raw: item.raw, tokens });
    currentIndex = lookAheadIndex;
  }
  return result;
}

/** Drop-in for the stock `OrderedList.config.markdownTokenizer.tokenize`. */
export function tokenizeOrderedList(src: string, _tokens: unknown[], lexer: BlockLexer) {
  const lines = src.split("\n");
  const [listItems, consumed] = collectOrderedListItems(lines);
  if (listItems.length === 0) return undefined;
  const items = buildNestedStructure(listItems, 0, listItems.length, 0, src, lexer);
  return {
    type: "list",
    ordered: true,
    start: listItems[0]?.number || 1,
    typeMarker: listItems[0]?.type,
    items,
    raw: lines.slice(0, consumed).join("\n"),
  };
}
