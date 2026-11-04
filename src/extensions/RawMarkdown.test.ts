import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import IncrementalMarkdown from "./IncrementalMarkdown";
import { NotenImage } from "./NotenImage";
import { NotenTable } from "./NotenTable";
import NotenTaskList from "./NotenTaskList";
import { createNotenTaskItem } from "./NotenTaskItem";
import WikiLink from "./WikiLink";
import { RawMarkdown } from "./RawMarkdown";

const marked = createFastMarked();
let editors: Editor[] = [];
afterEach(() => {
  editors.forEach((editor) => editor.destroy());
  editors = [];
});

function load(markdown: string): Editor {
  const editor = new Editor({
    extensions: [
      NotenStarterKit.configure({ underline: false, link: false }),
      Markdown.configure({ marked }),
      CodeSpanFence,
      IncrementalMarkdown,
      Link.configure({ openOnClick: false }),
      Underline,
      NotenImage,
      NotenTable,
      TableRow,
      TableCell,
      TableHeader,
      NotenTaskList,
      createNotenTaskItem(() => "en"),
      WikiLink,
      RawMarkdown,
    ],
    content: markdown,
    contentType: "markdown",
  } as ConstructorParameters<typeof Editor>[0]);
  editors.push(editor);
  return editor;
}

const FRONT_MATTER = "---\ntitle: My note\ntags: [a, b]\n---";

const KEPT: [string, string][] = [
  ["front matter with a list and an indented value", "---\ntags:\n  - a\n- b\nk: v\n---\n\nbody"],
  ["front matter with Korean keys", "---\n제목: 회의록\n날짜: x\n---\n\nbody"],
  ["front matter with special keys", "---\n$schema: x\n@type: y\n---\n\nbody"],
  ["front matter with a block scalar", "---\nnote: |\n  one\n\n  two\nk: v\n---\n\nbody"],
  ["front matter with spaced-out keys", "---\na: 1\n\nb: 2\n---\n\nbody"],
  ["front matter and a body", `${FRONT_MATTER}\n\n본문`],
  ["a note that is only front matter", FRONT_MATTER],
  ["front matter with a comment line", "---\n# generated\nk: v\n---\n\nbody"],
  ["a block comment", "<!-- secret -->\n\npara"],
  ["a comment between paragraphs", "a\n\n<!-- c -->\n\nb"],
  ["a multi-line comment", "<!-- one\ntwo -->\n\nafter"],
  ["an inline comment", "a <!-- c --> b"],
  ["a div", '<div class="x">\n  <b>hi</b>\n</div>'],
  ["details", "<details>\n<summary>Sum</summary>\n\nbody\n\n</details>"],
  ["a script", "<script>alert(1)</script>"],
  ["kbd", "press <kbd>K</kbd> now"],
  ["a styled span", 'a <span style="color:red">b</span> c'],
  ["sub and mark", "H<sub>2</sub>O <mark>m</mark>"],
  ["a styled strong", 'a <strong style="color:red">b</strong> c'],
  ["an unused reference definition", "para\n\n[unused]: http://x.y"],
  ["a linked image", "[![a](b.png)](http://x.y)"],
  ["a linked image in a sentence", "see [![a](b.png)](http://x.y) here"],
  ["a footnote reference and definition", "Text[^1] more\n\n[^1]: The note"],
  ["a footnote definition with a continuation", "x\n\n[^n]: first\n    second\n\ny"],
  ["a callout", "> [!NOTE]\n> body"],
  ["inline math", "where $a_b$ and $x^2_i$ hold"],
  ["inline math with a backslash", "so $\\frac{a_1}{b}$ here"],
  ["block math", "$$\n\\frac{a_1}{b}\n$$"],
  ["single-line block math", "$$a_1$$"],
  ["display math inside a line", "text $$ a_b $$ more"],
  ["an anchor with an id", '<a id="foo"></a>'],
  ["a tag named in prose", "use the <code> tag and <b> tag"],
  ["a lone tag before Korean text", "<b> 태그"],
  ["an unclosed link tag", 'a <a href="u"> c'],
  ["a lone closing tag", "a </b> c"],
  ["an aligned image", '<img src="a.png" align="right">'],
  ["an entity", "&copy; 2026 &#169;"],
];

describe("Markdown without a model is saved as written", () => {
  it.each(KEPT)("keeps %s across repeated saves", (_, markdown) => {
    let saved = markdown;
    for (let round = 0; round < 3; round += 1) {
      saved = load(saved).getMarkdown();
      expect(saved.trim()).toBe(markdown);
    }
  });

  it.each(KEPT)("keeps %s after an edit elsewhere in the note", (_, markdown) => {
    const editor = load(`${markdown}\n\nlast`);
    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.insertText("!", end));
    expect(editor.getMarkdown().trim()).toBe(`${markdown}\n\nlast!`);
  });

  it("produces a valid document for each", () => {
    for (const [, markdown] of KEPT) {
      expect(() => load(markdown).state.doc.check(), markdown).not.toThrow();
    }
  });

  it("keeps front matter after a byte order mark", () => {
    // Compared untrimmed: String.prototype.trim removes a byte order mark.
    const markdown = "\uFEFF---\ntitle: x\n---\n\nbody";
    expect(load(markdown).getMarkdown()).toBe(markdown);
  });

  it("keeps a footnote reference in a table cell", () => {
    expect(load("| h |\n| --- |\n| x[^1] |").getMarkdown()).toContain("| x[^1] |");
  });

  it("repairs what an older save escaped", () => {
    expect(load("Text\\[^1\\]").getMarkdown()).toBe("Text[^1]");
    expect(load("> \\[!NOTE\\]\n> body").getMarkdown()).toBe("> [!NOTE]\n> body");
  });
});

