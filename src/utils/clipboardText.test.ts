import { describe, it, expect } from "vitest";
import { Schema, Slice, Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { sliceToPlainText } from "./clipboardText";

// Minimal schema mirroring the relevant parts of the app's editor: paragraph,
// heading, hard break (no spec.leafText — like Tiptap), inline image, and the
// bold/link marks. sliceToPlainText must strip marks/markers and join blocks
// with a single "\n".
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 1 } },
      toDOM: (n) => [`h${n.attrs.level}`, 0],
    },
    image: {
      group: "block",
      atom: true,
      attrs: { src: { default: "" }, alt: { default: "" } },
      toDOM: (n) => ["img", { src: n.attrs.src, alt: n.attrs.alt }],
    },
    text: { group: "inline" },
    hardBreak: {
      group: "inline",
      inline: true,
      selectable: false,
      toDOM: () => ["br"],
    },
  },
  marks: {
    bold: { toDOM: () => ["strong", 0] },
    link: { attrs: { href: {} }, toDOM: (m) => ["a", { href: m.attrs.href }, 0] },
  },
});

function para(...content: PMNode[]): PMNode {
  return schema.node("paragraph", null, content);
}
function text(value: string): PMNode {
  return schema.text(value);
}
function sliceOf(...blocks: PMNode[]): Slice {
  return new Slice(Fragment.fromArray(blocks), 0, 0);
}

describe("sliceToPlainText", () => {
  it("T1: joins two paragraphs with a single newline (no blank line)", () => {
    expect(sliceToPlainText(sliceOf(para(text("a")), para(text("b"))))).toBe("a\nb");
  });

  it("T2: a hard break inside a paragraph becomes a single newline", () => {
    const p = para(text("a"), schema.node("hardBreak"), text("b"));
    expect(sliceToPlainText(sliceOf(p))).toBe("a\nb");
  });

  it("T3: one empty paragraph between two paragraphs yields exactly one blank line", () => {
    const slice = sliceOf(para(text("a")), para(), para(text("b")));
    expect(sliceToPlainText(slice)).toBe("a\n\nb");
  });

  it("T4: consecutive empty paragraphs scale proportionally (no extra amplification)", () => {
    const slice = sliceOf(para(text("a")), para(), para(), para(text("b")));
    expect(sliceToPlainText(slice)).toBe("a\n\n\nb");
  });

  it("T5: an image contributes its alt text", () => {
    const img = schema.node("image", { src: "x.png", alt: "pic" });
    expect(sliceToPlainText(sliceOf(img))).toBe("pic");
  });

  it("T6: headings and marks (bold/link) are stripped to plain text", () => {
    const heading = schema.node("heading", { level: 1 }, [text("Title")]);
    const body = para(
      schema.text("bold", [schema.mark("bold")]),
      text(" and "),
      schema.text("link", [schema.mark("link", { href: "https://x" })]),
    );
    expect(sliceToPlainText(sliceOf(heading, body))).toBe("Title\nbold and link");
  });

  it("does not append a trailing newline for a single paragraph", () => {
    expect(sliceToPlainText(sliceOf(para(text("solo"))))).toBe("solo");
  });
});
