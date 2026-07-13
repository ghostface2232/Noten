import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Sidebar } from "./Sidebar";
import type { NoteDoc } from "../utils/noteTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

// jsdom has no ResizeObserver; the sidebar uses one to track scroll edges.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

function makeDoc(id: string, name: string): NoteDoc {
  return {
    id,
    filePath: `/notes/${name}.md`,
    fileName: name,
    isDirty: false,
    content: `# ${name}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

const docs = [makeDoc("a", "Alpha"), makeDoc("b", "Beta")];

function makeProps() {
  return {
    docs,
    activeIndex: 0,
    getDocumentContent: (i: number) => docs[i]?.content ?? "",
    onSwitchDocument: vi.fn(),
    onNewNote: vi.fn(),
    onDeleteNote: vi.fn(),
    onDuplicateNote: vi.fn(),
    onExportNote: vi.fn(),
    onRenameNote: vi.fn(),
    onToggleNotePinned: vi.fn(),
    onSetNoteColor: vi.fn(),
    onSetNotesColor: vi.fn(),
    onSetNotesPinned: vi.fn(),
    onImportFile: vi.fn(),
    notesSortOrder: "updated-desc" as const,
    locale: "en" as const,
    onOpenSettings: vi.fn(),
    sidebarSearchOpen: false,
    sidebarSearchQuery: "",
    onSidebarSearchQueryChange: vi.fn(),
    onSidebarSearchClose: vi.fn(),
    groups: [],
    onCreateGroup: vi.fn(() => "g1"),
    onRenameGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    onUngroupGroup: vi.fn(),
    onAddNoteToGroup: vi.fn(),
    onRemoveNoteFromGroup: vi.fn(),
    onRemoveNotesFromGroups: vi.fn(),
    onMoveNotesToGroup: vi.fn(),
    onToggleGroupCollapsed: vi.fn(),
    onReorderGroups: vi.fn(),
    onDeleteNotes: vi.fn(),
    selectMode: false,
    onSelectModeChange: vi.fn(),
    pendingRenameGroupId: null,
    onPendingRenameGroupIdClear: vi.fn(),
    updateAvailable: false,
    isDarkMode: false,
    colorFilter: null,
    onClearColorFilter: vi.fn(),
    deleteUndoToast: null,
    onUndoDelete: vi.fn(),
    onDismissDeleteUndoToast: vi.fn(),
    onDeleteUndoToastHoverStart: vi.fn(),
    onDeleteUndoToastHoverEnd: vi.fn(),
  };
}

function renderSidebar() {
  const props = makeProps();
  const view = render(
    <FluentProvider theme={webLightTheme}>
      <Sidebar {...props} />
    </FluentProvider>,
  );
  return { props, view };
}

/** Click inside the sidebar so its keydown handler treats it as active. */
function activateSidebar() {
  const sidebar = document.querySelector("[data-sidebar]")!;
  sidebar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

/** Dispatch a keydown from app chrome and report whether the default was blocked. */
function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** The inline rename field — unlike the always-present search input, it has no placeholder. */
function renameField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("[data-sidebar] input:not([placeholder])");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  document.documentElement.dataset.sidebarActive = "";
});

describe("Sidebar keyboard shortcuts — exact modifier matching", () => {
  it("Ctrl+D duplicates the active note; Ctrl+Alt+D and Ctrl+Shift+D do not", () => {
    const { props } = renderSidebar();
    activateSidebar();

    expect(press({ key: "d", ctrlKey: true })).toBe(true);
    expect(props.onDuplicateNote).toHaveBeenCalledTimes(1);
    expect(props.onDuplicateNote).toHaveBeenCalledWith(0);

    expect(press({ key: "d", ctrlKey: true, altKey: true })).toBe(false);
    expect(press({ key: "D", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(props.onDuplicateNote).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+E exports the active note; Ctrl+Alt+E does not", () => {
    const { props } = renderSidebar();
    activateSidebar();

    expect(press({ key: "e", ctrlKey: true })).toBe(true);
    expect(props.onExportNote).toHaveBeenCalledTimes(1);

    expect(press({ key: "e", ctrlKey: true, altKey: true })).toBe(false);
    expect(props.onExportNote).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+R starts rename; Ctrl+Alt+R falls through untouched", () => {
    renderSidebar();
    activateSidebar();

    // Ctrl+Alt+R must fall through without opening the inline rename field.
    expect(press({ key: "r", ctrlKey: true, altKey: true })).toBe(false);
    expect(renameField()).toBeNull();

    // The rename branch preventDefaults and opens the inline rename field.
    expect(press({ key: "r", ctrlKey: true })).toBe(true);
    expect(renameField()).not.toBeNull();
    expect(renameField()!.value).toBe("Alpha");
  });

  it("bare F2 starts rename; Ctrl/Shift/Alt+F2 fall through untouched", () => {
    renderSidebar();
    activateSidebar();

    expect(press({ key: "F2", ctrlKey: true })).toBe(false);
    expect(press({ key: "F2", shiftKey: true })).toBe(false);
    expect(press({ key: "F2", altKey: true })).toBe(false);
    expect(renameField()).toBeNull();

    expect(press({ key: "F2" })).toBe(true);
    expect(renameField()).not.toBeNull();
  });

  it("bare Delete deletes the active note; modified Delete does not (pre-existing guard)", () => {
    const { props } = renderSidebar();
    activateSidebar();

    expect(press({ key: "Delete", ctrlKey: true })).toBe(false);
    expect(press({ key: "Delete", shiftKey: true })).toBe(false);
    expect(props.onDeleteNote).not.toHaveBeenCalled();

    expect(press({ key: "Delete" })).toBe(true);
    expect(props.onDeleteNote).toHaveBeenCalledWith(0);
  });

  it("handles Ctrl+R and Ctrl+D with CapsLock on (uppercase key, no Shift) — no WebView reload leak", () => {
    const { props } = renderSidebar();
    activateSidebar();

    // CapsLock reports "R"/"D" without shiftKey. These must still be handled
    // (and preventDefaulted): the useKeyboardShortcuts hook deliberately lets
    // Ctrl+R through when the sidebar is active, so an unhandled chord here
    // would reach the WebView reload accelerator.
    expect(press({ key: "D", ctrlKey: true })).toBe(true);
    expect(props.onDuplicateNote).toHaveBeenCalledTimes(1);

    expect(press({ key: "R", ctrlKey: true })).toBe(true);
    expect(renameField()).not.toBeNull();
  });

  it("Ctrl+Alt+P pins; Ctrl+Alt+Shift+P does not", () => {
    const { props } = renderSidebar();
    activateSidebar();

    expect(press({ key: "p", ctrlKey: true, altKey: true })).toBe(true);
    expect(props.onToggleNotePinned).toHaveBeenCalledTimes(1);

    expect(press({ key: "P", ctrlKey: true, altKey: true, shiftKey: true })).toBe(false);
    expect(props.onToggleNotePinned).toHaveBeenCalledTimes(1);
  });

  it("ignores note shortcuts entirely while the sidebar is not active", () => {
    const { props } = renderSidebar();
    // No activateSidebar() — focus never entered the sidebar.
    expect(press({ key: "d", ctrlKey: true })).toBe(false);
    expect(press({ key: "Delete" })).toBe(false);
    expect(props.onDuplicateNote).not.toHaveBeenCalled();
    expect(props.onDeleteNote).not.toHaveBeenCalled();
  });
});
