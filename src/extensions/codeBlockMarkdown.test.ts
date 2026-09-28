import { describe, it, expect, afterAll } from "vitest";
import { Editor, type AnyExtension, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { common, createLowlight } from "lowlight";
import { createFastMarked } from "./fastMarkdownLexer";
import CodeSpanFence, { NotenStarterKit } from "./CodeSpanFence";
import MermaidCodeBlock from "./MermaidCodeBlock";
import NotenTaskList from "./NotenTaskList";
import { createNotenTaskItem } from "./NotenTaskItem";

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

describe.each(Object.keys(CODE_BLOCKS))("code blocks (%s)", (name) => {
  function createEditor(content: string | JSONContent): Editor {
    const editor = new Editor({
      extensions: [
        ...CODE_BLOCKS[name](),
        Markdown.configure({ marked: createFastMarked() }),
        CodeSpanFence,
        NotenTaskList,
        createNotenTaskItem(() => "en"),
      ],
      content,
      ...(typeof content === "string" ? { contentType: "markdown" } : {}),
    } as ConstructorParameters<typeof Editor>[0]);
    editors.push(editor);
    return editor;
  }

  const save = (content: string | JSONContent) => createEditor(content).getMarkdown().trimEnd();

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

  // The stock renderer always wrote three backticks, so a line of ``` in the
  // code closed the block there on the next load and the rest read as
  // Markdown.
  describe("a fence around code holding backtick runs", () => {
    const block = (text: string): JSONContent => ({
      type: "codeBlock",
      attrs: { language: "js" },
      content: [{ type: "text", text }],
    });
    const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
    const CONTAINERS: Record<string, (code: JSONContent) => JSONContent> = {
      top: (code) => code,
      bullet: (code) => ({ type: "bulletList", content: [{ type: "listItem", content: [paragraph("n"), code] }] }),
      ordered: (code) => ({ type: "orderedList", attrs: { start: 10 }, content: [{ type: "listItem", content: [paragraph("n"), code] }] }),
      "ordered marker line": (code) => ({
        type: "orderedList",
        attrs: { start: 1 },
        content: [{ type: "listItem", content: [{ type: "paragraph" }, code] }],
      }),
      task: (code) => ({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("t"), code] }] }),
      quote: (code) => ({ type: "blockquote", content: [code] }),
      "bullet marker line": (code) => ({
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }, code] }, { type: "listItem", content: [paragraph("next")] }],
      }),
      "nested ordered": (code) => ({
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph("n"), CONTAINERS.ordered(code)] }],
      }),
      "task in quote": (code) => ({ type: "blockquote", content: [CONTAINERS.task(code)] }),
    };
    // A line starting with ``` followed by tildes (```~) closed the fence in
    // marked 17 as well; it still lengthens the fence.
    const TEXTS = ["a\n```~\nb", "a\n```\nb", "a\n````\nb", "a\n  ```\nb", "a\n   ```\nb", "```\nb", "a\n```", "a\n``` \nb", "a\n```js\nb"];

    it.each(Object.keys(CONTAINERS).flatMap((where) => TEXTS.map((text) => [where, text])))(
      "keeps the whole code in a %s block holding %j",
      (where, text) => {
        const first = save({ type: "doc", content: [CONTAINERS[where](block(text))] });
        expect(codeOf(createEditor(first).getJSON())).toEqual([text]);
        expect(save(first)).toBe(first);
      },
    );

    it("writes one backtick more than the longest run starting a line", () => {
      expect(save({ type: "doc", content: [block("a\n```\nb")] })).toBe("````js\na\n```\nb\n````");
      expect(save({ type: "doc", content: [block("   `````\n```")] })).toBe("``````js\n   `````\n```\n``````");
    });

    // Runs that cannot close a backtick fence, or are too short to.
    it.each(["a\n~~~\nb", "a\n    ```\nb", "a\n`` x\nb", "x ``` y", "\t```"])("keeps three backticks around %j", (text) => {
      expect(save({ type: "doc", content: [block(text)] })).toBe(`\`\`\`js\n${text}\n\`\`\``);
    });
  });
});
