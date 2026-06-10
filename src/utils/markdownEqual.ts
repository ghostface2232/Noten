// Conservative cosmetic-difference comparison for note bodies.
//
// Cloud sync clients (OneDrive/Dropbox/iCloud) and cross-platform editors
// routinely rewrite a file's line endings or trailing newline while its
// rendered Markdown is unchanged. Comparing such bodies byte-for-byte produces
// false "remote wrote first" conflict backups and needless editor reloads.
//
// normalizeMarkdown collapses ONLY differences that can never change rendered
// output: a leading UTF-8 BOM, line-ending style, and trailing blank lines at
// end-of-file. It deliberately leaves interior whitespace untouched — leading
// indentation marks code/list nesting, two trailing spaces are a hard line
// break, and blank lines separate blocks. Treating a meaningful edit as "equal"
// would let a real remote change skip its conflict backup and be silently
// clobbered, which violates Noten's conflict-avoidance invariant. When in
// doubt, these helpers must report "not equal".
export function normalizeMarkdown(md: string): string {
  // Strip a leading UTF-8 BOM (0xFEFF) without embedding the char in source.
  const body = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
  return body
    .replace(/\r\n?/g, "\n") // CRLF / lone CR -> LF
    .replace(/\n+$/, ""); // trailing blank lines never render
}

/** True when two note bodies differ only by cosmetic, non-rendering noise. */
export function markdownEqual(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeMarkdown(a) === normalizeMarkdown(b);
}
