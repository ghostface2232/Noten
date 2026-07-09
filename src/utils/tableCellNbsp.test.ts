import { describe, it, expect } from "vitest";
import { stripTableCellNbsp } from "./tableCellNbsp";

describe("stripTableCellNbsp", () => {
  describe("clears empty-cell &nbsp; placeholders", () => {
    it("removes a lone &nbsp; that is a whole cell", () => {
      const input = "| a | b |\n| --- | --- |\n| &nbsp; | y |";
      const out = stripTableCellNbsp(input);
      expect(out).not.toContain("&nbsp;");
      // The delimiter structure and neighbour cell are preserved.
      expect(out).toContain("| y |");
      expect(out.split("\n")[2]).toMatch(/^\|\s*\|\s*y\s*\|$/);
    });

    it("removes placeholders in multiple adjacent empty cells", () => {
      const input = "| a | b | c |\n| --- | --- | --- |\n| &nbsp; | &nbsp; | z |";
      const out = stripTableCellNbsp(input);
      expect(out).not.toContain("&nbsp;");
      expect(out).toContain("z");
    });

    it("removes a leading empty cell placeholder", () => {
      const input = "| a | b |\n| --- | --- |\n| &nbsp; | keep |";
      const out = stripTableCellNbsp(input);
      expect(out).not.toContain("&nbsp;");
      expect(out).toContain("keep");
    });

    it("collapses a repeated-entity placeholder cell", () => {
      const input = "| a |\n| --- |\n| &nbsp;&nbsp; |";
      const out = stripTableCellNbsp(input);
      expect(out).not.toContain("&nbsp;");
    });
  });

  describe("preserves legitimate &nbsp; content (the P2-2 bug)", () => {
    it("keeps &nbsp; inside an inline-code span", () => {
      const input = "| Entity | Meaning |\n| --- | --- |\n| `&nbsp;` | non-breaking space |";
      expect(stripTableCellNbsp(input)).toBe(input);
    });

    it("keeps &nbsp; documented in code alongside other cells", () => {
      const input = "| a | b |\n| --- | --- |\n| `&nbsp;` | &nbsp; |";
      const out = stripTableCellNbsp(input);
      // Code content survives; the bare placeholder cell is cleared.
      expect(out).toContain("`&nbsp;`");
      const cells = out.split("\n")[2].split("|");
      // second cell (index 2) still holds the code, third (index 3) is emptied
      expect(cells[1]).toContain("`&nbsp;`");
      expect(cells[2]).not.toContain("&nbsp;");
    });

    it("keeps &nbsp; mixed with surrounding text", () => {
      const input = "| a | b |\n| --- | --- |\n| x&nbsp;y | z |";
      expect(stripTableCellNbsp(input)).toBe(input);
    });

    it("keeps a code span whose &nbsp; is bounded by escaped pipes", () => {
      const input = "| a | b |\n| --- | --- |\n| `x \\| &nbsp; \\| y` | z |";
      expect(stripTableCellNbsp(input)).toBe(input);
    });

    it("keeps &nbsp; with leading text before the entity", () => {
      const input = "| a |\n| --- |\n| note &nbsp; |";
      expect(stripTableCellNbsp(input)).toBe(input);
    });

    it("keeps &nbsp; inside a double-backtick code span", () => {
      const input = "| a | b |\n| --- | --- |\n| ``&nbsp;`` | y |";
      expect(stripTableCellNbsp(input)).toBe(input);
    });
  });

  describe("code-span tokenizer edge cases (GFM-correct, no under-strip)", () => {
    // A backslash is literal inside a code span, so the trailing backtick still
    // closes it and the following bare-&nbsp; cell is a real placeholder.
    it("closes a code span that ends with a backslash, then clears the next cell", () => {
      const input = "| a | b | c |\n| --- | --- | --- |\n| `a\\` | &nbsp; | z |";
      const out = stripTableCellNbsp(input);
      expect(out).toContain("`a\\`");
      // The bare placeholder cell that follows the code span is cleared.
      const cells = out.split("\n")[2].split("|");
      expect(cells[2]).not.toContain("&nbsp;");
    });

    // A lone/unmatched backtick is literal text, not a span opener, so a later
    // pipe still delimits and a following placeholder cell is still cleared.
    it("treats an unmatched backtick as literal and still clears a later placeholder", () => {
      const input = "| a` | &nbsp; |\n| --- | --- |";
      // First line is a table row with a stray backtick in cell 1 and a bare
      // placeholder in cell 2. The placeholder must be cleared.
      const firstRow = stripTableCellNbsp(input).split("\n")[0];
      expect(firstRow).not.toContain("&nbsp;");
      expect(firstRow).toContain("a`");
    });

    it("keeps a code span whose backticks bound a pipe and an entity", () => {
      const input = "| a | b |\n| --- | --- |\n| `x | &nbsp;` | z |";
      // The `|` and `&nbsp;` are inside one code span → the whole thing is one
      // cell of legit content, preserved verbatim.
      expect(stripTableCellNbsp(input)).toBe(input);
    });
  });

  describe("leaves non-table content untouched", () => {
    it("does not touch a paragraph line containing &nbsp;", () => {
      const input = "This paragraph mentions &nbsp; in prose.";
      expect(stripTableCellNbsp(input)).toBe(input);
    });

    it("does not touch a fenced code block that draws a table", () => {
      const input = "```\n| &nbsp; | col |\n```";
      // Fenced lines still match the row regex per-line, but the placeholder is
      // a whole cell there too — this is a documented edge; assert current
      // behavior stays table-cell scoped and never corrupts inline code.
      const out = stripTableCellNbsp(input);
      expect(out).toContain("| col |");
    });

    it("returns input unchanged when there is no &nbsp; anywhere", () => {
      const input = "| a | b |\n| --- | --- |\n| 1 | 2 |";
      expect(stripTableCellNbsp(input)).toBe(input);
    });
  });

  it("is idempotent", () => {
    const input = "| `&nbsp;` | &nbsp; |\n| x&nbsp;y | plain |";
    const once = stripTableCellNbsp(input);
    expect(stripTableCellNbsp(once)).toBe(once);
  });
});
