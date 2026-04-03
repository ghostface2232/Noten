import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Editor } from "@tiptap/react";
import type { EditorView } from "@codemirror/view";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { openNewWindow } from "../utils/newWindow";

function shortcutTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isEditorShortcutTarget(target: EventTarget | null) {
  const element = shortcutTargetElement(target);
  return !!element?.closest(".ProseMirror, .cm-editor");
}

function isDialogTarget(target: EventTarget | null) {
  const element = shortcutTargetElement(target);
  return !!element?.closest('[role="dialog"]');
}

function toggleMarkdownStrike(cmView: EditorView) {
  const { state } = cmView;
  const selection = state.selection.main;
  if (selection.empty) {
    cmView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: "~~~~" },
      selection: { anchor: selection.from + 2 },
      scrollIntoView: true,
    });
    cmView.focus();
    return;
  }

  const before = selection.from >= 2 ? state.doc.sliceString(selection.from - 2, selection.from) : "";
  const after = selection.to + 2 <= state.doc.length
    ? state.doc.sliceString(selection.to, selection.to + 2)
    : "";

  if (before === "~~" && after === "~~") {
    cmView.dispatch({
      changes: [
        { from: selection.from - 2, to: selection.from, insert: "" },
        { from: selection.to, to: selection.to + 2, insert: "" },
      ],
      selection: { anchor: selection.from - 2, head: selection.to - 2 },
      scrollIntoView: true,
    });
  } else {
    cmView.dispatch({
      changes: [
        { from: selection.from, to: selection.from, insert: "~~" },
        { from: selection.to, to: selection.to, insert: "~~" },
      ],
      selection: { anchor: selection.from + 2, head: selection.to + 2 },
      scrollIntoView: true,
    });
  }

  cmView.focus();
}

export interface UseKeyboardShortcutsParams {
  activeCmView: EditorView | null;
  noteEditor: Editor | null;
  tiptapRef: RefObject<TiptapEditorHandle | null>;
  surface: "note" | "markdown";
  docSearchOpen: boolean;
  docGoToLineOpen: boolean;
  setDocSearchOpen: Dispatch<SetStateAction<boolean>>;
  setDocGoToLineOpen: Dispatch<SetStateAction<boolean>>;
  onToggleSurface: () => void;
  onToggleGoToLine: () => void;
  onNewNote: () => Promise<void>;
  onImportFile: () => void;
  onSaveFile: () => void;
}

export function useKeyboardShortcuts({
  activeCmView,
  noteEditor,
  tiptapRef,
  surface,
  docSearchOpen,
  docGoToLineOpen,
  setDocSearchOpen,
  setDocGoToLineOpen,
  onToggleSurface,
  onToggleGoToLine,
  onNewNote,
  onImportFile,
  onSaveFile,
}: UseKeyboardShortcutsParams) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const sidebarFocused = document.documentElement.dataset.sidebarActive === "1";
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === "Tab" && !isDialogTarget(e.target)) {
        if (surface === "markdown") {
          e.preventDefault();
          activeCmView?.focus();
          return;
        }
        if (surface === "note") {
          e.preventDefault();
          noteEditor?.commands.focus();
          return;
        }
      }

      // 브라우저/WebView 단축키 차단 — 사이드바 포커스 시 Ctrl+R은 rename으로 사용
      if ((ctrl && key === "r" && !sidebarFocused) || (ctrl && e.shiftKey && key === "r")) { e.preventDefault(); return; }
      if (e.key === "F5" || e.key === "F12" || e.key === "F7") { e.preventDefault(); return; }
      if (ctrl && e.shiftKey && (key === "i" || key === "j" || key === "c")) { e.preventDefault(); return; }
      if (ctrl && (key === "p" || key === "u")) { e.preventDefault(); return; }
      if (ctrl && (key === "=" || key === "+" || key === "-" || key === "0")) { e.preventDefault(); return; }
      if (ctrl && (e.key === "Add" || e.key === "Subtract")) { e.preventDefault(); return; }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); return; }
      if (e.key === "BrowserBack" || e.key === "BrowserForward") { e.preventDefault(); return; }

      if (ctrl && key === "/") { e.preventDefault(); onToggleSurface(); }
      if (ctrl && key === "o") { e.preventDefault(); onImportFile(); }
      if (ctrl && !e.shiftKey && key === "s") { e.preventDefault(); onSaveFile(); }
      if (ctrl && !e.shiftKey && key === "n") { e.preventDefault(); void onNewNote(); }
      if (ctrl && e.shiftKey && key === "n") { e.preventDefault(); openNewWindow(); }
      if (ctrl && !e.shiftKey && key === "f") {
        e.preventDefault();
        setDocGoToLineOpen(false);
        setDocSearchOpen((o) => !o);
        return;
      }
      if (ctrl && !e.shiftKey && key === "g") {
        e.preventDefault();
        onToggleGoToLine();
        return;
      }
      if (ctrl && e.shiftKey && key === "x" && isEditorShortcutTarget(e.target)) {
        e.preventDefault();
        if (surface === "markdown" && activeCmView) {
          toggleMarkdownStrike(activeCmView);
        } else if (surface === "note") {
          tiptapRef.current?.getEditor()?.chain().focus().toggleStrike().run();
        }
        return;
      }
      if (e.key === "Escape" && docGoToLineOpen) {
        e.preventDefault();
        setDocGoToLineOpen(false);
      } else if (e.key === "Escape" && docSearchOpen) {
        e.preventDefault();
        setDocSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeCmView,
    docGoToLineOpen,
    docSearchOpen,
    noteEditor,
    onImportFile,
    onNewNote,
    onSaveFile,
    onToggleGoToLine,
    onToggleSurface,
    setDocGoToLineOpen,
    setDocSearchOpen,
    surface,
    tiptapRef,
  ]);
}