describe("kept source inside a list item", () => {
  it.each([
    ["math", "$$\na_b\n$$", "1. \n   $$\n   a_b\n   $$"],
    ["a definition", "[a]: u", "1. \n   [a]: u"],
    ["a footnote", "[^1]: a_b", "1. \n   [^1]: a_b"],
    ["a multi-line div", "<div>\na\n</div>", "1. \n   <div>\n   a\n   </div>"],
  ])("keeps %s under an ordered item's empty first line", (_, source, saved) => {
    const editor = load("x");
    editor.commands.setContent({
      type: "doc",
      content: [{
        type: "orderedList",
        content: [{
          type: "listItem",
          content: [{ type: "paragraph" }, { type: "rawBlock", content: [{ type: "text", text: source }] }],
        }],
      }],
    });
    const first = editor.getMarkdown().trimEnd();
    expect(first).toBe(saved);
    expect(load(first).getMarkdown().trimEnd()).toBe(saved);
  });

  it.each([
    ["a comment", "1. a\n\n   <!-- c_d -->\n2. b"],
    ["a multi-line comment", "1. a\n\n   <!-- x\n\n   y -->\n2. b"],
    ["a bullet's definition", "- a\n\n  [r]: http://x_y"],
    ["math on the marker line", "- $$\n  x_y\n  $$\n- b"],
    ["a footnote on the marker line", "- [^1]: a"],
    ["a comment on the marker line", "- <!-- c_d -->"],
    ["a comment in a task item", "- [ ] a\n\n  <!-- c_d -->"],
  ])("does not change %s across saves", (_, markdown) => {
    const normal = (text: string) => text.replace(/^[ \t]+$/gm, "").trimEnd();
    let saved = markdown;
    for (let round = 0; round < 4; round += 1) {
      saved = load(saved).getMarkdown();
      expect(normal(saved)).toBe(markdown);
    }
    expect(JSON.stringify(load(saved).getJSON())).toContain('"rawBlock"');
  });
});

describe("what still reads as ordinary Markdown", () => {
  it.each([
    "---\n\ntext\n\n---",
    "---\nplain words\n---",
    "a\n\n---\nk: v\n---",
    "---",
    "---\n# Title\n\nbody **x**\n\n- a\n\n---\nafter",
    "---\n# only a comment\n---",
    "---\nNote: a sentence\nand another line\n---",
    "---\nNote: a sentence\n\nand a paragraph\n\n---",
    "---\n# Title\n\nk: v\n---",
  ])("does not read %j as front matter", (markdown) => {
    expect(JSON.stringify(load(markdown).getJSON())).not.toContain('"frontmatter"');
  });

  it.each([
    ["prices", "$5 and $6"],
    ["a price pair", "$5/$3"],
    ["a space inside", "$ a $"],
  ])("does not read %s as math", (_, markdown) => {
    expect(JSON.stringify(load(markdown).getJSON())).not.toContain('"rawInline"');
  });

  it.each([
    ["a code span holding a dollar", "set $HOME and `$PATH` here"],
    ["a link holding a dollar", "cost $5 and [link$](http://x.y) ok"],
    ["bold crossing a dollar", "$a **b$ c** d"],
    ["strike crossing a dollar", "$a ~~b$ c~~ d"],
  ])("keeps %s, not math", (_, markdown) => {
    let saved = markdown;
    for (let round = 0; round < 2; round += 1) {
      saved = load(saved).getMarkdown();
      expect(saved).toBe(markdown);
    }
    expect(JSON.stringify(load(markdown).getJSON())).not.toContain('"rawInline"');
  });

  it.each([
    ["$$ opener", "$$", "a"],
    ["footnote openers", "[^", ""],
    ["linked image openers", "[![a](", ""],
    ["callout openers", "[!", ""],
    ["dollars", "$a ", ""],
  ])("stays linear on a long line of %s", (_, repeated, tail) => {
    const measure = (count: number) => {
      const text = `${repeated.repeat(count)}${tail.repeat(count)}`;
      const start = performance.now();
      const editor = load(text);
      editor.getMarkdown();
      return performance.now() - start;
    };
    measure(200);
    const small = measure(4_000);
    const large = measure(32_000);
    // Eight times the text; quadratic would be 64.
    expect(large / small).toBeLessThan(25);
  }, 120_000);

  it.each([
    ["<u>x</u> y", "underline"],
    ["<strong>x</strong> y", "bold"],
    ["<em>x</em> y", "italic"],
    ['<a href="https://x.y">x</a> y', "link"],
  ])("still converts %j", (markdown, mark) => {
    const marks = JSON.stringify(load(markdown).getJSON());
    expect(marks).toContain(`"${mark}"`);
    expect(marks).not.toContain('"rawInline"');
  });

  it("still reads a sized image as an image", () => {
    const tag = '<img src=".assets/n/a.png" alt="a" width="320" height="200" />';
    expect(load(tag).getJSON().content?.[0]?.type).toBe("image");
  });

  it.each(["[a](http://x.y)", "![a](b.png)", "[^1](http://x.y)", "[!a](http://x.y)"])("still reads %j as a link or image", (markdown) => {
    expect(JSON.stringify(load(markdown).getJSON())).not.toContain('"rawInline"');
  });

  it("still resolves a reference link, keeping its definition", () => {
    const saved = load("[a][ref]\n\n[ref]: http://x.y").getMarkdown();
    expect(saved).toBe("[a](http://x.y)\n\n[ref]: http://x.y");
    expect(load(saved).getMarkdown()).toBe(saved);
  });

  it("does not run raw HTML", () => {
    const editor = load('<script>window.ran = true</script>\n\n<img src=x onerror="window.ran = true">');
    expect(editor.view.dom.querySelector("script")).toBeNull();
    expect(editor.view.dom.querySelector("pre.noten-raw-block")?.textContent).toContain("<script>");
  });
});

