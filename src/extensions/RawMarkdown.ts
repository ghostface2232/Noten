import { Extension, Mark, Node, type JSONContent, type MarkdownToken } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { firstIndexOf } from "./fastMarkdownLexer";
import { frontMatterEnd } from "../utils/frontMatter";

// Markdown the editor has no model for must survive a save unchanged. It used to
// be converted on the way in and lost on the way out: front matter became a rule
// and a heading, comments and reference definitions vanished, HTML kept its text
// and lost its tags, and footnotes, callouts and math gained backslashes. Other
// apps read those files, so that is damage even when the note looks right here.
//
// So it is kept as source text: `rawBlock` for a block, the `rawInline` mark for
// inline text. Both are `code`, which is what exempts their text from the
// serializer's escaping, and both stay editable as plain text. Neither is ever
// rendered as HTML, so raw HTML in a note stays inert.

const RAW_BLOCK = "rawBlock";
const RAW_INLINE = "rawInline";

export type RawBlockKind = "frontmatter" | "comment" | "html" | "math" | "definition" | "footnote";

function rawBlock(text: string, kind: RawBlockKind): JSONContent {
  return { type: RAW_BLOCK, attrs: { kind }, content: [{ type: "text", text }] };
}

function rawInline(text: string): JSONContent {
  return { type: "text", text, marks: [{ type: RAW_INLINE }] };
}

