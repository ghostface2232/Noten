import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SearchHighlight } from "../extensions/SearchHighlight";
import { NO_FOCUS_REQUEST, SearchBar, type DocSearchFocusRequest } from "./SearchBar";

let active: Editor | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  active?.destroy();
  active = null;
  vi.useRealTimers();
});

/** Lets the spoken status catch up with the query. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

function spoken() {
  return screen.getByRole("status").textContent;
}

function makeEditor(content: string) {
  const editor = new Editor({ extensions: [StarterKit, SearchHighlight], content });
  active = editor;
  return editor;
}

function bar(editor: Editor, onNotice: () => void, focusRequest: DocSearchFocusRequest = NO_FOCUS_REQUEST) {
  return (
    <FluentProvider theme={webLightTheme}>
      <SearchBar
        editor={editor}
        onClose={vi.fn()}
        replaceOpen
        onToggleReplace={vi.fn()}
        locale="en"
        onNotice={onNotice}
        focusRequest={focusRequest}
      />
    </FluentProvider>
  );
}

function renderBar(content: string, onNotice = vi.fn(), focusRequest: DocSearchFocusRequest = NO_FOCUS_REQUEST) {
  const editor = makeEditor(content);
  const view = render(bar(editor, onNotice, focusRequest));
  const [findInput, replaceInput] = screen.getAllByRole("textbox");
  return { editor, view, onNotice, findInput, replaceInput };
}

function selection(input: HTMLElement) {
  const el = input as HTMLInputElement;
  return [el.selectionStart, el.selectionEnd];
}

function caseToggle() {
  return screen.getByRole("button", { name: "Match case" });
}

function counter() {
  // The visible counter is aria-hidden, so it is addressed by its text.
  return screen.getByText(/^\d+\/\d+$/);
}

/**
 * Griffel hashes class names, so the no-match state is detected by comparing
 * against the classes the counter wears while it has matches: the styles differ
 * by exactly the color rule.
 */
function baselineCounterClass(content: string, query: string) {
  const { findInput } = renderBar(content);
  fireEvent.change(findInput, { target: { value: query } });
  const className = counter().className;
  cleanup();
  active?.destroy();
  active = null;
  return className;
}

