import { useEffect, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import type { EditorView } from "@codemirror/view";
import { buildImageMarkdownFromPaths, insertImagesAtPosition, isImagePath } from "../extensions/ImageDrop";

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx|txt)$/i;

export interface UseDragDropParams {
  activeCmView: EditorView | null;
  tiptapRef: RefObject<TiptapEditorHandle | null>;
  surface: "note" | "markdown";
  docReady: boolean;
  importFiles: (paths: string[]) => Promise<void>;
  setIsDirty: (v: boolean) => void;
  scheduleAutoSave: () => void;
}

export function useDragDrop({
  activeCmView,
  tiptapRef,
  surface,
  docReady,
  importFiles,
  setIsDirty,
  scheduleAutoSave,
}: UseDragDropParams) {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWindow().onDragDropEvent(async ({ payload }) => {
      if (disposed || payload.type !== "drop") return;

      const markdownPaths = payload.paths.filter((path) => MARKDOWN_FILE_PATTERN.test(path));
      const imagePaths = payload.paths.filter((path) => isImagePath(path));

      if (markdownPaths.length > 0) {
        await importFiles(markdownPaths);
      }

      if (imagePaths.length === 0) {
        return;
      }

      const scale = window.devicePixelRatio || 1;
      const clientX = payload.position.x / scale;
      const clientY = payload.position.y / scale;

      if (surface === "markdown" && activeCmView) {
        const pos = activeCmView.posAtCoords({ x: clientX, y: clientY }) ?? activeCmView.state.doc.length;
        const markdown = await buildImageMarkdownFromPaths(imagePaths);
        const insert = pos > 0 ? `\n\n${markdown}\n\n` : `${markdown}\n\n`;
        activeCmView.dispatch({
          changes: { from: pos, to: pos, insert },
          selection: { anchor: pos + insert.length },
          scrollIntoView: true,
        });
        return;
      }

      if (surface !== "note" || !docReady) return;

      const editor = tiptapRef.current?.getEditor();
      if (!editor) return;
      const pos = editor.view.posAtCoords({ left: clientX, top: clientY })?.pos;
      await insertImagesAtPosition(editor, imagePaths, pos);
      setIsDirty(true);
      scheduleAutoSave();
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    }).catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeCmView, docReady, importFiles, scheduleAutoSave, setIsDirty, surface, tiptapRef]);
}
