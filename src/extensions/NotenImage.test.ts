import { describe, it, expect, afterEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import { NotenImage } from "./NotenImage";
import { NotenTable } from "./NotenTable";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function load(markdown: string): Editor {
  editor?.destroy();
  editor = new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ marked: createFastMarked() }),
      NotenImage,
      NotenTable,
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: markdown,
    contentType: "markdown",
  } as ConstructorParameters<typeof Editor>[0]);
  return editor;
}

function images(node: JSONContent): Record<string, unknown>[] {
  const own = node.type === "image" ? [node.attrs ?? {}] : [];
  return own.concat((node.content ?? []).flatMap(images));
}

const SIZED = '<img src=".assets/n/a.png" alt="a" width="320" height="200" />';

describe("NotenImage inline <img> tags", () => {
  it("keeps a sized image in a table cell across a reload", () => {
    const markdown = `| Image | Note |\n| --- | --- |\n| ${SIZED} | text |`;
    const first = load(markdown);
    expect(images(first.getJSON())).toHaveLength(1);
    const saved = first.getMarkdown();
    expect(saved).toContain(SIZED);
    expect(load(saved).getMarkdown()).toBe(saved);
  });

  it("keeps an image the editor put in a table cell", () => {
    const first = load("x");
    first.commands.setContent({
      type: "doc",
      content: [{
        type: "table",
        content: [
          { type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph" }] }] },
          {
            type: "tableRow",
            content: [{
              type: "tableCell",
              content: [{ type: "image", attrs: { src: ".assets/n/a.png", alt: "a", width: 560, height: 315 } }],
            }],
          },
        ],
      }],
    });
    const saved = first.getMarkdown();
    expect(images(load(saved).getJSON())).toHaveLength(1);
    expect(editor!.getMarkdown()).toBe(saved);
  });

  it("keeps an image between words of a paragraph", () => {
    const markdown = `Before ${SIZED} after`;
    const loaded = load(markdown);
    expect(images(loaded.getJSON())).toHaveLength(1);
    expect(loaded.getMarkdown().trim()).toBe(markdown);
  });

  it.each([
    ["a link", `<a href="https://x.test">${SIZED}</a>`],
    ["a span beside text", `<span>${SIZED} caption</span> after`],
    ["a link inside a table cell", `| h |\n| --- |\n| <a href="https://x.test">${SIZED}</a> |`],
  ])("keeps an image wrapped in %s", (_, markdown) => {
    const loaded = load(markdown);
    expect(images(loaded.getJSON())).toHaveLength(1);
    expect(loaded.getMarkdown()).toContain(SIZED);
  });

  it("reads an inline tag exactly as a standalone one", () => {
    const tag = `<IMG SRC='x.png' ALT="a > b" width="40" onerror="alert(1)">`;
    const standalone = images(load(tag).getJSON());
    expect(standalone).toHaveLength(1);
    expect(images(load(`A ${tag} b`).getJSON())).toEqual(standalone);
  });

  it("keeps the text around a tag Markdown does not read as HTML", () => {
    const markdown = `<img src="cat.png" alt='cat's toy' width="200"> is my cat's favourite <b>ball</b>`;
    expect(load(markdown).getMarkdown()).toContain("is my cat's favourite");
  });

  it("leaves a tag without src, and code, to the stock paths", () => {
    const loaded = load("A <img alt=\"none\"> b `<img src=\"x.png\">`");
    expect(images(loaded.getJSON())).toHaveLength(0);
    expect(loaded.getMarkdown()).toContain('`<img src="x.png">`');
  });
});
