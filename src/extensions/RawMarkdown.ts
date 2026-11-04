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
const INLINE_MATH_HERE = new RegExp(INLINE_MATH, "y");
const BRACKET_SYNTAX_HERE = new RegExp(`${FOOTNOTE_REFERENCE}|${CALLOUT_MARKER}`, "y");
// How far a math attempt reads before it needs its closer.
const INLINE_MATH_BODY_HERE = /\$(?![\s$])(?:\\[^\n]|[^$\\\n`])*/y;

function readHere(pattern: RegExp, text: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

/**
 * What the same text would be read as if it were written unescaped. Typing these
 * in the editor must save them as written, or the reload would read `$a\_b$`.
 *
 * Every `$` an attempt reads past is the second half of a `\$` pair. Starting from
 * one reaches the same stopping point and fails there the same way, so those are
 * skipped, or a line of `\$` after an unclosed `$` costs a scan per pair.
 */
function* syntaxInPlainText(text: string): Generator<[index: number, source: string]> {
  let attemptedUntil = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "[" && (character !== "$" || index < attemptedUntil)) continue;
    const source = readHere(character === "$" ? INLINE_MATH_HERE : BRACKET_SYNTAX_HERE, text, index);
    if (source) {
      yield [index, source];
      index += source.length - 1;
    } else if (character === "$") {
      attemptedUntil = index + (readHere(INLINE_MATH_BODY_HERE, text, index)?.length ?? 0);
    }
  }
}

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
const EMPTY_ELEMENT = /<\s*([a-zA-Z][\w-]*)[^>]*>\s*<\/\s*\1\s*>/;
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
  let open = 0;
  for (const [tag, rawName, attributes] of html.matchAll(HTML_TAG)) {
    sawTag = true;
    const name = rawName.toLowerCase();
    if (name === "img" && !/\bsrc\s*=/i.test(attributes)) return false;
    if (name !== "br" && name !== "img") open += /^<\s*\//.test(tag) ? -1 : tag.endsWith("/>") ? 2 : 1;
    if (name === "a") sawLink = true;
    if (name === "img") sawImage = true;
    const kept = KEPT_ATTRIBUTES[name];
    if (!kept && !FORMATTING_TAGS.has(name)) return false;
    for (const [, attribute] of attributes.matchAll(HTML_ATTRIBUTE)) {
      if (!kept?.has(attribute.toLowerCase())) return false;
    }
  }
  // A tag with nothing to apply to would just be deleted, as in `the <b> tag`, so a
  // lone one, a self-closed one or an empty pair stays. And the image would survive
  // where the link around it would not.
  return sawTag && open === 0 && !EMPTY_ELEMENT.test(html) && !(sawLink && sawImage);
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
    for (const [index, source] of syntaxInPlainText(text)) {
      if (!readsAsMath(source)) continue;
      output += encodePlain(text.slice(cursor, index)) + source;
      cursor = index + source.length;
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

const BARE_MATH_FENCE = /^ {0,3}\$\$\s*$/;
// A blank line or one that opens a block, as far as this can tell: a rule, a table
// delimiter or a setext underline, then a heading, quote, fence, list marker or tag.
const ENDS_A_PARAGRAPH =
  /^ {0,3}(?:[-=_*:|\s]*$|#{1,6}(?:\s|$)|>|`{3}|~{3}|(?:[*+-]|[a-zA-Z\d]+[.)])(?:\s|$)|<[a-zA-Z/!?])/;
const BLOCK_ON_ITS_FIRST_LINE = /^(?: {4}| {0,3}\t| {0,3}\[[^\]\n]*\]:)/;

/**
 * The paragraph above a `$$` line, when that line ends it. Only a bare fence with
 * its closer does: a `$$a$$` line stays inline math, so saving does not split its
 * paragraph. Unsure lines stop the search, which leaves the paragraph whole, and
 * they keep a note without blank lines linear: a paragraph that is not cut here is
 * taken whole by the lexer, so each line is read once.
 */
function paragraphBeforeMath(src: string): string | undefined {
  if (FENCED_MATH_OPEN.test(src)) return undefined;
  let cursor = lineEnd(src, 0);
  const firstLine = src.slice(0, cursor);
  if (ENDS_A_PARAGRAPH.test(firstLine.trimEnd()) || BLOCK_ON_ITS_FIRST_LINE.test(firstLine)) return undefined;
  while (cursor < src.length) {
    const end = lineEnd(src, cursor);
    const line = src.slice(cursor, end);
    if (BARE_MATH_FENCE.test(line)) return fencedMathLength(src.slice(cursor)) > 0 ? src.slice(0, cursor) : undefined;
    if (ENDS_A_PARAGRAPH.test(line.trimEnd())) return undefined;
    cursor = end;
  }
  return undefined;
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

const PARAGRAPH_BEFORE_MATH = "paragraphBeforeMath";

/**
 * Math is often written right under a line of text, where its lines read as text
 * and gain backslashes. This takes the paragraph above it, so the next block starts
 * at the `$$`. Cutting the paragraph through a tokenizer's `start` instead leaves
 * marked's setext rule reading the rest of a note without blank lines at each cut.
 * The inline text is lexed at parse time, when every reference definition is known.
 */
const ParagraphBeforeMath = Extension.create({
  name: PARAGRAPH_BEFORE_MATH,
  markdownTokenName: PARAGRAPH_BEFORE_MATH,
  markdownTokenizer: {
    name: PARAGRAPH_BEFORE_MATH,
    level: "block" as const,
    start: () => -1,
    tokenize: (src: string) => {
      const raw = paragraphBeforeMath(src);
      return raw ? { type: PARAGRAPH_BEFORE_MATH, raw, text: raw.slice(0, -1) } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken, helpers) {
    const text = String(token.text ?? "");
    return helpers.parseChildren([{ type: "paragraph", raw: token.raw, text, tokens: helpers.tokenizeInline?.(text) ?? [] }]);
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
    return [RawBlock, RawInline, RawBracketSyntax, ParagraphBeforeMath, RawLinkDefinition];
  },
});
