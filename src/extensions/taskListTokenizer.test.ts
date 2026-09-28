import { describe, it, expect, afterAll } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import NotenTaskList from "./NotenTaskList";
import { taskItemContentIndent, tokenizeTaskList } from "./taskListTokenizer";

const editors: Editor[] = [];
afterAll(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

function createEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: [
      NotenStarterKit.configure({ underline: false, link: false }),
      Markdown.configure({ marked: createFastMarked() }),
      CodeSpanFence,
      NotenTaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: markdown,
    contentType: "markdown",
  } as ConstructorParameters<typeof Editor>[0]);
  editors.push(editor);
  return editor;
}

function save(markdown: string): string {
  return createEditor(markdown).getMarkdown().trimEnd();
}

function nodesOf(doc: JSONContent, type: string): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === type) out.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return out;
}

function textOf(doc: JSONContent): string {
  return nodesOf(doc, "text")
    .map((node) => node.text ?? "")
    .join("\n");
}

function checkedOf(doc: JSONContent): boolean[] {
  return nodesOf(doc, "taskItem").map((task) => task.attrs?.checked === true);
}

describe("lines under a task item", () => {
  // The stock tokenizer took every line indented past the marker as content
  // and sliced 2 columns from each, deleting what a shallower line held.
  it.each([
    ["- [ ] t1\n x", "x"],
    ["- [ ] t1\n\n after", "after"],
    ["- [ ] t1\n # heading", "heading"],
    ["- [ ] t1\n - bullet", "bullet"],
    ["  - [ ] t1\n   x", "x"],
  ])("keeps every character of %j", (markdown, word) => {
    const first = save(markdown);
    expect(first).toContain(word);
    expect(textOf(createEditor(first).getJSON()).split("\n").map((text) => text.trim())).toContain(word);
    expect(save(first)).toBe(first);
  });

  // CommonMark reads an item indented short of the previous item's content
  // column as its sibling; the stock one read it as the previous item's text.
  it.each([
    ["- [ ] t1\n - [x] t2", [false, true]],
    ["- [ ] t1\n  - [x] t2\n - [ ] t3", [false, true, false]],
    ["-  [ ] t1\n   - [x] t2\n  - [ ] t3", [false, true, false]],
    ["- [x] t1\n\n - [ ] t2", [true, false]],
  ] as const)("keeps every checkbox of %j", (markdown, checked) => {
    const editor = createEditor(markdown);
    expect(checkedOf(editor.getJSON())).toEqual(checked);
    expect(textOf(editor.getJSON())).not.toContain("[");
    const first = editor.getMarkdown().trimEnd();
    expect(checkedOf(createEditor(first).getJSON())).toEqual(checked);
    expect(save(first)).toBe(first);
  });

  // Obsidian indents with tabs. Counted as one column each, a tab fell short
  // of the content column: nesting was saved flat, a paragraph became
  // indented code, and a fence became code holding its own fence lines.
  it("measures tab indentation in columns", () => {
    const nested = createEditor("- [ ] a\n\t- [ ] b\n\t\t- [x] c").getJSON();
    expect(nodesOf(nested, "taskList")).toHaveLength(3);
    expect(checkedOf(nested)).toEqual([false, false, true]);
    expect(save("- [ ] a\n\t- [ ] b\n\t\t- [x] c")).toBe("- [ ] a\n  - [ ] b\n    - [x] c");

    const para = createEditor("- [ ] a\n\n\tpara").getJSON();
    expect(nodesOf(para, "codeBlock")).toHaveLength(0);
    expect(textOf(para)).toContain("para");

    const fence = createEditor("- [ ] a\n\t```\n\tcode\n\t\tdeeper\n\t```").getJSON();
    expect(nodesOf(fence, "codeBlock").map((block) => block.content?.[0].text)).toEqual(["code\n\tdeeper"]);
  });

  it("ends the list at a line short of the content column after a blank line", () => {
    const doc = createEditor("- [ ] t1\n\n after").getJSON();
    expect(doc.content?.map((node) => node.type)).toEqual(["taskList", "paragraph"]);
  });

  it.each([
    "- [ ] t1\n  - [x] t2\n    - [ ] t3\n- [ ] t4",
    "- [ ] t1\n\n  para\n- [x] t2",
    "- [ ] t1\n  ```\n  code\n  ```",
  ])("round-trips %j byte for byte", (markdown) => {
    expect(save(markdown)).toBe(markdown);
  });

  it("reads the content column the way CommonMark does", () => {
    expect(taskItemContentIndent("- [ ] x")).toBe(2);
    expect(taskItemContentIndent("  * [x] x")).toBe(4);
    expect(taskItemContentIndent("-  [ ] x")).toBe(3);
    expect(taskItemContentIndent("-      [ ] x")).toBe(2);
    expect(taskItemContentIndent("- plain")).toBeNull();
  });
});

describe("tokenizeTaskList against the stock tokenizer", () => {
  const stock = TaskList.config.markdownTokenizer!.tokenize;
  const manager = createEditor("").markdown as unknown as {
    createLexer(): unknown;
    createTokenizerHelpers(lexer: unknown): Parameters<typeof tokenizeTaskList>[2];
  };
  const helpers = () => manager.createTokenizerHelpers(manager.createLexer());

  function lcg(seed: number) {
    return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  }

  // With one space after every marker and every line at an even indent, no
  // line falls between an item's marker and its content column, which is the
  // only place the two differ: the tokens must be identical.
  it("matches exactly where no line falls short of the content column (seeded fuzz)", () => {
    const random = lcg(7);
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const lines = [
      "- [ ] one", "- [x] two", "* [X] star", "  - [ ] nested", "    - [x] deep", "  text", "    more",
      "      code", "  - bullet", "  # heading", "  > quote", "  ```", "text", "- bullet", "# heading", "", "  ",
    ];
    for (let n = 0; n < 1500; n++) {
      const src = Array.from({ length: 1 + Math.floor(random() * 10) }, () => pick(lines)).join("\n");
      const expected = stock(src, [], helpers() as never);
      const actual = tokenizeTaskList(src, [], helpers());
      expect(JSON.parse(JSON.stringify(actual ?? null)), JSON.stringify(src)).toEqual(
        JSON.parse(JSON.stringify(expected ?? null)),
      );
    }
  });

  // Anywhere else, no word is lost, on the first save or the next. A save is
  // not always a fixed point: a paragraph after an indented item keeps its
  // leading spaces and reloads as that item's content, which stock Tiptap
  // does too.
  it("keeps every word of lines at any indent (seeded fuzz)", () => {
    const random = lcg(23);
    const editor = createEditor("");
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const templates = [
      "- [ ] #", "- [x] #", " - [ ] #", " - [x] #", "  - [ ] #", "   - [x] #", "-  [ ] #", " #", "  #", "   #",
      "#", " # #", "",
    ];
    for (let n = 0; n < 300; n++) {
      const words: string[] = [];
      const src = Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
        const template = pick(templates);
        if (!template.includes("#")) return template;
        const word = `w${words.length}x`;
        words.push(word);
        return template.slice(0, template.lastIndexOf("#")) + word;
      }).join("\n");
      const load = (markdown: string) => {
        editor.commands.setContent(markdown, { contentType: "markdown" });
        return editor.getMarkdown().trimEnd();
      };
      const second = load(load(src));
      load(second);
      const text = textOf(editor.getJSON());
      for (const word of words) expect(text, `${JSON.stringify(src)} -> ${JSON.stringify(second)}`).toContain(word);
    }
  });
});
