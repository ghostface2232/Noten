import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { openNewWindow } from "../utils/newWindow";

function shortcutTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isEditorShortcutTarget(target: EventTarget | null) {
  const element = shortcutTargetElement(target);
  return !!element?.closest(".ProseMirror");
}

function isDialogTarget(target: EventTarget | null) {
  const element = shortcutTargetElement(target);
  return !!element?.closest('[role="dialog"]');
}

function isTextEntryTarget(target: EventTarget | null) {
  const element = shortcutTargetElement(target);
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  // Any contentEditable host (the editor is also one, but a stray editable
  // surface elsewhere must count too — otherwise Ctrl+R would fall through to
  // the sidebar handler, which bails on contentEditable, and nothing blocks
  // the WebView reload).
  return !!element.closest('[contenteditable="true"], [contenteditable=""]');
}

export interface UseKeyboardShortcutsParams {
  tiptapRef: RefObject<TiptapEditorHandle | null>;
  docSearchOpen: boolean;
  docGoToLineOpen: boolean;
  setDocSearchOpen: Dispatch<SetStateAction<boolean>>;
  setDocSearchReplace: Dispatch<SetStateAction<boolean>>;
  setDocGoToLineOpen: Dispatch<SetStateAction<boolean>>;
  onNewNote: () => Promise<void>;
  onImportFile: () => void;
}

export function useKeyboardShortcuts({
  tiptapRef,
  docSearchOpen,
  docGoToLineOpen,
  setDocSearchOpen,
  setDocSearchReplace,
  setDocGoToLineOpen,
  onNewNote,
  onImportFile,
}: UseKeyboardShortcutsParams) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // The sidebar-active flag is set on mousedown and goes stale once focus
      // moves into a text-entry region by other means (e.g. Tab into the
      // editor, or a rename field). Confirm the live keydown target really is
      // outside the editor / inputs, so Ctrl+R is only let through to the
      // sidebar's rename handler when that handler would actually act on it —
      // otherwise a stale flag lets Ctrl+R fall through and reload the WebView.
      const sidebarFocused =
        document.documentElement.dataset.sidebarActive === "1" &&
        !isEditorShortcutTarget(e.target) &&
        !isTextEntryTarget(e.target);
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === "Tab" && !isDialogTarget(e.target)) {
        e.preventDefault();
        tiptapRef.current?.getEditor()?.commands.focus();
        return;
      }

      // Dev-only shortcuts must run before the browser-shortcut blocker.
      if (ctrl && e.altKey && e.shiftKey && key === "i") {
        e.preventDefault();
        e.stopPropagation();
        void invoke("toggle_devtools").catch(() => {});
        return;
      }
      if (import.meta.env.DEV && ctrl && e.altKey && e.shiftKey && key === "r") {
        e.preventDefault();
        e.stopPropagation();
        window.location.reload();
        return;
      }

      // Block browser/WebView shortcuts; Ctrl+R is sidebar rename when focused.
      if ((ctrl && key === "r" && !sidebarFocused) || (ctrl && e.shiftKey && key === "r")) { e.preventDefault(); return; }
      if (e.key === "F5" || e.key === "F12" || e.key === "F7") { e.preventDefault(); return; }
      if (ctrl && e.shiftKey && (key === "i" || key === "j" || key === "c")) { e.preventDefault(); return; }
      if (ctrl && (key === "p" || key === "u")) { e.preventDefault(); return; }
      if (ctrl && (key === "=" || key === "+" || key === "-" || key === "0")) { e.preventDefault(); return; }
      if (ctrl && (e.key === "Add" || e.key === "Subtract")) { e.preventDefault(); return; }
      // Ctrl+S has no action — autosave persists every ~1s — but is swallowed so
      // the WebView's "save page" dialog never appears.
      if (ctrl && !e.shiftKey && key === "s") { e.preventDefault(); return; }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); return; }
      if (e.key === "BrowserBack" || e.key === "BrowserForward") { e.preventDefault(); return; }

      if (ctrl && key === "o") { e.preventDefault(); onImportFile(); }
      if (ctrl && !e.shiftKey && key === "n") { e.preventDefault(); void onNewNote(); }
      if (ctrl && e.shiftKey && key === "n") { e.preventDefault(); openNewWindow(); }
      if (ctrl && !e.shiftKey && key === "f") {
        e.preventDefault();
        setDocGoToLineOpen(false);
        setDocSearchReplace(false);
        setDocSearchOpen((o) => !o);
        return;
      }
      if (ctrl && !e.shiftKey && key === "h") {
        e.preventDefault();
        setDocGoToLineOpen(false);
        setDocSearchOpen(true);
        setDocSearchReplace(true);
        return;
      }
      if (ctrl && !e.shiftKey && key === "g") {
        e.preventDefault();
        setDocSearchOpen(false);
        setDocSearchReplace(false);
        setDocGoToLineOpen((o) => !o);
        return;
      }
      if (ctrl && e.shiftKey && key === "x" && isEditorShortcutTarget(e.target)) {
        e.preventDefault();
        tiptapRef.current?.getEditor()?.chain().focus().toggleStrike().run();
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
    docGoToLineOpen,
    docSearchOpen,
    onImportFile,
    onNewNote,
    setDocGoToLineOpen,
    setDocSearchOpen,
    setDocSearchReplace,
    tiptapRef,
  ]);
}
