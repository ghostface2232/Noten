import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import TaskItem from "@tiptap/extension-task-item";
import type { Locale } from "../hooks/useSettings";
import { t } from "../i18n";
import { normalizeListItemContent } from "./NotenListItem";

/**
 * The checkbox's accessible name, taken from the item's own first paragraph.
 *
 * Tiptap names it after `node.textContent`, the item's whole subtree, and
 * writes that into both the checkbox's `aria-label` and a hidden span on every
 * update of the item and of each task item above it. In a large nested list
 * every keystroke re-read and rewrote the text of the whole list, and the
 * name ran nested items together ("Task item checkbox for ParentChild").
 */
export function taskCheckboxLabel(node: ProseMirrorNode, locale: Locale): string {
  const text = node.firstChild?.textContent.trim() ?? "";
  if (!text) return t("task.checkboxEmpty", locale);
  return t("task.checkbox", locale).replace("{text}", () => text);
}

type ParseTaskItem = NonNullable<typeof TaskItem.config.parseMarkdown>;

/**
 * The stock parse, with a bare text node among the item's blocks wrapped in a
 * paragraph. marked lexes a list item's content outside its top level, where
 * a paragraph comes out as a `text` token, so a task list nested in a bullet
 * item (`- a` / `  - [x] b` / `    c`) put `c` beside the item's blocks as
 * bare text. The schema does not allow that, so edits there could throw, and
 * a blank line before it was lost on save.
 */
export const parseTaskItemMarkdown: ParseTaskItem = function (this: unknown, token, helpers) {
  const parsed = TaskItem.config.parseMarkdown!.call(this, token, helpers);
  if (!parsed || Array.isArray(parsed) || !("type" in parsed) || parsed.type !== "taskItem") return parsed;
  return { ...parsed, content: normalizeListItemContent(parsed.content ?? []) };
};

/** TaskItem as Noten configures it; `getLocale` is read on every label update. */
export function createNotenTaskItem(getLocale: () => Locale) {
  return TaskItem.extend({ parseMarkdown: parseTaskItemMarkdown }).configure({
    nested: true,
    a11y: { checkboxLabel: (node) => taskCheckboxLabel(node, getLocale()) },
  });
}
