import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import { createNotenTaskItem } from "../extensions/NotenTaskItem";
import { NotenStarterKit } from "../extensions/CodeSpanFence";

const css = readFileSync(join(process.cwd(), "src", "styles", "tiptap-editor.css"), "utf8");

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("task item label copy", () => {
  // TaskItem copies each checkbox's accessible name into a visually hidden
  // span inside its label. Laid out, those copies cost layout on load and a
  // text iterator pass on every IME composition update; the stylesheet keeps
  // them out. Judged by computed style, so an inline `display` from a Tiptap
  // upgrade or a lost rule fails here, not only a renamed selector.
  it("is present in the label span and kept out of layout by the stylesheet", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit, TaskList, createNotenTaskItem(() => "en")],
      content:
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Parent</p>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Child</p></li></ul></li></ul>',
    });
    cleanup = () => {
      editor.destroy();
      element.remove();
      style.remove();
    };

    const spans = [...element.querySelectorAll("li > label > span")];
    expect(spans.map((span) => span.textContent)).toEqual(["Task: Parent", "Task: Child"]);
    for (const span of spans) expect(getComputedStyle(span).display).toBe("none");
    expect(getComputedStyle(element.querySelector("input[type=checkbox]")!).display).not.toBe("none");
  });
});

describe("ordered list markers", () => {
  // An ordered list shows the markers its Markdown holds. Nesting used to
  // restyle numbered lists as letters, which saved as `1.`; and `ol[type]`
  // cannot tell `a` from `A`, since HTML matches `type` case-insensitively.
  it("follow each list's own style, not its depth", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [NotenStarterKit],
      content:
        "<ol><li><p>n</p><ol><li><p>nested n</p>" +
        '<ol type="a"><li><p>a</p><ol type="A"><li><p>A</p><ol type="i"><li><p>i</p>' +
        '<ol type="I"><li><p>I</p></li></ol></li></ol></li></ol></li></ol></li></ol></li></ol>',
    });
    cleanup = () => {
      editor.destroy();
      element.remove();
      style.remove();
    };

    const styles = [...element.querySelectorAll("ol")].map((ol) => getComputedStyle(ol).listStyleType);
    expect(styles).toEqual(["decimal", "decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"]);
  });
});
