import type { MarkdownToken, MarkdownTokenizer } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { serializeImageMarkdown } from "../utils/imageMarkdownSerialize";
import { firstIndexOf } from "./fastMarkdownLexer";

// One HTML `<img>` tag. A quoted attribute value may itself contain `>`.
const IMG_TAG = /^<img(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/i;

/**
 * Lex an inline HTML `<img>` tag as the same `image` token `![alt](src)`
 * produces.
 *
 * A sized image is saved as `<img … width="…" />` (see `serializeImageMarkdown`),
 * and inside a table row, or mid-paragraph in a hand-written note, that tag is
 * inline HTML. `@tiptap/markdown` keeps only the schema's inline nodes from
 * inline HTML, and Image is a block node, so the tag parsed to nothing: the
 * image vanished on load and the next save wrote the note without it. Claiming
 * the tag before marked's HTML tokenizer sends it down the Markdown image path
 * instead, where it lands exactly where `![alt](src)` would.
 *
 * A tag without `src` is left to the stock HTML path, since Image's parseHTML
 * rule (`img[src]`) would not match it either. The tag is read through an
 * inert `<template>`, so nothing is fetched and no handler attribute runs, and
 * only the attributes Image declares survive, as they would through parseHTML.
 */
const htmlImageTokenizer: MarkdownTokenizer = {
  name: "htmlImage",
  level: "inline",
  start: firstIndexOf("<img"),
  tokenize: (src) => {
    const match = IMG_TAG.exec(src);
    if (!match) return undefined;
    const template = document.createElement("template");
    template.innerHTML = match[0];
    const img = template.content.firstElementChild;
    if (!img?.hasAttribute("src")) return undefined;
    return {
      type: "image",
      raw: match[0],
      href: img.getAttribute("src"),
      text: img.getAttribute("alt") ?? undefined,
      title: img.getAttribute("title"),
      width: img.getAttribute("width"),
      height: img.getAttribute("height"),
    };
  },
};

/**
 * The image node as Noten reads and writes it in Markdown. Base64 sources stay
 * allowed for legacy notes, which are migrated to `.assets/` on startup.
 */
export const NotenImage = Image.configure({ allowBase64: true }).extend({
  markdownTokenizer: htmlImageTokenizer,

  parseMarkdown(token: MarkdownToken, helpers) {
    return helpers.createNode("image", {
      src: token.href,
      alt: token.text,
      title: token.title,
      width: token.width ?? null,
      height: token.height ?? null,
    });
  },

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
