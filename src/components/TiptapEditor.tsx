import {
  useEffect,
  useImperativeHandle,
  forwardRef,
  useRef,
  useCallback,
  useState,
  type CSSProperties,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, TextSelection, EditorState, Selection } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { Fragment, Slice } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { usePopoverAnchor, type PopoverReference } from "../hooks/usePopoverAnchor";
import { useHoverDismissTimer } from "../hooks/useHoverDismissTimer";
import { HOVER_SAFE_ZONE_PX, isPointInExpandedRect } from "../utils/popoverGeometry";
import { CopySelectRegular, RenameRegular } from "@fluentui/react-icons";
import { common, createLowlight } from "lowlight";
import MermaidCodeBlock from "../extensions/MermaidCodeBlock";
import SlashCommands from "../extensions/SlashCommands";
import ImageDrop from "../extensions/ImageDrop";
import { createImageNodeView } from "../extensions/ImageView";
import WikiLink from "../extensions/WikiLink";
import WikiLinkSuggestion from "../extensions/WikiLinkSuggestion";
import TextContextMenu, {
  createTiptapTextContextMenuContext,
  isBelowTiptapDocumentEnd,
  moveTiptapSelectionToEnd,
  showGenericContextMenu,
} from "../extensions/TextContextMenu";
import { SearchHighlight } from "../extensions/SearchHighlight";
import { t } from "../i18n";
import type { Locale, WordWrap } from "../hooks/useSettings";
import { isSafeLinkHref, normalizeLinkHref } from "../utils/linkHref";
import "../styles/tiptap-editor.css";
import "../styles/mermaid-theme.css";
import "../styles/wiki-link.css";

declare module "@tiptap/core" {
  interface Storage {
    readonlyGuard: { readonly: boolean };
    slashCommands: { locale: string };
    markdownPaste: { keepFormatOnPaste: boolean };
    documentContext: { noteId: string | null; filePath: string | null };
    wikiLink: import("../extensions/WikiLink").WikiLinkStorage;
  }
}

const MD_PATTERN = /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^>\s|^```|^\|.+\||\[.+\]\(.+\)/m;
type TextRange = { from: number; to: number };
const DOC_SESSION_CACHE_LIMIT = 20;

function computeMarkdownSignature(markdown: string): string {
  let hash = 2166136261;
  for (let i = 0; i < markdown.length; i += 1) {
    hash ^= markdown.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${markdown.length}:${hash >>> 0}`;
}

function buildDocumentSessionKey(noteId: string | null, filePath: string | null): string | null {
  if (noteId) return `id:${noteId}`;
  if (!filePath) return null;
  return `path:${filePath.replace(/\\/g, "/").toLowerCase()}`;
}

function createPlainTextSlice(editor: Editor, text: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const paragraph = editor.schema.nodes.paragraph;
  const hardBreak = editor.schema.nodes.hardBreak;

  const nodes = blocks.map((block) => {
    const lines = block.split("\n");
    const content = lines.flatMap((line, index) => {
      const parts = [];
      if (line.length > 0) {
        parts.push(editor.schema.text(line));
      }
      if (index < lines.length - 1 && hardBreak) {
        parts.push(hardBreak.create());
      }
      return parts;
    });

    return paragraph.create(null, content);
  });

  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

function getScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;

  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function refreshRenderedContent(editor: Editor) {
  // Replacing content during IME composition aborts the browser's
  // composition buffer mid-stream — the already-typed jamo are dropped
  // and the user sees nothing until they start the next character.
  if (editor.view.composing) return;

  const scrollParent = getScrollParent(editor.view.dom);
  const scrollTop = scrollParent?.scrollTop ?? 0;
  const scrollLeft = scrollParent?.scrollLeft ?? 0;
  const { from, to } = editor.state.selection;
  const markdown = editor.getMarkdown();
  const wasReadonly = editor.storage.readonlyGuard.readonly;

  editor.storage.readonlyGuard.readonly = false;
  editor.commands.setContent(markdown, {
    emitUpdate: false,
    contentType: "markdown",
  });
  editor.storage.readonlyGuard.readonly = wasReadonly;
  editor.commands.setTextSelection({ from, to });

  if (scrollParent) {
    requestAnimationFrame(() => {
      scrollParent.scrollTop = scrollTop;
      scrollParent.scrollLeft = scrollLeft;
    });
  }
}

function refreshSpellcheckMarkers(editor: Editor, forceFullRefresh = false) {
  // Toggling the `spellcheck` attribute while the browser is holding an
  // active IME composition kills the in-progress preview (observed with
  // Korean IME: typed jamo become invisible until the next character
  // triggers a commit). Skip here; the IMEGuard extension already toggles
  // spellcheck around each composition, so the marker refresh isn't needed
  // mid-IME — see the `imeGuard` plugin below.
  if (editor.view.composing) return;

  const dom = editor.view.dom as HTMLElement;
  const spellcheckEnabled = dom.getAttribute("spellcheck") === "true";

  if (!spellcheckEnabled) {
    return;
  }

  dom.setAttribute("spellcheck", "false");
  void dom.offsetHeight;
  dom.setAttribute("spellcheck", "true");

  if (forceFullRefresh) {
    refreshRenderedContent(editor);
  }
}

function getSelectionRect(editor: Editor, range: TextRange): DOMRect {
  try {
    const start = editor.view.coordsAtPos(range.from);
    const end = editor.view.coordsAtPos(range.to);
    const top = Math.min(start.top, end.top);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right);
    const bottom = Math.max(start.bottom, end.bottom);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    return new DOMRect(left, top, width, height);
  } catch {
    const rect = editor.view.dom.getBoundingClientRect();
    return new DOMRect(rect.left, rect.top, Math.max(1, rect.width), Math.max(1, rect.height));
  }
}


function isImageNodeSelection(selection: unknown): selection is NodeSelection {
  return selection instanceof NodeSelection && selection.node.type.name === "image";
}

function createSelectionAfterImage(editor: Editor, imageAfterPos: number): Selection {
  const resolved = editor.state.doc.resolve(imageAfterPos);
  if (resolved.parent.inlineContent) {
    return TextSelection.create(editor.state.doc, imageAfterPos);
  }

  const gapCursorCtor = GapCursor as unknown as {
    findFrom?: ($pos: unknown, dir: number, mustMove?: boolean) => Selection | null;
    valid?: ($pos: unknown) => boolean;
    new ($pos: unknown): Selection;
  };

  if (typeof gapCursorCtor.findFrom === "function") {
    const found = gapCursorCtor.findFrom(resolved, 1, false);
    if (found) return found;
  }

  if (typeof gapCursorCtor.valid === "function" && gapCursorCtor.valid(resolved)) {
    return new GapCursor(resolved);
  }

  return TextSelection.near(resolved, -1);
}

