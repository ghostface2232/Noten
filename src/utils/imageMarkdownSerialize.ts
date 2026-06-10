// Serializes an image node back into the markdown source of truth.
//
// The values flowing in here are user data: alt/title come from pasted HTML or
// edited captions, src can be a data URL or .assets path. Interpolating them
// raw produced broken output — alt='He said "hi"' became alt="He said "hi""
// which the next load parses as garbage attributes and leaks fragments into
// the body text, silently corrupting the note. Every value is escaped for the
// context it lands in (HTML attribute vs markdown inline syntax).

export interface ImageNodeAttrs {
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  width?: number | string | null;
  height?: number | string | null;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// `![alt]` — backslash-escape the bracket delimiters (and backslash itself).
function escapeMdAlt(value: string): string {
  return value.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

// `"title"` — the quote is the only delimiter; escape it and backslash.
function escapeMdTitle(value: string): string {
  return value.replace(/[\\"]/g, (c) => `\\${c}`);
}

// `](dest)` — whitespace or parens end a bare destination; CommonMark's
// angle-bracket form accepts them, but cannot itself contain <, > or newlines,
// so percent-encode those.
function mdDestination(src: string): string {
  if (!/[\s()<>]/.test(src)) return src;
  return `<${src.replace(/[<>\n\r]/g, (c) => encodeURIComponent(c))}>`;
}

export function serializeImageMarkdown(attrs: ImageNodeAttrs): string {
  const src = attrs.src ?? "";
  const alt = attrs.alt ?? "";
  const title = attrs.title ?? "";
  const { width, height } = attrs;

  // Markdown image syntax has no width/height, so sized images round-trip
  // through an HTML tag instead.
  if (width || height) {
    const parts = [`src="${escapeHtmlAttr(src)}"`, `alt="${escapeHtmlAttr(alt)}"`];
    if (title) parts.push(`title="${escapeHtmlAttr(title)}"`);
    if (width) parts.push(`width="${escapeHtmlAttr(String(width))}"`);
    if (height) parts.push(`height="${escapeHtmlAttr(String(height))}"`);
    return `<img ${parts.join(" ")} />`;
  }

  return title
    ? `![${escapeMdAlt(alt)}](${mdDestination(src)} "${escapeMdTitle(title)}")`
    : `![${escapeMdAlt(alt)}](${mdDestination(src)})`;
}
