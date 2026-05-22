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

export interface UseKeyboardShortcutsParams {
  tiptapRef: RefObject<TiptapEditorHandle | null>;
  docSearchOpen: boolean;
  docGoToLineOpen: boolean;
  setDocSearchOpen: Dispatch<SetStateAction<boolean>>;
  setDocSearchReplace: Dispatch<SetStateAction<boolean>>;
  setDocGoToLineOpen: Dispatch<SetStateAction<boolean>>;
  onNewNote: () => Promise<void>;
  onImportFile: () => void;
  onSaveFile: () => void;
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
  onSaveFile,
}: UseKeyboardShortcutsParams) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const sidebarFocused = document.documentElement.dataset.sidebarActive === "1";
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.key === "Tab" && !isDialogTarget(e.target)) {
        e.preventDefault();
        tiptapRef.current?.getEditor()?.commands.focus();
        return;
      }

      // 개발자용 비밀 단축키 (차단 규칙보다 먼저 처리해 preventDefault 이전에 통과시킴)
      // — Ctrl+Alt+Shift+I: 개발자 도구 토글 (release 빌드에서는 no-op)
      // — Ctrl+Alt+Shift+R: 하드 새로고침 (dev 빌드 전용, release 빌드에서는 차단)
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

      // 브라우저/WebView 단축키 차단 — 사이드바 포커스 시 Ctrl+R은 rename으로 사용
      if ((ctrl && key === "r" && !sidebarFocused) || (ctrl && e.shiftKey && key === "r")) { e.preventDefault(); return; }
      if (e.key === "F5" || e.key === "F12" || e.key === "F7") { e.preventDefault(); return; }
      if (ctrl && e.shiftKey && (key === "i" || key === "j" || key === "c")) { e.preventDefault(); return; }
      if (ctrl && (key === "p" || key === "u")) { e.preventDefault(); return; }
      if (ctrl && (key === "=" || key === "+" || key === "-" || key === "0")) { e.preventDefault(); return; }
      if (ctrl && (e.key === "Add" || e.key === "Subtract")) { e.preventDefault(); return; }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); return; }
      if (e.key === "BrowserBack" || e.key === "BrowserForward") { e.preventDefault(); return; }

      if (ctrl && key === "o") { e.preventDefault(); onImportFile(); }
      if (ctrl && !e.shiftKey && key === "s") { e.preventDefault(); onSaveFile(); }
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
    onSaveFile,
    setDocGoToLineOpen,
    setDocSearchOpen,
    setDocSearchReplace,
    tiptapRef,
  ]);
}
