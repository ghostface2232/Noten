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

  /** Tiptap dirty 시 마크다운 추출하여 state 동기화 */
  const flushTiptapIfDirty = useCallback(() => {
    const editor = editorRef.current;
    if (editor && tiptapDirty) {
      const md = editor.getMarkdown();
      setMarkdown(md);
      setTiptapDirty(false);
      return md;
    }
    return null;
  }, [tiptapDirty]);

  /** CodeMirror → Tiptap 동기화 (ReadonlyGuard bypass 포함) */
  const syncCmToTiptap = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const cmValue = codemirrorValueRef.current;
    setMarkdown(cmValue);
    editor.storage.readonlyGuard.readonly = false;
    editor.commands.setContent(cmValue, { contentType: "markdown" });
  }, []);

  const toggleEditing = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (isEditing) {
      if (editorMode === "richtext") {
        flushTiptapIfDirty();
      } else {
        syncCmToTiptap();
        setEditorMode("richtext");
      }
      setIsEditing(false);
    } else {
      setEditorMode("richtext");
      setIsEditing(true);
    }
  }, [isEditing, editorMode, flushTiptapIfDirty, syncCmToTiptap]);

  const switchEditorMode = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !isEditing) return;

    if (editorMode === "richtext") {
      const flushed = flushTiptapIfDirty();
      if (!flushed) {
        // tiptapDirty가 아니면 현재 markdown을 CM ref에 동기화
        codemirrorValueRef.current = markdown;
      } else {
        codemirrorValueRef.current = flushed;
      }
      setEditorMode("markdown");
    } else {
      syncCmToTiptap();
      setEditorMode("richtext");
    }
  }, [isEditing, editorMode, markdown, flushTiptapIfDirty, syncCmToTiptap]);

  const setEditing = useCallback((editing: boolean) => {
    setEditorMode("richtext");
    setIsEditing(editing);
  }, []);

  return {
    markdown,
    isEditing,
    editorMode,
    filePath,
    isDirty,
    tiptapDirty,
    editorRef,
    toggleEditing,
    switchEditorMode,
    updateMarkdown,
    setTiptapDirty,
    setEditing,
    setFilePath,
    setMarkdownRaw: setMarkdown,
    setIsDirty,
  };
}