describe("typing that syntax in the editor", () => {
  function typed(text: string): string {
    const editor = load("x");
    editor.view.dispatch(editor.state.tr.insertText(text, 1, 2));
    return editor.getMarkdown();
  }

  it.each([
    ["$a_b$", "$a_b$"],
    ["see [^1] here", "see [^1] here"],
    ["[!NOTE] x", "[!NOTE] x"],
    ["&copy; x", "&copy; x"],
  ])("saves %j as written, and it reloads the same", (text, saved) => {
    expect(typed(text)).toBe(saved);
    expect(load(saved).getMarkdown()).toBe(saved);
    expect(load(saved).state.doc.textContent).toBe(text);
  });

  it.each([
    ["a_b", "a\\_b"],
    ["[a](b)", "\\[a\\](b)"],
    ["*a*", "\\*a\\*"],
    ["a < b & c", "a &lt; b &amp; c"],
    ["&amp;", "&amp;amp;"],
    ["$a_b and c_d", "$a\\_b and c\\_d"],
    ["$a_b$ and c_d", "$a_b$ and c\\_d"],
  ])("still escapes what would change meaning in %j", (text, saved) => {
    expect(typed(text)).toBe(saved);
    expect(load(saved).state.doc.textContent).toBe(text);
  });

  it("edits kept source as plain text", () => {
    const editor = load("$$\nx\n$$");
    editor.commands.setTextSelection(1);
    editor.view.dispatch(editor.state.tr.insertText("%% ", 1));
    expect(editor.getMarkdown().trimEnd()).toBe("%% $$\nx\n$$");
  });

  it.each([
    ["Backspace at the start of the paragraph below", "---\nk: v\n---\n\nbody", "body"],
    ["Backspace at the start of the source", "para\n\n<!-- c_d -->\n\nend", "<!-- c_d -->"],
  ])("does not join on %s", (_, markdown, line) => {
    const editor = load(markdown);
    let position = 0;
    editor.state.doc.descendants((node, pos) => {
      if (!position && node.isTextblock && node.textContent === line) position = pos + 1;
    });
    editor.commands.setTextSelection(position);
    editor.commands.first(({ commands }) => [() => commands.joinBackward(), () => commands.selectNodeBackward()]);
    expect(editor.getMarkdown().trimEnd()).toBe(markdown);
  });

  it("does not spread the inline mark onto text typed after it", () => {
    const editor = load("a $x$");
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    editor.commands.insertContent("_b");
    expect(editor.getMarkdown()).toBe("a $x$\\_b");
  });
});

describe("how kept source is shown", () => {
  it.each([
    [`${FRONT_MATTER}\n\nbody`, "frontmatter"],
    ["<!-- c -->", "comment"],
    ["<div>x</div>", "html"],
    ["$$\nx\n$$", "math"],
    ["[ref]: http://x.y", "definition"],
    ["[^1]: note", "footnote"],
  ])("marks %j as %s", (markdown, kind) => {
    expect(load(markdown).view.dom.querySelector(`pre[data-raw-kind="${kind}"]`)).not.toBeNull();
  });

  it("does not call a comment followed by text a comment", () => {
    const editor = load("<!-- todo --> **Important** text");
    expect(editor.view.dom.querySelector('pre[data-raw-kind="comment"]')).toBeNull();
    expect(editor.view.dom.querySelector('pre[data-raw-kind="html"]')).not.toBeNull();
  });

  it("copies between editors as the same node", () => {
    const html = load(`${FRONT_MATTER}\n\nsee $a_b$`).getHTML();
    const editor = load("x");
    editor.commands.setContent(html);
    expect(editor.getMarkdown().trim()).toBe(`${FRONT_MATTER}\n\nsee $a_b$`);
  });
});
