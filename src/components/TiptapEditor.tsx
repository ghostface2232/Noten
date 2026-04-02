import {
  useEffect,
  useImperativeHandle,
  forwardRef,
  useRef,
  useCallback,
  type CSSProperties,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "@tiptap/markdown";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import TextAlign from "@tiptap/extension-text-align";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { common, createLowlight } from "lowlight";
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

declare module "@tiptap/core" {
  interface Storage {
    readonlyGuard: { readonly: boolean };
    slashCommands: { locale: string };
    markdownPaste: { keepFormatOnPaste: boolean };
  }
}

const MD_PATTERN = /^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^>\s|^```|^\|.+\||\[.+\]\(.+\)/m;

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

const MarkdownSafeTextAlign = TextAlign.extend({
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-l": () => true,
      "Mod-Shift-e": () => true,
      "Mod-Shift-r": () => true,
    };
  },
});

const lowlight = createLowlight(common);

export interface TiptapEditorHandle {
  getMarkdown: () => string;
  setContent: (markdown: string) => void;
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
  onToolbarStateActivate?: () => void;
  onActivateQuietState?: () => void;
}

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
    onToolbarStateActivate,
    onActivateQuietState,
  }, ref) {
    const dirtyRef = useRef(false);
    const localeRef = useRef(locale);
    localeRef.current = locale;
    const spellcheckRef = useRef(spellcheck);
    const spellcheckRefreshFrameRef = useRef<number | null>(null);
    const editorStyle = {
      "--editor-paragraph-spacing": `${paragraphSpacing / 50}em`,
    } as CSSProperties;
    const wrapClass = wordWrap === "char" ? "tiptap-wrap-char" : "tiptap-wrap-word";
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

    const editor = useEditor({
      extensions: [
        StarterKit.configure({ codeBlock: false, underline: false }),
        Markdown,
        CodeBlockLowlight.extend({
          renderHTML({ node, HTMLAttributes }) {
            return [
              "pre",
              {
                ...HTMLAttributes,
                "data-language": node.attrs.language || "",
              },
              ["code", { class: node.attrs.language ? `language-${node.attrs.language}` : null }, 0],
            ];
          },
        }).configure({ lowlight }),
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
        MarkdownSafeTextAlign.configure({ types: ["heading", "paragraph"] }),
        Underline,
        TaskList,
        TaskItem.configure({ nested: true }),
        Table,
        TableRow,
        TableCell,
        TableHeader,
        TableNodeSelect,
        MarkdownPaste,
        ReadonlyGuard,
        SlashCommands,
        ImageDrop,
        TextContextMenu,
        SearchHighlight,
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

    useEffect(() => {
      if (editor && onReady) onReady();
    }, [editor, onReady]);

    useEffect(() => {
      if (editor) {
        editor.storage.readonlyGuard.readonly = !editable;
        if (!editable) {
          dirtyRef.current = false;
          // Note quiet 상태 전환 시 이미지 선택/핸들/아웃라인 해제
          if (editor.state.selection instanceof NodeSelection) {
            editor.commands.setTextSelection(0);
          }
        }
      }
    }, [editor, editable]);

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

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => {
          if (!editor) return "";
          return editor.getMarkdown();
        },
        setContent: (markdown: string) => {
          if (!editor) return;
          const wasReadonly = editor.storage.readonlyGuard.readonly;
          editor.storage.readonlyGuard.readonly = false;
          editor.commands.setContent(markdown, {
            emitUpdate: false,
            contentType: "markdown",
          });
          editor.storage.readonlyGuard.readonly = wasReadonly;
          dirtyRef.current = false;
          if (spellcheckRef.current) {
            scheduleSpellcheckRefresh(editor, true);
          }
        },
        setEditable: (value: boolean) => {
          if (!editor) return;
          editor.storage.readonlyGuard.readonly = !value;
          if (!value) {
            dirtyRef.current = false;
          }
        },
        getEditor: () => editor,
      }),
      [editor],
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
          let activated = false;

          if (!isLinkClick) {
            onToolbarStateActivate?.();
          }

          if (!editable && !isLinkClick) {
            onActivateQuietState?.();
            editor.storage.readonlyGuard.readonly = false;
            activated = true;
          }

          if ((!editable && !activated) || isLinkClick) return;
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
      >
        <EditorContent editor={editor} />
      </div>
    );
  },
);
