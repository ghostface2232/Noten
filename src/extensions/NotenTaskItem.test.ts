import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import type { Locale } from "../hooks/useSettings";
import { createNotenTaskItem } from "./NotenTaskItem";

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
