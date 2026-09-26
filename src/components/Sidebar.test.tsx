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
// jsdom elements have no scrollTo; the sidebar scrolls to the top on a query.
Element.prototype.scrollTo = function scrollTo() {};

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

function makeProps(docs: NoteDoc[], sidebarSearchQuery = "") {
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
    sidebarSearchOpen: sidebarSearchQuery !== "",
    sidebarSearchQuery,
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
  const props = makeProps(docs);
  const view = render(
    <FluentProvider theme={webLightTheme}>
      <Sidebar {...props} />
    </FluentProvider>,
  );
  return { props, view };
}

/** Click sidebar chrome (not a note row) so its keydown handler treats it as active. */
function activateSidebar() {
  const sidebar = document.querySelector("[data-sidebar]")!;
  sidebar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

/** Click the note row at `index`, the way a user picks the note they act on. */
function activateNoteRow(index = 0) {
  const row = document.querySelectorAll("[data-note-id]")[index];
  row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

/** Move focus into the sidebar with no pointer event, as Tab navigation does. */
function focusInto(selector: string) {
  const target = document.querySelector(selector)!;
  act(() => {
    target.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
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
  vi.useRealTimers();
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

  it("bare Delete deletes the note row that took the click; modified Delete does not", () => {
    const { props } = renderSidebar();
    activateNoteRow(0);

    expect(press({ key: "Delete", ctrlKey: true })).toBe(false);
    expect(press({ key: "Delete", shiftKey: true })).toBe(false);
    expect(props.onDeleteNote).not.toHaveBeenCalled();

    expect(press({ key: "Delete" })).toBe(true);
    expect(props.onDeleteNote).toHaveBeenCalledWith(0);
  });

  it("Delete is inert when the click landed on sidebar chrome instead of a note row", () => {
    const { props } = renderSidebar();
    activateSidebar();

    // Non-destructive shortcuts still work from anywhere in the sidebar…
    expect(press({ key: "d", ctrlKey: true })).toBe(true);
    expect(props.onDuplicateNote).toHaveBeenCalledTimes(1);

    // …but Delete must not remove a note the user never pointed at.
    expect(press({ key: "Delete" })).toBe(false);
    expect(props.onDeleteNote).not.toHaveBeenCalled();
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

  it("activates on keyboard focus alone and acts on the focused row, not the open note", () => {
    const { props } = renderSidebar();
    // Tab traversal emits focusin without any pointer event; without it the
    // sidebar shortcuts were unreachable for keyboard-only users.
    // Note 0 (Alpha) is the active/open one; Tab moves focus to note 1 (Beta).
    // Targeting activeIndex here would delete the note the user is reading
    // while looking straight at a different row.
    focusInto('[data-note-id="b"]');

    expect(press({ key: "Delete" })).toBe(true);
    expect(props.onDeleteNote).toHaveBeenCalledWith(1);

    expect(press({ key: "d", ctrlKey: true })).toBe(true);
    expect(props.onDuplicateNote).toHaveBeenCalledWith(1);
    expect(press({ key: "e", ctrlKey: true })).toBe(true);
    expect(props.onExportNote).toHaveBeenCalledWith(1);
    expect(press({ key: "p", ctrlKey: true, altKey: true })).toBe(true);
    expect(props.onToggleNotePinned).toHaveBeenCalledWith(1);
  });

  it("acts on the clicked row, not the open note, when they differ", () => {
    const { props } = renderSidebar();
    activateNoteRow(1);

    expect(press({ key: "Delete" })).toBe(true);
    expect(props.onDeleteNote).toHaveBeenCalledWith(1);
  });

  it("renames the focused row rather than the open note", () => {
    renderSidebar();
    focusInto('[data-note-id="b"]');

    expect(press({ key: "F2" })).toBe(true);
    expect(renameField()!.value).toBe("Beta");
  });

  it("falls back to the open note once the pointed row is gone", () => {
    const { props, view } = renderSidebar();
    focusInto('[data-note-id="b"]');

    // The pointed note disappears (deleted elsewhere, filtered out, moved to
    // another window). Its id must not resolve to some other row by position.
    view.rerender(
      <FluentProvider theme={webLightTheme}>
        <Sidebar {...props} docs={[docs[0]]} />
      </FluentProvider>,
    );

    // Non-destructive shortcuts fall back to the open note…
    expect(press({ key: "d", ctrlKey: true })).toBe(true);
    expect(props.onDuplicateNote).toHaveBeenCalledWith(0);
    // …but Delete stays inert rather than deleting a note nobody pointed at.
    expect(press({ key: "Delete" })).toBe(false);
    expect(props.onDeleteNote).not.toHaveBeenCalled();
  });

  it("deactivates when focus leaves the sidebar", () => {
    const { props } = renderSidebar();
    activateNoteRow(0);

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(press({ key: "Delete" })).toBe(false);
    expect(press({ key: "d", ctrlKey: true })).toBe(false);
    expect(props.onDeleteNote).not.toHaveBeenCalled();
    expect(props.onDuplicateNote).not.toHaveBeenCalled();
    outside.remove();
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

function renderSearch(initialDocs: NoteDoc[], query: string) {
  const ui = (d: NoteDoc[]) => (
    <FluentProvider theme={webLightTheme}>
      <Sidebar {...makeProps(d, query)} />
    </FluentProvider>
  );
  const view = render(ui(initialDocs));
  return { rerender: (d: NoteDoc[]) => view.rerender(ui(d)) };
}

function visibleNoteIds(): string[] {
  return [...new Set([...document.querySelectorAll("[data-note-id]")].map((el) => el.getAttribute("data-note-id")!))];
}

// The lowercase body is cached next to the stripped body, so a docs commit
// that changes nothing else must keep matching and snippeting exactly as a
// fresh search would.
describe("Sidebar search", () => {
  it("matches bodies case-insensitively and keeps the original casing in the snippet", () => {
    vi.useFakeTimers();
    const searchDocs = [
      { ...makeDoc("a", "Alpha"), content: "Notes on the GAMMA ray burst" },
      { ...makeDoc("b", "Beta"), content: "nothing relevant" },
    ];
    const { rerender } = renderSearch(searchDocs, "gamma");
    act(() => { vi.advanceTimersByTime(300); });

    expect(visibleNoteIds()).toEqual(["a"]);
    expect(document.body.textContent).toContain("GAMMA");

    // Autosave commits hand the sidebar a new array with the same bodies.
    rerender(searchDocs.map((d) => ({ ...d })));
    expect(visibleNoteIds()).toEqual(["a"]);

    // An edited body is re-stripped and re-lowercased.
    rerender([searchDocs[0], { ...searchDocs[1], content: "a gamma note too" }]);
    expect(visibleNoteIds().sort()).toEqual(["a", "b"]);
  });
});
