import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, type JSONContent } from "@tiptap/core";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { common, createLowlight } from "lowlight";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import MermaidCodeBlock from "./MermaidCodeBlock";
import NotenTable from "./NotenTable";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import WikiLink from "./WikiLink";
import { normalizeFragmentHref } from "../utils/headingSlug";
import { serializeImageMarkdown } from "../utils/imageMarkdownSerialize";
import { isSafeLinkHref } from "../utils/linkHref";
import { stripTableCellNbsp } from "../utils/tableCellNbsp";

const lowlight = createLowlight(common);
const fastMarked = createFastMarked();

const fixtureNames = [
  "kitchen-sink.md",
  "list-boundaries.md",
  "images-and-tables.md",
  "international-and-links.md",
] as const;

function readFixture(name: (typeof fixtureNames)[number]): string {
  const path = join(process.cwd(), "src", "extensions", "__fixtures__", "markdown", name);
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trimEnd();
}

function createMarkdownEditor(content: string): Editor {
  return new Editor({
    extensions: [
      NotenStarterKit.configure({ codeBlock: false, underline: false, link: false }),
      Markdown.configure({ marked: fastMarked }),
      CodeSpanFence,
      Link.configure({
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        defaultProtocol: "https",
        isAllowedUri: (url, { defaultValidate }) =>
          defaultValidate(url) && isSafeLinkHref(url),
      }),
      MermaidCodeBlock.configure({ lowlight }),
      Image.configure({ allowBase64: true }).extend({
        renderMarkdown(node) {
          return serializeImageMarkdown({
            src: node.attrs?.src,
            alt: node.attrs?.alt,
            title: node.attrs?.title,
            width: node.attrs?.width,
            height: node.attrs?.height,
          });
        },
      }),
      Placeholder.configure({ placeholder: "Start writing" }),
      Typography,
      Underline,
      TaskList,
      TaskItem.configure({ nested: true }),
      NotenTable,
      TableRow,
      TableCell,
      TableHeader,
      WikiLink,
    ],
    content,
    contentType: "markdown",
  } as ConstructorParameters<typeof Editor>[0]);
}

function stableMarkdown(editor: Editor): string {
  return stripTableCellNbsp(editor.getMarkdown()).trimEnd();
}

function descendants(node: JSONContent): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (current: JSONContent) => {
    out.push(current);
    current.content?.forEach(visit);
  };
  visit(node);
  return out;
}

function countNodes(doc: JSONContent, type: string): number {
  return descendants(doc).filter((node) => node.type === type).length;
}

function hasMark(doc: JSONContent, type: string): boolean {
  return descendants(doc).some((node) => node.marks?.some((mark) => mark.type === type));
}

function textContent(node: JSONContent): string {
  if (node.text) return node.text;
  return node.content?.map(textContent).join("") ?? "";
}

// Split a table row the way GFM does, before any inline parsing: every `|`
// behind an even run of backslashes is a delimiter, and `\|` becomes `|`.
// Noten's own tokenizer reads code spans as atomic, so reloading in Noten
// alone cannot show whether GitHub would see the same cells.
function gfmRowCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let backslashes = 0;
  for (const ch of line.trim().replace(/^\|/, "")) {
    if (ch === "|" && backslashes % 2 === 0) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
    backslashes = ch === "\\" ? backslashes + 1 : 0;
  }
  if (cell.trim() !== "") cells.push(cell);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

function tableRowLines(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.trimStart().startsWith("|"));
}

function tableCells(doc: JSONContent): JSONContent[][] {
  const table = descendants(doc).find((node) => node.type === "table");
  return (table?.content ?? []).map((row) => row.content ?? []);
}

