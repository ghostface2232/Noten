import { useState, useRef, useCallback } from "react";
import type { Editor } from "@tiptap/react";

export type EditorSurface = "note" | "markdown";
export type NoteState = "quiet" | "editing";

export interface MarkdownState {
  markdown: string;
  surface: EditorSurface;
  noteState: NoteState;
  filePath: string | null;
  isDirty: boolean;
  tiptapDirty: boolean;
  editorRef: React.MutableRefObject<Editor | null>;
  readCurrentEditor: () => string;
  setSurface: (surface: EditorSurface) => void;
  setNoteState: (state: NoteState) => void;
  enterNoteEditing: () => void;
  exitNoteEditing: () => void;
  updateMarkdown: (value: string) => void;
  setTiptapDirty: (dirty: boolean) => void;
  setFilePath: (path: string | null) => void;
  setMarkdownRaw: (value: string) => void;
  setIsDirty: (dirty: boolean) => void;
}

export function useMarkdownState(): MarkdownState {
  const [markdown, setMarkdown] = useState("");
  const [surface, setSurfaceRaw] = useState<EditorSurface>("note");
  const [noteState, setNoteStateRaw] = useState<NoteState>("quiet");
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
    return surface === "markdown"
      ? codemirrorValueRef.current
      : editor?.getMarkdown() ?? markdown;
  }, [surface, markdown]);

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

  const applySurface = useCallback((nextSurface: EditorSurface) => {
    if (nextSurface === surface) return;

    const md = flushCurrentEditor();

    if (nextSurface === "markdown") {
      codemirrorValueRef.current = md;
      setSurfaceRaw("markdown");
      return;
    }

    const editor = editorRef.current;
    if (editor) {
      loadIntoTiptap(md);
    }
    setSurfaceRaw("note");
  }, [flushCurrentEditor, loadIntoTiptap, surface]);

  const setSurface = useCallback((nextSurface: EditorSurface) => {
    applySurface(nextSurface);
  }, [applySurface]);

  const setNoteState = useCallback((nextState: NoteState) => {
    setNoteStateRaw(nextState);
  }, []);

  const enterNoteEditing = useCallback(() => {
    setNoteStateRaw("editing");
  }, []);

  const exitNoteEditing = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      setNoteStateRaw("quiet");
      return;
    }

    const md = flushCurrentEditor();
    if (surface === "markdown") {
      codemirrorValueRef.current = md;
    } else {
      loadIntoTiptap(md);
    }
    setNoteStateRaw("quiet");
  }, [flushCurrentEditor, loadIntoTiptap, surface]);

  const setMarkdownRaw = useCallback((value: string) => {
    codemirrorValueRef.current = value;
    setMarkdown(value);
  }, []);

  return {
    markdown,
    surface,
    noteState,
    filePath,
    isDirty,
    tiptapDirty,
    editorRef,
    readCurrentEditor,
    setSurface,
    setNoteState,
    enterNoteEditing,
    exitNoteEditing,
    updateMarkdown,
    setTiptapDirty,
    setFilePath,
    setMarkdownRaw,
    setIsDirty,
  };
}
