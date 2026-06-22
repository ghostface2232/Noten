import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import type { TiptapEditorHandle } from "../components/TiptapEditor";
import { useKeyboardShortcuts, type UseKeyboardShortcutsParams } from "./useKeyboardShortcuts";

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
  };
}

/** Dispatch Ctrl+R from `target` and report whether the default was blocked. */
function pressCtrlR(target: Element): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "r",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

let editorEl: HTMLElement;
let inputEl: HTMLInputElement;
let plainEl: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.dataset.sidebarActive = "";

  editorEl = document.createElement("div");
  editorEl.className = "ProseMirror";
  const editorChild = document.createElement("p");
  editorEl.appendChild(editorChild);

  inputEl = document.createElement("input");
  plainEl = document.createElement("div");

  document.body.append(editorEl, inputEl, plainEl);
});

afterEach(() => {
  editorEl.remove();
  inputEl.remove();
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
});
