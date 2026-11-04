import { describe, expect, it } from "vitest";
import { deriveTitle } from "./noteText";

describe("deriveTitle", () => {
  it("skips front matter and comments", () => {
    expect(deriveTitle("---\ntitle: x\n---\n\n# Actual")).toBe("Actual");
    expect(deriveTitle("<!-- note -->\n\nActual")).toBe("Actual");
    expect(deriveTitle("<!-- one\n\ntwo -->\nActual")).toBe("Actual");
    expect(deriveTitle("\n  <!-- one -->\nActual")).toBe("Actual");
  });

  it("uses the first meaningful Markdown line", () => {
    expect(deriveTitle("\n  ![cover](cover.png)\n```mermaid\n# Actual **title**\n"))
      .toBe("Actual title");
  });

  it("strips block markers and limits the visible title", () => {
    expect(deriveTitle("> 1. [[A deliberately long title for a note]]"))
      .toBe("A deliberately long ");
  });

  it("does not split an unused large tail into an array", () => {
    const content = `# Ready\n${"tail\n".repeat(100_000)}`;
    expect(deriveTitle(content)).toBe("Ready");
  });
});