describe("Markdown fixture round-trip compatibility", () => {
  const editors: Editor[] = [];
  const docWithElementFromPoint = document as unknown as {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  let originalElementFromPoint: ((x: number, y: number) => Element | null) | undefined;

  beforeAll(() => {
    originalElementFromPoint = docWithElementFromPoint.elementFromPoint;
    docWithElementFromPoint.elementFromPoint =
      docWithElementFromPoint.elementFromPoint ?? (() => document.body);
  });

  afterAll(() => {
    if (originalElementFromPoint) {
      docWithElementFromPoint.elementFromPoint = originalElementFromPoint;
    } else {
      delete docWithElementFromPoint.elementFromPoint;
    }
  });

  afterEach(() => {
    while (editors.length > 0) editors.pop()!.destroy();
  });

  function trackedEditor(markdown: string): Editor {
    const editor = createMarkdownEditor(markdown);
    editors.push(editor);
    return editor;
  }

  it.each(fixtureNames)("%s reaches a stable markdown representation after reload", (name) => {
    const first = trackedEditor(readFixture(name));
    const firstMarkdown = stableMarkdown(first);

    const second = trackedEditor(firstMarkdown);
    const secondMarkdown = stableMarkdown(second);

    expect(secondMarkdown).toBe(firstMarkdown);
  });

  it("preserves Noten-specific structures in the kitchen-sink fixture", () => {
    const editor = trackedEditor(readFixture("kitchen-sink.md"));
    const doc = editor.getJSON();

    expect(countNodes(doc, "taskList")).toBeGreaterThanOrEqual(1);
    expect(countNodes(doc, "taskItem")).toBeGreaterThanOrEqual(3);
    expect(countNodes(doc, "table")).toBe(1);
    expect(countNodes(doc, "image")).toBe(2);
    expect(hasMark(doc, "wikiLink")).toBe(true);

    const mermaidBlocks = descendants(doc).filter(
      (node) => node.type === "codeBlock" && node.attrs?.language === "mermaid",
    );
    expect(mermaidBlocks).toHaveLength(1);
    expect(textContent(mermaidBlocks[0])).toContain("flowchart TD");

    const markdown = stableMarkdown(editor);
    expect(markdown).toContain("[[Project Alpha]]");
    expect(markdown).toContain(".assets/note-kitchen/asset-image.png");
    expect(markdown).toContain('width="560"');
  });

  it("parses ordered-list boundary fixtures without swallowing following blocks", () => {
    const editor = trackedEditor(readFixture("list-boundaries.md"));
    const doc = editor.getJSON();
    const allText = textContent(doc);

    expect(countNodes(doc, "heading")).toBeGreaterThanOrEqual(2);
    expect(countNodes(doc, "codeBlock")).toBe(1);
    expect(countNodes(doc, "horizontalRule")).toBe(1);
    expect(countNodes(doc, "bulletList")).toBeGreaterThanOrEqual(2);
    expect(allText).toContain("Heading should not be swallowed");
    expect(allText).toContain("Top-level bullet after ordered list");
  });

  it("keeps table cells, sized images, and escaped image metadata round-trippable", () => {
    const editor = trackedEditor(readFixture("images-and-tables.md"));
    const doc = editor.getJSON();
    const images = descendants(doc).filter((node) => node.type === "image");
    const markdown = stableMarkdown(editor);

    expect(countNodes(doc, "table")).toBe(1);
    expect(images.length).toBeGreaterThanOrEqual(3);
    expect(images.some((node) => String(node.attrs?.src ?? "").includes("file with spaces"))).toBe(true);
    expect(markdown).toContain('width="320"');
    expect(markdown).toContain('width="480"');
    expect(markdown).not.toContain("&nbsp;");
  });

  it("preserves a table cell that documents &nbsp; in inline code (P2-2)", () => {
    const source = [
      "| Entity | Meaning |",
      "| --- | --- |",
      "| `&nbsp;` | non-breaking space |",
    ].join("\n");

    const first = trackedEditor(source);
    const firstMarkdown = stableMarkdown(first);

    // The documented entity must survive the save path...
    expect(firstMarkdown).toContain("`&nbsp;`");
    expect(firstMarkdown).toContain("non-breaking space");

    // ...and remain stable across a full reload (the load path strips too).
    const second = trackedEditor(firstMarkdown);
    const secondMarkdown = stableMarkdown(second);
    expect(secondMarkdown).toBe(firstMarkdown);
    expect(secondMarkdown).toContain("`&nbsp;`");

    // The code mark is preserved in the document model, not flattened to text.
    expect(hasMark(second.getJSON(), "code")).toBe(true);
  });

  it("keeps empty table cells clean without leaking a visible &nbsp;", () => {
    const source = [
      "| Image | Description |",
      "| --- | --- |",
      "|  | empty leading cell |",
    ].join("\n");

    const editor = trackedEditor(source);
    const markdown = stableMarkdown(editor);

    expect(markdown).not.toContain("&nbsp;");
    expect(markdown).toContain("empty leading cell");

    // Idempotent across reload.
    const second = trackedEditor(markdown);
    expect(stableMarkdown(second)).toBe(markdown);
  });

  it("keeps code-span pipes inside one table cell", () => {
    const source = [
      "| Expression | Meaning |",
      "| --- | --- |",
      "| `a || b` | logical OR |",
    ].join("\n");

    const first = trackedEditor(source);
    const table = descendants(first.getJSON()).find((node) => node.type === "table");
    const bodyRow = table?.content?.[1];
    expect(bodyRow?.content).toHaveLength(2);
    expect(textContent(bodyRow!.content![0])).toBe("a || b");
    expect(hasMark(bodyRow!.content![0], "code")).toBe(true);

    const markdown = stableMarkdown(first);
    const second = trackedEditor(markdown);
    expect(stableMarkdown(second)).toBe(markdown);
    expect(textContent(second.getJSON())).toContain("a || b");
  });

  it.each([
    { name: "a doubled pipe in code", cell: "`a || b`", code: true, text: "a || b", out: "`a \\|\\| b`" },
    { name: "an escaped pipe in code", cell: "`x \\| y`", code: true, text: "x | y", out: "`x \\| y`" },
    { name: "an escaped pipe in plain text", cell: "a \\| b", code: false, text: "a | b", out: "a \\| b" },
    { name: "a pipe after two backslashes in code", cell: "`a\\\\\\|b`", code: true, text: "a\\\\|b", out: "`a\\\\\\|b`" },
    { name: "a pipe after a backslash in plain text", cell: "a\\\\\\|b", code: false, text: "a\\|b", out: "a\\\\\\|b" },
  ])("serializes $name so GFM keeps the table's cells", ({ cell, code, text, out }) => {
    const source = ["| a | b |", "| --- | --- |", `| ${cell} | z |`].join("\n");

    const first = trackedEditor(source);
    const firstCell = tableCells(first.getJSON())[1][0];
    expect(textContent(firstCell)).toBe(text);
    expect(hasMark(firstCell, "code")).toBe(code);

    const markdown = stableMarkdown(first);
    expect(markdown).toContain(out);
    const rows = tableRowLines(markdown);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(gfmRowCells(row)).toHaveLength(2);
    const [bodyFirst, bodySecond] = gfmRowCells(rows[2]);
    expect(bodyFirst).toBe(code ? `\`${text}\`` : text.replace(/\\/g, "\\\\"));
    expect(bodySecond).toBe("z");

    const second = trackedEditor(markdown);
    const reloadedCells = tableCells(second.getJSON());
    expect(reloadedCells[1]).toHaveLength(2);
    expect(textContent(reloadedCells[1][0])).toBe(text);
    expect(hasMark(reloadedCells[1][0], "code")).toBe(code);
    expect(stableMarkdown(second)).toBe(markdown);
    expect(stableMarkdown(trackedEditor(stableMarkdown(second)))).toBe(markdown);
  });

  it("escapes pipes in header cells too", () => {
    const source = ["| `a|b` | c |", "| --- | --- |", "| 1 | 2 |"].join("\n");

    const first = trackedEditor(source);
    expect(textContent(tableCells(first.getJSON())[0][0])).toBe("a|b");

    const markdown = stableMarkdown(first);
    expect(markdown).toContain("`a\\|b`");
    for (const row of tableRowLines(markdown)) expect(gfmRowCells(row)).toHaveLength(2);

    const second = trackedEditor(markdown);
    expect(textContent(tableCells(second.getJSON())[0][0])).toBe("a|b");
    expect(stableMarkdown(second)).toBe(markdown);
  });

  it.each([
    { name: "one backtick", source: "x ``a`b`` y", text: "a`b", out: "x ``a`b`` y" },
    { name: "a run of two backticks", source: "```a``b```", text: "a``b", out: "```a``b```" },
    { name: "a leading backtick", source: "`` `a ``", text: "`a", out: "`` `a ``" },
    { name: "a trailing backtick", source: "`` a` ``", text: "a`", out: "`` a` ``" },
    { name: "nothing but backticks", source: "` `` `", text: "``", out: "``` `` ```" },
    { name: "a backtick under a bold mark", source: "**``a`b``**", text: "a`b", out: "**``a`b``**" },
    { name: "no backtick", source: "`a b`", text: "a b", out: "`a b`" },
  ])("round-trips inline code holding $name", ({ source, text, out }) => {
    const first = trackedEditor(source);
    const codeText = (doc: JSONContent) =>
      descendants(doc)
        .filter((node) => node.marks?.some((mark) => mark.type === "code"))
        .map(textContent);
    expect(codeText(first.getJSON())).toEqual([text]);

    const markdown = stableMarkdown(first);
    expect(markdown).toBe(out);

    const second = trackedEditor(markdown);
    expect(codeText(second.getJSON())).toEqual([text]);
    expect(stableMarkdown(second)).toBe(markdown);
  });

  it("round-trips inline code holding a backtick inside a table cell", () => {
    const source = ["| a | b |", "| --- | --- |", "| ``a`|b`` | z |"].join("\n");

    const first = trackedEditor(source);
    const firstCell = tableCells(first.getJSON())[1][0];
    expect(textContent(firstCell)).toBe("a`|b");
    expect(hasMark(firstCell, "code")).toBe(true);

    const markdown = stableMarkdown(first);
    expect(markdown).toContain("``a`\\|b``");
    const rows = tableRowLines(markdown);
    for (const row of rows) expect(gfmRowCells(row)).toHaveLength(2);
    expect(gfmRowCells(rows[2])).toEqual(["``a`|b``", "z"]);

    const second = trackedEditor(markdown);
    const reloadedCell = tableCells(second.getJSON())[1][0];
    expect(textContent(reloadedCell)).toBe("a`|b");
    expect(hasMark(reloadedCell, "code")).toBe(true);
    expect(stableMarkdown(second)).toBe(markdown);
  });

  it("preserves a plain bullet nested under a task-list parent", () => {
    const source = [
      "- [ ] parent",
      "  - plain child",
      "  - [ ] task child",
    ].join("\n");

    const first = trackedEditor(source);
    const doc = first.getJSON();
    expect(textContent(doc)).toContain("parent");
    expect(textContent(doc)).toContain("plain child");
    expect(textContent(doc)).toContain("task child");
    expect(countNodes(doc, "bulletList")).toBeGreaterThanOrEqual(1);

    const markdown = stableMarkdown(first);
    const second = trackedEditor(markdown);
    expect(stableMarkdown(second)).toBe(markdown);
    expect(textContent(second.getJSON())).toContain("plain child");
  });

  it("does not parse a parenthesized phone number as an ordered list", () => {
    const source = "Call (216) 555-1234 tomorrow.";
    const editor = trackedEditor(source);
    const doc = editor.getJSON();

    expect(countNodes(doc, "orderedList")).toBe(0);
    expect(textContent(doc)).toBe(source);
  });

  it("round-trips hard breaks inside table cells as br tags", () => {
    const source = [
      "| Notes |",
      "| --- |",
      "| first line<br>second line |",
    ].join("\n");

    const first = trackedEditor(source);
    const markdown = stableMarkdown(first);
    expect(markdown).toContain("first line<br>second line");

    const second = trackedEditor(markdown);
    expect(stableMarkdown(second)).toBe(markdown);
    expect(countNodes(second.getJSON(), "hardBreak")).toBeGreaterThanOrEqual(1);
  });

  it("preserves intentional blank paragraphs after block elements", () => {
    const source = [
      "# Heading",
      "",
      "",
      "",
      "Paragraph after an intentional blank line.",
      "",
      "| A | B |",
      "| --- | --- |",
      "| one | two |",
      "",
      "",
      "",
      "Paragraph after the table gap.",
    ].join("\n");

    const first = trackedEditor(source);
    const firstDoc = first.getJSON();
    const emptyParagraphs = (firstDoc.content ?? []).filter(
      (node) => node.type === "paragraph" && (!node.content || node.content.length === 0),
    );
    expect(emptyParagraphs).toHaveLength(2);

    const markdown = stableMarkdown(first);
    const second = trackedEditor(markdown);
    expect(stableMarkdown(second)).toBe(markdown);
    const secondEmptyParagraphs = (second.getJSON().content ?? []).filter(
      (node) => node.type === "paragraph" && (!node.content || node.content.length === 0),
    );
    expect(secondEmptyParagraphs).toHaveLength(2);
  });

  it("round-trips anchor links with Hangul slug destinations verbatim", () => {
    // Anchor hrefs are stored as GitHub-style slugs precisely so the markdown
    // destination never needs encoding — guard that assumption end to end.
    const source = [
      "## 서론 개요",
      "",
      "본문입니다.",
      "",
      "[서론으로 이동](#서론-개요) 그리고 [go](#my-heading)",
    ].join("\n");

    const first = trackedEditor(source);
    const firstMarkdown = stableMarkdown(first);
    expect(firstMarkdown).toContain("[서론으로 이동](#서론-개요)");
    expect(firstMarkdown).toContain("[go](#my-heading)");

    const second = trackedEditor(firstMarkdown);
    expect(stableMarkdown(second)).toBe(firstMarkdown);
    expect(hasMark(second.getJSON(), "link")).toBe(true);
  });

  it("keeps malformed-percent anchor links with spaces across reload", () => {
    const href = normalizeFragmentHref("#broken%2 fragment");
    expect(href).toBe("#broken2-fragment");

    const source = [
      "## Broken%2 Fragment",
      "",
      `[go](${href})`,
    ].join("\n");

    const first = trackedEditor(source);
    const firstMarkdown = stableMarkdown(first);
    expect(firstMarkdown).toContain("[go](#broken2-fragment)");
    expect(hasMark(first.getJSON(), "link")).toBe(true);

    const second = trackedEditor(firstMarkdown);
    expect(stableMarkdown(second)).toBe(firstMarkdown);
    expect(hasMark(second.getJSON(), "link")).toBe(true);
  });

  it("preserves multilingual text, safe links, and wiki-link marks", () => {
    const editor = trackedEditor(readFixture("international-and-links.md"));
    const doc = editor.getJSON();
    const markdown = stableMarkdown(editor);

    expect(textContent(doc)).toContain("한국어 문장");
    expect(textContent(doc)).toContain("日本語");
    expect(textContent(doc)).toContain("نص عربي");
    expect(hasMark(doc, "wikiLink")).toBe(true);
    expect(markdown).toContain("[[한글 노트]]");
    expect(markdown).toContain("https://example.org/path?x=1");
  });
});
