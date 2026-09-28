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
  // Only the lead block's later lines differ from the stock renderer given
  // that block first, which is how stock Tiptap parses such an item.
  it("renders the rest of the item as the stock list item does", () => {
    const noten = createEditor("- # h\n\n  para\n  - x\n1. > q\n\n   ```\n   c\n   ```");
    const withoutLead = (node: JSONContent): JSONContent => {
      const content = node.content?.map(withoutLead);
      if (node.type !== "listItem" || !content) return { ...node, ...(content ? { content } : {}) };
      const empty = content[0]?.type === "paragraph" && !content[0].content?.length;
      return { ...node, content: empty ? content.slice(1) : content };
    };
    const stock = createEditor(withoutLead(noten.getJSON()), StarterKit);
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

  // The stock parse left the block as the item's first child, and a marked
  // `text` token beside it as a bare text node, neither of which the schema
  // allows. Loading did not check, but Enter, Backspace, deletions and Tab
  // threw there.
  it.each([
    "1. - [ ] t1\n   - [x] t2\n\n   para\n2. m9",
    "1. > t1 t2\n\n   para\n2. m9",
    "- - [ ] t1\n  - [x] t2\n\n  para\n- m9",
    "- - a\n\n  para\n- m9",
  ])("reads %j into items the schema allows, and edits them", (markdown) => {
    const load = () => {
      const editor = new Editor({
        element: document.createElement("div"),
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
    };
    const textPos = (editor: Editor, text: string) => {
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (found < 0 && node.isText && node.text?.includes(text)) found = pos + node.text.indexOf(text);
      });
      return found;
    };
    const editor = load();
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.getMarkdown().trimEnd()).toBe(markdown);
    const edits: ((editor: Editor) => void)[] = [
      (e) => e.chain().setTextSelection(textPos(e, "para") + 4).run() && e.commands.keyboardShortcut("Enter"),
      (e) => e.chain().setTextSelection(textPos(e, "para")).run() && e.commands.keyboardShortcut("Backspace"),
      (e) => e.chain().setTextSelection({ from: textPos(e, "a") + 1, to: textPos(e, "para") + 2 }).run() && e.commands.deleteSelection(),
      (e) => e.chain().setTextSelection(textPos(e, "m9")).run() && e.commands.keyboardShortcut("Tab"),
    ];
    for (const edit of edits) {
      const edited = load();
      expect(() => edit(edited)).not.toThrow();
      expect(() => edited.state.doc.check()).not.toThrow();
    }
  });

  it("writes an empty first paragraph and a block as the block on the marker line", () => {
    const item = (content: JSONContent[]): JSONContent => ({ type: "listItem", content });
    const nested: JSONContent = { type: "bulletList", content: [item([paragraph("a")])] };
    expect(save(doc({ type: "orderedList", attrs: { start: 1 }, content: [item([{ type: "paragraph" }, nested])] }))).toBe(
      "1. - a",
    );
    expect(nodesOf(createEditor("1. - a").getJSON(), "listItem")[0].content?.map((child) => child.type)).toEqual([
      "paragraph",
      "bulletList",
    ]);
  });

  // An ordered list on the marker line reads back as text (`1. 1. b`), so
  // one under an empty item, as Tab on the item below it makes, stays on the
  // lines below; so does a rule under a bullet, since `- ---` is a rule itself.
  it.each([
    ["ordered", { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [paragraph("b")] }] }, "1. \n   1. b"],
    ["rule", { type: "horizontalRule" }, "1. ---"],
  ] as [string, JSONContent, string][])("keeps an empty item's nested %s where the next load finds it", (_name, block, saved) => {
    const item: JSONContent = { type: "listItem", content: [{ type: "paragraph" }, block] };
    const tree = doc({ type: "orderedList", attrs: { start: 1 }, content: [item, { type: "listItem", content: [paragraph("c")] }] });
    const first = save(tree);
    expect(first).toBe(`${saved}\n2. c`);
    const reloaded = nodesOf(createEditor(first).getJSON(), "listItem")[0];
    expect(reloaded.content?.map((child) => child.type)).toEqual(["paragraph", block.type]);
    expect(save(first)).toBe(first);
  });

  it("writes a rule under an empty bullet item below the marker line", () => {
    const tree = doc({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }, { type: "horizontalRule" }] }] });
    expect(save(tree)).toBe("- \n  ---");
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
