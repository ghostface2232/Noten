import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, type MarkdownToken } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { DOMParser } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";
import { createFastMarked } from "./fastMarkdownLexer";
import { stockParseHTMLToken } from "./markdownHtmlSchema";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import MermaidCodeBlock from "./MermaidCodeBlock";
import WikiLink from "./WikiLink";
import { NotenImage } from "./NotenImage";
import { NotenTable } from "./NotenTable";

type HtmlTokenParser = { parseHTMLToken(token: MarkdownToken): unknown };

const lowlight = createLowlight(common);
const proto = MarkdownManager.prototype as unknown as HtmlTokenParser;
const cachedParseHTMLToken = proto.parseHTMLToken;

let editors: Editor[] = [];
afterEach(() => {
  proto.parseHTMLToken = cachedParseHTMLToken;
  vi.restoreAllMocks();
  editors.forEach((editor) => editor.destroy());
  editors = [];
});

function load(markdown: string): Editor {
  const editor = new Editor({
    extensions: [
      NotenStarterKit.configure({ codeBlock: false, link: false }),
      Markdown.configure({ marked: createFastMarked() }),
      CodeSpanFence,
      Link.configure({ openOnClick: false }),
      MermaidCodeBlock.configure({ lowlight }),
      NotenImage,
      TaskList,
      TaskItem.configure({ nested: true }),
      NotenTable,
      TableRow,
      TableCell,
      TableHeader,
      WikiLink,
    ],
    content: markdown,
    contentType: "markdown",
  } as ConstructorParameters<typeof Editor>[0]);
  editors.push(editor);
  return editor;
}

function withStock<T>(run: () => T): T {
  proto.parseHTMLToken = stockParseHTMLToken;
  try {
    return run();
  } finally {
    proto.parseHTMLToken = cachedParseHTMLToken;
  }
}

const HTML = [
  '<img src="a.png" alt="a" width="320" height="200" />',
  "<IMG SRC='x.png' ALT=\"a > b\" onerror=\"alert(1)\">",
  '<img alt="no source">',
  '<a href="https://x.test"><img src="b.svg"></a>',
  "<span><img src=\"a.png\"> caption</span>",
  "<u>under</u>",
  "<b>unclosed",
  "<em>a</em> <strong>b</strong>",
  "<br>",
  "<sub>2</sub>",
  "<p>one</p><p>two</p>",
  "<div><img src=\"a.png\"><p>after</p></div>",
  "<table><tr><td>cell</td></tr></table>",
  "<ul><li>item</li></ul>",
  "<pre><code>x < y</code></pre>",
  "<details><summary>s</summary>body</details>",
  "<enter foo bar>",
  "<my-el>custom</my-el>",
  "<!-- comment -->",
  "   ",
  "<h2>heading</h2>",
];

describe("markdownHtmlSchema", () => {
  it("parses every kind of HTML token exactly as the stock method", () => {
    const manager = load("").markdown as unknown as HtmlTokenParser;
    for (const html of HTML) {
      for (const block of [true, false]) {
        const token = { type: "html", raw: html, text: html, block } as MarkdownToken;
        expect(manager.parseHTMLToken(token), `${block ? "block" : "inline"} ${html}`).toEqual(
          stockParseHTMLToken.call(manager, token),
        );
      }
    }
  });

  it("loads every Markdown fixture into the same document as the stock method", () => {
    const dir = join(process.cwd(), "src", "extensions", "__fixtures__", "markdown");
    const notes = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8"));
    notes.push(HTML.map((html) => `Inline ${html} text\n\n${html}\n\n| h |\n| --- |\n| ${html} |`).join("\n\n"));
    for (const markdown of notes) {
      expect(load(markdown).getJSON()).toEqual(withStock(() => load(markdown).getJSON()));
    }
  });

  it("builds a manager's schema once for all its HTML tokens", () => {
    const fromSchema = vi.spyOn(DOMParser, "fromSchema");
    const img = '<img src="a.png" width="3" />';
    load(`${img}\n\nText ${img} <u>u</u>\n\n| h |\n| --- |\n| ${img} |`);
    const schemas = new Set(fromSchema.mock.calls.map(([schema]) => schema));
    expect(fromSchema.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(schemas.size).toBe(1);
  });

  it("loads a note full of sized images faster than rebuilding the schema per image", () => {
    const img = '<img src=".assets/n/a.png" alt="a" width="560" height="315" />';
    const markdown = `${img}\n\n`.repeat(100) + "| a | b |\n| --- | --- |\n" + `| ${img} | t |\n`.repeat(100);
    const time = (run: () => unknown) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        run();
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    load(markdown);
    const cached = time(() => load(markdown));
    const stock = time(() => withStock(() => load(markdown)));
    // Relative, so machine speed does not matter. In Chromium the gap is ~9x;
    // jsdom's per-document selector setup, absent in WebView2, narrows it here.
    expect(stock / cached).toBeGreaterThan(1.5);
  }, 60_000);
});