function clearAllImageOutlines(editor: Editor): void {
  const view = editor.view;
  if (!view) return;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "image") return true;
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (dom) {
      dom.style.outline = "none";
      dom.classList.remove("ProseMirror-selectednode");
      dom.querySelectorAll("[data-corner]").forEach((handle) => {
        const el = handle as HTMLElement;
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
      });
    }
    return true;
  });
}

function moveSelectionAfterSelectedImage(editor: Editor): boolean {
  const { state, view } = editor;
  const { selection } = state;
  if (!isImageNodeSelection(selection)) {
    // Even if PM state doesn't reflect a NodeSelection, defensively clear any stale
    // outline left on image NodeViews so the UI never appears stuck.
    clearAllImageOutlines(editor);
    return false;
  }

  const imageAfterPos = Math.min(selection.from + selection.node.nodeSize, state.doc.content.size);
  const nextSelection = createSelectionAfterImage(editor, imageAfterPos);
  view.dispatch(state.tr.setSelection(nextSelection));
  clearAllImageOutlines(editor);
  return true;
}

function selectAdjacentImageAtCoords(editor: Editor, x: number, y: number): boolean {
  const targetPos = editor.view.posAtCoords({ left: x, top: y })?.pos;
  if (typeof targetPos !== "number") return false;

  const resolved = editor.state.doc.resolve(targetPos);
  const imageBeforeNode = resolved.nodeBefore?.type.name === "image" ? resolved.nodeBefore : null;
  const imageAfterNode = resolved.nodeAfter?.type.name === "image" ? resolved.nodeAfter : null;
  if (!imageBeforeNode && !imageAfterNode) return false;

  // Candidates in priority order: prefer the image BEFORE the click position so that
  // clicking in the blank space to the right of an image selects that image (not the next).
  const candidates: { pos: number }[] = [];
  if (imageBeforeNode) candidates.push({ pos: targetPos - imageBeforeNode.nodeSize });
  if (imageAfterNode) candidates.push({ pos: targetPos });

  // If the click landed strictly inside any image rect, let the image NodeView's own
  // pointerdown handler deal with it (direct click selection).
  for (const cand of candidates) {
    const dom = editor.view.nodeDOM(cand.pos) as HTMLElement | null;
    if (!dom) continue;
    const rect = dom.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return false;
    }
  }

  // Pick the first candidate that shares the click's vertical row, and select it.
  for (const cand of candidates) {
    const dom = editor.view.nodeDOM(cand.pos) as HTMLElement | null;
    if (!dom) continue;
    const rect = dom.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      const selection = NodeSelection.create(editor.state.doc, cand.pos);
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      return true;
    }
  }

  return false;
}

const MarkdownPaste = Extension.create({
  name: "markdownPaste",
  priority: 100,

  addStorage() {
    return { keepFormatOnPaste: true };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage as { keepFormatOnPaste: boolean };

    return [
      new Plugin({
        key: new PluginKey("markdownPaste"),
        props: {
          handlePaste(view, event) {
            const clipboard = event.clipboardData;
            const hasFiles = Array.from(clipboard?.items ?? []).some((item) => item.kind === "file");
            if (hasFiles) return false;

            const text = clipboard?.getData("text/plain");
            if (!text) return false;

            if (!storage.keepFormatOnPaste) {
              event.preventDefault();
              const { tr } = view.state;
              tr.replaceSelection(createPlainTextSlice(editor, text));
              view.dispatch(tr.scrollIntoView());
              requestAnimationFrame(() => {
                refreshSpellcheckMarkers(editor, true);
              });
              return true;
            }

            if (clipboard?.getData("text/html")) return false;
            if (!MD_PATTERN.test(text) || !editor.markdown) return false;

            const parsed = editor.markdown.parse(text);
            if (!parsed) return false;

            const doc = editor.schema.nodeFromJSON(parsed);
            event.preventDefault();

            const { tr } = view.state;
            tr.replaceSelection(new Slice(doc.content, 0, 0));
            view.dispatch(tr.scrollIntoView());
            requestAnimationFrame(() => {
              refreshSpellcheckMarkers(editor, true);
            });
            return true;
          },
        },
      }),
    ];
  },
});

const TableNodeSelect = Extension.create({
  name: "tableNodeSelect",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tableNodeSelect"),
        props: {
          handleKeyDown(view, event) {
            if (
              event.key !== "ArrowDown"
              && event.key !== "ArrowUp"
              && event.key !== "ArrowLeft"
              && event.key !== "ArrowRight"
            ) {
              return false;
            }

            const { selection, doc } = view.state;
            if (selection instanceof NodeSelection) return false;
            if (!(selection instanceof TextSelection) || !selection.empty) return false;

            const pos = selection.$from;
            const forward = event.key === "ArrowDown" || event.key === "ArrowRight";

            if (forward) {
              const after = pos.after();
              if (after < doc.content.size) {
                const nodeAfter = doc.resolve(after).nodeAfter;
                if (nodeAfter?.type.name === "table") {
                  event.preventDefault();
                  view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, after)));
                  return true;
                }
              }
            } else {
              const before = pos.before();
              if (before > 0) {
                const nodeBefore = doc.resolve(before).nodeBefore;
                if (nodeBefore?.type.name === "table") {
                  event.preventDefault();
                  const tablePos = before - nodeBefore.nodeSize;
                  view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, tablePos)));
                  return true;
                }
              }
            }

            return false;
          },
        },
      }),
    ];
  },
});

const linkPopoverCallbackRef: { current: (() => boolean) | undefined } = { current: undefined };

const LinkPopoverShortcut = Extension.create({
  name: "linkPopoverShortcut",

  addKeyboardShortcuts() {
    return {
      "Mod-k": () => {
        return linkPopoverCallbackRef.current?.() ?? false;
      },
    };
  },
});

