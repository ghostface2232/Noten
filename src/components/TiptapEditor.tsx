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
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { CopySelectRegular, RenameRegular } from "@fluentui/react-icons";
import { common, createLowlight } from "lowlight";
import MermaidCodeBlock from "../extensions/MermaidCodeBlock";
import SlashCommands from "../extensions/SlashCommands";
import ImageDrop from "../extensions/ImageDrop";
import { createImageNodeView } from "../extensions/ImageView";
import TextContextMenu, {
  createTiptapTextContextMenuContext,
  isBelowTiptapDocumentEnd,
  moveTiptapSelectionToEnd,
  showGenericContextMenu,
} from "../extensions/TextContextMenu";
import { SearchHighlight } from "../extensions/SearchHighlight";
import { t } from "../i18n";
import type { Locale, WordWrap } from "../hooks/useSettings";
import "../styles/tiptap-editor.css";
import "../styles/mermaid-theme.css";

declare module "@tiptap/core" {
  interface Storage {
    readonlyGuard: { readonly: boolean };
    slashCommands: { locale: string };
    markdownPaste: { keepFormatOnPaste: boolean };
    documentContext: { noteId: string | null; filePath: string | null };
  }
}

const MD_PATTERN = /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^>\s|^```|^\|.+\||\[.+\]\(.+\)/m;
type TextRange = { from: number; to: number };
const LINK_HOVER_CLOSE_DELAY_MS = 300;
const LINK_HOVER_SAFE_ZONE_PX = 16;
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

function normalizeLinkHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("#")) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function isPointInExpandedRect(x: number, y: number, rect: DOMRect, expandBy: number): boolean {
  return (
    x >= rect.left - expandBy
    && x <= rect.right + expandBy
    && y >= rect.top - expandBy
    && y <= rect.bottom + expandBy
  );
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

function moveSelectionAfterSelectedImage(editor: Editor): boolean {
  const { state, view } = editor;
  const { selection } = state;
  if (!isImageNodeSelection(selection)) return false;

  const imageAfterPos = Math.min(selection.from + selection.node.nodeSize, state.doc.content.size);
  const nextSelection = createSelectionAfterImage(editor, imageAfterPos);
  view.dispatch(state.tr.setSelection(nextSelection));
  return true;
}

function moveSelectionAfterAdjacentImageAtCoords(editor: Editor, x: number, y: number): boolean {
  const targetPos = editor.view.posAtCoords({ left: x, top: y })?.pos;
  if (typeof targetPos !== "number") return false;

  const resolved = editor.state.doc.resolve(targetPos);
  const imageBefore = resolved.nodeBefore?.type.name === "image" ? resolved.nodeBefore : null;
  const imageAfter = resolved.nodeAfter?.type.name === "image" ? resolved.nodeAfter : null;

  let imagePos: number | null = null;
  let imageNodeSize = 0;
  if (imageBefore) {
    imageNodeSize = imageBefore.nodeSize;
    imagePos = targetPos - imageNodeSize;
  } else if (imageAfter) {
    imageNodeSize = imageAfter.nodeSize;
    imagePos = targetPos;
  } else {
    return false;
  }

  const imageDom = editor.view.nodeDOM(imagePos) as HTMLElement | null;
  if (!imageDom) return false;
  const rect = imageDom.getBoundingClientRect();
  const clickedInsideImage = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  if (clickedInsideImage) return false;

  const cursorPos = Math.min(imagePos + imageNodeSize, editor.state.doc.content.size);
  const nextSelection = createSelectionAfterImage(editor, cursorPos);
  editor.view.dispatch(editor.state.tr.setSelection(nextSelection));
  return true;
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
    const localeRef = useRef(locale);
    localeRef.current = locale;
    const spellcheckRef = useRef(spellcheck);
    const spellcheckRefreshFrameRef = useRef<number | null>(null);
    const linkPopoverRef = useRef<HTMLDivElement | null>(null);
    const linkInputRef = useRef<HTMLInputElement | null>(null);
    const linkRangeRef = useRef<TextRange | null>(null);
    const linkPopoverCleanupRef = useRef<(() => void) | null>(null);
    const linkHoverPopoverRef = useRef<HTMLDivElement | null>(null);
    const linkHoverPopoverCleanupRef = useRef<(() => void) | null>(null);
    const linkHoverCloseTimerRef = useRef<number | null>(null);
    const linkHoverClientXRef = useRef<number | null>(null);
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
      linkPopoverCleanupRef.current?.();
      linkPopoverCleanupRef.current = null;
    }, []);

    const closeLinkHoverPopover = useCallback(() => {
      if (linkHoverCloseTimerRef.current !== null) {
        window.clearTimeout(linkHoverCloseTimerRef.current);
        linkHoverCloseTimerRef.current = null;
      }
      setLinkHoverPopoverOpen(false);
      setLinkHoverHref("");
      setLinkHoverAnchorEl(null);
      setLinkHoverPos(null);
      linkHoverClientXRef.current = null;
      linkHoverPopoverCleanupRef.current?.();
      linkHoverPopoverCleanupRef.current = null;
    }, []);

    const scheduleCloseLinkHoverPopover = useCallback(() => {
      if (linkHoverCloseTimerRef.current !== null) return;
      linkHoverCloseTimerRef.current = window.setTimeout(() => {
        closeLinkHoverPopover();
      }, LINK_HOVER_CLOSE_DELAY_MS);
    }, [closeLinkHoverPopover]);

    const clearLinkHoverCloseTimer = useCallback(() => {
      if (linkHoverCloseTimerRef.current !== null) {
        window.clearTimeout(linkHoverCloseTimerRef.current);
        linkHoverCloseTimerRef.current = null;
      }
    }, []);

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
        StarterKit.configure({ codeBlock: false, underline: false }),
        Markdown,
        Link.configure({
          autolink: true,
          linkOnPaste: true,
          openOnClick: false,
          defaultProtocol: "https",
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
        ReadonlyGuard,
        SlashCommands,
        ImageDrop,
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
          // Note quiet 상태 전환 시 이미지 선택/핸들/아웃라인 해제
          if (editor.state.selection instanceof NodeSelection) {
            editor.commands.setTextSelection(0);
          }
        }
      }
    }, [closeLinkHoverPopover, closeLinkPopover, editor, editable]);

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
      if (linkHoverCloseTimerRef.current !== null) {
        window.clearTimeout(linkHoverCloseTimerRef.current);
      }
      linkHoverPopoverCleanupRef.current?.();
      linkPopoverCleanupRef.current?.();
    }, []);

    useEffect(() => {
      if (!linkPopoverOpen) return;
      const popoverEl = linkPopoverRef.current;
      const range = linkRangeRef.current;
      if (!editor || !popoverEl || !range) return;

      const reference = {
        contextElement: editor.view.dom,
        getBoundingClientRect: () => getSelectionRect(editor, range),
      };

      const updatePosition = () => {
        void computePosition(reference, popoverEl, {
          strategy: "fixed",
          placement: "top",
          middleware: [offset(10), flip(), shift({ padding: 8 })],
        }).then(({ x, y }) => {
          popoverEl.style.left = `${x}px`;
          popoverEl.style.top = `${y}px`;
        });
      };

      const cleanup = autoUpdate(reference, popoverEl, updatePosition, { animationFrame: true });
      linkPopoverCleanupRef.current = cleanup;
      updatePosition();

      requestAnimationFrame(() => {
        linkInputRef.current?.focus();
        linkInputRef.current?.select();
        updateLinkInputFades();
      });

      return () => {
        cleanup();
        if (linkPopoverCleanupRef.current === cleanup) {
          linkPopoverCleanupRef.current = null;
        }
      };
    }, [editor, linkPopoverOpen, updateLinkInputFades]);

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
      if (!linkPopoverOpen) return;

      const handleMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (target && linkPopoverRef.current?.contains(target)) {
          return;
        }
        closeLinkPopover();
      };

      window.addEventListener("mousedown", handleMouseDown, true);
      return () => window.removeEventListener("mousedown", handleMouseDown, true);
    }, [closeLinkPopover, linkPopoverOpen]);

    useEffect(() => {
      if (linkPopoverOpen) {
        closeLinkHoverPopover();
      }
    }, [closeLinkHoverPopover, linkPopoverOpen]);

    useEffect(() => {
      if (!linkHoverPopoverOpen) return;
      const popoverEl = linkHoverPopoverRef.current;
      const anchorEl = linkHoverAnchorEl;
      if (!editor || !popoverEl || !anchorEl) return;

      const reference = {
        contextElement: editor.view.dom,
        getBoundingClientRect: () => {
          const anchorRect = anchorEl.getBoundingClientRect();
          const x = linkHoverClientXRef.current ?? (anchorRect.left + anchorRect.right) / 2;
          return new DOMRect(x, anchorRect.top, 0, Math.max(1, anchorRect.height));
        },
      };

      const updatePosition = () => {
        void computePosition(reference, popoverEl, {
          strategy: "fixed",
          placement: "top-start",
          middleware: [offset(6), flip(), shift({ padding: 8 })],
        }).then(({ x, y }) => {
          popoverEl.style.left = `${x}px`;
          popoverEl.style.top = `${y}px`;
        });
      };

      const cleanup = autoUpdate(reference, popoverEl, updatePosition, { animationFrame: true });
      linkHoverPopoverCleanupRef.current = cleanup;
      updatePosition();

      return () => {
        cleanup();
        if (linkHoverPopoverCleanupRef.current === cleanup) {
          linkHoverPopoverCleanupRef.current = null;
        }
      };
    }, [editor, linkHoverAnchorEl, linkHoverPopoverOpen]);

    useEffect(() => {
      if (!linkHoverPopoverOpen) return;

      const handleMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (target && linkHoverPopoverRef.current?.contains(target)) {
          return;
        }
        closeLinkHoverPopover();
      };

      window.addEventListener("mousedown", handleMouseDown, true);
      return () => window.removeEventListener("mousedown", handleMouseDown, true);
    }, [closeLinkHoverPopover, linkHoverPopoverOpen]);

    useEffect(() => {
      if (!editor) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        if (!editor.isFocused) return;
        if (!moveSelectionAfterSelectedImage(editor)) return;
        event.preventDefault();
      };

      const handleMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (target && editor.view.dom.contains(target)) return;
        moveSelectionAfterSelectedImage(editor);
      };

      window.addEventListener("keydown", handleKeyDown, true);
      window.addEventListener("mousedown", handleMouseDown, true);
      return () => {
        window.removeEventListener("keydown", handleKeyDown, true);
        window.removeEventListener("mousedown", handleMouseDown, true);
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
            const moved = moveSelectionAfterAdjacentImageAtCoords(editor, event.clientX, event.clientY);
            if (moved) {
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

          if (linkHoverPopoverOpen) {
            const popoverRect = linkHoverPopoverRef.current?.getBoundingClientRect();
            if (popoverRect && isPointInExpandedRect(mouseX, mouseY, popoverRect, LINK_HOVER_SAFE_ZONE_PX)) {
              clearLinkHoverCloseTimer();
              return;
            }
          }

          const target = event.target as HTMLElement | null;
          const anchor = target?.closest("a") as HTMLAnchorElement | null;
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
