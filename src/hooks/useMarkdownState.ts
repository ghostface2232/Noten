import { useState, useRef, useCallback } from "react";
import type { Editor } from "@tiptap/react";

export type EditorMode = "richtext" | "markdown";

export interface MarkdownState {
  markdown: string;
  isEditing: boolean;
  editorMode: EditorMode;
  filePath: string | null;
  isDirty: boolean;
  tiptapDirty: boolean;
  editorRef: React.MutableRefObject<Editor | null>;
  readCurrentEditor: () => string;
  toggleEditing: () => void;
  switchEditorMode: () => void;
  updateMarkdown: (value: string) => void;
  setTiptapDirty: (dirty: boolean) => void;
  setEditing: (editing: boolean) => void;
  setFilePath: (path: string | null) => void;
  setMarkdownRaw: (value: string) => void;
  setIsDirty: (dirty: boolean) => void;
}

export function useMarkdownState(): MarkdownState {
  const [markdown, setMarkdown] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("richtext");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [tiptapDirty, setTiptapDirty] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const codemirrorValueRef = useRef<string>("");

  const updateMarkdown = useCallback((value: string) => {
    setMarkdown(value);
    codemirrorValueRef.current = value;
    setIsDirty(true);
  }, []);

  const readCurrentEditor = useCallback(() => {
    const editor = editorRef.current;
    return editorMode === "markdown"
      ? codemirrorValueRef.current
      : editor?.getMarkdown() ?? markdown;
  }, [editorMode, markdown]);

  /**
   * 현재 활성 편집기에서 최신 마크다운을 직접 읽어 state를 동기화.
   * dirty 플래그를 보지 않고 항상 직접 읽되, 값이 바뀐 경우에만 갱신.
   */
  const flushCurrentEditor = useCallback(() => {
    const current = readCurrentEditor();

    if (current !== markdown) {
      setMarkdown(current);
      codemirrorValueRef.current = current;
    }
    setTiptapDirty(false);
    return current;
  }, [markdown, readCurrentEditor]);

  /** 반대편 편집기에 콘텐츠를 로드 (값이 바뀐 경우에만) */
  const loadIntoTiptap = useCallback((md: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const wasReadonly = editor.storage.readonlyGuard.readonly;
    editor.storage.readonlyGuard.readonly = false;
    editor.commands.setContent(md, {
      emitUpdate: false,
      contentType: "markdown",
    });
    editor.storage.readonlyGuard.readonly = wasReadonly;
  }, []);

  const toggleEditing = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (isEditing) {
      const md = flushCurrentEditor();
      if (editorMode === "markdown") {
        loadIntoTiptap(md);
        setEditorMode("richtext");
      }
      setIsEditing(false);
    } else {
      setEditorMode("richtext");
      setIsEditing(true);
    }
  }, [isEditing, editorMode, flushCurrentEditor, loadIntoTiptap]);

  const switchEditorMode = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !isEditing) return;

    const md = flushCurrentEditor();

    if (editorMode === "richtext") {
      codemirrorValueRef.current = md;
      setEditorMode("markdown");
    } else {
      loadIntoTiptap(md);
      setEditorMode("richtext");
    }
  }, [isEditing, editorMode, flushCurrentEditor, loadIntoTiptap]);

  const setEditing = useCallback((editing: boolean) => {
    setEditorMode("richtext");
    setIsEditing(editing);
  }, []);

  const setMarkdownRaw = useCallback((value: string) => {
    codemirrorValueRef.current = value;
    setMarkdown(value);
  }, []);

  return {
    markdown,
    isEditing,
    editorMode,
    filePath,
    isDirty,
    tiptapDirty,
    editorRef,
    readCurrentEditor,
    toggleEditing,
    switchEditorMode,
    updateMarkdown,
    setTiptapDirty,
    setEditing,
    setFilePath,
    setMarkdownRaw,
    setIsDirty,
  };
}