describe("match counter", () => {
  it("reports the active match and the total", () => {
    const { findInput } = renderBar("<p>foo bar foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });

    expect(counter().textContent).toBe("1/2");
    settle();
    expect(spoken()).toBe("Match 1 of 2");
  });

  it("waits for typing to pause before speaking the count", () => {
    const { findInput } = renderBar("<p>foo bar foo</p>");
    fireEvent.change(findInput, { target: { value: "f" } });
    fireEvent.change(findInput, { target: { value: "fo" } });
    fireEvent.change(findInput, { target: { value: "foo" } });

    expect(spoken()).toBe("");
    settle();
    expect(spoken()).toBe("Match 1 of 2");
  });

  it("wraps backwards from the first match to the last", () => {
    const { findInput } = renderBar("<p>foo bar foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });
    fireEvent.keyDown(findInput, { key: "Enter", shiftKey: true });

    expect(counter().textContent).toBe("2/2");
  });

  it("marks a query that matches nothing", () => {
    const baseline = baselineCounterClass("<p>foo bar foo</p>", "foo");
    const { findInput } = renderBar("<p>foo bar</p>");
    fireEvent.change(findInput, { target: { value: "zzz" } });

    expect(counter().textContent).toBe("0/0");
    settle();
    expect(spoken()).toBe("No matches");
    expect(counter().className).not.toBe(baseline);
  });

  it("does not mark a replace that consumed every match", () => {
    const baseline = baselineCounterClass("<p>foo bar foo</p>", "foo");
    const { findInput, replaceInput } = renderBar("<p>foo bar foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });
    settle();
    expect(spoken()).toBe("Match 1 of 2");
    fireEvent.change(replaceInput, { target: { value: "baz" } });
    fireEvent.keyDown(replaceInput, { key: "Enter", ctrlKey: true });

    expect(counter().textContent).toBe("0/0");
    expect(counter().className).toBe(baseline);
    settle();
    expect(spoken()).toBe("");
  });

  it("marks a miss again once the query changes after a replace", () => {
    const baseline = baselineCounterClass("<p>foo bar foo</p>", "foo");
    const { findInput, replaceInput } = renderBar("<p>foo bar foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });
    fireEvent.change(replaceInput, { target: { value: "baz" } });
    fireEvent.keyDown(replaceInput, { key: "Enter", ctrlKey: true });
    fireEvent.change(findInput, { target: { value: "zzz" } });

    expect(counter().className).not.toBe(baseline);
    settle();
    expect(spoken()).toBe("No matches");
  });
});

describe("replace all", () => {
  it("reports how many matches it replaced", () => {
    const { onNotice, editor, findInput, replaceInput } = renderBar("<p>foo bar foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });
    fireEvent.change(replaceInput, { target: { value: "baz" } });
    fireEvent.keyDown(replaceInput, { key: "Enter", ctrlKey: true });

    expect(onNotice).toHaveBeenCalledWith("2 replaced");
    expect(editor.state.doc.textContent).toBe("baz bar baz");
  });

  it("counts overlapping matches only as often as it replaces them", () => {
    const { onNotice, editor, findInput, replaceInput } = renderBar("<p>aaaa</p>");
    fireEvent.change(findInput, { target: { value: "aa" } });
    fireEvent.change(replaceInput, { target: { value: "b" } });
    fireEvent.keyDown(replaceInput, { key: "Enter", ctrlKey: true });

    expect(onNotice).toHaveBeenCalledWith("2 replaced");
    expect(editor.state.doc.textContent).toBe("bb");
  });
});

describe("controls", () => {
  it("names every button and reports the replace row as expanded", () => {
    renderBar("<p>foo</p>");

    expect(screen.getByLabelText("Previous match")).toBeTruthy();
    expect(screen.getByLabelText("Next match")).toBeTruthy();
    expect(screen.getByLabelText("Close find")).toBeTruthy();
    expect(screen.getByLabelText("Replace").getAttribute("aria-expanded")).toBe("true");
  });

  it("focuses the replace field on mount when its row is open", () => {
    // Ctrl+H opens the bar with the row already disclosed; the row's own
    // effect wins over the query input's mount focus.
    const { replaceInput } = renderBar("<p>foo</p>");
    expect(document.activeElement).toBe(replaceInput);
  });

  it("takes focus back to the query and selects it when asked", () => {
    const { editor, view, onNotice, findInput, replaceInput } = renderBar("<p>foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });
    replaceInput.focus();
    expect(document.activeElement).toBe(replaceInput);

    view.rerender(bar(editor, onNotice, { nonce: 1, target: "find" }));

    expect(document.activeElement).toBe(findInput);
    expect(selection(findInput)).toEqual([0, 3]);
  });

  it("takes focus back to the replace field and selects it when asked", () => {
    const { editor, view, onNotice, findInput, replaceInput } = renderBar("<p>foo</p>");
    fireEvent.change(replaceInput, { target: { value: "bar" } });
    findInput.focus();

    view.rerender(bar(editor, onNotice, { nonce: 1, target: "replace" }));

    expect(document.activeElement).toBe(replaceInput);
    expect(selection(replaceInput)).toEqual([0, 3]);
  });

  it("does not replay a request left over from before it mounted", () => {
    // The bar is unmounted on close and the request state lives in App, so a
    // reopened bar mounts with an old nonce; it must behave like a fresh one.
    // A replayed request is the only path that selects, so that is the tell.
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    try {
      renderBar("<p>foo</p>", vi.fn(), { nonce: 7, target: "find" });
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });

  it("toggles match case from the input with Alt+C", () => {
    const { findInput } = renderBar("<p>Foo foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });
    expect(counter().textContent).toBe("1/2");

    fireEvent.keyDown(findInput, { key: "c", code: "KeyC", altKey: true });

    expect(caseToggle().getAttribute("aria-pressed")).toBe("true");
    expect(counter().textContent).toBe("1/1");
  });

  it("toggles match case from its button and shows the pressed state", () => {
    const { findInput } = renderBar("<p>Foo foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });
    expect(caseToggle().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(caseToggle());
    expect(caseToggle().getAttribute("aria-pressed")).toBe("true");
    expect(counter().textContent).toBe("1/1");

    fireEvent.click(caseToggle());
    expect(caseToggle().getAttribute("aria-pressed")).toBe("false");
    expect(counter().textContent).toBe("1/2");
  });

  it("recognizes Alt+C by physical key while an IME rewrites e.key", () => {
    const { findInput } = renderBar("<p>Foo foo</p>");
    fireEvent.change(findInput, { target: { value: "foo" } });

    fireEvent.keyDown(findInput, { key: "Process", code: "KeyC", altKey: true });

    expect(caseToggle().getAttribute("aria-pressed")).toBe("true");
  });
});
