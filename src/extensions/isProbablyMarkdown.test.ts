import { describe, it, expect } from "vitest";
import { isProbablyMarkdown } from "./isProbablyMarkdown";

describe("isProbablyMarkdown — decisive block syntax", () => {
  it("detects headings, tasks, tables, blockquotes, fences, images", () => {
    expect(isProbablyMarkdown("# Heading")).toBe(true);
    expect(isProbablyMarkdown("- [ ] take out the trash")).toBe(true);
    expect(isProbablyMarkdown("| a | b |\n| c | d |")).toBe(true);
    expect(isProbablyMarkdown("> a quoted line")).toBe(true);
    expect(isProbablyMarkdown("```js\nconst x = 1;\n```")).toBe(true);
    expect(isProbablyMarkdown("![alt](photo.png)")).toBe(true);
  });

  it("detects a real list document", () => {
    expect(
      isProbablyMarkdown("Shopping list:\n\n- milk\n- eggs\n- bread"),
    ).toBe(true);
  });
});

describe("isProbablyMarkdown — non-Markdown is rejected", () => {
  it("rejects plain prose, even with a single inline link", () => {
    expect(isProbablyMarkdown("This is a normal sentence.")).toBe(false);
    expect(isProbablyMarkdown("See [our site](https://x.com) today")).toBe(false);
  });

  it("rejects bare emails and URLs", () => {
    expect(isProbablyMarkdown("john.doe@example.com")).toBe(false);
    expect(isProbablyMarkdown("https://example.com/some/path")).toBe(false);
  });

  it("rejects HTML and XML", () => {
    expect(isProbablyMarkdown("<div>hello <b>world</b></div>")).toBe(false);
    expect(isProbablyMarkdown('<?xml version="1.0"?><root/>')).toBe(false);
  });

  it("rejects a pasted email with headers", () => {
    expect(
      isProbablyMarkdown(
        "From: a@b.com\nTo: c@d.com\nSubject: hi\n\nBody text here",
      ),
    ).toBe(false);
  });

  it("rejects empty or whitespace-only input", () => {
    expect(isProbablyMarkdown("")).toBe(false);
    expect(isProbablyMarkdown("   \n  ")).toBe(false);
  });
});
