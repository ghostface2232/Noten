import { describe, it, expect } from "vitest";
import { normalizeMarkdown, markdownEqual } from "./markdownEqual";

const BOM = String.fromCharCode(0xfeff);

describe("markdownEqual — cosmetic differences are equal", () => {
  it("ignores line-ending style (CRLF / CR / LF)", () => {
    expect(markdownEqual("a\r\nb", "a\nb")).toBe(true);
    expect(markdownEqual("a\rb", "a\nb")).toBe(true);
    expect(markdownEqual("a\r\nb\r\nc", "a\nb\nc")).toBe(true);
  });

  it("ignores a leading UTF-8 BOM", () => {
    expect(markdownEqual(BOM + "hello", "hello")).toBe(true);
  });

  it("ignores trailing blank lines at end of file", () => {
    expect(markdownEqual("text", "text\n")).toBe(true);
    expect(markdownEqual("text\n", "text\n\n\n")).toBe(true);
  });

  it("treats identical strings as equal", () => {
    expect(markdownEqual("# Title\n\nbody", "# Title\n\nbody")).toBe(true);
  });

  it("combines cosmetic differences", () => {
    expect(markdownEqual(BOM + "a\r\nb\r\n", "a\nb")).toBe(true);
  });
});

describe("markdownEqual — meaningful differences are NOT equal", () => {
  it("preserves interior blank lines (paragraph breaks)", () => {
    expect(markdownEqual("a\n\nb", "a\nb")).toBe(false);
  });

  it("preserves leading indentation (code / list nesting)", () => {
    expect(markdownEqual("    code", "code")).toBe(false);
    expect(markdownEqual("- a\n  - b", "- a\n- b")).toBe(false);
  });

  it("preserves two-trailing-space hard line breaks", () => {
    expect(markdownEqual("a  \nb", "a\nb")).toBe(false);
  });

  it("detects real content edits", () => {
    expect(markdownEqual("hello world", "hello there")).toBe(false);
  });
});

describe("normalizeMarkdown", () => {
  it("is idempotent", () => {
    const messy = BOM + "x\r\ny\r\n\n";
    expect(normalizeMarkdown(normalizeMarkdown(messy))).toBe(normalizeMarkdown(messy));
  });
});
