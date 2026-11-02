import { describe, it, expect } from "vitest";
import { holdInput, inputHeld, type HoldableEditor } from "./updateInputHold";

function editor(composing = false) {
  const state = { locked: 0, composing };
  const handle: HoldableEditor = {
    isComposing: () => state.composing,
    lockDocument: () => {
      state.locked++;
      return () => { state.locked--; };
    },
  };
  return { state, handle };
}

function dispatch(type: string, target: EventTarget = document.body) {
  let reached = false;
  const listener = () => { reached = true; };
  target.addEventListener(type, listener);
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  target.removeEventListener(type, listener);
  return { reached, prevented: event.defaultPrevented };
}

describe("holdInput", () => {
  it("swallows editing input while held and lets it through once released", () => {
    const { handle } = editor();
    const release = holdInput(handle)!;

    for (const type of ["keydown", "beforeinput", "paste", "drop", "pointerdown", "click"]) {
      expect(dispatch(type)).toEqual({ reached: false, prevented: true });
    }
    // Scrolling edits nothing, so a user reading the note can keep doing it.
    expect(dispatch("wheel").reached).toBe(true);

    release();
    expect(dispatch("keydown")).toEqual({ reached: true, prevented: false });
  });

  it("locks the document for the first hold and unlocks it after the last", () => {
    const { state, handle } = editor();
    const first = holdInput(handle)!;
    const second = holdInput(handle)!;
    expect(state.locked).toBe(1);

    first();
    first();
    expect(inputHeld()).toBe(true);
    expect(state.locked).toBe(1);
    second();
    expect(inputHeld()).toBe(false);
    expect(state.locked).toBe(0);
  });

  it("refuses during an IME composition the document has not received", () => {
    const { state, handle } = editor(true);

    expect(holdInput(handle)).toBeNull();
    expect(inputHeld()).toBe(false);
    expect(state.locked).toBe(0);
  });

  it("still holds DOM input in a window with no editor", () => {
    const release = holdInput(null)!;
    expect(dispatch("keydown").reached).toBe(false);
    release();
  });
});
