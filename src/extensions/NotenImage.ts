import type { JSONContent } from "@tiptap/core";
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

/**
 * The image node as Noten reads and writes it in Markdown. Base64 sources stay
 * allowed for legacy notes, which are migrated to `.assets/` on startup.
 */
export const NotenImage = Image.configure({ allowBase64: true }).extend({
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
