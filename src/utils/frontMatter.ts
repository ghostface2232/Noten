const OPENING_FENCE = /^---[ \t]*\r?$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*\r?$/;
// A rule followed by text also starts with `---`, and a second rule later would
// close it, so the first line under the fence has to look like YAML.
const YAML_LINE = /^(?:#|[\w"'.-][^:\r\n]*:(?:[ \t]|\r?$))/;

/**
 * Where a YAML front matter block at the very start of a note ends: the index
 * just past its closing fence's line, or 0 when the note does not open with one.
 */
export function frontMatterEnd(markdown: string): number {
  if (!markdown.startsWith("---")) return 0;
  let lineStart = markdown.indexOf("\n") + 1;
  if (lineStart === 0 || !OPENING_FENCE.test(markdown.slice(0, lineStart - 1))) return 0;
  let first = true;
  while (lineStart > 0 && lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const line = markdown.slice(lineStart, newline === -1 ? markdown.length : newline);
    if (first && !YAML_LINE.test(line)) return 0;
    first = false;
    if (CLOSING_FENCE.test(line)) return newline === -1 ? markdown.length : newline + 1;
    if (newline === -1) return 0;
    lineStart = newline + 1;
  }
  return 0;
}
