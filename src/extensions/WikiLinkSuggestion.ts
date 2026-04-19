import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";
import {
  WikiSuggestionList,
  type WikiSuggestionItem,
  type WikiSuggestionListRef,
} from "../components/WikiSuggestionList";
import type { WikiLinkStorage } from "./WikiLink";
import { findDocByTitle } from "./WikiLink";
import { t } from "../i18n";

const MENU_MAX_HEIGHT = 320;
const GAP = 4;
const TRIGGER = "[[";
const WIKI_SUGGESTION_PLUGIN_KEY = new PluginKey("wikiLinkSuggestion");

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

  if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
    popup.style.top = "";
    popup.style.bottom = `${window.innerHeight - rect.top + GAP}px`;
  } else {
    popup.style.bottom = "";
    popup.style.top = `${rect.bottom + GAP}px`;
  }

  popup.style.left = `${rect.left}px`;
}

// Detect whether the cursor sits inside a pending `[[...` without the closing
// `]]` (so `]` appearing in the tail terminates the match). Returning null
// closes the suggestion dropdown.
function findWikiMatch({ $position }: { $position: ResolvedPos }) {
  const nodeBefore = $position.nodeBefore;
  if (!nodeBefore?.isText || !nodeBefore.text) return null;

  const text = nodeBefore.text;
  const lastOpen = text.lastIndexOf(TRIGGER);
  if (lastOpen < 0) return null;

  const between = text.slice(lastOpen + TRIGGER.length);
  if (/[\]\n]/.test(between)) return null;

  const textFrom = $position.pos - text.length;
  const from = textFrom + lastOpen;
  const to = $position.pos;

  return {
    range: { from, to },
    query: between,
    text: `${TRIGGER}${between}`,
  };
}

function normalizeQuery(query: string): string {
  return query.normalize("NFC").trim().toLowerCase();
}

function buildItems(storage: WikiLinkStorage, rawQuery: string): WikiSuggestionItem[] {
  const docs = storage.docs ?? [];
  const needle = normalizeQuery(rawQuery);
  const trimmed = rawQuery.trim();

  const matches: WikiSuggestionItem[] = docs
    .filter((doc) => {
      if (!needle) return true;
      return normalizeQuery(doc.fileName).includes(needle);
    })
    .slice(0, 20)
    .map((doc) => ({
      kind: "existing" as const,
      title: doc.fileName,
      noteId: doc.id,
    }));

  // Offer "Create new" only when the user has typed something and no match
  // has that exact title.
  if (trimmed) {
    const exactExists = !!findDocByTitle(docs, trimmed);
    if (!exactExists) {
      matches.push({
        kind: "create",
        title: trimmed,
        createLabel: t("wiki.createNew", storage.locale),
      });
    }
  }

  return matches;
}

const WikiLinkSuggestion = Extension.create({
  name: "wikiLinkSuggestion",

  addOptions() {
    return {
      suggestion: {
        pluginKey: WIKI_SUGGESTION_PLUGIN_KEY,
        char: TRIGGER,
        startOfLine: false,
        allowedPrefixes: null,
        findSuggestionMatch: findWikiMatch,
        command: ({
          editor,
          range,
          props,
        }: {
          editor: import("@tiptap/core").Editor;
          range: { from: number; to: number };
          props: WikiSuggestionItem;
        }) => {
          const storage = editor.storage.wikiLink as WikiLinkStorage | undefined;
          const markType = editor.schema.marks.wikiLink;
          if (!markType) return;

          const title = props.title;
          if (!title) return;

          // In edit mode the original `]]` sits just past the cursor; the
          // Suggestion-reported range only covers `[[` + query. Absorb the
          // trailing `]]` when present so the replacement doesn't leave
          // orphan brackets behind (`[[Foo]]]]`).
          let to = range.to;
          const { state } = editor;
          const docSize = state.doc.content.size;
          if (to + 2 <= docSize) {
            const trailing = state.doc.textBetween(to, to + 2, "\n", "\ufffc");
            if (trailing === "]]") to += 2;
          }

          const text = `[[${title}]]`;
          const mark = markType.create({ target: title });
          const node = editor.schema.text(text, [mark]);

          const { tr } = state;
          tr.replaceRangeWith(range.from, to, node);
          tr.removeStoredMark(markType);
          editor.view.dispatch(tr);

          if (props.kind === "create" && storage?.createNoteWithTitle) {
            void storage.createNoteWithTitle(title);
          }
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
          const storage = this.editor.storage.wikiLink as WikiLinkStorage | undefined;
          if (!storage) return [];
          return buildItems(storage, query);
        },
        render: () => {
          let component: ReactRenderer<WikiSuggestionListRef> | null = null;
          let popup: HTMLDivElement | null = null;

          return {
            onStart: (props: SuggestionProps) => {
              component = new ReactRenderer(WikiSuggestionList, {
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

export default WikiLinkSuggestion;
