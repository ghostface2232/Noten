import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
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
  const { menu, isDark } = createMenuShell(pos, 200);

  // Fluent UI 20px regular icons (extracted from @fluentui/react-icons)
  const iconCut = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M5.92 2.23a.5.5 0 0 0-.84.54L9.4 9.43l-1.92 2.96a3 3 0 1 0 .78.64L10 10.35l1.74 2.68a3 3 0 1 0 .78-.64L5.92 2.23ZM14 17a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM4 15a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm7.2-6.49-.6-.92 3.48-5.36a.5.5 0 0 1 .84.54l-3.73 5.74Z"/></svg>';
  const iconCopy = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M8 2a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h6a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8ZM7 4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4ZM4 6a2 2 0 0 1 1-1.73V14.5A2.5 2.5 0 0 0 7.5 17h6.23A2 2 0 0 1 12 18H7.5A3.5 3.5 0 0 1 4 14.5V6Z"/></svg>';
  const iconPaste = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M4.5 4h1.59c.2.58.76 1 1.41 1h3c.65 0 1.2-.42 1.41-1h1.59c.28 0 .5.22.5.5v1a.5.5 0 0 0 1 0v-1c0-.83-.67-1.5-1.5-1.5h-1.59c-.2-.58-.76-1-1.41-1h-3c-.65 0-1.2.42-1.41 1H4.5C3.67 3 3 3.67 3 4.5v12c0 .83.67 1.5 1.5 1.5h3a.5.5 0 0 0 0-1h-3a.5.5 0 0 1-.5-.5v-12c0-.28.22-.5.5-.5Zm3 0a.5.5 0 0 1 0-1h3a.5.5 0 0 1 0 1h-3Zm3 3C9.67 7 9 7.67 9 8.5v8c0 .83.67 1.5 1.5 1.5h5c.83 0 1.5-.67 1.5-1.5v-8c0-.83-.67-1.5-1.5-1.5h-5ZM10 8.5c0-.28.22-.5.5-.5h5c.28 0 .5.22.5.5v8a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-8Z"/></svg>';
  const iconPastePlain = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 8a.5.5 0 0 0 0 1h7a.5.5 0 0 0 0-1h-7ZM6 11.5c0-.28.22-.5.5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5Zm.5 2.5a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5Zm2-12c-.65 0-1.2.42-1.41 1H5.5C4.67 3 4 3.67 4 4.5v12c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5v-12c0-.83-.67-1.5-1.5-1.5h-1.59c-.2-.58-.76-1-1.41-1h-3Zm3 1a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1h3Zm-6 1h1.59c.2.58.76 1 1.41 1h3c.65 0 1.2-.42 1.41-1h1.59c.28 0 .5.22.5.5v12a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-12c0-.28.22-.5.5-.5Z"/></svg>';
  const iconSelectAll = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M12.33 6.62c.2.19.23.5.05.7l-3.5 4a.5.5 0 0 1-.73.03l-2-2a.5.5 0 1 1 .7-.7l1.63 1.62 3.14-3.6a.5.5 0 0 1 .7-.05ZM3 6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Zm3-2a2 2 0 0 0-2 2v6c0 1.1.9 2 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6Zm-.25 12A3 3 0 0 0 8 17h4.5a4.5 4.5 0 0 0 4.5-4.5V8a3 3 0 0 0-1-2.23v6.73a3.5 3.5 0 0 1-3.5 3.5H5.75Z"/></svg>';
  const iconEmoji = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M18 10a8 8 0 1 0-16 0 8 8 0 0 0 16 0ZM3 10a7 7 0 1 1 14 0 7 7 0 0 1-14 0Zm10.5-1.5a1 1 0 1 0-2 0 1 1 0 0 0 2 0Zm-5 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0Zm-1.61 4.01a.5.5 0 1 0-.78.63 5 5 0 0 0 7.78 0 .5.5 0 1 0-.78-.63 4 4 0 0 1-6.22 0Z"/></svg>';

  const items: { label: string; shortcut: string | null; icon: string; disabled?: boolean; separator?: boolean; action: () => void }[] = [
    {
      label: i("ctx.cut"), shortcut: "Ctrl+X", icon: iconCut,
      disabled: !ctx.hasSelection || !ctx.isEditable,
      action: () => { closeContextMenu(); ctx.cut(); },
    },
    {
      label: i("ctx.copy"), shortcut: "Ctrl+C", icon: iconCopy,
      disabled: !ctx.hasSelection,
      action: () => { closeContextMenu(); ctx.copy(); },
    },
    {
      label: i("ctx.paste"), shortcut: "Ctrl+V", icon: iconPaste,
      disabled: !ctx.isEditable,
      action: () => { closeContextMenu(); ctx.paste(false); },
    },
    {
      label: i("ctx.pasteNoFormat"), shortcut: "Ctrl+Shift+V", icon: iconPastePlain,
      disabled: !ctx.isEditable,
      action: () => { closeContextMenu(); ctx.paste(true); },
    },
    {
      label: i("ctx.selectAll"), shortcut: "Ctrl+A", icon: iconSelectAll, separator: true,
      action: () => { closeContextMenu(); ctx.selectAll(); },
    },
    {
      label: i("ctx.emoji"), shortcut: "Win+.", icon: iconEmoji, separator: true,
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
    if (item.separator) menu.appendChild(createMenuSeparator(isDark));
    const btn = createMenuItem(item.label, item.shortcut, { disabled: item.disabled, icon: item.icon, isDark });
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

export function createTiptapTextContextMenuContext(editor: Editor): TextContextMenuContext {
  return tiptapContext(editor);
}

export function moveTiptapSelectionToEnd(editor: Editor) {
  if (editor.storage.readonlyGuard?.readonly) return;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  editor.commands.focus();
}

export function isBelowTiptapDocumentEnd(editor: Editor, clientY: number) {
  let endCoords: ReturnType<typeof editor.view.coordsAtPos> | null = null;
  try {
    endCoords = editor.view.coordsAtPos(editor.state.doc.content.size);
  } catch {
    endCoords = null;
  }

  return !!endCoords && clientY > endCoords.bottom;
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
                createTiptapTextContextMenuContext(editor),
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
