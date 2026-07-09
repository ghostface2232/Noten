import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { common, createLowlight } from "lowlight";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import MermaidCodeBlock from "./MermaidCodeBlock";
import WikiLink from "./WikiLink";
import { serializeImageMarkdown } from "../utils/imageMarkdownSerialize";
import { isSafeLinkHref } from "../utils/linkHref";

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

function stripTableCellNbsp(md: string): string {
  return md.replace(/^\|[^\n]*\|[ \t]*$/gm, (line) =>
    line.replace(/&nbsp;/g, ""),
  );
}

function createMarkdownEditor(content: string): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false, underline: false, link: false }),
      Markdown.configure({ marked: fastMarked }),
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
      Table.configure({
        resizable: true,
        handleWidth: 6,
        cellMinWidth: 48,
        lastColumnResizable: false,
      }),
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