// Pandoc's rule, so prices stay text: no space just inside either `$`, and no
// digit right after the closer (`$5 and $6`, `$5/$3`). `$$a$$` is the same inside
// a line. The classes leave out what the next delimiter's search would also scan
// (`[`, `(`), so a long run of unclosed openers stays linear.
const INLINE_MATH = /\$\$[^$`\n]+\$\$(?!\d)|\$(?![\s$])(?:\\[^\n]|[^$\\\n`])+?(?<!\s)\$(?!\d)/.source;
// A link or definition keeps its own reading: `[^1](x)`, `[!a][b]`, `[^1]:`.
const FOOTNOTE_REFERENCE = /\[\^[^\][\s]+\](?![([:])/.source;
const CALLOUT_MARKER = /\[![A-Za-z][\w-]*\][+-]?(?![([:])/.source;
// The schema cannot hold a link on an image, so the link would be lost.
const LINKED_IMAGE = /\[!\[[^\][\n]*\]\([^()[\n]*\)\]\([^()[\n]*\)/.source;

const INLINE_MATH_AT_START = new RegExp(`^(?:${INLINE_MATH})`);
const BRACKET_SYNTAX_AT_START = new RegExp(`^(?:${FOOTNOTE_REFERENCE}|${CALLOUT_MARKER}|${LINKED_IMAGE})`);
// What the same text would be read as if it were written unescaped. Typing these
// in the editor must save them as written, or the reload would read `$a\_b$`.
const SYNTAX_IN_PLAIN_TEXT = new RegExp(`${INLINE_MATH}|${FOOTNOTE_REFERENCE}|${CALLOUT_MARKER}`, "g");

// `$` is also an ordinary character, and this tokenizer runs before the ones for
// code spans, links and emphasis. A match that would cut across one of those is
// not math: `$HOME and [a$](u)` and `$a **b$ c**` keep their link and bold.
function readsAsMath(source: string): boolean {
  if (!source.startsWith("$")) return true;
  if (source.includes("**") || source.includes("__") || source.includes("~~") || source.includes("](")) return false;
  let depth = 0;
  for (const character of source) {
    if (character === "[") depth += 1;
    else if (character === "]" && --depth < 0) return false;
  }
  return depth === 0;
}

// Tags the schema reads and the serializer writes back, so converting them keeps
// their meaning. Everything else stays as source, and so does a tag with an
// attribute its mark or node has nowhere to hold.
const FORMATTING_TAGS = new Set(["strong", "b", "em", "i", "u", "s", "del", "strike", "code", "br"]);
const KEPT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
};
const HTML_TAG = /<\s*\/?\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const HTML_ATTRIBUTE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;

function isOnlyAComment(html: string): boolean {
  const source = html.trim();
  return source.startsWith("<!--") && source.indexOf("-->") === source.length - 3;
}

function schemaKeepsHtml(html: string): boolean {
  if (html.includes("<!") || html.includes("<?")) return false;
  let sawTag = false;
  let sawLink = false;
  let sawImage = false;
  for (const [, rawName, attributes] of html.matchAll(HTML_TAG)) {
    sawTag = true;
    const name = rawName.toLowerCase();
    if (name === "a") sawLink = true;
    if (name === "img") sawImage = true;
    const kept = KEPT_ATTRIBUTES[name];
    if (!kept && !FORMATTING_TAGS.has(name)) return false;
    for (const [, attribute] of attributes.matchAll(HTML_ATTRIBUTE)) {
      if (!kept?.has(attribute.toLowerCase())) return false;
    }
  }
  // The image would survive and the link around it would not.
  return sawTag && !(sawLink && sawImage);
}

type ParseResult = JSONContent | JSONContent[] | null;

interface ManagerInternals {
  nodeTypeRegistry: Map<string, unknown>;
  codeTypes: Set<string>;
  parse(markdown: string): JSONContent;
  parseHTMLToken(token: MarkdownToken): ParseResult;
  encodeTextForMarkdown(text: string, node: JSONContent, parentNode?: JSONContent): string;
}

// The manager encodes `&`, so `&copy;` came back as `&amp;copy;`. Its parser only
// decodes the entities below, so anything else reads back as written.
const ESCAPED_OTHER_ENTITY = /&amp;(?!(?:amp|lt|gt|quot);)(#\d+;|#[xX][\da-fA-F]+;|[a-zA-Z][a-zA-Z\d]*;)/g;

const PATCHED = Symbol.for("noten.rawMarkdownPatched");

/**
 * The three steps the extensions below cannot reach. They sit on the prototype
 * because the Markdown extension parses initial content inside its own
 * onBeforeCreate, and each applies only to a manager whose schema has the nodes,
 * so an editor built without RawMarkdown keeps the stock behaviour.
 */
function patchManager(): void {
  const proto = MarkdownManager.prototype as unknown as ManagerInternals & { [PATCHED]?: true };
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  const { parse, parseHTMLToken, encodeTextForMarkdown } = proto;

  // A block tokenizer cannot tell the start of the note from the start of any
  // other block, and this is the one place front matter counts.
  proto.parse = function (this: ManagerInternals, markdown) {
    const end = this.nodeTypeRegistry.has(RAW_BLOCK) ? frontMatterEnd(markdown) : 0;
    if (end === 0) return parse.call(this, markdown);
    const doc = parse.call(this, markdown.slice(end));
    const source = markdown.slice(0, end).replace(/\r\n/g, "\n").trimEnd();
    return { ...doc, content: [rawBlock(source, "frontmatter"), ...(doc.content ?? [])] };
  };

  proto.parseHTMLToken = function (this: ManagerInternals, token) {
    const html = token.text || token.raw || "";
    if (!this.nodeTypeRegistry.has(RAW_BLOCK) || !html.trim() || schemaKeepsHtml(html)) {
      return parseHTMLToken.call(this, token);
    }
    if (!token.block) return [rawInline(html)];
    return [rawBlock(html.trimEnd(), isOnlyAComment(html) ? "comment" : "html")];
  };

  proto.encodeTextForMarkdown = function (this: ManagerInternals, text, node, parentNode) {
    const encode = (part: string) => encodeTextForMarkdown.call(this, part, node, parentNode);
    if (!this.nodeTypeRegistry.has(RAW_INLINE)) return encode(text);
    const inCode =
      (parentNode?.type != null && this.codeTypes.has(parentNode.type)) ||
      (node.marks ?? []).some((mark) => this.codeTypes.has(mark.type));
    if (inCode) return encode(text);

    const encodePlain = (part: string) => encode(part).replace(ESCAPED_OTHER_ENTITY, "&$1");
    if (!text.includes("$") && !text.includes("[")) return encodePlain(text);
    let output = "";
    let cursor = 0;
    for (const match of text.matchAll(SYNTAX_IN_PLAIN_TEXT)) {
      if (!readsAsMath(match[0])) continue;
      output += encodePlain(text.slice(cursor, match.index)) + match[0];
      cursor = match.index + match[0].length;
    }
    return output + encodePlain(text.slice(cursor));
  };
}

patchManager();

const FENCED_MATH_OPEN = /^ {0,3}\$\$/;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[^\][\s]+\]:/;

function lineEnd(src: string, start: number): number {
  const newline = src.indexOf("\n", start);
  return newline === -1 ? src.length : newline + 1;
}

// A blank line ends the search, so an unclosed `$$` costs one paragraph's scan.
function fencedMathLength(src: string): number {
  let cursor = lineEnd(src, 0);
  const firstLine = src.slice(0, cursor).trim();
  if (firstLine.endsWith("$$") && firstLine.slice(2, -2).trim()) return cursor;
  while (cursor < src.length) {
    const end = lineEnd(src, cursor);
    const line = src.slice(cursor, end).trimEnd();
    if (!line) return 0;
    if (line.endsWith("$$")) return end;
    cursor = end;
  }
  return 0;
}

// The definition's line, then every indented line, across blank lines.
function footnoteDefinitionLength(src: string): number {
  let length = lineEnd(src, 0);
  let cursor = length;
  while (cursor < src.length) {
    const end = lineEnd(src, cursor);
    const line = src.slice(cursor, end);
    if (/^(?: {4}|\t)\S/.test(line)) length = end;
    else if (line.trim()) break;
    cursor = end;
  }
  return length;
}

function readRawBlock(src: string): (MarkdownToken & { kind: RawBlockKind }) | undefined {
  const isMath = FENCED_MATH_OPEN.test(src);
  if (!isMath && !FOOTNOTE_DEFINITION.test(src)) return undefined;
  const length = isMath ? fencedMathLength(src) : footnoteDefinitionLength(src);
  if (length === 0) return undefined;
  const raw = src.slice(0, length);
  return { type: RAW_BLOCK, raw, text: raw.trimEnd(), kind: isMath ? "math" : "footnote" };
}

/** Markdown source shown and saved as written. */
export const RawBlock = Node.create({
  name: RAW_BLOCK,
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  // Backspace at the start of the paragraph below, where a note with front matter
  // opens, would join it into the source: `---body`, which no longer closes the
  // front matter. Delete at the source's end and Backspace at its start likewise.
  isolating: true,

  addAttributes() {
    return {
      kind: {
        default: "html",
        parseHTML: (element) => element.getAttribute("data-raw-kind") ?? "html",
        renderHTML: (attrs) => ({ "data-raw-kind": attrs.kind }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "pre[data-raw-kind]", preserveWhitespace: "full", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["pre", { ...HTMLAttributes, class: "noten-raw-block", spellcheck: "false" }, 0];
  },

  markdownTokenName: RAW_BLOCK,
  markdownTokenizer: {
    name: RAW_BLOCK,
    level: "block" as const,
    // Never interrupts a paragraph. Asking on every block would rescan the rest
    // of the note, and these are written as blocks of their own.
    start: () => -1,
    tokenize: (src: string) => readRawBlock(src),
  },

  parseMarkdown(token: MarkdownToken) {
    return rawBlock(String(token.text ?? ""), (token.kind as RawBlockKind | undefined) ?? "html");
  },

  renderMarkdown(node: JSONContent, _helpers, context) {
    const source = (node.content ?? []).map((child) => child.text ?? "").join("");
    // A list item writes its later blocks on the next line, and only a paragraph
    // gets a blank line first. Without one this source is read as part of the
    // paragraph above: the line stops being indented on the next save and is
    // escaped on the one after. Written as a line of the block, so it is indented
    // with the rest of it.
    const inItem = context?.parentType === "listItem" || context?.parentType === "taskItem";
    return inItem && context?.index > 0 ? `\n${source}` : source;
  },
});

/** Inline Markdown source saved as written. The mark's text holds its delimiters. */
export const RawInline = Mark.create({
  name: RAW_INLINE,
  inclusive: false,
  code: true,

  parseHTML() {
    return [{ tag: "span[data-raw-inline]" }];
  },

  renderHTML() {
    return ["span", { class: "noten-raw-inline", "data-raw-inline": "", spellcheck: "false" }, 0];
  },

  markdownTokenName: RAW_INLINE,
  markdownTokenizer: {
    name: RAW_INLINE,
    level: "inline" as const,
    start: firstIndexOf("$"),
    tokenize: (src: string) => {
      const match = INLINE_MATH_AT_START.exec(src);
      return match && readsAsMath(match[0]) ? { type: RAW_INLINE, raw: match[0], text: match[0] } : undefined;
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.applyMark(RAW_INLINE, [helpers.createTextNode(token.raw ?? "")]);
  },

  renderMarkdown(node, helpers) {
    return node.content ? helpers.renderChildren(node.content) : "";
  },
});

const RAW_BRACKET = "rawBracket";

/** Footnote references, callout markers and linked images, read into `rawInline`. */
const RawBracketSyntax = Extension.create({
  name: RAW_BRACKET,
  markdownTokenName: RAW_BRACKET,
  markdownTokenizer: {
    name: RAW_BRACKET,
    level: "inline" as const,
    start: firstIndexOf("["),
    tokenize: (src: string) => {
      const match = BRACKET_SYNTAX_AT_START.exec(src);
      return match ? { type: RAW_BRACKET, raw: match[0], text: match[0] } : undefined;
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.applyMark(RAW_INLINE, [helpers.createTextNode(token.raw ?? "")]);
  },
});

/** `[ref]: url`, which marked reads as a `def` token and the stock parser drops. */
const RawLinkDefinition = Extension.create({
  name: "rawLinkDefinition",
  markdownTokenName: "def",
  parseMarkdown(token: MarkdownToken) {
    return rawBlock(String(token.raw ?? "").trimEnd(), "definition");
  },
});

export const RawMarkdown = Extension.create({
  name: "rawMarkdown",
  addExtensions() {
    return [RawBlock, RawInline, RawBracketSyntax, RawLinkDefinition];
  },
});
