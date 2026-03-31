import { useMemo, useCallback, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown as cmMarkdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { cmSearchField } from "../extensions/cmSearchHighlight";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { showGenericContextMenu, type TextContextMenuContext } from "../extensions/TextContextMenu";
import type { Locale, WordWrap } from "../hooks/useSettings";
import "../styles/markdown-editor.css";

function moveCursorToDocumentEndIfBelow(view: EditorView, clientY: number) {
  let endCoords: ReturnType<EditorView["coordsAtPos"]> | null = null;
  try {
    endCoords = view.coordsAtPos(view.state.doc.length);
  } catch {
    endCoords = null;
  }

  if (!endCoords || clientY <= endCoords.bottom) {
    return false;
  }

  view.dispatch({
    selection: { anchor: view.state.doc.length },
    scrollIntoView: false,
  });
  view.focus();
  return true;
}

function isBelowDocumentEnd(view: EditorView, clientY: number) {
  let endCoords: ReturnType<EditorView["coordsAtPos"]> | null = null;
  try {
    endCoords = view.coordsAtPos(view.state.doc.length);
  } catch {
    endCoords = null;
  }

  return !!endCoords && clientY > endCoords.bottom;
}

function createContextMenuContext(view: EditorView, locale: Locale): TextContextMenuContext {
  const { from, to } = view.state.selection.main;
  return {
    hasSelection: from !== to,
    isEditable: true,
    locale,
    cut: () => document.execCommand("cut"),
    copy: () => document.execCommand("copy"),
    paste: async () => {
      try {
        const text = await navigator.clipboard.readText();
        view.dispatch(view.state.replaceSelection(text));
      } catch { document.execCommand("paste"); }
      view.focus();
    },
    selectAll: () => {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
    },
    focus: () => view.focus(),
  };
}

/* ─── 라이트 / 다크 팔레트 ─── */
const palette = {
  light: {
    text: "#1b1b1f",
    textSecondary: "#616161",
    codeBg: "#f6f6f6",
    accent: "#0078d4",
    border: "#e0e0e0",
    selection: "rgba(0, 120, 212, 0.3)",
    // 구문 강조
    keyword: "#0078d4",
    string: "#0a7e07",
    number: "#9c5d27",
    comment: "#8b8b8b",
    meta: "#9c5d27",
  },
  dark: {
    text: "#e0e0e0",
    textSecondary: "#9e9e9e",
    codeBg: "#2a2a2a",
    accent: "#4da6ff",
    border: "#404040",
    selection: "rgba(77, 166, 255, 0.3)",
    // 구문 강조
    keyword: "#6cb6ff",
    string: "#7ee787",
    number: "#f0b072",
    comment: "#6e7681",
    meta: "#f0b072",
  },
};

function buildHighlightStyle(dark: boolean) {
  const p = dark ? palette.dark : palette.light;

  return HighlightStyle.define([
    // 헤딩
    { tag: tags.heading1, fontSize: "2em", fontWeight: "bold", color: p.text },
    { tag: tags.heading2, fontSize: "1.5em", fontWeight: "bold", color: p.text },
    { tag: tags.heading3, fontSize: "1.25em", fontWeight: "bold", color: p.text },
    { tag: tags.heading4, fontWeight: "bold", color: p.text },
    { tag: tags.heading5, fontWeight: "bold", color: p.text },
    { tag: tags.heading6, fontWeight: "bold", color: p.text },
    // 서식
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    // 인라인 코드
    { tag: tags.monospace, backgroundColor: p.codeBg, borderRadius: "3px", padding: "0.1em 0.3em" },
    // 링크
    { tag: tags.link, color: p.accent, textDecoration: "underline" },
    { tag: tags.url, color: p.accent },
    // 인용
    { tag: tags.quote, color: p.textSecondary, fontStyle: "italic" },
    // 마크다운 메타 문자 (# - > ``` 등)
    { tag: tags.meta, color: p.meta },
    { tag: tags.processingInstruction, color: p.meta },
    // 코드블럭 내 구문 강조
    { tag: tags.keyword, color: p.keyword },
    { tag: tags.comment, color: p.comment, fontStyle: "italic" },
    { tag: tags.string, color: p.string },
    { tag: tags.number, color: p.number },
    { tag: tags.variableName, color: p.text },
    { tag: tags.definition(tags.variableName), color: p.accent },
    { tag: tags.typeName, color: p.keyword },
    { tag: tags.contentSeparator, color: p.border },
  ]);
}

function buildEditorTheme(dark: boolean) {
  const p = dark ? palette.dark : palette.light;

  return EditorView.theme(
    {
      "&": { color: p.text, backgroundColor: "transparent" },
      ".cm-content": { caretColor: p.accent },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.accent },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: p.selection + " !important",
      },
      ".cm-activeLine": { backgroundColor: "transparent" },
      ".cm-gutters": { display: "none" },
    },
    { dark },
  );
}

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  isDarkMode: boolean;
  locale: Locale;
  wordWrap: WordWrap;
  onViewReady?: (view: EditorView) => void;
}

export function MarkdownEditor({
  value,
  onChange,
  isDarkMode,
  locale,
  wordWrap,
  onViewReady,
}: MarkdownEditorProps) {
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const viewRef = useRef<EditorView | null>(null);

  const extensions = useMemo(() => {
    const hl = buildHighlightStyle(isDarkMode);
    const theme = buildEditorTheme(isDarkMode);

    const cmContextMenu = EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        if (!moveCursorToDocumentEndIfBelow(view, event.clientY)) return false;
        event.preventDefault();
        return true;
      },
      contextmenu(event, view) {
        event.preventDefault();
        showGenericContextMenu(
          { x: event.clientX, y: event.clientY },
          createContextMenuContext(view, localeRef.current),
        );
        return true;
      },
    });

    return [
      cmMarkdown({ codeLanguages: languages }),
      syntaxHighlighting(hl),
      EditorView.lineWrapping,
      theme,
      cmSearchField,
      cmContextMenu,
    ];
  }, [isDarkMode]);

  const handleCreateEditor = useCallback(
    (view: EditorView, _state: EditorState) => {
      viewRef.current = view;
      onViewReady?.(view);
    },
    [onViewReady],
  );

  const handleWrapperMouseDownCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const view = viewRef.current;
    if (!view) return;
    if (!isBelowDocumentEnd(view, event.clientY)) return;
    if (!moveCursorToDocumentEndIfBelow(view, event.clientY)) return;
    event.preventDefault();
  }, []);

  const handleWrapperContextMenuCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const view = viewRef.current;
    if (!view) return;
    if (!isBelowDocumentEnd(view, event.clientY)) return;
    event.preventDefault();
    showGenericContextMenu(
      { x: event.clientX, y: event.clientY },
      createContextMenuContext(view, localeRef.current),
    );
  }, []);

  return (
    <div
      className={`markdown-editor ${wordWrap === "char" ? "markdown-editor-wrap-char" : "markdown-editor-wrap-word"}`}
      onMouseDownCapture={handleWrapperMouseDownCapture}
      onContextMenuCapture={handleWrapperContextMenuCapture}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme="none"
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightSelectionMatches: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          searchKeymap: false,
        }}
        height="100%"
        onCreateEditor={handleCreateEditor}
      />
    </div>
  );
}