// IME composition guard.
//
// Root cause this addresses: with `spellcheck="true"` on the editor, the
// browser's spellchecker occasionally races the in-progress IME composition
// preview and the preview never renders — typed Korean jamo stay invisible
// until the user starts the next syllable, which commits the prior one and
// makes it appear. Switching to another document fixes it only because the
// doc-switch path toggles the spellcheck attribute through
// `scheduleSpellcheckRefresh`, resetting the racing state.
//
// The fix disables spellcheck for the duration of each composition (and
// tags the root with `.ime-composing` for CSS hooks), then restores the
// user's spellcheck preference on the next frame — deferring the restore
// so it lands after the browser commits the composed text, not during it.
// A depth counter keeps rapid back-to-back compositions (e.g. typing
// "한국어" fluently) from thrashing the attribute.
const IMEGuard = Extension.create({
  name: "imeGuard",

  addProseMirrorPlugins() {
    let savedSpellcheck: string | null = null;
    let depth = 0;

    const restore = (dom: HTMLElement) => {
      const spellcheckToRestore = savedSpellcheck;
      savedSpellcheck = null;
      depth = 0;
      if (spellcheckToRestore === null) dom.removeAttribute("spellcheck");
      else dom.setAttribute("spellcheck", spellcheckToRestore);
      dom.classList.remove("ime-composing");
    };

    return [
      new Plugin({
        key: new PluginKey("imeGuard"),
        props: {
          handleDOMEvents: {
            compositionstart(view) {
              const dom = view.dom as HTMLElement;
              if (depth === 0) {
                savedSpellcheck = dom.getAttribute("spellcheck");
                dom.setAttribute("spellcheck", "false");
                dom.classList.add("ime-composing");
              }
              depth += 1;
              return false;
            },
            compositionend(view) {
              const dom = view.dom as HTMLElement;
              depth = Math.max(0, depth - 1);
              if (depth > 0) return false;
              const spellcheckToRestore = savedSpellcheck;
              savedSpellcheck = null;
              requestAnimationFrame(() => {
                // If a new composition started before the rAF, leave the
                // guard in place — the next compositionend will handle it.
                if (depth > 0) return;
                if (spellcheckToRestore === null) dom.removeAttribute("spellcheck");
                else dom.setAttribute("spellcheck", spellcheckToRestore);
                dom.classList.remove("ime-composing");
              });
              return false;
            },
            // Belt-and-suspenders: if the editor loses focus mid-composition
            // and the browser doesn't synthesize a compositionend (rare but
            // observed with system-level IME interruptions), `depth` would
            // stay > 0 and the next compositionstart would skip the save.
            // Forcibly reset on blur so the plugin self-heals.
            blur(view) {
              if (depth === 0 && savedSpellcheck === null) return false;
              restore(view.dom as HTMLElement);
              return false;
            },
          },
        },
      }),
    ];
  },
});

