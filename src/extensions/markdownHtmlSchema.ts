import { elementFromString, getSchema, type AnyExtension, type JSONContent, type MarkdownToken } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { DOMParser, type Schema } from "@tiptap/pm/model";

type ParseResult = JSONContent | JSONContent[] | null;

interface HtmlTokenParser {
  baseExtensions: AnyExtension[];
  parseHTMLToken(token: MarkdownToken): ParseResult;
  isUnrecognizedHtml(html: string): boolean;
  toInlineContent(content: JSONContent[]): JSONContent[];
}

const STOCK = Symbol.for("noten.stockParseHTMLToken");
const proto = MarkdownManager.prototype as unknown as HtmlTokenParser & {
  [STOCK]?: HtmlTokenParser["parseHTMLToken"];
};

/**
 * `@tiptap/markdown`'s own `parseHTMLToken`, kept for the equivalence test. It
 * is stored on the prototype so re-evaluating this module (HMR) never mistakes
 * the patch for the original.
 */
export const stockParseHTMLToken = (proto[STOCK] ??= proto.parseHTMLToken);

// A manager's extensions are fixed at construction, so its schema is too.
const schemas = new WeakMap<AnyExtension[], Schema>();

function schemaFor(extensions: AnyExtension[]): Schema {
  let schema = schemas.get(extensions);
  if (!schema) {
    schema = getSchema(extensions);
    schemas.set(extensions, schema);
  }
  return schema;
}

/**
 * `parseHTMLToken` with the schema built once per manager.
 *
 * The stock method calls `generateJSON(html, extensions)` for every HTML
 * token, and `generateJSON` rebuilds the whole schema each time, which also
 * throws away the DOM parser ProseMirror caches on it. Every sized image is
 * saved as `<img>` HTML, so a note with 200 of them rebuilt the schema 200
 * times on load (0.7 ms each of a ~2.5 ms token). This is `generateJSON` with
 * that one step cached: the same `elementFromString` document and the same
 * parseHTML rules, so the JSON is identical.
 *
 * Transcribed from `@tiptap/markdown` 3.31.3; the guard cases (blank or
 * unrecognized HTML) stay on the stock method. `markdownHtmlSchema.test.ts`
 * compares both on every kind of HTML token, and fails when an upgrade changes
 * what the stock method does after parsing.
 */
function parseHTMLToken(this: HtmlTokenParser, token: MarkdownToken): ParseResult {
  const html = token.text || token.raw || "";
  if (!html.trim() || this.isUnrecognizedHtml(html)) return stockParseHTMLToken.call(this, token);

  try {
    const dom = elementFromString(html);
    const parsed = DOMParser.fromSchema(schemaFor(this.baseExtensions)).parse(dom).toJSON() as JSONContent;
    if (parsed.type === "doc" && parsed.content) {
      if (token.block) return parsed.content;
      const inlineContent = this.toInlineContent(parsed.content);
      return inlineContent.length > 0 ? inlineContent : null;
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse HTML in markdown: ${error}`);
  }
}

proto.parseHTMLToken = parseHTMLToken;
