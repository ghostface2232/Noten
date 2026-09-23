import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Sidebar } from "./Sidebar";
import type { NoteDoc } from "../utils/noteTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

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


function makeProps(docs: NoteDoc[], sidebarSearchQuery: string) {
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
    sidebarSearchOpen: true,
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

function renderSidebar(docs: NoteDoc[], query: string) {
  const ui = (d: NoteDoc[]) => (
    <FluentProvider theme={webLightTheme}>
      <Sidebar {...makeProps(d, query)} />
    </FluentProvider>
  );
  const view = render(ui(docs));
  return { rerender: (d: NoteDoc[]) => view.rerender(ui(d)) };
}

function visibleNoteIds(): string[] {
  return [...new Set([...document.querySelectorAll("[data-note-id]")].map((el) => el.getAttribute("data-note-id")!))];
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The lowercase body is cached next to the stripped body, so a docs commit
// that changes nothing else must keep matching and snippeting exactly as a
// fresh search would.
describe("Sidebar search", () => {
  it("matches bodies case-insensitively and keeps the original casing in the snippet", () => {
    vi.useFakeTimers();
    const docs = [
      { ...makeDoc("a", "Alpha"), content: "Notes on the GAMMA ray burst" },
      { ...makeDoc("b", "Beta"), content: "nothing relevant" },
    ];
    const { rerender } = renderSidebar(docs, "gamma");
    act(() => { vi.advanceTimersByTime(300); });

    expect(visibleNoteIds()).toEqual(["a"]);
    expect(document.body.textContent).toContain("GAMMA");

    // Autosave commits hand the sidebar a new array with the same bodies.
    rerender(docs.map((d) => ({ ...d })));
    expect(visibleNoteIds()).toEqual(["a"]);

    // An edited body is re-stripped and re-lowercased.
    rerender([docs[0], { ...docs[1], content: "a gamma note too" }]);
    expect(visibleNoteIds().sort()).toEqual(["a", "b"]);
  });
});
