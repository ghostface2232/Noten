const OPENING_FENCE = /^---[ \t]*\r?$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*\r?$/;
const KEY_LINE = /^[\w"'.-][^:\r\n]*:(?:[ \t]|\r?$)/;
// A comment, an indented continuation, or a list item under a key.
const OTHER_YAML_LINE = /^(?:#|[ \t]+\S|- )/;

/**
 * Where a YAML front matter block at the very start of a note ends: the index
 * just past its closing fence's line, or 0 when the note does not open with one.
 *
 * Two rules around ordinary text look the same from the outside, and reading them
 * as front matter would show a whole section of the note as source. So every line
 * has to look like YAML, at least one has to be a key, and a blank line ends the
 * attempt. A note whose front matter holds a blank line reads as ordinary Markdown.
 */
export function frontMatterEnd(markdown: string): number {
  const start = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!markdown.startsWith("---", start)) return 0;
  let lineStart = markdown.indexOf("\n", start) + 1;
  if (lineStart === 0 || !OPENING_FENCE.test(markdown.slice(start, lineStart - 1))) return 0;
  let sawKey = false;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const line = markdown.slice(lineStart, newline === -1 ? markdown.length : newline);
    if (CLOSING_FENCE.test(line)) {
      if (!sawKey) return 0;
      return newline === -1 ? markdown.length : newline + 1;
    }
    if (KEY_LINE.test(line)) sawKey = true;
    else if (!OTHER_YAML_LINE.test(line)) return 0;
    if (newline === -1) return 0;
    lineStart = newline + 1;
  }
  return 0;
}
