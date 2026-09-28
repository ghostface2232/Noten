// @tiptap/extension-list's taskList Markdown tokenizer, with the
// `parseIndentedBlocks` it runs on (@tiptap/core) transcribed into it, and two
// changes to which lines under an item are its content and how they are
// dedented.
//
// The stock one takes every line indented past an item's marker as the item's
// content and slices a fixed `indentLevel + 2` columns from each, so a line
// indented less than that lost real characters, and a sibling item CommonMark
// reads at 1 space was taken as the item's text:
//  - `- [ ] t1` / ` x` saved as `- [ ] t1`: the x was deleted;
//  - `- [ ] t1` / blank / ` after` saved `after` as `fter`;
//  - `- [ ] t1` / ` - [x] t2` saved t2 as the text `\[x\] t2`.
// Here, with the item's content column C (its marker and the 1-4 spaces after
// it, so `- [ ] ` has C = indent + 2), and indentation measured in columns
// with a tab running to the next multiple of 4, as CommonMark measures it:
//  - a line indented at least C is content, dedented by C as before;
//  - a line indented past the marker but short of C ends the item when it
//    starts a task item (the next item of this list), a bullet, a heading, a
//    fence, a quote or a thematic break, as CommonMark reads it; any other one
//    is a lazy continuation, content dedented by its own indent, so no
//    character is cut;
//  - after a blank line, a line short of C ends the item, and so the list.
// A line at or left of the marker ends the item as before, and so does every
// line at column 0 that is not a task item, which is what the cut rule in
// boundedBlockTokenizers.ts relies on; `boundedBlockTokenizers.test.ts` fuzzes
// this tokenizer bounded against unbounded too. Re-transcribe on an
// @tiptap/extension-list or @tiptap/core upgrade, or drop this file once
// upstream dedents by the content column.

interface BlockLexer {
  inlineTokens(src: string): unknown[];
  blockTokens(src: string): unknown[];
}

interface TaskItemToken {
  type: "taskItem";
  raw: string;
  mainContent: string;
  indentLevel: number;
  checked: boolean;
  text: string;
  tokens: unknown[];
  nestedTokens: unknown[] | undefined;
}

const TASK_ITEM_PATTERN = /^(\s*)([-+*])(\s+)\[([ xX])\]\s+(.*)$/;
const LEADING_WHITESPACE = /^(\s*)/;

// Blocks other than a paragraph that a line short of the content column opens,
// ending the item there. A task item matches the bullet pattern.
const ITEM_INTERRUPTERS = [
  /^[-+*](?:\s|$)/,
  /^#{1,6}(?:\s|$)/,
  /^(?:```|~~~)/,
  /^>/,
  /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/,
];

const TAB_STOP = 4;

// The column after `text`, starting from column `from`: a tab runs to the
// next multiple of 4, as CommonMark measures indentation; any other character
// is one column. Counting a tab as one column read Obsidian's tab-indented
// nesting (`- [ ] a` / `\t- [ ] b`) as short of the content column.
function columnAfter(text: string, from = 0): number {
  let column = from;
  for (const character of text) column = character === "\t" ? column + TAB_STOP - (column % TAB_STOP) : column + 1;
  return column;
}

function indentOf(line: string): number {
  return columnAfter(line.match(LEADING_WHITESPACE)?.[1] ?? "");
}

// `line` without its first `columns` columns of indentation, or all of it if
// it has fewer. A tab straddling the cut leaves its remaining columns as
// spaces; the characters after it are kept as written.
function dedent(line: string, columns: number): string {
  let column = 0;
  let index = 0;
  while (index < line.length && column < columns && /\s/.test(line[index])) {
    const next = columnAfter(line[index], column);
    if (next > columns) return " ".repeat(next - columns) + line.slice(index + 1);
    column = next;
    index += 1;
  }
  return line.slice(index);
}

/** Content column of a task item: indent, marker, then 1-4 columns of space (5+ count as 1). */
export function taskItemContentIndent(line: string): number | null {
  const match = line.match(TASK_ITEM_PATTERN);
  if (!match) return null;
  const marker = columnAfter(match[1]) + 1;
  const spaces = columnAfter(match[3], marker) - marker;
  return marker + (spaces > 4 ? 1 : spaces);
}

function parseTaskItems(src: string, lexer: BlockLexer): { items: TaskItemToken[]; raw: string } | undefined {
  const lines = src.split("\n");
  const items: TaskItemToken[] = [];
  let totalRaw = "";
  let i = 0;
  while (i < lines.length) {
    const currentLine = lines[i];
    const itemMatch = currentLine.match(TASK_ITEM_PATTERN);
    if (!itemMatch) {
      if (items.length > 0) break;
      if (currentLine.trim() === "") {
        i += 1;
        totalRaw = `${totalRaw}${currentLine}\n`;
        continue;
      }
      return undefined;
    }
    // The token keeps the stock character count; the rules below use columns.
    const indentLevel = itemMatch[1].length;
    const indentColumn = columnAfter(itemMatch[1]);
    const mainContent = itemMatch[5];
    const checked = itemMatch[4].toLowerCase() === "x";
    const contentIndent = taskItemContentIndent(currentLine)!;
    totalRaw = `${totalRaw}${currentLine}\n`;
    const nestedContent: string[] = [];
    i += 1;
    while (i < lines.length) {
      const nextLine = lines[i];
      if (nextLine.trim() === "") {
        const nextNonEmptyIndex = lines.slice(i + 1).findIndex((line) => line.trim() !== "");
        if (nextNonEmptyIndex === -1) break;
        // Stock: `> indentLevel`.
        if (indentOf(lines[i + 1 + nextNonEmptyIndex]) < contentIndent) break;
        nestedContent.push(nextLine);
        totalRaw = `${totalRaw}${nextLine}\n`;
        i += 1;
        continue;
      }
      const indent = indentOf(nextLine);
      if (indent <= indentColumn) break;
      if (indent < contentIndent && ITEM_INTERRUPTERS.some((pattern) => pattern.test(nextLine.trimStart()))) break;
      nestedContent.push(nextLine);
      totalRaw = `${totalRaw}${nextLine}\n`;
      i += 1;
    }
    let nestedTokens: unknown[] | undefined;
    if (nestedContent.length > 0) {
      // Stock: `nestedLine.slice(indentLevel + 2)`, whatever the line held.
      const dedented = nestedContent.map((line) => dedent(line, contentIndent)).join("\n");
      if (dedented.trim()) nestedTokens = parseTaskListContent(dedented, lexer);
    }
    items.push({
      type: "taskItem",
      raw: "",
      mainContent,
      indentLevel,
      checked,
      text: mainContent,
      tokens: lexer.inlineTokens(mainContent),
      nestedTokens,
    });
  }
  if (items.length === 0) return undefined;
  return { items, raw: totalRaw };
}

function parseTaskListContent(content: string, lexer: BlockLexer): unknown[] {
  const nested = parseTaskItems(content, lexer);
  if (!nested) return lexer.blockTokens(content);
  const taskListToken = { type: "taskList", raw: nested.raw, items: nested.items };
  const remainder = content.slice(nested.raw.length);
  return remainder.trim() ? [taskListToken, ...lexer.blockTokens(remainder)] : [taskListToken];
}

/** Drop-in for the stock `TaskList.config.markdownTokenizer.tokenize`. */
export function tokenizeTaskList(src: string, _tokens: unknown[], lexer: BlockLexer) {
  const result = parseTaskItems(src, lexer);
  if (!result) return undefined;
  return { type: "taskList", raw: result.raw, items: result.items };
}
