import { mergeAttributes, type JSONContent } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { MarkdownManager } from "@tiptap/markdown";
import { serializeImageMarkdown } from "../utils/imageMarkdownSerialize";

interface InlineHtmlFilter {
  toInlineContent(content: JSONContent[]): JSONContent[];
}

const KEEPS_IMAGES = Symbol.for("noten.inlineHtmlKeepsImages");

/**
 * Keep images when `@tiptap/markdown` reduces inline HTML to inline nodes.
 *
 * A sized image is saved as `<img … width="…" />` (see `serializeImageMarkdown`),
 * and inside a table row, between words, or wrapped in `<a>`/`<span>` that tag
 * is inline HTML. Since Tiptap 3.30 the manager parses such HTML with the
 * schema and keeps only its inline nodes (`toInlineContent`); Image is a block
 * node, so the image parsed to nothing and the next save deleted it. An image
 * is kept where it stands instead, exactly where `![alt](src)` would land.
 *
 * Every other node still goes through the stock filter, and the HTML is still
 * read by the schema's own parseHTML rules, so attributes match a standalone
 * `<img>`. The patch sits on the prototype because the Markdown extension
 * parses the editor's initial content inside its own onBeforeCreate, before
 * any later extension could reach the instance. `NotenImage.test.ts` fails if
 * a Tiptap upgrade renames the method or the images vanish again.
 */
function keepImagesInInlineHtml(): void {
  const proto = MarkdownManager.prototype as unknown as InlineHtmlFilter & { [KEEPS_IMAGES]?: true };
  const keepInline = proto.toInlineContent;
  if (typeof keepInline !== "function" || proto[KEEPS_IMAGES]) return;
  proto[KEEPS_IMAGES] = true;
  proto.toInlineContent = function (this: InlineHtmlFilter, content) {
    return content.flatMap((node) => (node.type === "image" ? [node] : keepInline.call(this, [node])));
  };
}

keepImagesInInlineHtml();

const INLINE_IMAGE = "inlineImage";

function inlineImagesInTextblocks(node: JSONContent): void {
  const inTextblock = node.type === "paragraph" || node.type === "heading";
  for (const child of node.content ?? []) {
    if (inTextblock && child.type === "image") child.type = INLINE_IMAGE;
    else inlineImagesInTextblocks(child);
  }
}

interface MarkdownParser {
  parse(markdown: string): JSONContent;
  nodeTypeRegistry: Map<string, unknown>;
}

const INLINES_IMAGES = Symbol.for("noten.parseInlinesImages");

/**
 * An image that shares a textblock with anything else is an inline node.
 *
 * A standalone `![a](b)` becomes the block `image`, but the parser also puts that
 * same block node inside a paragraph, which the schema forbids, for an image next
 * to text, beside another image, in a list item or in a table cell. ProseMirror
 * does not check content on load, so the note looks right until it is edited:
 * marks and some edits threw, and typing next to the image reparsed the paragraph
 * from the DOM and silently deleted the image. Noten's own insert and paste paths
 * produce those shapes. Splitting the paragraph around a block image would keep
 * the document valid but move the image onto its own line on the next save.
 */
function parseImagesInTextblocksAsInline(): void {
  const proto = MarkdownManager.prototype as unknown as MarkdownParser & { [INLINES_IMAGES]?: true };
  const parse = proto.parse;
  if (typeof parse !== "function" || proto[INLINES_IMAGES]) return;
  proto[INLINES_IMAGES] = true;
  proto.parse = function (this: MarkdownParser, markdown) {
    const doc = parse.call(this, markdown);
    if (this.nodeTypeRegistry.has(INLINE_IMAGE)) inlineImagesInTextblocks(doc);
    return doc;
  };
}

parseImagesInTextblocksAsInline();

const ImageNode = Image.configure({ allowBase64: true }).extend({
  renderMarkdown(node) {
    return serializeImageMarkdown({
      src: node.attrs?.src,
      alt: node.attrs?.alt,
      title: node.attrs?.title,
      width: node.attrs?.width,
      height: node.attrs?.height,
    });
  },
});

/**
 * An image inside a textblock. It reads and writes the same Markdown as the block
 * image. It is only ever made by the parse step above or copied from the editor:
 * a plain `<img>` and the image commands and input rule stay with the block node.
 */
export const NotenInlineImage = ImageNode.extend({
  name: INLINE_IMAGE,
  inline: true,
  group: "inline",
  draggable: false,
  // Never produced by the lexer; the `image` token stays with the block node.
  markdownTokenName: "notenInlineImage",

  parseHTML() {
    return [{ tag: "img[src][data-inline-image]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { "data-inline-image": "" })];
  },

  addCommands() {
    return {};
  },

  addInputRules() {
    return [];
  },
});

/**
 * The image node as Noten reads and writes it in Markdown. Base64 sources stay
 * allowed for legacy notes, which are migrated to `.assets/` on startup. Brings
 * the inline node along, since the parse step above needs it to be in the schema.
 */
export const NotenImage = ImageNode.extend({
  addExtensions() {
    return [NotenInlineImage];
  },
});
