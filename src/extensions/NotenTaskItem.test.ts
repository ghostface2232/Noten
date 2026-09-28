import { describe, it, expect, afterEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import type { Locale } from "../hooks/useSettings";
import { createNotenTaskItem } from "./NotenTaskItem";
import { Markdown } from "@tiptap/markdown";
import { createFastMarked } from "./fastMarkdownLexer";
import { NotenStarterKit } from "./CodeSpanFence";
import NotenTaskList from "./NotenTaskList";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function checkboxLabels(html: string, locale: Locale = "en"): string[] {
  const element = document.createElement("div");
  editor = new Editor({
    element,
    extensions: [StarterKit, TaskList, createNotenTaskItem(() => locale)],
    content: html,
  });
  return [...element.querySelectorAll("input[type=checkbox]")].map((box) => box.getAttribute("aria-label") ?? "");
}

const item = (text: string, nested = "") =>
  `<li data-type="taskItem" data-checked="false"><p>${text}</p>${nested}</li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;

describe("NotenTaskItem checkbox labels", () => {
  it("name each checkbox after its own paragraph, not its nested items", () => {
    expect(checkboxLabels(list(item("Parent", list(item("Child")))))).toEqual(["Task: Parent", "Task: Child"]);
  });

  it("follow the locale and name an empty item", () => {
    expect(checkboxLabels(list(item("우유 사기"), item("")), "ko")).toEqual(["할 일: 우유 사기", "빈 할 일"]);
  });

  it("insert the text literally", () => {
    expect(checkboxLabels(list(item("Pay $& and $1")))).toEqual(["Task: Pay $& and $1"]);
  });

  it("follow an edit to the item's paragraph", () => {
    checkboxLabels(list(item("Parent", list(item("Child")))));
    let childEnd = -1;
    editor!.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "Child") childEnd = pos + node.nodeSize;
    });
    editor!.commands.insertContentAt(childEnd, " more");
    const labels = [...editor!.view.dom.querySelectorAll("input[type=checkbox]")].map((box) => box.getAttribute("aria-label"));
    expect(labels).toEqual(["Task: Parent", "Task: Child more"]);
  });
});

describe("NotenTaskItem Markdown parse", () => {
  // marked lexes a list item's content outside its top level, where a
  // paragraph is a `text` token: the stock parse put it in the task item as
  // bare text, which the schema does not allow, and dropped the blank line.
  it.each(["- a\n  - [x] b\n    c", "- a\n  - [x] b\n\n    c\n- d"])("wraps bare text of %j in a paragraph", (markdown) => {
    const load = (content: string) =>
      new Editor({
        element: document.createElement("div"),
        extensions: [
          NotenStarterKit.configure({ underline: false, link: false }),
          Markdown.configure({ marked: createFastMarked() }),
          NotenTaskList,
          createNotenTaskItem(() => "en"),
        ],
        content,
        contentType: "markdown",
      } as ConstructorParameters<typeof Editor>[0]);
    const editor = load(markdown);
    try {
      expect(() => editor.state.doc.check()).not.toThrow();
      const task = (editor.getJSON() as JSONContent).content?.[0].content?.[0].content?.[1].content?.[0];
      expect(task?.content?.map((child) => child.type)).toEqual(["paragraph", "paragraph"]);
      const saved = editor.getMarkdown();
      expect(saved).toContain("- [x] b\n  \n    c");
      const reloaded = load(saved);
      expect(reloaded.getMarkdown()).toBe(saved);
      reloaded.destroy();
    } finally {
      editor.destroy();
    }
  });
});
