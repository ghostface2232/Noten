import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { useKeyboardShortcuts, type UseKeyboardShortcutsParams } from "./useKeyboardShortcuts";
import { openNewWindow } from "../utils/newWindow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("../utils/newWindow", () => ({ openNewWindow: vi.fn() }));

const focusSpy = vi.fn();

function makeParams(): UseKeyboardShortcutsParams {
  const tiptapRef = {
    current: { getEditor: () => ({ commands: { focus: focusSpy } }) },
  } as unknown as RefObject<TiptapEditorHandle | null>;
  return {
    tiptapRef,
    docSearchOpen: false,
    docGoToLineOpen: false,
    setDocSearchOpen: vi.fn(),
    setDocSearchReplace: vi.fn(),
    setDocGoToLineOpen: vi.fn(),
    onNewNote: vi.fn(async () => {}),
    onImportFile: vi.fn(),
    onToggleOutline: vi.fn(),
    onToggleFocusMode: vi.fn(),
  };
}

/** Dispatch a keydown from `target` and report whether the default was blocked. */
function press(target: Element, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const pressCtrlR = (target: Element) => press(target, { key: "r", ctrlKey: true });

let editorEl: HTMLElement;
let inputEl: HTMLInputElement;
let editableEl: HTMLElement;
let plainEl: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.dataset.sidebarActive = "";

  editorEl = document.createElement("div");
  editorEl.className = "ProseMirror";
  const editorChild = document.createElement("p");
  editorEl.appendChild(editorChild);

  inputEl = document.createElement("input");

  editableEl = document.createElement("div");
  editableEl.setAttribute("contenteditable", "true");

  plainEl = document.createElement("div");

  document.body.append(editorEl, inputEl, editableEl, plainEl);
});

afterEach(() => {
  editorEl.remove();
  inputEl.remove();
  editableEl.remove();
  plainEl.remove();
  document.documentElement.dataset.sidebarActive = "";
});

describe("useKeyboardShortcuts — Ctrl+R / WebView reload guard", () => {
  it("blocks Ctrl+R (no reload) when the sidebar is not active", () => {
    renderHook(() => useKeyboardShortcuts(makeParams()));
    expect(pressCtrlR(plainEl)).toBe(true);
  });

  it("lets Ctrl+R through to the sidebar rename handler when the sidebar is active and focus is outside any text-entry region", () => {
    document.documentElement.dataset.sidebarActive = "1";
    renderHook(() => useKeyboardShortcuts(makeParams()));
    // Not prevented here: the sidebar's own keydown handler performs the rename.
    expect(pressCtrlR(plainEl)).toBe(false);
  });

  it("blocks Ctrl+R when the sidebar flag is stale but focus is now inside the editor (Tab-after-click)", () => {
    document.documentElement.dataset.sidebarActive = "1";
    renderHook(() => useKeyboardShortcuts(makeParams()));
    // Target inside .ProseMirror — the stale flag must not let the reload through.
    const editorChild = editorEl.querySelector("p")!;
    expect(pressCtrlR(editorChild)).toBe(true);
  });

  it("blocks Ctrl+R when the sidebar flag is set but focus is in a text input (e.g. rename field)", () => {
    document.documentElement.dataset.sidebarActive = "1";
    renderHook(() => useKeyboardShortcuts(makeParams()));
    expect(pressCtrlR(inputEl)).toBe(true);
  });

  it("blocks Ctrl+R when the sidebar flag is set but focus is in any contentEditable host", () => {
    document.documentElement.dataset.sidebarActive = "1";
    renderHook(() => useKeyboardShortcuts(makeParams()));
    // A contentEditable that is NOT the .ProseMirror editor: the sidebar
    // handler would bail on it, so this layer must block the reload.
    expect(pressCtrlR(editableEl)).toBe(true);
  });

  it("always blocks Ctrl+Shift+R (hard reload) even when the sidebar is active", () => {
    document.documentElement.dataset.sidebarActive = "1";
    renderHook(() => useKeyboardShortcuts(makeParams()));
    expect(press(plainEl, { key: "r", ctrlKey: true, shiftKey: true })).toBe(true);
  });
});

