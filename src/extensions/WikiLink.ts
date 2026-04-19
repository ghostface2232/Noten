import { InputRule, Mark, mergeAttributes } from "@tiptap/core";
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Mark as ProseMirrorMark } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NoteDoc } from "../hooks/useNotesLoader";
import type { Locale } from "../hooks/useSettings";

export interface WikiLinkStorage {
  docs: NoteDoc[];
  locale: Locale;
  // Navigate to a note by its current title (case-insensitive).
  // No-op if no exact match; handled by the click dispatcher.
  navigateToTitle: (title: string) => void;
  // Create a note with the given title and persist it. Does NOT switch the
  // current document. Returns the new note's id once scheduling succeeds.
  createNoteWithTitle: (title: string) => Promise<string | null>;
}

export interface WikiLinkAttributes {
  target: string;
}

const WIKI_LINK_DECORATION_KEY = new PluginKey("wikiLinkDecorations");

interface CompleteWikiLinkRun {
  from: number;
  to: number;
}

function normalizeTitle(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

export function findDocByTitle(docs: NoteDoc[], title: string): NoteDoc | null {
  const needle = normalizeTitle(title);
  if (!needle) return null;
  return docs.find((doc) => normalizeTitle(doc.fileName) === needle) ?? null;
}

function getWikiLinkMarkTarget(mark: ProseMirrorMark): string {
  return String((mark.attrs as WikiLinkAttributes).target ?? "");
}

function isCompleteWikiLinkText(text: string, mark: ProseMirrorMark): boolean {
  const target = getWikiLinkMarkTarget(mark);
  return !!target && text === target;
}

function findCompleteWikiLinkBeforeOrInside(
  state: EditorState,
  pos: number,
): CompleteWikiLinkRun | null {
  let hit: CompleteWikiLinkRun | null = null;

  state.doc.descendants((node, nodePos) => {
    if (hit) return false;
    if (!node.isText) return true;

    const mark = node.marks.find((m) => m.type.name === "wikiLink");
    if (!mark || !isCompleteWikiLinkText(node.text ?? "", mark)) return false;

    const from = nodePos;
    const to = nodePos + node.nodeSize;
    if (pos > from && pos <= to) {
      hit = { from, to };
    }

    return false;
  });

  return hit;
}

const WikiLink = Mark.create<unknown, WikiLinkStorage>({
  name: "wikiLink",

  // The mark wraps `[[Title]]` verbatim (brackets included), so it behaves
  // like a contiguous atomic run even when the user edits around the edges.
  inclusive: false,
  spanning: false,
  // Prevent Link (and other "_" group marks) from coexisting on the same text.
  excludes: "_",

  addAttributes() {
    return {
      target: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-wiki-link") ?? "",
        renderHTML: (attrs) => {
          const target = (attrs as WikiLinkAttributes).target ?? "";
          return { "data-wiki-link": target };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wiki-link]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "wiki-link",
      }),
      0,
    ];
  },

  addStorage(): WikiLinkStorage {
    return {
      docs: [],
      locale: "en",
      navigateToTitle: () => {},
      createNoteWithTitle: async () => null,
    };
  },

  markdownTokenName: "wikiLink",

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline" as const,
    start: (src: string) => {
      const idx = src.indexOf("[[");
      return idx < 0 ? -1 : idx;
    },
    tokenize: (src: string) => {
      const match = /^\[\[([^\[\]\n]+)\]\]/.exec(src);
      if (!match) return undefined;
      const target = match[1].trim();
      if (!target) return undefined;
      return {
        type: "wikiLink",
        raw: match[0],
        target,
      };
    },
  },

  parseMarkdown(
    token: MarkdownToken,
    helpers: MarkdownParseHelpers,
  ) {
    const target = String(token.target ?? "").trim();
    return helpers.applyMark(
      "wikiLink",
      [helpers.createTextNode(target)],
      { target },
    );
  },

  // The editor model stores only the visible title. Markdown serialization
  // adds the wiki-link brackets so there are no hidden bracket positions for
  // the caret to enter after a completed link.
  renderMarkdown(
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
  ) {
    const renderedText = helpers.renderChildren(node);
    const target = String(
      (node.attrs as WikiLinkAttributes | undefined)?.target ?? renderedText,
    );
    return target ? `[[${target}]]` : "";
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^\[\]\n]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const target = (match[1] ?? "").trim();
          if (!target) return null;

          const markType = state.schema.marks.wikiLink;
          if (!markType) return null;

          // The input-rule handler runs before the final `]` is inserted:
          // `range.from..range.to` covers `[[Foo]`. Replace that source text
          // with only the visible title; renderMarkdown restores `[[Foo]]`
          // for the file format.
          const markedText = state.schema.text(
            target,
            [markType.create({ target })],
          );
          const { tr } = state;
          tr.replaceWith(range.from, range.to, markedText);
          tr.removeStoredMark(markType);
          // Fall through without an explicit return so Tiptap's input-rule
          // runtime actually dispatches our transaction.
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const extension = this;

    return [
      new Plugin({
        key: WIKI_LINK_DECORATION_KEY,
        state: {
          init: (_, state) => buildMissingDecorations(state.doc, extension.storage.docs),
          apply: (tr, value, _oldState, newState) => {
            if (!tr.docChanged && !tr.getMeta(WIKI_LINK_DECORATION_KEY)) {
              return value;
            }
            return buildMissingDecorations(newState.doc, extension.storage.docs);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClick: (view, pos, event) => {
            if (event.button !== 0) return false;
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
              return false;
            }

            // `posAtCoords` happily maps clicks in the trailing gutter of a
            // line to the position just past the last character — whose
            // marks still include any wiki-link at the end of the line. Gate
            // the handler on the actual DOM target to avoid misfires when
            // the user clicks empty space beside (not on) a wiki-link.
            const domTarget = event.target as HTMLElement | null;
            const wikiEl = domTarget?.closest(".wiki-link");
            if (!wikiEl || !view.dom.contains(wikiEl)) return false;

            const $pos = view.state.doc.resolve(pos);
            const marks = $pos.marks();
            const wikiMark = marks.find((mark) => mark.type.name === "wikiLink");
            if (!wikiMark) return false;

            const target = (wikiMark.attrs as WikiLinkAttributes).target ?? "";
            if (!target) return false;

            const hit = findDocByTitle(extension.storage.docs, target);
            if (!hit) {
              // Missing target — let the click fall through so the user can
              // still place the caret and edit the bracketed text.
              return false;
            }

            extension.storage.navigateToTitle(target);
            event.preventDefault();
            return true;
          },
        },
      }),
      // Atomicity + content integrity for the wikiLink mark. Completed links
      // store only the visible title, and the brackets exist only when
      // serializing markdown. This keeps caret positions out of hidden
      // syntax and makes the mark behave like a single link run.
      //
      //   1. storedMarks hygiene — never let wikiLink sit in storedMarks,
      //      so the next typed character can't inherit it regardless of
      //      where the caret sits.
      //
      //   2. Content integrity — when a wikiLink run's text still contains
      //      the canonical target substring but has extra characters at
      //      either end, trim the mark back to exactly that substring.
      //
      //   3. Caret atomicity — if the caret ends up *inside* a complete
      //      wikiLink mark, snap it out to the nearest boundary in the
      //      direction the user was moving. Completed links only re-enter
      //      bracket-edit mode through the explicit hover popover.
      new Plugin({
        key: new PluginKey("wikiLinkAtomicity"),
        props: {
          handleTextInput: (view, from, to, text) => {
            const markType = view.state.schema.marks.wikiLink;
            if (!markType || from !== to || !text) return false;

            const run = findCompleteWikiLinkBeforeOrInside(view.state, from);
            if (!run) return false;

            const activeMarks = (
              view.state.storedMarks ?? view.state.selection.$from.marks()
            ).filter((mark) => mark.type !== markType);
            const textNode = view.state.schema.text(text, activeMarks);
            const tr = view.state.tr.insert(run.to, textNode);
            tr.removeStoredMark(markType);
            tr.setSelection(TextSelection.create(tr.doc, run.to + text.length));
            view.dispatch(tr);
            return true;
          },
          handleKeyDown: (view, event) => {
            if (
              event.key !== "Backspace"
              || event.altKey
              || event.ctrlKey
              || event.metaKey
              || !view.state.selection.empty
            ) {
              return false;
            }

            const markType = view.state.schema.marks.wikiLink;
            if (!markType) return false;

            const run = findCompleteWikiLinkBeforeOrInside(
              view.state,
              view.state.selection.from,
            );
            if (!run) return false;

            event.preventDefault();
            const tr = view.state.tr.delete(run.from, run.to);
            tr.removeStoredMark(markType);
            view.dispatch(tr);
            return true;
          },
        },
        appendTransaction: (transactions, oldState, newState) => {
          const markType = newState.schema.marks.wikiLink;
          if (!markType) return null;

          const docChanged = transactions.some((tr) => tr.docChanged);
          const selChanged = transactions.some(
            (tr) => tr.selectionSet && !tr.docChanged,
          );
          if (!docChanged && !selChanged) return null;

          const tr = newState.tr;
          let mutated = false;

          // (1) Purge wikiLink from storedMarks. If PM ever parks the mark
          // in the stored set (via `inheritMarks` or a stale rule), the
          // next keystroke would absorb into the link despite
          // `inclusive: false`. Strip it proactively.
          const stored = newState.storedMarks;
          if (stored && stored.some((m) => m.type.name === "wikiLink")) {
            const filtered = stored.filter((m) => m.type.name !== "wikiLink");
            tr.setStoredMarks(filtered.length > 0 ? filtered : null);
            mutated = true;
          }

          // (2) Trim leaked extensions on either side of the target text.
          if (docChanged) {
            newState.doc.descendants((node, pos) => {
              if (!node.isText) return;
              const mark = node.marks.find((m) => m.type.name === "wikiLink");
              if (!mark) return;

              const text = node.text ?? "";
              const target = (mark.attrs as WikiLinkAttributes).target ?? "";
              if (!target) return;

              const expected = target;
              if (text === expected) return;

              const expectedIdx = text.indexOf(expected);
              if (expectedIdx < 0) return;

              const from = pos;
              const to = pos + node.nodeSize;
              const keepFrom = from + expectedIdx;
              const keepTo = keepFrom + expected.length;
              if (keepFrom > from) {
                tr.removeMark(from, keepFrom, markType);
                mutated = true;
              }
              if (keepTo < to) {
                tr.removeMark(keepTo, to, markType);
                mutated = true;
              }
            });
          }

          // (3) Caret snap. Completed links can only be edited by converting
          // the mark back to bracket text through the hover popover.
          if (docChanged || selChanged) {
            const sel = newState.selection;
            if (sel.empty) {
              const caretPos = sel.$anchor.pos;
              const run = findCompleteWikiLinkBeforeOrInside(
                newState,
                caretPos,
              );
              if (run && caretPos > run.from && caretPos < run.to) {
                const oldPos = oldState.selection.$anchor.pos;
                const movingForward = caretPos >= oldPos;
                const snapTo = docChanged
                  ? (
                    caretPos - run.from <= run.to - caretPos
                      ? run.from
                      : run.to
                  )
                  : (movingForward ? run.to : run.from);

                tr.setSelection(TextSelection.create(newState.doc, snapTo));
                mutated = true;
              }
            }
          }

          return mutated ? tr : null;
        },
      }),
    ];
  },
});

function buildMissingDecorations(
  doc: import("@tiptap/pm/model").Node,
  docs: NoteDoc[],
): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const wikiMark = node.marks.find((m) => m.type.name === "wikiLink");
    if (!wikiMark) return;

    const from = pos;
    const to = pos + node.nodeSize;

    const target = (wikiMark.attrs as WikiLinkAttributes).target ?? "";
    const exists = !!findDocByTitle(docs, target);
    if (!exists) {
      decorations.push(
        Decoration.inline(from, to, { class: "wiki-link-missing" }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

/** Dispatch a no-op transaction that flags the decoration plugin to rebuild. */
export function refreshWikiLinkDecorations(editor: import("@tiptap/core").Editor): void {
  const { tr } = editor.state;
  tr.setMeta(WIKI_LINK_DECORATION_KEY, { refresh: true });
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

export default WikiLink;
