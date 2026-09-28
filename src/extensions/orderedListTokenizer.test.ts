import { describe, it, expect, afterAll } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { OrderedList } from "@tiptap/extension-list";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import { orderedItemContentIndent, tokenizeOrderedList } from "./orderedListTokenizer";

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
      TaskList,
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

describe("block content under an ordered item", () => {
  // The stock tokenizer dedented continuation lines one column short, so a
  // task list under `1.` read `- [x] task2` as task1's text: the checkbox was
  // lost and the text drifted right on every save.
  it.each([
    ["1. n\n   - [ ] task1\n   - [x] task2\n2. m", [false, true]],
    ["1. n\n   - [ ] task1\n   - [x] task2\n   - [ ] task3", [false, true, false]],
    ["10. n\n    - [ ] task1\n    - [x] task2", [false, true]],
    ["a. n\n   - [ ] task1\n   - [x] task2", [false, true]],
    ["iv. n\n    - [x] task1\n    - [ ] task2", [true, false]],
    ["1. n\n   - [ ] t1\n     - [ ] deep\n   - [x] t2", [false, false, true]],
  ] as const)("keeps every task of %j", (markdown, checked) => {
    const editor = createEditor(markdown);
    const tasks = nodesOf(editor.getJSON(), "taskItem");
    expect(tasks.map((task) => task.attrs?.checked)).toEqual(checked);
    expect(nodesOf(editor.getJSON(), "text").some((text) => text.text?.includes("["))).toBe(false);
    const first = editor.getMarkdown().trimEnd();
    expect(first).toBe(markdown);
    expect(save(first)).toBe(first);
  });

  // Hand-written nesting deeper than the content column: correcting the
  // column alone left a one-column offset, and trimming the first line only
  // made the task-list tokenizer drop the second checkbox again.
  it.each([
    ["1. n\n    - [ ] t1\n    - [x] t2\n2. m", [false, true]],
    ["1. n\n     - [ ] t1\n     - [x] t2", [false, true]],
    ["1. n\n\n    - [x] t1\n    - [ ] t2", [true, false]],
    ["1. n\n    - [ ] t1\n      - [x] deep\n    - [ ] t2", [false, true, false]],
  ] as const)("keeps every task of deeper-indented %j", (markdown, checked) => {
    const editor = createEditor(markdown);
    expect(nodesOf(editor.getJSON(), "taskItem").map((task) => task.attrs?.checked)).toEqual(checked);
    const first = editor.getMarkdown().trimEnd();
    expect(save(first)).toBe(first);
    expect(nodesOf(createEditor(first).getJSON(), "taskItem").map((task) => task.attrs?.checked)).toEqual(checked);
  });

  // Found in verification, stock and before this fix: a character deleted
  // after a task list, and a code block that is not the item's first block
  // deleted on the first save.
  it.each([
    ["1. n\n   - [ ] t1\n\n   after", "after"],
    ["1. n\n\n   p\n\n   ```\n   c1\n   c2\n   ```\n2. m", "c1\nc2"],
    ["1. n\n\n    p\n\n    ```\n    c1\n    ```\n2. m", "c1"],
    ["1. n\n\n    ```\n    code\n    ```", "code"],
    // An unindented lazy line makes the shared indent 0, so only the right
    // column keeps the fence below it unindented.
    ["1. n\n   - a\nlazy\n   ```\n   c\n   ```", "c"],
  ])("keeps the text of %j", (markdown, text) => {
    const first = save(markdown);
    const doc = createEditor(first).getJSON();
    const blocks = [...nodesOf(doc, "paragraph"), ...nodesOf(doc, "codeBlock")].map((node) =>
      (node.content ?? []).map((child) => child.text ?? "").join(""),
    );
    expect(blocks).toContain(text);
    expect(save(first)).toBe(first);
  });

  it("keeps a task list after a blank line under the item", () => {
    const first = save("1. n\n\n   - [ ] task1\n   - [x] task2");
    expect(first).toBe("1. n\n   - [ ] task1\n   - [x] task2");
    expect(save(first)).toBe(first);
  });

  // The same offset added a space to every code line and to every paragraph
  // after the first, on each save.
  it.each([
    "1. n\n   ```\n   code\n     indented\n   ```",
    "1. n\n\n   para two\n\n   para three",
    "10. n\n\n    para two\n\n    para three",
    "1. n\n   > quote\n   > more",
    "1. n\n   - a\n   - b",
  ])("round-trips %j byte for byte", (markdown) => {
    expect(save(markdown)).toBe(markdown);
    expect(save(save(markdown))).toBe(markdown);
  });

  it("reads the content column the way CommonMark does", () => {
    expect(orderedItemContentIndent("1. x")).toBe(3);
    expect(orderedItemContentIndent("10. x")).toBe(4);
    expect(orderedItemContentIndent("  iv) x")).toBe(6);
    expect(orderedItemContentIndent("1.  x")).toBe(4);
    expect(orderedItemContentIndent("1.      x")).toBe(3);
    expect(orderedItemContentIndent("1.    ")).toBe(3);
    expect(orderedItemContentIndent("not an item")).toBeNull();
  });
});

describe("tokenizeOrderedList against the stock tokenizer", () => {
  const stock = OrderedList.config.markdownTokenizer!.tokenize;
  const manager = createEditor("").markdown as unknown as {
    createLexer(): unknown;
    createTokenizerHelpers(lexer: unknown): Parameters<typeof tokenizeOrderedList>[2];
  };
  const helpers = () => manager.createTokenizerHelpers(manager.createLexer());

  // Only the dedent of indented continuation lines differs, so the lines a
  // list takes (`raw`, which boundedBlockTokenizers.ts's cut rules are argued
  // against) always match, and so does the whole token when no line under an
  // item is indented content.
  it("consumes the same lines, and matches exactly without indented content (seeded fuzz)", () => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const lines = [
      "1. one", "2. two", "10. ten", "a. letter", "iv. roman", "1) paren", "1.  wide",
      "   1. nested", "   - [ ] task", "   - [x] done", "   - bullet", "   > quote", "   ```", "   code",
      "      deep", "    four", " one space", "lazy text", "", "- bullet", "# heading", "> quote",
    ];
    let compared = 0;
    for (let n = 0; n < 1500; n++) {
      const src = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pick(lines)).join("\n");
      const expected = stock(src, [], helpers() as never) as { raw?: string } | undefined;
      const actual = tokenizeOrderedList(src, [], helpers());
      expect(actual?.raw, JSON.stringify(src)).toBe(expected?.raw);
      const consumed = (expected?.raw ?? "").split("\n").slice(1);
      if (!consumed.some((line) => /^\s/.test(line) && line.trim() !== "" && orderedItemContentIndent(line) === null)) {
        expect(JSON.parse(JSON.stringify(actual ?? null)), JSON.stringify(src)).toEqual(
          JSON.parse(JSON.stringify(expected ?? null)),
        );
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });
});