describe("useKeyboardShortcuts — Tab is not hijacked (keyboard navigation)", () => {
  it("lets Tab through from app chrome so focus can leave the editor (WCAG 2.1.1/2.1.2)", () => {
    renderHook(() => useKeyboardShortcuts(makeParams()));
    expect(press(plainEl, { key: "Tab" })).toBe(false);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("lets Tab through from a text input (e.g. find bar Find→Replace)", () => {
    renderHook(() => useKeyboardShortcuts(makeParams()));
    expect(press(inputEl, { key: "Tab" })).toBe(false);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("lets Shift+Tab through from app chrome", () => {
    renderHook(() => useKeyboardShortcuts(makeParams()));
    expect(press(plainEl, { key: "Tab", shiftKey: true })).toBe(false);
  });

  it("does not force focus into the editor on a Tab from inside the editor", () => {
    renderHook(() => useKeyboardShortcuts(makeParams()));
    const editorChild = editorEl.querySelector("p")!;
    // ProseMirror handles list/indent Tab itself; this hook must not intervene.
    expect(press(editorChild, { key: "Tab" })).toBe(false);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});

describe("useKeyboardShortcuts — v0.3.0 toggles (Ctrl+Shift+O, F8)", () => {
  let dialogChild: HTMLElement;

  beforeEach(() => {
    const dialogEl = document.createElement("div");
    dialogEl.setAttribute("role", "dialog");
    dialogChild = document.createElement("button");
    dialogEl.appendChild(dialogChild);
    document.body.appendChild(dialogEl);
  });

  afterEach(() => {
    dialogChild.parentElement?.remove();
  });

  it("Ctrl+Shift+O toggles the outline panel and does NOT fall through to the Ctrl+O import handler", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    expect(press(plainEl, { key: "o", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(params.onToggleOutline).toHaveBeenCalledTimes(1);
    expect(params.onImportFile).not.toHaveBeenCalled();
  });

  it("Ctrl+O still opens the import dialog, not the outline panel", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    expect(press(plainEl, { key: "o", ctrlKey: true })).toBe(true);
    expect(params.onImportFile).toHaveBeenCalledTimes(1);
    expect(params.onToggleOutline).not.toHaveBeenCalled();
  });

  it("F8 toggles focus mode globally — from app chrome and from inside the editor", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    expect(press(plainEl, { key: "F8" })).toBe(true);
    expect(press(editorEl.querySelector("p")!, { key: "F8" })).toBe(true);
    expect(params.onToggleFocusMode).toHaveBeenCalledTimes(2);
  });

  it("ignores F8 while focus is inside an open dialog (e.g. Settings modal)", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    expect(press(dialogChild, { key: "F8" })).toBe(false);
    expect(params.onToggleFocusMode).not.toHaveBeenCalled();
  });

  it("ignores Ctrl+Shift+O while focus is inside an open dialog (e.g. Settings modal)", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    expect(press(dialogChild, { key: "o", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(params.onToggleOutline).not.toHaveBeenCalled();
    expect(params.onImportFile).not.toHaveBeenCalled();
  });

  it("only bare F8 toggles focus mode — Ctrl/Meta/Shift/Alt+F8 do nothing", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    expect(press(plainEl, { key: "F8", ctrlKey: true })).toBe(false);
    expect(press(plainEl, { key: "F8", metaKey: true })).toBe(false);
    expect(press(plainEl, { key: "F8", shiftKey: true })).toBe(false);
    expect(press(plainEl, { key: "F8", altKey: true })).toBe(false);
    expect(params.onToggleFocusMode).not.toHaveBeenCalled();
  });

  it("does not fire Ctrl+O / Ctrl+Shift+O actions when Alt is also held", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    press(plainEl, { key: "o", ctrlKey: true, altKey: true });
    press(plainEl, { key: "o", ctrlKey: true, shiftKey: true, altKey: true });
    expect(params.onImportFile).not.toHaveBeenCalled();
    expect(params.onToggleOutline).not.toHaveBeenCalled();
  });

  it("does not fire Ctrl+N / Ctrl+Shift+N / Ctrl+F actions when Alt is also held", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    press(plainEl, { key: "n", ctrlKey: true, altKey: true });
    press(plainEl, { key: "n", ctrlKey: true, shiftKey: true, altKey: true });
    press(plainEl, { key: "f", ctrlKey: true, altKey: true });
    expect(params.onNewNote).not.toHaveBeenCalled();
    expect(openNewWindow).not.toHaveBeenCalled();
    expect(params.setDocSearchOpen).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+P blocked (reserved for the future quick switcher)", () => {
    const params = makeParams();
    renderHook(() => useKeyboardShortcuts(params));
    expect(press(plainEl, { key: "p", ctrlKey: true })).toBe(true);
    expect(params.onToggleOutline).not.toHaveBeenCalled();
    expect(params.onToggleFocusMode).not.toHaveBeenCalled();
  });
});
