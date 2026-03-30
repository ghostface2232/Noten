import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";
import { closeContextMenu, createMenuShell, createMenuItem, createMenuSeparator } from "../utils/contextMenuRegistry";

export interface TextContextMenuContext {
  hasSelection: boolean;
  isEditable: boolean;
  locale: Locale;
  cut: () => void;
  copy: () => void;
  paste: (plain?: boolean) => void;
  selectAll: () => void;
  focus: () => void;
}

export function showGenericContextMenu(pos: { x: number; y: number }, ctx: TextContextMenuContext) {
  const i = (key: Parameters<typeof t>[0]) => t(key, ctx.locale);
  const { menu } = createMenuShell(pos, 200);

  const items: { label: string; shortcut: string | null; disabled?: boolean; separator?: boolean; action: () => void }[] = [
    {
      label: i("ctx.cut"), shortcut: "Ctrl+X",
      disabled: !ctx.hasSelection || !ctx.isEditable,
      action: () => { closeContextMenu(); ctx.cut(); },
    },
    {
      label: i("ctx.copy"), shortcut: "Ctrl+C",
      disabled: !ctx.hasSelection,
      action: () => { closeContextMenu(); ctx.copy(); },
    },
    {
      label: i("ctx.paste"), shortcut: "Ctrl+V",
      disabled: !ctx.isEditable,
      action: () => { closeContextMenu(); ctx.paste(false); },
    },
    {
      label: i("ctx.pasteNoFormat"), shortcut: "Ctrl+Shift+V",
      disabled: !ctx.isEditable,
      action: () => { closeContextMenu(); ctx.paste(true); },
    },
    {
      label: i("ctx.selectAll"), shortcut: "Ctrl+A", separator: true,
      action: () => { closeContextMenu(); ctx.selectAll(); },
    },
    {
      label: i("ctx.emoji"), shortcut: "Win+.", separator: true,
      disabled: !ctx.isEditable,
      action: () => {
        closeContextMenu();
        ctx.focus();
        try {
          document.dispatchEvent(new KeyboardEvent("keydown", {
            key: ".", code: "Period", keyCode: 190,
            bubbles: true, cancelable: true, metaKey: true,
          }));
        } catch { /* ignore */ }
      },
    },
  ];

  items.forEach((item) => {
    if (item.separator) menu.appendChild(createMenuSeparator());
    const btn = createMenuItem(item.label, item.shortcut, { disabled: item.disabled });
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (!item.disabled) item.action(); });
    menu.appendChild(btn);
  });
}

function tiptapContext(editor: Editor): TextContextMenuContext {
  const { from, to } = editor.state.selection;
  return {
    hasSelection: from !== to,
    isEditable: !editor.storage.readonlyGuard?.readonly,
    locale: (editor.storage.slashCommands?.locale ?? "en") as Locale,
    cut: () => document.execCommand("cut"),
    copy: () => document.execCommand("copy"),
    paste: async (plain) => {
      try {
        if (plain) {
          const text = await navigator.clipboard.readText();
          editor.chain().focus().insertContent(text).run();
        } else {
          const items = await navigator.clipboard.read();
          const htmlItem = items[0]?.types.includes("text/html") ? items[0] : null;
          if (htmlItem) {
            const blob = await htmlItem.getType("text/html");
            const html = await blob.text();
            editor.chain().focus().insertContent(html).run();
          } else {
            const text = await navigator.clipboard.readText();
            editor.chain().focus().insertContent(text).run();
          }
        }
      } catch { document.execCommand("paste"); }
    },
    selectAll: () => editor.chain().focus().selectAll().run(),
    focus: () => editor.commands.focus(),
  };
}

const TextContextMenu = Extension.create({
  name: "textContextMenu",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("textContextMenu"),
        props: {
          handleDOMEvents: {
            contextmenu(_view, event) {
              const target = event.target as HTMLElement;
              if (target.tagName === "IMG" || target.closest("img")) return false;

              event.preventDefault();
              showGenericContextMenu(
                { x: event.clientX, y: event.clientY },
                tiptapContext(editor),
              );
              return true;
            },
          },
        },
      }),
    ];
  },
});

export default TextContextMenu;
