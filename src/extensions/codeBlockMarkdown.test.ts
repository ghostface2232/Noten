import { describe, it, expect, afterAll } from "vitest";
import { Editor, type AnyExtension, type JSONContent } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { common, createLowlight } from "lowlight";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import MermaidCodeBlock from "./MermaidCodeBlock";
import NotenTaskList from "./NotenTaskList";

const lowlight = createLowlight(common);

// The editor uses MermaidCodeBlock; NotenStarterKit's own code block serves
// editors without it. Both must keep an indented fence.
const CODE_BLOCKS: Record<string, () => AnyExtension[]> = {
  mermaid: () => [
    NotenStarterKit.configure({ codeBlock: false, underline: false, link: false }),
    MermaidCodeBlock.configure({ lowlight }),
  ],
  kit: () => [NotenStarterKit.configure({ underline: false, link: false })],
};

const editors: Editor[] = [];
afterAll(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

function nodesOf(doc: JSONContent, type: string): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === type) out.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return out;
}

function codeOf(doc: JSONContent): string[] {
  return nodesOf(doc, "codeBlock").map((node) => (node.content ?? []).map((child) => child.text ?? "").join(""));
}

describe.each(Object.keys(CODE_BLOCKS))("an indented fence (%s)", (name) => {
  function createEditor(markdown: string): Editor {
    const editor = new Editor({
      extensions: [
        ...CODE_BLOCKS[name](),
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

  const save = (markdown: string) => createEditor(markdown).getMarkdown().trimEnd();

  // The stock parseMarkdown dropped every fence whose line did not start with
  // the fence itself, and the code with it.
  it.each([
    ["p\n\n ```\n c\n ```", "p\n\n```\nc\n```", ["c"]],
    // Alone in the note, the dropped fence fell back to one paragraph of
    // escaped backticks, its line breaks lost.
    ["  ```\n  a\n  b\n  ```", "```\na\nb\n```", ["a\nb"]],
    ["   ~~~js\n   let x;\n     y\n   ~~~", "```js\nlet x;\n  y\n```", ["let x;\n  y"]],
    ["  ~~~\n x\nz\n  ~~~", "```\nx\nz\n```", ["x\nz"]],
    ["- n\n\n  p\n\n   ```\n   c\n   ```", "- n\n\n  p\n  ```\n  c\n  ```", ["c"]],
    ["- [ ] t\n\n   ```\n   c\n   ```", "- [ ] t\n  ```\n  c\n  ```", ["c"]],
    ["> ```\n>  x\n> ```", "> ```\n>  x\n> ```", [" x"]],
  ])("keeps the code of %j", (markdown, saved, code) => {
    expect(codeOf(createEditor(markdown).getJSON())).toEqual(code);
    expect(save(markdown)).toBe(saved);
    expect(save(saved)).toBe(saved);
  });

  // Four spaces is indented code, not a fence; its text keeps the backticks.
  it("reads a fence indented by four spaces as indented code", () => {
    expect(codeOf(createEditor("p\n\n    ```\n    c\n    ```").getJSON())).toEqual(["```\nc\n```"]);
  });

  it("round-trips an unindented fence byte for byte", () => {
    expect(save("```ts\nconst a = 1;\n```")).toBe("```ts\nconst a = 1;\n```");
  });

  // marked closed a fence at the other character too (```~~~ after ```), so
  // that line vanished on the first save and the rest of the code read as
  // Markdown; see commonMarkFence in fastMarkdownLexer.ts.
  it.each([
    ["```\n```~~~\nx\n```", ["```~~~\nx"]],
    ["~~~\n~~~```\nx\n~~~", ["~~~```\nx"]],
    ["- n\n  ```\n  ```~~~\n  2. x\n  ```", ["```~~~\n2. x"]],
    ["- [ ] t\n  ```\n  ```~\n  y\n  ```", ["```~\ny"]],
    ["> ```\n> ```~\n> x\n> ```", ["```~\nx"]],
  ])("keeps the line of the other fence character in %j", (markdown, code) => {
    expect(codeOf(createEditor(markdown).getJSON())).toEqual(code);
    const first = save(markdown);
    expect(codeOf(createEditor(first).getJSON())).toEqual(code);
    expect(save(first)).toBe(first);
  });
});
