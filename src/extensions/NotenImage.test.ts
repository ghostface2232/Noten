import { describe, it, expect, afterEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { NotenStarterKit } from "./CodeSpanFence";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import { NotenImage } from "./NotenImage";
import { NotenTable } from "./NotenTable";
import NotenTaskList from "./NotenTaskList";
import { createNotenTaskItem } from "./NotenTaskItem";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function load(markdown: string): Editor {
  editor?.destroy();
  editor = new Editor({
    extensions: [
      NotenStarterKit,
      Markdown.configure({ marked: createFastMarked() }),
      NotenImage,
      NotenTable,
      NotenTaskList,
      createNotenTaskItem(() => "en"),
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
  const own = node.type === "image" || node.type === "inlineImage" ? [node.attrs ?? {}] : [];
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

describe("an image sharing a textblock", () => {
  const SHAPES: [string, string][] = [
    ["between words", "before ![i](z.png) after"],
    ["beside another image", "![a](a.png) ![b](b.png)"],
    ["with a sized image between words", `before ${SIZED} after`],
    ["in a bullet item", "- ![a](a.png)"],
    ["after a bullet item's text", "- item ![a](a.png)"],
    ["in an ordered item", "1. ![a](a.png)"],
    ["in a heading", "# title ![a](a.png)"],
    ["alone in a table cell", "| h |\n| --- |\n| ![a](a.png) |"],
    ["beside text in a table cell", "| h |\n| --- |\n| x ![a](a.png) |"],
    ["in a quote with text", "> quote ![a](a.png)"],
  ];

  function firstTextPos(doc: Editor["state"]["doc"]): number | null {
    let found: number | null = null;
    doc.descendants((node, pos) => {
      if (found === null && node.isTextblock) found = pos + 1;
      return found === null;
    });
    return found;
  }

  it.each(SHAPES)("is a valid document %s", (_, markdown) => {
    const loaded = load(markdown);
    expect(() => loaded.state.doc.check()).not.toThrow();
    expect(images(loaded.getJSON()).length).toBeGreaterThan(0);
  });

  it.each(SHAPES)("round-trips %s unchanged", (_, markdown) => {
    const saved = load(markdown).getMarkdown();
    expect(load(saved).getMarkdown()).toBe(saved);
    expect(images(load(saved).getJSON()).length).toBeGreaterThan(0);
  });

  it.each(SHAPES)("takes typing, delete and marks %s and keeps the image", (_, markdown) => {
    const loaded = load(markdown);
    const count = images(loaded.getJSON()).length;
    const pos = firstTextPos(loaded.state.doc)!;

    expect(() => loaded.view.dispatch(loaded.state.tr.insertText("x", pos))).not.toThrow();
    expect(() => loaded.view.dispatch(loaded.state.tr.delete(pos, pos + 1))).not.toThrow();
    expect(() => {
      loaded.commands.selectAll();
      loaded.commands.toggleBold();
    }).not.toThrow();

    expect(() => loaded.state.doc.check()).not.toThrow();
    expect(images(loaded.getJSON())).toHaveLength(count);
  });

  it("keeps the image when Enter splits the line beside it", () => {
    const loaded = load("![a](a.png) ![b](b.png)");
    loaded.commands.setTextSelection(1);
    expect(() => loaded.commands.splitBlock()).not.toThrow();
    expect(() => loaded.state.doc.check()).not.toThrow();
    expect(images(loaded.getJSON())).toHaveLength(2);
  });

  it.each(["- ![a](a.png)", "1. ![a](a.png)", "- [ ] ![a](a.png)", "- x ![a](a.png)", "> ![a](a.png)"])(
    "writes %j back as it was",
    (markdown) => {
      expect(load(markdown).getMarkdown()).toBe(markdown);
    },
  );

  it("keeps an image the editor put in an empty list item on its marker line", () => {
    const loaded = load("x");
    loaded.commands.setContent({
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [{ type: "paragraph" }, { type: "image", attrs: { src: "a.png" } }],
        }],
      }],
    });
    const saved = loaded.getMarkdown();
    expect(saved.trimEnd()).toBe("- ![](a.png)");
    const types = JSON.stringify(load(saved).getJSON());
    expect(types).toContain("bulletList");
    expect(types).toContain("inlineImage");
  });

  it("stays a block image when it stands alone", () => {
    expect(load("![a](a.png)").getJSON().content?.[0]?.type).toBe("image");
    expect(load(SIZED).getJSON().content?.[0]?.type).toBe("image");
  });

  it("gives the block node the image commands", () => {
    const loaded = load("text");
    loaded.commands.setImage({ src: "b.png" });
    const types = (loaded.getJSON().content ?? []).map((node) => node.type);
    expect(types).toContain("image");
  });

  it("keeps a copied inline image inline and a pasted plain <img> a block", () => {
    const loaded = load("before ![i](z.png) after");
    const html = loaded.getHTML();
    expect(html).toContain("data-inline-image");
    loaded.commands.setContent(html);
    expect(loaded.getJSON().content?.[0]?.content?.some((node) => node.type === "inlineImage")).toBe(true);
    loaded.commands.setContent('<img src="p.png">');
    expect(loaded.getJSON().content?.[0]?.type).toBe("image");
  });
});
