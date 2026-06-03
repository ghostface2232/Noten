import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import {
  SlashCommandList,
  type SlashCommandItem,
  type SlashCommandListRef,
} from "../components/SlashCommand";
import { pickAndInsertImage } from "./ImageDrop";
import { insertMermaidCodeBlock } from "./mermaidCommands";
import { t, type I18nKey } from "../i18n";
import type { Locale } from "../hooks/useSettings";

const SlashCommands = Extension.create({
  name: "slashCommands",

  addStorage() {
    return { locale: "ko" as Locale };
  },

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({
          editor,
          range,
          props,
        }: {
          editor: any;
          range: any;
          props: SlashCommandItem;
        }) => {
          props.command({ editor, range });
        },
      } satisfies Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query }: { query: string }) => {
          const locale = this.storage.locale as Locale;
          return filterSlashItems(getSlashItems(locale), query);
        },
        render: () => {
          let component: ReactRenderer<SlashCommandListRef> | null = null;
          let popup: HTMLDivElement | null = null;

          return {
            onStart: (props: SuggestionProps) => {
              component = new ReactRenderer(SlashCommandList, {
                props,
                editor: props.editor,
              });

              popup = document.createElement("div");
              popup.style.position = "fixed";
              popup.style.zIndex = "50";
              applyPopupTheme(popup);
              popup.appendChild(component.element);
              document.body.appendChild(popup);

              updatePosition(popup, props);
            },

            onUpdate: (props: SuggestionProps) => {
              component?.updateProps(props);
              if (popup) {
                applyPopupTheme(popup);
                updatePosition(popup, props);
              }
            },

            onKeyDown: (props: { event: KeyboardEvent }) => {
              if (props.event.key === "Escape") {
                popup?.remove();
                component?.destroy();
                popup = null;
                component = null;
                return true;
              }
              return component?.ref?.onKeyDown(props.event) ?? false;
            },

            onExit: () => {
              popup?.remove();
              component?.destroy();
              popup = null;
              component = null;
            },
          };
        },
      }),
    ];
  },
});

const MENU_MAX_HEIGHT = 320;
const GAP = 4;

function getCurrentTheme(): "light" | "dark" {
  return document.querySelector("[data-theme='dark']") ? "dark" : "light";
}

function applyPopupTheme(popup: HTMLDivElement) {
  popup.setAttribute("data-theme", getCurrentTheme());
}

function updatePosition(popup: HTMLDivElement, props: SuggestionProps) {
  const { clientRect } = props;
  if (!clientRect) return;
  const rect = typeof clientRect === "function" ? clientRect() : clientRect;
  if (!rect) return;

  const spaceBelow = window.innerHeight - rect.bottom - GAP;
  const spaceAbove = rect.top - GAP;
  const menuHeight = Math.min(
    popup.firstElementChild?.scrollHeight ?? MENU_MAX_HEIGHT,
    MENU_MAX_HEIGHT,
  );

  // Flip upward when there is more room above than below.
  if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
    popup.style.top = "";
    popup.style.bottom = `${window.innerHeight - rect.top + GAP}px`;
  } else {
    popup.style.bottom = "";
    popup.style.top = `${rect.bottom + GAP}px`;
  }

  popup.style.left = `${rect.left}px`;
}

interface SlashItemDef {
  titleKey: I18nKey;
  descKey: I18nKey;
  searchTerms: string[];
  icon: string;
  command: SlashCommandItem["command"];
}

const SLASH_DEFS: SlashItemDef[] = [
  { titleKey: "slash.text", descKey: "slash.text.desc", searchTerms: ["paragraph", "text", "plain", "body", "본문", "텍스트", "문단"], icon: "TextT",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setParagraph().run(); } },
  { titleKey: "slash.h1", descKey: "slash.h1.desc", searchTerms: ["heading", "heading1", "h1", "title", "제목", "큰제목"], icon: "TextHeader1",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(); } },
  { titleKey: "slash.h2", descKey: "slash.h2.desc", searchTerms: ["heading", "heading2", "h2", "subtitle", "제목", "소제목"], icon: "TextHeader2",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(); } },
  { titleKey: "slash.h3", descKey: "slash.h3.desc", searchTerms: ["heading", "heading3", "h3", "제목"], icon: "TextHeader3",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(); } },
  { titleKey: "slash.bulletList", descKey: "slash.bulletList.desc", searchTerms: ["bullet", "list", "unordered", "ul", "리스트", "목록", "글머리"], icon: "TextBulletList",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleBulletList().run(); } },
  { titleKey: "slash.orderedList", descKey: "slash.orderedList.desc", searchTerms: ["ordered", "number", "numbered", "list", "ol", "리스트", "번호", "목록"], icon: "TextNumberListLtr",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleOrderedList().run(); } },
  { titleKey: "slash.taskList", descKey: "slash.taskList.desc", searchTerms: ["task", "todo", "checkbox", "checklist", "체크", "할일", "체크리스트"], icon: "TaskListLtr",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleTaskList().run(); } },
  { titleKey: "slash.blockquote", descKey: "slash.blockquote.desc", searchTerms: ["quote", "blockquote", "citation", "인용", "인용문"], icon: "TextQuoteOpening",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleBlockquote().run(); } },
  { titleKey: "slash.codeBlock", descKey: "slash.codeBlock.desc", searchTerms: ["code", "codeblock", "snippet", "pre", "fence", "코드", "코드블록"], icon: "CodeBlock",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).toggleCodeBlock().run(); } },
  { titleKey: "slash.mermaid", descKey: "slash.mermaid.desc", searchTerms: ["mermaid", "diagram", "flowchart", "chart", "graph", "다이어그램", "도표"], icon: "Flowchart",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); insertMermaidCodeBlock(editor); } },
  { titleKey: "slash.hr", descKey: "slash.hr.desc", searchTerms: ["hr", "divider", "horizontal", "rule", "separator", "line", "구분", "구분선"], icon: "LineHorizontal1",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).setHorizontalRule().run(); } },
  { titleKey: "slash.image", descKey: "slash.image.desc", searchTerms: ["image", "img", "picture", "photo", "사진", "이미지", "그림"], icon: "ImageAdd",
    command: ({ editor, range }) => { editor.chain().focus().deleteRange(range).run(); pickAndInsertImage(editor); } },
  { titleKey: "slash.table", descKey: "slash.table.desc", searchTerms: ["table", "grid", "spreadsheet", "표", "테이블", "도표"], icon: "Table",
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    } },
];

export function getSlashItems(locale: Locale): SlashCommandItem[] {
  return SLASH_DEFS.map((d) => ({
    title: t(d.titleKey, locale),
    description: t(d.descKey, locale),
    searchTerms: d.searchTerms,
    icon: d.icon,
    command: d.command,
  }));
}

// Shared, case-insensitive filter over the localized title and the EN/KO
// searchTerms aliases. Exported so the matching rules are unit-tested
// independently of the Suggestion plugin wiring.
export function filterSlashItems(
  items: SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.searchTerms.some((st) => st.toLowerCase().includes(q)),
  );
}

export default SlashCommands;
