import { describe, it, expect, afterAll } from "vitest";
import { Editor, type AnyExtension, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import NotenTaskList from "./NotenTaskList";

const editors: Editor[] = [];
afterAll(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

function createEditor(content: string | JSONContent, kit: AnyExtension = NotenStarterKit.configure({ underline: false, link: false })): Editor {
  const editor = new Editor({
    extensions: [
      kit,
      Markdown.configure({ marked: createFastMarked() }),
      CodeSpanFence,
      NotenTaskList,
      TaskItem.configure({ nested: true }),
    ],
    content,
    ...(typeof content === "string" ? { contentType: "markdown" } : {}),
  } as ConstructorParameters<typeof Editor>[0]);
  editors.push(editor);
  return editor;
}

const save = (content: string | JSONContent) => createEditor(content).getMarkdown().trimEnd();

function nodesOf(doc: JSONContent, type: string): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === type) out.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return out;
}

const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const task = (text: string, checked = false): JSONContent => ({ type: "taskItem", attrs: { checked }, content: [paragraph(text)] });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

describe("a list item whose first child is not a paragraph", () => {
  // The stock renderer indented only the children after the first, so the
  // first child's later lines left the item: `- [x] t2` reloaded as a second
  // list after it, and a code line ended the item.
  it.each([
    ["1.\n   - [ ] t1\n   - [x] t2", "1. - [ ] t1\n   - [x] t2"],
    ["- - [ ] t1\n  - [x] t2", "- - [ ] t1\n  - [x] t2"],
    ["- - a\n  - b", "- - a\n  - b"],
    ["- > q\n  > r", "- > q\n  > r"],
    ["1. ```js\n   a\n   b\n   ```\n2. m", "1. ```js\n   a\n   b\n   ```\n2. m"],
  ])("keeps every line of %j inside the item", (markdown, saved) => {
    const editor = createEditor(markdown);
    const items = nodesOf(editor.getJSON(), "listItem");
    const first = editor.getMarkdown().trimEnd();
    expect(first).toBe(saved);
    expect(save(first)).toBe(first);
    expect(nodesOf(createEditor(first).getJSON(), "listItem")).toEqual(items);
  });

  it("indents to the marker's width, as the item's later children are", () => {
    const list = (attrs: Record<string, unknown>, items: JSONContent[]): JSONContent => ({
      type: "orderedList",
      attrs,
      content: items.map((item) => ({ type: "listItem", content: [item] })),
    });
    const tasks: JSONContent = { type: "taskList", content: [task("a"), task("b", true)] };
    expect(save(doc(list({ start: 10 }, [tasks])))).toBe("10. - [ ] a\n    - [x] b");
    expect(save(doc(list({ start: 1, type: "i" }, [paragraph("x"), paragraph("y"), paragraph("z"), tasks])))).toBe(
      "i. x\nii. y\niii. z\niv. - [ ] a\n    - [x] b",
    );
    expect(save(doc({ type: "bulletList", content: [{ type: "listItem", content: [tasks] }] }))).toBe(
      "- - [ ] a\n  - [x] b",
    );
  });

  // Only the first child's later lines differ from the stock renderer.
  it("renders the rest of the item as the stock list item does", () => {
    const noten = createEditor("- # h\n\n  para\n  - x\n1. > q\n\n   ```\n   c\n   ```");
    const stock = createEditor(noten.getJSON(), StarterKit);
    expect(noten.getMarkdown()).toBe(stock.getMarkdown());
  });

  // Rendering the first child twice per level made this 2^depth.
  it("renders deep nesting in linear time", () => {
    const markdown = `${"- ".repeat(40)}a`;
    const editor = createEditor(markdown);
    const started = performance.now();
    expect(editor.getMarkdown().trimEnd()).toBe(markdown);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("keeps a task list's checkboxes through two saves", () => {
    const second = save(save("1.\n   - [ ] t1\n   - [x] t2"));
    const tasks = nodesOf(createEditor(second).getJSON(), "taskItem");
    expect(tasks.map((item) => item.attrs?.checked)).toEqual([false, true]);
    expect(second).not.toContain("\\[");
  });
});

describe("a list item whose first child is a paragraph", () => {
  it("renders exactly as the stock list item does", () => {
    const markdown = [
      "- a",
      "  - b",
      "",
      "  para",
      "  ```",
      "  code",
      "  ```",
      "1. one",
      "   > quote",
      "10. ten",
      "    - [x] done",
    ].join("\n");
    const noten = createEditor(markdown);
    const stock = createEditor(noten.getJSON(), StarterKit);
    expect(noten.getMarkdown()).toBe(stock.getMarkdown());
  });
});