const ReadonlyGuard = Extension.create({
  name: "readonlyGuard",

  addStorage() {
    return { readonly: false };
  },

  addProseMirrorPlugins() {
    const storage = this.storage as { readonly: boolean };

    return [
      new Plugin({
        key: new PluginKey("readonlyGuard"),
        filterTransaction(tr) {
          if (storage.readonly && tr.docChanged) {
            return false;
          }
          return true;
        },
        props: {
          handleKeyDown(_view, event) {
            if (!storage.readonly) return false;
            if (event.ctrlKey || event.metaKey) return false;
            if (
              event.key.startsWith("Arrow")
              || event.key === "Home"
              || event.key === "End"
              || event.key === "PageUp"
              || event.key === "PageDown"
            ) {
              return false;
            }
            return true;
          },
          handleDOMEvents: {
            paste(_view, event) {
              if (storage.readonly) {
                event.preventDefault();
                return true;
              }
              return false;
            },
            drop(_view, event) {
              if (storage.readonly) {
                event.preventDefault();
                return true;
              }
              return false;
            },
            cut(_view, event) {
              if (storage.readonly) {
                event.preventDefault();
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

const DocumentContext = Extension.create({
  name: "documentContext",

  addStorage() {
    return { noteId: null, filePath: null };
  },
});

const ImageFocusGuard = Extension.create({
  name: "imageFocusGuard",

  addKeyboardShortcuts() {
    return {
      Escape: () => {
        return moveSelectionAfterSelectedImage(this.editor);
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("imageFocusGuard"),
        props: {
          handleDOMEvents: {
            blur: (view) => {
              const { selection } = view.state;
              if (!(selection instanceof NodeSelection)) return false;
              if (selection.node.type.name !== "image") return false;
              const afterPos = Math.min(
                selection.from + selection.node.nodeSize,
                view.state.doc.content.size,
              );
              const resolved = view.state.doc.resolve(afterPos);
              const nextSelection = resolved.parent.inlineContent
                ? TextSelection.create(view.state.doc, afterPos)
                : TextSelection.near(resolved, -1);
              view.dispatch(view.state.tr.setSelection(nextSelection));
              return false;
            },
          },
        },
      }),
    ];
  },
});

const lowlight = createLowlight(common);

export interface TiptapEditorHandle {
  getMarkdown: () => string;
  setContent: (markdown: string) => void;
  setDocumentContext: (noteId: string | null, filePath: string | null, refresh?: boolean) => void;
  openDocument: (params: {
    noteId: string | null;
    filePath: string | null;
    markdown: string;
    reason?: "init" | "switch" | "window-sync" | "file-watch" | "fallback";
  }) => void;
  invalidateDocumentSession: (noteId: string | null, filePath: string | null) => void;
  setEditable: (editable: boolean) => void;
  getEditor: () => ReturnType<typeof useEditor> | null;
}

interface TiptapEditorProps {
  initialMarkdown: string;
  editable: boolean;
  isDarkMode: boolean;
  locale: Locale;
  paragraphSpacing: number;
  wordWrap: WordWrap;
  keepFormatOnPaste: boolean;
  spellcheck: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onReady?: () => void;
  onChromeActivate?: () => void;
}

type DocumentSession = {
  state: EditorState;
  markdownSignature: string;
  noteId: string | null;
  filePath: string | null;
};

export const TiptapEditor = forwardRef<TiptapEditorHandle, TiptapEditorProps>(
  function TiptapEditor({
    initialMarkdown,
    editable,
    isDarkMode,
    locale,
    paragraphSpacing,
    wordWrap,
    keepFormatOnPaste,
    spellcheck,
    onDirtyChange,
    onReady,
    onChromeActivate,
  }, ref) {
    const dirtyRef = useRef(false);
    const documentSessionsRef = useRef<Map<string, DocumentSession>>(new Map());
    const currentSessionKeyRef = useRef<string | null>(null);
    const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState("");
    const [linkHasValue, setLinkHasValue] = useState(false);
    const [linkInputFadeLeft, setLinkInputFadeLeft] = useState(false);
    const [linkInputFadeRight, setLinkInputFadeRight] = useState(false);
    const [linkHoverPopoverOpen, setLinkHoverPopoverOpen] = useState(false);
    const [linkHoverHref, setLinkHoverHref] = useState("");
    const [linkHoverAnchorEl, setLinkHoverAnchorEl] = useState<HTMLAnchorElement | null>(null);
    const [linkHoverPos, setLinkHoverPos] = useState<number | null>(null);
    const [wikiHoverPopoverOpen, setWikiHoverPopoverOpen] = useState(false);
    const [wikiHoverAnchorEl, setWikiHoverAnchorEl] = useState<HTMLElement | null>(null);
    const [wikiHoverPos, setWikiHoverPos] = useState<number | null>(null);
    const localeRef = useRef(locale);
    localeRef.current = locale;
    const spellcheckRef = useRef(spellcheck);
    const spellcheckRefreshFrameRef = useRef<number | null>(null);
    const linkPopoverRef = useRef<HTMLDivElement | null>(null);
    const linkInputRef = useRef<HTMLInputElement | null>(null);
    const linkRangeRef = useRef<TextRange | null>(null);
    const linkPopoverTeardownRef = useRef<(() => void) | null>(null);
    const linkHoverPopoverRef = useRef<HTMLDivElement | null>(null);
    const linkHoverClientXRef = useRef<number | null>(null);
    const linkHoverTeardownRef = useRef<(() => void) | null>(null);
    const wikiHoverPopoverRef = useRef<HTMLDivElement | null>(null);
    const wikiHoverClientXRef = useRef<number | null>(null);
    const wikiHoverTeardownRef = useRef<(() => void) | null>(null);
    const editorStyle = {
      "--editor-paragraph-spacing": `${paragraphSpacing / 50}em`,
    } as CSSProperties;
    const wrapClass = wordWrap === "char" ? "tiptap-wrap-char" : "tiptap-wrap-word";

    const touchDocumentSession = useCallback((key: string, session: DocumentSession) => {
      const cache = documentSessionsRef.current;
      cache.delete(key);
      cache.set(key, session);
      while (cache.size > DOC_SESSION_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        cache.delete(oldestKey);
      }
    }, []);
    const scheduleSpellcheckRefresh = useCallback((currentEditor: Editor, forceFullRefresh = false) => {
      if (!spellcheckRef.current) return;

      if (spellcheckRefreshFrameRef.current !== null) {
        cancelAnimationFrame(spellcheckRefreshFrameRef.current);
      }

      spellcheckRefreshFrameRef.current = requestAnimationFrame(() => {
        refreshSpellcheckMarkers(currentEditor, forceFullRefresh);
        spellcheckRefreshFrameRef.current = null;
      });
    }, []);

    const handleUpdate = useCallback((currentEditor: Editor, isPaste: boolean) => {
      if (!dirtyRef.current) {
        dirtyRef.current = true;
      }
      onDirtyChange(true);

      if (spellcheckRef.current && isPaste) {
        scheduleSpellcheckRefresh(currentEditor, true);
      }
    }, [onDirtyChange, scheduleSpellcheckRefresh]);

    const closeLinkPopover = useCallback(() => {
      setLinkPopoverOpen(false);
      setLinkHasValue(false);
      linkRangeRef.current = null;
      linkPopoverTeardownRef.current?.();
    }, []);

    const {
      schedule: scheduleCloseLinkHoverPopover,
      clear: clearLinkHoverCloseTimer,
      closeNow: closeLinkHoverPopover,
    } = useHoverDismissTimer({
      onClose: () => {
        setLinkHoverPopoverOpen(false);
        setLinkHoverHref("");
        setLinkHoverAnchorEl(null);
        setLinkHoverPos(null);
        linkHoverClientXRef.current = null;
        linkHoverTeardownRef.current?.();
      },
    });

    const {
      schedule: scheduleCloseWikiHoverPopover,
      clear: clearWikiHoverCloseTimer,
      closeNow: closeWikiHoverPopover,
    } = useHoverDismissTimer({
      onClose: () => {
        setWikiHoverPopoverOpen(false);
        setWikiHoverAnchorEl(null);
        setWikiHoverPos(null);
        wikiHoverClientXRef.current = null;
        wikiHoverTeardownRef.current?.();
      },
    });

    const openLinkPopoverAtRange = useCallback((range: TextRange, href: string) => {
      linkRangeRef.current = range;
      setLinkUrl(href);
      setLinkHasValue(Boolean(href));
      setLinkPopoverOpen(true);
    }, []);

    const updateLinkInputFades = useCallback(() => {
      const inputEl = linkInputRef.current;
      if (!inputEl) {
        setLinkInputFadeLeft(false);
        setLinkInputFadeRight(false);
        return;
      }

      const maxScrollLeft = Math.max(0, inputEl.scrollWidth - inputEl.clientWidth);
      if (maxScrollLeft <= 1) {
        setLinkInputFadeLeft(false);
        setLinkInputFadeRight(false);
        return;
      }

      setLinkInputFadeLeft(inputEl.scrollLeft > 1);
      setLinkInputFadeRight(inputEl.scrollLeft < maxScrollLeft - 1);
    }, []);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({ codeBlock: false, underline: false, link: false }),
        Markdown,
        Link.configure({
          autolink: true,
          linkOnPaste: true,
          openOnClick: false,
          defaultProtocol: "https",
          // Intersect Tiptap's default validator (handles whitespace/edge
          // cases) with our scheme allow-list so every write path — popover
          // save, paste, autolink, render — honours the same rules.
          isAllowedUri: (url, { defaultValidate }) =>
            defaultValidate(url) && isSafeLinkHref(url),
        }),
        MermaidCodeBlock.configure({ lowlight }),
        Image.configure({ allowBase64: true }).extend({
          renderMarkdown(node) {
            const src = node.attrs?.src ?? "";
            const alt = node.attrs?.alt ?? "";
            const title = node.attrs?.title ?? "";
            const width = node.attrs?.width;
            const height = node.attrs?.height;
            if (width || height) {
              const parts = [`src="${src}"`, `alt="${alt}"`];
              if (title) parts.push(`title="${title}"`);
              if (width) parts.push(`width="${width}"`);
              if (height) parts.push(`height="${height}"`);
              return `<img ${parts.join(" ")} />`;
            }
            return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
          },
          addNodeView() {
            return createImageNodeView(this.editor);
          },
        }),
        Placeholder.configure({ placeholder: () => t("placeholder", localeRef.current) }),
        Typography,
        Underline,
        TaskList,
        TaskItem.configure({ nested: true }),
        Table,
        TableRow,
        TableCell,
        TableHeader,
        TableNodeSelect,
        MarkdownPaste,
        DocumentContext,
        IMEGuard,
        ReadonlyGuard,
        SlashCommands,
        WikiLink,
        WikiLinkSuggestion,
        ImageDrop,
        ImageFocusGuard,
        TextContextMenu,
        SearchHighlight,
        LinkPopoverShortcut,
      ],
      content: initialMarkdown,
      contentType: "markdown",
      editable: true,
      immediatelyRender: true,
      onUpdate: ({ editor: currentEditor, transaction }) => {
        const isPaste = transaction.getMeta("paste") === true || transaction.getMeta("uiEvent") === "paste";
        handleUpdate(currentEditor, isPaste);
      },
    });

    const storeCurrentDocumentSession = useCallback(() => {
      if (!editor) return;
      const contextNoteId = editor.storage.documentContext.noteId;
      const contextFilePath = editor.storage.documentContext.filePath;
      const key = currentSessionKeyRef.current ?? buildDocumentSessionKey(contextNoteId, contextFilePath);
      if (!key) return;
      const markdown = editor.getMarkdown();
      touchDocumentSession(key, {
        state: editor.state,
        markdownSignature: computeMarkdownSignature(markdown),
        noteId: contextNoteId,
        filePath: contextFilePath,
      });
    }, [editor, touchDocumentSession]);

    const parseMarkdownToState = useCallback((markdown: string): EditorState | null => {
      if (!editor?.markdown) return null;
      try {
        const parsed = editor.markdown.parse(markdown);
        const doc = editor.schema.nodeFromJSON(parsed);
        return EditorState.create({
          doc,
          plugins: editor.state.plugins,
        });
      } catch {
        return null;
      }
    }, [editor]);

    const replaceCurrentDocumentContent = useCallback((markdown: string, addToHistory: boolean) => {
      if (!editor?.markdown) return false;
      const wasReadonly = editor.storage.readonlyGuard.readonly;
      editor.storage.readonlyGuard.readonly = false;
      try {
        const parsed = editor.markdown.parse(markdown);
        const doc = editor.schema.nodeFromJSON(parsed);

        const replaceTr = closeHistory(editor.state.tr);
        replaceTr.replaceWith(0, editor.state.doc.content.size, doc.content);
        replaceTr.setMeta("preventUpdate", true);
        replaceTr.setMeta("addToHistory", addToHistory);
        editor.view.dispatch(replaceTr);

        const boundaryTr = closeHistory(editor.state.tr);
        boundaryTr.setMeta("preventUpdate", true);
        boundaryTr.setMeta("addToHistory", false);
        editor.view.dispatch(boundaryTr);
        return true;
      } catch {
        return false;
      } finally {
        editor.storage.readonlyGuard.readonly = wasReadonly;
      }
    }, [editor]);

    const openDocument = useCallback((params: {
      noteId: string | null;
      filePath: string | null;
      markdown: string;
      reason?: "init" | "switch" | "window-sync" | "file-watch" | "fallback";
    }) => {
      if (!editor) return;
      closeLinkPopover();
      closeLinkHoverPopover();

      const {
        noteId,
        filePath,
        markdown,
        reason = "switch",
      } = params;
      const nextKey = buildDocumentSessionKey(noteId, filePath);
      const currentKey = currentSessionKeyRef.current;
      const sameSession = !!nextKey && nextKey === currentKey;

      // NodeView image source resolution needs current document context
      // before state/content replacement to avoid initial broken images.
      editor.storage.documentContext.noteId = noteId;
      editor.storage.documentContext.filePath = filePath;

      if (!sameSession) {
        storeCurrentDocumentSession();
      }

      const expectedSignature = computeMarkdownSignature(markdown);
      const cachedSession = nextKey ? documentSessionsRef.current.get(nextKey) : null;
      const shouldRestoreCachedSession = !!cachedSession && cachedSession.markdownSignature === expectedSignature;
      let applied = false;

      if (sameSession) {
        const currentSignature = computeMarkdownSignature(editor.getMarkdown());
        if (currentSignature !== expectedSignature) {
          const shouldTrackInHistory = reason === "window-sync" || reason === "file-watch";
          applied = replaceCurrentDocumentContent(markdown, shouldTrackInHistory);
        } else {
          applied = true;
        }
      } else if (shouldRestoreCachedSession && cachedSession) {
        const wasReadonly = editor.storage.readonlyGuard.readonly;
        editor.storage.readonlyGuard.readonly = false;
        editor.view.updateState(cachedSession.state);
        editor.storage.readonlyGuard.readonly = wasReadonly;
        applied = true;
      } else {
        const nextState = parseMarkdownToState(markdown);
        if (nextState) {
          const wasReadonly = editor.storage.readonlyGuard.readonly;
          editor.storage.readonlyGuard.readonly = false;
          editor.view.updateState(nextState);
          editor.storage.readonlyGuard.readonly = wasReadonly;
          applied = true;
        }
      }

      if (!applied) {
        const wasReadonly = editor.storage.readonlyGuard.readonly;
        editor.storage.readonlyGuard.readonly = false;
        editor.commands.setContent(markdown, {
          emitUpdate: false,
          contentType: "markdown",
        });
        editor.storage.readonlyGuard.readonly = wasReadonly;
      }

      dirtyRef.current = false;

      const resolvedKey = nextKey ?? buildDocumentSessionKey(noteId, filePath);
      currentSessionKeyRef.current = resolvedKey;
      if (resolvedKey) {
        touchDocumentSession(resolvedKey, {
          state: editor.state,
          markdownSignature: expectedSignature,
          noteId,
          filePath,
        });
      }

      if (spellcheckRef.current) {
        scheduleSpellcheckRefresh(editor);
      }
    }, [
      closeLinkHoverPopover,
      closeLinkPopover,
      editor,
      parseMarkdownToState,
      replaceCurrentDocumentContent,
      scheduleSpellcheckRefresh,
      storeCurrentDocumentSession,
      touchDocumentSession,
    ]);

    const invalidateDocumentSession = useCallback((noteId: string | null, filePath: string | null) => {
      const key = buildDocumentSessionKey(noteId, filePath);
      if (!key) return;
      documentSessionsRef.current.delete(key);
      if (currentSessionKeyRef.current === key) {
        currentSessionKeyRef.current = null;
      }
    }, []);

    const triggerLinkPopover = useCallback(() => {
      if (!editor || !editable) return false;

      if (linkPopoverOpen) {
        closeLinkPopover();
        return true;
      }

      const initialSelection = editor.state.selection;
      const hasSelection = !initialSelection.empty;
      const canExpandLink = editor.isActive("link");

      if (!hasSelection && !canExpandLink) {
        return false;
      }

      if (!hasSelection && canExpandLink) {
        editor.chain().focus().extendMarkRange("link").run();
      }

      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) {
        return false;
      }

      const href = editor.getAttributes("link").href;
      const currentUrl = typeof href === "string" ? href : "";
      openLinkPopoverAtRange({ from, to }, currentUrl);
      return true;
    }, [closeLinkPopover, editable, editor, linkPopoverOpen, openLinkPopoverAtRange]);

    linkPopoverCallbackRef.current = triggerLinkPopover;

    const applyLinkFromPopover = useCallback(() => {
      if (!editor) return;
      const range = linkRangeRef.current;
      if (!range || range.from === range.to) return;

      const href = normalizeLinkHref(linkUrl);
      const chain = editor.chain().focus().setTextSelection({ from: range.from, to: range.to });
      if (href) {
        chain.setLink({ href }).run();
      } else {
        chain.unsetLink().run();
      }

      closeLinkPopover();
      editor.commands.focus();
    }, [closeLinkPopover, editor, linkUrl]);

    const removeLinkFromPopover = useCallback(() => {
      if (!editor) return;
      const range = linkRangeRef.current;
      if (!range || range.from === range.to) return;

      editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).unsetLink().run();
      closeLinkPopover();
      editor.commands.focus();
    }, [closeLinkPopover, editor]);

    const copyHoveredLink = useCallback(async () => {
      const href = linkHoverHref.trim();
      if (!href) return;
      try {
        await navigator.clipboard.writeText(href);
      } catch {
        // no-op
      }
      closeLinkHoverPopover();
    }, [closeLinkHoverPopover, linkHoverHref]);

    const editHoveredLink = useCallback(() => {
      if (!editor || linkHoverPos == null) return;

      editor.chain().focus().setTextSelection(linkHoverPos).extendMarkRange("link").run();
      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) return;

      const href = editor.getAttributes("link").href;
      const currentUrl = typeof href === "string" ? href : "";
      closeLinkHoverPopover();
      openLinkPopoverAtRange({ from, to }, currentUrl);
    }, [closeLinkHoverPopover, editor, linkHoverPos, openLinkPopoverAtRange]);

    // Convert the atomic wikiLink mark back into bracket text and park the
    // caret just before the closing `]]`. Suggestion then handles retargeting
    // from the normal editable `[[Title` text.
    const editHoveredWikiLink = useCallback(() => {
      if (!editor || wikiHoverPos == null) return;
      const markType = editor.schema.marks.wikiLink;
      if (!markType) return;

      editor.chain().focus().setTextSelection(wikiHoverPos).extendMarkRange("wikiLink").run();
      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) return;

      const attrs = editor.getAttributes("wikiLink") as { target?: unknown };
      const target = typeof attrs.target === "string"
        ? attrs.target
        : editor.state.doc.textBetween(from, to, "\n", "\ufffc");
      if (!target) return;

      const tr = editor.state.tr;
      const editText = `[[${target}]]`;
      tr.replaceWith(from, to, editor.state.schema.text(editText));
      tr.removeStoredMark(markType);
      const caretPos = from + 2 + target.length;
      tr.setSelection(TextSelection.create(tr.doc, caretPos));
      editor.view.dispatch(tr);
      closeWikiHoverPopover();
      editor.commands.focus();
    }, [closeWikiHoverPopover, editor, wikiHoverPos]);

    useEffect(() => {
      if (editor && onReady) onReady();
    }, [editor, onReady]);

    useEffect(() => {
      if (editor) {
        editor.storage.readonlyGuard.readonly = !editable;
        if (!editable) {
          dirtyRef.current = false;
          closeLinkPopover();
          closeLinkHoverPopover();
          closeWikiHoverPopover();
          // Note quiet 상태 전환 시 이미지 선택/핸들/아웃라인 해제
          if (editor.state.selection instanceof NodeSelection) {
            editor.commands.setTextSelection(0);
          }
        }
      }
    }, [closeLinkHoverPopover, closeLinkPopover, closeWikiHoverPopover, editor, editable]);

    useEffect(() => {
      if (editor?.storage.slashCommands) {
        editor.storage.slashCommands.locale = locale;
      }
      if (editor) {
        editor.view.dispatch(editor.state.tr);
      }
    }, [editor, locale]);

    useEffect(() => {
      if (editor?.storage.markdownPaste) {
        editor.storage.markdownPaste.keepFormatOnPaste = keepFormatOnPaste;
      }
    }, [editor, keepFormatOnPaste]);

    useEffect(() => {
      spellcheckRef.current = spellcheck;
    }, [spellcheck]);

    useEffect(() => {
      if (!editor) return;
      editor.view.dom.setAttribute("spellcheck", String(spellcheck));
      scheduleSpellcheckRefresh(editor, spellcheck);
    }, [editor, scheduleSpellcheckRefresh, spellcheck]);

    useEffect(() => () => {
      if (spellcheckRefreshFrameRef.current !== null) {
        cancelAnimationFrame(spellcheckRefreshFrameRef.current);
      }
    }, []);

    const linkPopoverGetReference = useCallback((): PopoverReference | null => {
      const range = linkRangeRef.current;
      if (!editor || !range) return null;
      return {
        contextElement: editor.view.dom,
        getBoundingClientRect: () => getSelectionRect(editor, range),
      };
    }, [editor]);

    const { teardownNow: teardownLinkPopover } = usePopoverAnchor({
      open: linkPopoverOpen,
      popoverRef: linkPopoverRef,
      getReference: linkPopoverGetReference,
      placement: "top",
      offsetPx: 10,
      onPositioned: () => {
        linkInputRef.current?.focus();
        linkInputRef.current?.select();
        updateLinkInputFades();
      },
      onOutsideMouseDown: closeLinkPopover,
    });
    linkPopoverTeardownRef.current = teardownLinkPopover;

    useEffect(() => {
      if (!linkPopoverOpen) {
        setLinkInputFadeLeft(false);
        setLinkInputFadeRight(false);
        return;
      }

      const inputEl = linkInputRef.current;
      if (!inputEl) return;

      const update = () => updateLinkInputFades();
      const updateNextFrame = () => {
        requestAnimationFrame(update);
      };

      updateNextFrame();
      inputEl.addEventListener("scroll", update, { passive: true });
      window.addEventListener("resize", updateNextFrame);

      return () => {
        inputEl.removeEventListener("scroll", update);
        window.removeEventListener("resize", updateNextFrame);
      };
    }, [linkPopoverOpen, linkUrl, updateLinkInputFades]);

    useEffect(() => {
      if (linkPopoverOpen) {
        closeLinkHoverPopover();
      }
    }, [closeLinkHoverPopover, linkPopoverOpen]);

    const linkHoverPopoverGetReference = useCallback((): PopoverReference | null => {
      if (!editor || !linkHoverAnchorEl) return null;
      const anchorEl = linkHoverAnchorEl;
      return {
        contextElement: editor.view.dom,
        getBoundingClientRect: () => {
          const anchorRect = anchorEl.getBoundingClientRect();
          const x = linkHoverClientXRef.current ?? (anchorRect.left + anchorRect.right) / 2;
          return new DOMRect(x, anchorRect.top, 0, Math.max(1, anchorRect.height));
        },
      };
    }, [editor, linkHoverAnchorEl]);

    const { teardownNow: teardownLinkHoverPopover } = usePopoverAnchor({
      open: linkHoverPopoverOpen,
      popoverRef: linkHoverPopoverRef,
      getReference: linkHoverPopoverGetReference,
      placement: "top-start",
      offsetPx: 6,
      onOutsideMouseDown: closeLinkHoverPopover,
    });
    linkHoverTeardownRef.current = teardownLinkHoverPopover;

    // Wiki-link hover popover: mirrors the Link hover popover's positioning,
    // outside-click dismissal, and mutual-exclusion with the link edit dialog.
    useEffect(() => {
      if (linkPopoverOpen) {
        closeWikiHoverPopover();
      }
    }, [closeWikiHoverPopover, linkPopoverOpen]);

    const wikiPopoverGetReference = useCallback((): PopoverReference | null => {
      if (!editor || !wikiHoverAnchorEl) return null;
      const anchorEl = wikiHoverAnchorEl;
      return {
        contextElement: editor.view.dom,
        getBoundingClientRect: () => {
          const anchorRect = anchorEl.getBoundingClientRect();
          const x = wikiHoverClientXRef.current ?? (anchorRect.left + anchorRect.right) / 2;
          return new DOMRect(x, anchorRect.top, 0, Math.max(1, anchorRect.height));
        },
      };
    }, [editor, wikiHoverAnchorEl]);

    const { teardownNow: teardownWikiHoverPopover } = usePopoverAnchor({
      open: wikiHoverPopoverOpen,
      popoverRef: wikiHoverPopoverRef,
      getReference: wikiPopoverGetReference,
      placement: "top-start",
      offsetPx: 6,
      onOutsideMouseDown: closeWikiHoverPopover,
    });
    wikiHoverTeardownRef.current = teardownWikiHoverPopover;

    useEffect(() => {
      if (!editor) return;

      // Window-level ESC as a backup to the Tiptap keymap. The Tiptap keymap only fires
      // when view.dom has native focus (e.g. focus-stealing Fluent buttons with
      // preventDefault can leave focus ambiguous). The window handler fires regardless.
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        if (!isImageNodeSelection(editor.state.selection)) return;
        if (moveSelectionAfterSelectedImage(editor)) {
          event.preventDefault();
          event.stopPropagation();
        }
      };

      // Fallback for pointerdown on non-focusable targets (e.g. Tauri drag-region title
      // bar, Fluent sidebar buttons that preventDefault() mousedown and so never blur
      // view.dom).
      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (target && editor.view.dom.contains(target)) return;
        moveSelectionAfterSelectedImage(editor);
      };

      window.addEventListener("keydown", handleKeyDown, true);
      window.addEventListener("pointerdown", handlePointerDown, true);
      return () => {
        window.removeEventListener("keydown", handleKeyDown, true);
        window.removeEventListener("pointerdown", handlePointerDown, true);
      };
    }, [editor]);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => {
          if (!editor) return "";
          return editor.getMarkdown();
        },
        setContent: (markdown: string) => {
          if (!editor) return;
          openDocument({
            noteId: editor.storage.documentContext.noteId,
            filePath: editor.storage.documentContext.filePath,
            markdown,
            reason: "fallback",
          });
        },
        setDocumentContext: (noteId: string | null, filePath: string | null, refresh = true) => {
          if (!editor) return;
          const prevNoteId = editor.storage.documentContext.noteId;
          const prevFilePath = editor.storage.documentContext.filePath;
          editor.storage.documentContext.noteId = noteId;
          editor.storage.documentContext.filePath = filePath;
          if (refresh && (prevNoteId !== noteId || prevFilePath !== filePath)) {
            scheduleSpellcheckRefresh(editor);
          }
        },
        openDocument,
        invalidateDocumentSession,
        setEditable: (value: boolean) => {
          if (!editor) return;
          editor.storage.readonlyGuard.readonly = !value;
          if (!value) {
            dirtyRef.current = false;
            closeLinkPopover();
            closeLinkHoverPopover();
          }
        },
        getEditor: () => editor,
      }),
      [closeLinkHoverPopover, closeLinkPopover, editor, invalidateDocumentSession, openDocument, scheduleSpellcheckRefresh],
    );

    return (
      <div
        className={`${editable ? "tiptap-editable" : "tiptap-readonly"} ${wrapClass}`}
        data-theme={isDarkMode ? "dark" : "light"}
        style={editorStyle}
        onMouseDownCapture={(event) => {
          if (!editor || event.button !== 0) return;
          const target = event.target as HTMLElement | null;
          const isLinkClick = !!target?.closest("a");
          const isImageDirectClick = !!target?.closest("img") || !!target?.closest("[data-corner]");

          if (!isLinkClick) {
            onChromeActivate?.();
          }

          if (!editable || isLinkClick) return;
          if (!isImageDirectClick) {
            const handled = selectAdjacentImageAtCoords(editor, event.clientX, event.clientY);
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              editor.view.focus();
              return;
            }
          }
          if (!isBelowTiptapDocumentEnd(editor, event.clientY)) return;
          event.preventDefault();
          moveTiptapSelectionToEnd(editor);
        }}
        onContextMenuCapture={(event) => {
          if (!editor) return;
          if (!isBelowTiptapDocumentEnd(editor, event.clientY)) return;
          event.preventDefault();
          showGenericContextMenu(
            { x: event.clientX, y: event.clientY },
            createTiptapTextContextMenuContext(editor),
          );
        }}
        onMouseMoveCapture={(event) => {
          if (!editor || linkPopoverOpen) return;
          const mouseX = event.clientX;
          const mouseY = event.clientY;

          // Wiki-link hover — evaluated first so a wiki-link doesn't
          // accidentally trigger the URL-link popover when the two are
          // adjacent.
          if (wikiHoverPopoverOpen) {
            const popoverRect = wikiHoverPopoverRef.current?.getBoundingClientRect();
            if (popoverRect && isPointInExpandedRect(mouseX, mouseY, popoverRect, HOVER_SAFE_ZONE_PX)) {
              clearWikiHoverCloseTimer();
              return;
            }
          }

          const targetEl = event.target as HTMLElement | null;
          const wikiEl = targetEl?.closest(".wiki-link") as HTMLElement | null;
          if (wikiEl && editor.view.dom.contains(wikiEl)) {
            const wikiPos = editor.view.posAtCoords({ left: mouseX, top: mouseY })?.pos;
            if (typeof wikiPos === "number") {
              clearWikiHoverCloseTimer();
              if (!wikiHoverPopoverOpen) {
                wikiHoverClientXRef.current = mouseX;
                setWikiHoverPopoverOpen(true);
                setWikiHoverAnchorEl(wikiEl);
                setWikiHoverPos(wikiPos);
              } else if (wikiHoverAnchorEl !== wikiEl) {
                scheduleCloseWikiHoverPopover();
              } else if (wikiHoverPos == null) {
                setWikiHoverPos(wikiPos);
              }
              // Wiki-link hover takes precedence — skip the URL-link path.
              return;
            }
          } else if (wikiHoverPopoverOpen) {
            scheduleCloseWikiHoverPopover();
          }

          if (linkHoverPopoverOpen) {
            const popoverRect = linkHoverPopoverRef.current?.getBoundingClientRect();
            if (popoverRect && isPointInExpandedRect(mouseX, mouseY, popoverRect, HOVER_SAFE_ZONE_PX)) {
              clearLinkHoverCloseTimer();
              return;
            }
          }

          const anchor = targetEl?.closest("a") as HTMLAnchorElement | null;
          if (!anchor || !editor.view.dom.contains(anchor)) {
            if (linkHoverPopoverOpen) {
              scheduleCloseLinkHoverPopover();
            }
            return;
          }

          const href = (anchor.getAttribute("href") ?? "").trim();
          if (!href) {
            if (linkHoverPopoverOpen) {
              scheduleCloseLinkHoverPopover();
            }
            return;
          }

          const pos = editor.view.posAtCoords({ left: mouseX, top: mouseY })?.pos;
          if (typeof pos !== "number") {
            if (linkHoverPopoverOpen) {
              scheduleCloseLinkHoverPopover();
            }
            return;
          }

          clearLinkHoverCloseTimer();
          if (!linkHoverPopoverOpen) {
            linkHoverClientXRef.current = mouseX;
            setLinkHoverPopoverOpen(true);
            setLinkHoverAnchorEl(anchor);
            setLinkHoverPos(pos);
            setLinkHoverHref(href);
            return;
          }

          if (linkHoverAnchorEl !== anchor) {
            scheduleCloseLinkHoverPopover();
            return;
          }

          if (linkHoverPos == null) {
            setLinkHoverPos(pos);
          }
        }}
        onMouseLeave={() => {
          if (linkHoverPopoverOpen) {
            scheduleCloseLinkHoverPopover();
          }
          if (wikiHoverPopoverOpen) {
            scheduleCloseWikiHoverPopover();
          }
        }}
      >
        <EditorContent editor={editor} />
        {linkHoverPopoverOpen && !linkPopoverOpen && (
          <div
            ref={linkHoverPopoverRef}
            className="tiptap-link-hover-popover"
            role="toolbar"
            aria-label={t("link.popover.title", locale)}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseEnter={clearLinkHoverCloseTimer}
            onMouseLeave={scheduleCloseLinkHoverPopover}
          >
            <button
              type="button"
              className="tiptap-link-hover-button"
              aria-label={t("link.hover.copy", locale)}
              onClick={() => {
                void copyHoveredLink();
              }}
            >
              <CopySelectRegular fontSize={16} />
              <span className="tiptap-link-hover-label">{t("link.hover.copyShort", locale)}</span>
            </button>
            <button
              type="button"
              className="tiptap-link-hover-button"
              aria-label={t("link.hover.edit", locale)}
              onClick={editHoveredLink}
            >
              <RenameRegular fontSize={16} />
              <span className="tiptap-link-hover-label">{t("link.hover.editShort", locale)}</span>
            </button>
          </div>
        )}
        {wikiHoverPopoverOpen && !linkPopoverOpen && (
          <div
            ref={wikiHoverPopoverRef}
            className="tiptap-link-hover-popover"
            role="toolbar"
            aria-label={t("wiki.hover.edit", locale)}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseEnter={clearWikiHoverCloseTimer}
            onMouseLeave={scheduleCloseWikiHoverPopover}
          >
            <button
              type="button"
              className="tiptap-link-hover-button"
              aria-label={t("wiki.hover.edit", locale)}
              onClick={editHoveredWikiLink}
            >
              <RenameRegular fontSize={16} />
              <span className="tiptap-link-hover-label">{t("link.hover.editShort", locale)}</span>
            </button>
          </div>
        )}
        {linkPopoverOpen && (
          <div
            ref={linkPopoverRef}
            className="tiptap-link-popover"
            role="dialog"
            aria-label={t("link.popover.title", locale)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div
              className={`tiptap-link-popover-input-wrap${linkInputFadeLeft ? " show-left-fade" : ""}${linkInputFadeRight ? " show-right-fade" : ""}`}
            >
              <span className="tiptap-link-popover-input-prefix">URL</span>
              <input
                ref={linkInputRef}
                className="tiptap-link-popover-input"
                type="text"
                value={linkUrl}
                onChange={(event) => {
                  setLinkUrl(event.target.value);
                  requestAnimationFrame(updateLinkInputFades);
                }}
                onClick={() => requestAnimationFrame(updateLinkInputFades)}
                onKeyUp={() => requestAnimationFrame(updateLinkInputFades)}
                placeholder={t("link.popover.placeholder", locale)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyLinkFromPopover();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeLinkPopover();
                    editor?.commands.focus();
                  }
                }}
              />
            </div>
            <div className="tiptap-link-popover-actions">
              <button
                type="button"
                className="tiptap-link-popover-button tiptap-link-popover-button-apply"
                onClick={applyLinkFromPopover}
              >
                {t("link.popover.apply", locale)}
              </button>
              {linkHasValue && (
                <button
                  type="button"
                  className="tiptap-link-popover-button tiptap-link-popover-button-danger"
                  onClick={removeLinkFromPopover}
                >
                  {t("link.popover.remove", locale)}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);
