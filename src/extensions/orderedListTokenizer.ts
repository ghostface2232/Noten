// @tiptap/extension-list's orderedList Markdown tokenizer, transcribed with
// two changes to how an item's block content is dedented and one to how its
// first line is read.
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
// Last, the stock loop took every line shaped like an ordered marker as a new
// item, inside a fenced code block too: under `1. n`, a fence holding the line
// `   2. x` lost that line to a nested item, and its closing fence opened a
// second, empty code block. A fence opened in the item's own content
// (0-3 columns past its content column, the marker line included, by marked's
// `fences` rule) now holds every line indented to the content column until
// its closing fence, so such a line is code; a fence after bullet markers, in
// a bullet nested in the item, holds the lines at that bullet's column. A line left of the column ends
// the item as before, fence or not: CommonMark continues no fence lazily.
// Without a fence, the lines an item takes are unchanged, and a list with no
// indented continuation lines and no block on a marker line tokenizes exactly
// as before; `orderedListTokenizer.test.ts` compares both with the stock one.
// With one, a column-0 line still meets the same branch as before, which is
// what the cut rule in boundedBlockTokenizers.ts relies on.
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
}

const ORDERED_LIST_ITEM_REGEX = new RegExp(`^(\\s*)(${ORDERED_LIST_MARKER_PATTERN})([.)])\\s+(.*)$`);
const INDENTED_LINE_REGEX = /^\s/;
const PARAGRAPH_INTERRUPTERS = {
  heading: /^#{1,6}(?:\s|$)/,
  bulletItem: /^[-+*]\s+/,
  codeFence: /^(?:```|~~~)/,
  blockMath: /^\$\$/,
  thematicBreak: /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/,
};

function isOrderedListMarkerLine(line: string): boolean {
  return ORDERED_LIST_ITEM_REGEX.test(line.trimStart());
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

// marked's `fences` rule, which lexes the item's content afterwards: 3+
// backticks with no backtick after them, or 3+ tildes, after 0-3 spaces,
// closed by the same fence followed only by more fence characters and spaces.
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

/** The fence a content line (dedented to the item's column) opens, or null. */
function openFence(line: string): OpenFence | null {
  const match = line.match(FENCE_OPENING);
  if (!match) return null;
  const indent = /[-+*]/.test(match[1]) ? match[1].length : 0;
  return { indent, closer: new RegExp(`^ {0,3}${match[2]}[~\`]* *$`) };
}

function interruptsLazyContinuation(line: string): boolean {
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
  const match = line.match(ORDERED_LIST_ITEM_REGEX);
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

function collectOrderedListItems(lines: string[]): [ListItemLine[], number] {
  const listItems: ListItemLine[] = [];
  let currentLineIndex = 0;
  let consumed = 0;
  while (currentLineIndex < lines.length) {
    const line = lines[currentLineIndex];
    const match = line.match(ORDERED_LIST_ITEM_REGEX);
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
      const inFence =
        fence !== null && nextLine.trim() !== "" && leadingWhitespace >= contentIndent + fence.indent;
      if (!inFence && nextLine.match(ORDERED_LIST_ITEM_REGEX)) break;
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
        if (sawBlankLine || interruptsLazyContinuation(nextLine)) break;
        itemLines.push(nextLine);
        itemContentLines.push(nextLine);
        nextLineIndex += 1;
      }
      // A line left of the fence's content ends its container, and the fence.
      const text = itemContentLines[itemContentLines.length - 1];
      if (fence && inFence) {
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
    });
    consumed = nextLineIndex;
    currentLineIndex = nextLineIndex;
  }
  return [listItems, consumed];
}

function buildNestedStructure(items: ListItemLine[], baseIndent: number, lexer: BlockLexer): unknown[] {
  const result: unknown[] = [];
  let currentIndex = 0;
  while (currentIndex < items.length) {
    const item = items[currentIndex];
    if (item.indent === baseIndent) {
      const { paragraphLines, blockLines } = splitItemContent(item.contentLines);
      const mainText = paragraphLines.join("\n").trim();
      const tokens: unknown[] = [];
      if (mainText) tokens.push({ type: "paragraph", raw: mainText, tokens: lexer.inlineTokens(mainText) });
      // The second change: the stock `blockLines.join("\n").trim()` strips the
      // first line's indent only; see dedentBlock.
      const additionalContent = dedentBlock(blockLines);
      if (additionalContent) tokens.push(...lexer.blockTokens(additionalContent));
      let lookAheadIndex = currentIndex + 1;
      const nestedItems: ListItemLine[] = [];
      while (lookAheadIndex < items.length && items[lookAheadIndex].indent > baseIndent) {
        nestedItems.push(items[lookAheadIndex]);
        lookAheadIndex += 1;
      }
      if (nestedItems.length > 0) {
        const nestedListItems = buildNestedStructure(
          nestedItems,
          Math.min(...nestedItems.map((nestedItem) => nestedItem.indent)),
          lexer,
        );
        tokens.push({
          type: "list",
          ordered: true,
          start: nestedItems[0].number,
          typeMarker: nestedItems[0].type,
          items: nestedListItems,
          raw: nestedItems.map((nestedItem) => nestedItem.raw).join("\n"),
        });
      }
      result.push({ type: "list_item", raw: item.raw, tokens });
      currentIndex = lookAheadIndex;
    } else {
      currentIndex += 1;
    }
  }
  return result;
}

/** Drop-in for the stock `OrderedList.config.markdownTokenizer.tokenize`. */
export function tokenizeOrderedList(src: string, _tokens: unknown[], lexer: BlockLexer) {
  const lines = src.split("\n");
  const [listItems, consumed] = collectOrderedListItems(lines);
  if (listItems.length === 0) return undefined;
  const items = buildNestedStructure(listItems, listItems[0].indent, lexer);
  if (items.length === 0) return undefined;
  return {
    type: "list",
    ordered: true,
    start: listItems[0]?.number || 1,
    typeMarker: listItems[0]?.type,
    items,
    raw: lines.slice(0, consumed).join("\n"),
  };
}
