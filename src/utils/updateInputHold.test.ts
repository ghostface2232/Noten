import { describe, it, expect } from "vitest";
import { holdInput, inputHeld, type HoldableEditor } from "./updateInputHold";

function editor(composing = false): HoldableEditor {
  return { isComposing: () => composing };
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
    const release = holdInput(editor())!;

    for (const type of ["keydown", "beforeinput", "paste", "drop", "pointerdown", "click"]) {
      expect(dispatch(type)).toEqual({ reached: false, prevented: true });
    }
    // Scrolling edits nothing, so a user reading the note can keep doing it.
    expect(dispatch("wheel").reached).toBe(true);

    release();
    expect(dispatch("keydown")).toEqual({ reached: true, prevented: false });
  });

  it("moves focus out of the field for the hold and puts it back after the last release", () => {
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    const first = holdInput(editor())!;
    const second = holdInput(editor())!;
    expect(document.activeElement).toBe(document.body);

    first();
    first();
    expect(inputHeld()).toBe(true);
    expect(document.activeElement).toBe(document.body);
    second();
    expect(inputHeld()).toBe(false);
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("refuses during an IME composition the document has not received", () => {
    expect(holdInput(editor(true))).toBeNull();
    expect(inputHeld()).toBe(false);
  });

  it("still holds DOM input in a window with no editor", () => {
    const release = holdInput(null)!;
    expect(dispatch("keydown").reached).toBe(false);
    release();
  });
});
