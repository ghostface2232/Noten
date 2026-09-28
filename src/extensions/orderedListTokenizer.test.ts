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

  // The stock tokenizer read the text after the marker as a paragraph whatever
  // it held: `- [ ] t1` there lost its checkbox (saved as `- \[ \] t1`).
  it.each([
    ["1. - [ ] t1\n   - [x] t2\n2. m", [false, true]],
    ["1. - [x] t1\n2. m", [true]],
    ["10. - [ ] t1\n    - [x] t2", [false, true]],
    ["a. - [ ] t1\n   - [x] t2", [false, true]],
    ["1. - [ ] t1\n   - [x] t2\n\n   para\n2. m", [false, true]],
  ] as const)("reads the task list on the marker line of %j", (markdown, checked) => {
    const editor = createEditor(markdown);
    expect(nodesOf(editor.getJSON(), "taskItem").map((task) => task.attrs?.checked)).toEqual(checked);
    expect(nodesOf(editor.getJSON(), "text").some((text) => text.text?.includes("["))).toBe(false);
    expect(editor.getMarkdown().trimEnd()).toBe(markdown);
  });

  it.each([
    ["1. > q\n   > r\n2. m", "blockquote"],
    ["1. # h", "heading"],
    ["1. ```\n   c\n   ```", "codeBlock"],
    ["1. ---", "horizontalRule"],
    ["1. - a\n   - b", "bulletList"],
  ])("reads the block on the marker line of %j", (markdown, type) => {
    // After the empty paragraph the schema requires first; see NotenListItem.
    const item = nodesOf(createEditor(markdown).getJSON(), "listItem")[0];
    expect(item.content?.slice(0, 2).map((child) => [child.type, child.content?.length ?? 0])).toEqual([
      ["paragraph", 0],
      [type, expect.any(Number)],
    ]);
    expect(save(markdown)).toBe(markdown);
  });

  // Tiptap keeps `- 1. a` as a bullet item's text; an ordered one does too.
  it("keeps an ordered marker on the marker line as text", () => {
    const item = nodesOf(createEditor("1. 2. x").getJSON(), "listItem")[0];
    expect(item.content?.map((child) => child.type)).toEqual(["paragraph"]);
    expect(save("1. 2. x")).toBe("1. 2. x");
  });

  // A code line shaped like a marker started a new item: the code block was
  // emptied, the line became a nested item, and the closing fence a second
  // empty code block.
  it.each([
    ["1. n\n\n   ```\n   2. x\n   ```\n2. m", ["2. x"], 2],
    ["1. ```\n   2. x\n   ```\n2. m", ["2. x"], 2],
    ["1. n\n   ~~~\n   2) x\n   ~~~\n2. m", ["2) x"], 2],
    ["1. n\n   ```js\n   2. x\n\n   3. y\n   ```\n2. m", ["2. x\n\n3. y"], 2],
    ["a. n\n   ```\n   b. x\n   ```\nb. m", ["b. x"], 2],
    ["10. n\n    ```\n    11. x\n     12. y\n    ```", ["11. x\n 12. y"], 1],
    ["> 1. n\n>    ```\n>    2. x\n>    ```", ["2. x"], 1],
    // A line of the other fence character does not close the fence.
    ["1. n\n   ```\n   ```~~~\n   2. x\n   ```", ["```~~~\n2. x"], 1],
    // Tab indentation, Obsidian's default, counts to the next multiple of 4.
    ["1. a\n\t```\n\tx\n\t2. y\n\t```", ["x\n2. y"], 1],
    // An unclosed fence runs to the end of the item, as marked reads it.
    ["1. a\n   ```\n   code\n   1. nested\n2. b", ["code\n1. nested"], 2],
    // In a bullet nested in the item, where the fence's lines sit deeper.
    ["1. n\n   - ```\n     2. x\n     ```\n2. m", ["2. x"], 2],
    ["1. - ```\n     2. x\n\n     3. y\n     ```\n2. m", ["2. x\n\n3. y"], 2],
    ["1. n\n   - - ~~~\n       2. x\n       ~~~", ["2. x"], 1],
  ] as const)("keeps the marker-shaped code lines of %j in the code", (markdown, code, items) => {
    const doc = createEditor(markdown).getJSON();
    const blocks = nodesOf(doc, "codeBlock").map((node) => (node.content ?? []).map((child) => child.text ?? "").join(""));
    expect(blocks).toEqual(code);
    expect(nodesOf(doc, "orderedList")).toHaveLength(1);
    // The outer list's own items; nested bullets have theirs.
    expect(nodesOf(doc, "orderedList")[0].content).toHaveLength(items);
    const first = save(markdown);
    expect(save(first)).toBe(first);
  });

  // A closing fence left of the item's column reaches marked dedented to it
  // and closes the block there. Judged by its raw indent, it opened a second
  // fence, and code after the next item moved between items on every save.
  it.each(["1. a\n   ```\n   x\n  ```\n   2. y\n   ```\n   z\n   ```", "1. a\n   ```\n   x\n\t```\n   2. y\n   ```\n   z\n   ```"])(
    "closes the fence of %j where marked does",
    (markdown) => {
      const doc = createEditor(markdown).getJSON();
      const nested = nodesOf(doc, "orderedList")[1];
      const codeIn = (node: JSONContent | undefined) =>
        nodesOf(node ?? {}, "codeBlock").map((block) => (block.content ?? []).map((child) => child.text ?? "").join(""));
      expect(codeIn(doc)).toEqual(["x", "z"]);
      expect(codeIn(nested)).toEqual(["z"]);
      const first = save(markdown);
      expect(save(first)).toBe(first);
    },
  );

  // Only as long as a closing fence of the same kind: the ``` line is code.
  // (Saving it back needs a fence longer than that line, which is the code
  // block renderer's job, not the tokenizer's.)
  it("keeps a shorter fence line inside a longer fence as code", () => {
    const doc = createEditor("1. n\n   ````\n   ```\n   2. x\n   ````").getJSON();
    const blocks = nodesOf(doc, "codeBlock").map((node) => (node.content ?? []).map((child) => child.text ?? "").join(""));
    expect(blocks).toEqual(["```\n2. x"]);
    expect(nodesOf(doc, "listItem")).toHaveLength(1);
  });

  // After the fence closes, a marker line is an item again (nested here).
  // The fence holds only lines at its content column: a fence cannot
  // be continued lazily, so a line left of it ends the item there.
  it.each([
    ["1. n\n\n   ```\n2. x\n   ```", 2],
    ["1. n\n   ```\n   2. x\n   ```\n   3. y", 2],
    ["1. n\n   - ```\n   2. x", 2],
  ] as const)("still reads the items outside the fence of %j", (markdown, items) => {
    const ordered = nodesOf(createEditor(markdown).getJSON(), "orderedList").flatMap((list) => list.content ?? []);
    expect(ordered).toHaveLength(items);
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

  // Without a fence, only the dedent of indented continuation lines and the
  // reading of a block on a marker line differ, so the lines a list takes
  // (`raw`) match, and so does the whole token when no line under an item is
  // indented content and no marker line holds a block. A fence changes which
  // lines are items, and with them the lines taken; the bounding is checked
  // on fenced input in boundedBlockTokenizers.test.ts instead.
  it("consumes the same lines, and matches exactly without indented content (seeded fuzz)", () => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const lines = [
      "1. one", "2. two", "10. ten", "a. letter", "iv. roman", "1) paren", "1.  wide",
      "   1. nested", "   - [ ] task", "   - [x] done", "   - bullet", "   > quote", "   ```", "   code",
      "      deep", "    four", " one space", "lazy text", "", "- bullet", "# heading", "> quote",
      "1. - [ ] first task", "2. > quoted", "3. ```", "   2. - bullet",
    ];
    const blockOnMarkerLine = /^\s*[0-9A-Za-z]+[.)]\s+(?:[-+*]\s|#|>|```)/;
    let compared = 0;
    let sameLines = 0;
    for (let n = 0; n < 1500; n++) {
      const src = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pick(lines)).join("\n");
      if (/```|~~~/.test(src)) continue;
      sameLines++;
      const expected = stock(src, [], helpers() as never) as { raw?: string } | undefined;
      const actual = tokenizeOrderedList(src, [], helpers());
      expect(actual?.raw, JSON.stringify(src)).toBe(expected?.raw);
      const rawLines = (expected?.raw ?? "").split("\n");
      const consumed = rawLines.slice(1);
      if (
        !consumed.some((line) => /^\s/.test(line) && line.trim() !== "" && orderedItemContentIndent(line) === null) &&
        !rawLines.some((line) => blockOnMarkerLine.test(line))
      ) {
        expect(JSON.parse(JSON.stringify(actual ?? null)), JSON.stringify(src)).toEqual(
          JSON.parse(JSON.stringify(expected ?? null)),
        );
        compared++;
      }
    }
    expect(sameLines).toBeGreaterThan(700);
    expect(compared).toBeGreaterThan(300);
  });
});
