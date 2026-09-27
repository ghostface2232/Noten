import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import TaskItem from "@tiptap/extension-task-item";
import type { Locale } from "../hooks/useSettings";
import { t } from "../i18n";

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

/** TaskItem as Noten configures it; `getLocale` is read on every label update. */
export function createNotenTaskItem(getLocale: () => Locale) {
  return TaskItem.configure({
    nested: true,
    a11y: { checkboxLabel: (node) => taskCheckboxLabel(node, getLocale()) },
  });
}
