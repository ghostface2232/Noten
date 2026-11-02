import { useEffect, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { insertImagesAtPosition, isImagePath } from "../extensions/ImageDrop";
import { inputHeld } from "../utils/updateInputHold";

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx|txt)$/i;

export interface UseDragDropParams {
  tiptapRef: RefObject<TiptapEditorHandle | null>;
  docReady: boolean;
  importFiles: (paths: string[]) => Promise<void>;
  setIsDirty: (v: boolean) => void;
  scheduleAutoSave: () => void;
}

export function useDragDrop({
  tiptapRef,
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
      // Native drops bypass the DOM, so the install's input hold cannot
      // swallow them; an import would be cut short by the installer.
      if (inputHeld()) return;

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

      if (!docReady) return;

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
  }, [docReady, importFiles, scheduleAutoSave, setIsDirty, tiptapRef]);
}
