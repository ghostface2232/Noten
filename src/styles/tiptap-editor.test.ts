import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";

const css = readFileSync(join(process.cwd(), "src", "styles", "tiptap-editor.css"), "utf8");

describe("task item label copy", () => {
  // Tiptap 3.31's TaskItem copies each item's whole text, nested items
  // included, into a visually hidden span inside the checkbox label. Laid out,
  // that doubled every task list's text; the stylesheet removes the span.
  it("is kept out of layout by the stylesheet", () => {
    expect(css).toMatch(/\.ProseMirror ul\[data-type="taskList"\] li > label > span \{\s*display: none;\s*\}/);
  });

  it("still lives in the span that rule targets", () => {
    const element = document.createElement("div");
    const editor = new Editor({
      element,
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true })],
      content: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Buy milk</p></li></ul>',
    });
    try {
      const spans = element.querySelectorAll('ul[data-type="taskList"] li > label > span');
      expect(spans).toHaveLength(1);
      expect(spans[0].textContent).toContain("Buy milk");
    } finally {
      editor.destroy();
    }
  });
});
