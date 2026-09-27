import { describe, it, expect } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "@tiptap/markdown";
import CodeSpanFence, { annotateCodeSpanFences, codeSpanFence, NotenStarterKit } from "./CodeSpanFence";
import IncrementalMarkdown from "./IncrementalMarkdown";
import WikiLink from "./WikiLink";
import { createFastMarked } from "./fastMarkdownLexer";

describe("codeSpanFence", () => {
  it.each([
    ["a b", "`", false],
    ["a`b", "``", false],
    ["a``b`c", "```", false],
    ["`a", "``", true],
    ["a`", "``", true],
    ["``", "```", true],
    [" a ", "`", true],
    ["   ", "`", false],
    [" a", "`", false],
  ])("fences %j with %j (pad: %s)", (content, fence, pad) => {
    expect(codeSpanFence(content)).toEqual({ fence, pad });
  });
});

describe("annotateCodeSpanFences", () => {
  const code = (text: string, extra: JSONContent["marks"] = []): JSONContent => ({
    type: "text",
    text,
    marks: [...extra, { type: "code" }],
  });

  it("returns the same array when every run fits a single backtick", () => {
    const nodes = [{ type: "text", text: "x `" }, code("a b"), code("c", [{ type: "bold" }])];
    expect(annotateCodeSpanFences(nodes)).toBe(nodes);
  });

  it("gives every node of a run the same fence, measured over the whole run", () => {
    const nodes = [code("a`", [{ type: "bold" }]), code("`b"), { type: "text", text: " c" }];
    const out = annotateCodeSpanFences(nodes);
    const attrs = out.slice(0, 2).map((node) => node.marks!.find((mark) => mark.type === "code")!.attrs);
    expect(attrs).toEqual([
      { markdownFence: "```", markdownPad: false },
      { markdownFence: "```", markdownPad: false },
    ]);
    expect(out[2]).toBe(nodes[2]);
    expect(nodes[0].marks![1]).toEqual({ type: "code" });
  });

  it("decides padding on the text the serializer leaves inside the fence", () => {
    const [node] = annotateCodeSpanFences([code("  `a  ")]);
    expect(node.marks![0].attrs).toEqual({ markdownFence: "``", markdownPad: true });
  });
});

describe("NotenStarterKit", () => {
  it("keeps the stock schema apart from ranking code as the last mark", () => {
    const options = { codeBlock: false, underline: false, link: false } as const;
    const stock = new Editor({ extensions: [StarterKit.configure(options)] });
    const noten = new Editor({ extensions: [NotenStarterKit.configure(options)] });
    const stockMarks = Object.keys(stock.schema.marks);
    expect(Object.keys(noten.schema.marks)).toEqual([
      ...stockMarks.filter((name) => name !== "code"),
      "code",
    ]);
    expect(Object.keys(noten.schema.nodes)).toEqual(Object.keys(stock.schema.nodes));
    stock.destroy();
    noten.destroy();
  });

  it("ranks code after marks registered later in the extension list", () => {
    const editor = new Editor({
      extensions: [
        NotenStarterKit.configure({ codeBlock: false, underline: false, link: false }),
        Link,
        Underline,
        WikiLink,
      ],
    });
    const marks = Object.keys(editor.schema.marks);
    expect(marks[marks.length - 1]).toBe("code");
    editor.destroy();
  });
});

describe("CodeSpanFence", () => {
  it("reaches the incremental serializer as well as the stock one", () => {
    const editor = new Editor({
      extensions: [
        NotenStarterKit,
        Markdown.configure({ marked: createFastMarked() }),
        CodeSpanFence,
        IncrementalMarkdown,
      ],
      content: "x ``a`b`` y\n\n- `` `c ``",
      contentType: "markdown",
    } as ConstructorParameters<typeof Editor>[0]);
    const expected = "x ``a`b`` y\n\n- `` `c ``";
    expect(editor.getMarkdown()).toBe(expected);
    expect(editor.markdown!.serialize(editor.getJSON())).toBe(expected);
    editor.destroy();
  });
});
