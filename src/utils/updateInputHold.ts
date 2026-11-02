// The last step of an install, from the final drain to the process ending,
// must not take an edit the drain did not see. While held, this window drops
// the events that edit anything: keys, pointer presses, clipboard and drops.
// The installer only runs after a fresh idle check, so any input the hold
// swallowed also cancels the install and releases it; what it costs is that
// one keystroke, never an edit already typed.
//
// Registered at import time, on window in the capture phase, so the guard runs
// before every other listener: listeners on one target and phase run in the
// order they were added.
const BLOCKED_EVENTS = [
  "keydown",
  "keypress",
  "beforeinput",
  "paste",
  "cut",
  "drop",
  "dragstart",
  "pointerdown",
  "mousedown",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
] as const;

let holds = 0;
let restoreEditor: (() => void) | null = null;

function swallow(event: Event) {
  if (holds === 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

if (typeof window !== "undefined") {
  for (const type of BLOCKED_EVENTS) window.addEventListener(type, swallow, { capture: true });
}

export interface HoldableEditor {
  /** An IME composition the document has not received yet. */
  isComposing: () => boolean;
  /** Makes the document refuse changes; returns the undo. */
  lockDocument: () => () => void;
}

export function inputHeld(): boolean {
  return holds > 0;
}

/**
 * Holds this window's input until the returned release runs. Returns null
 * while an IME composition is open: its text is not in the document yet, so
 * no drain could have saved it, and ending the composition is the user's call.
 */
export function holdInput(editor: HoldableEditor | null): (() => void) | null {
  if (editor?.isComposing()) return null;
  if (holds === 0) restoreEditor = editor?.lockDocument() ?? null;
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0) {
      restoreEditor?.();
      restoreEditor = null;
    }
  };
}
