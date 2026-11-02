// The last step of an install, from the final drain to the process ending,
// must not take an edit the drain did not see. While held, this window drops
// the events that edit anything: keys, pointer presses, clipboard and drops
// (native file drops check inputHeld() themselves).
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
let restoreFocus: (() => void) | null = null;

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
}

export function inputHeld(): boolean {
  return holds > 0;
}

/**
 * Holds this window's input until the returned release runs. Returns null
 * while an IME composition is open: its text is not in the document yet, so
 * no drain could have saved it, and ending the composition is the user's call.
 *
 * Focus leaves the focused field for the hold. An IME composition cannot be
 * cancelled from its events, but with nothing focused it has nowhere to go,
 * and swallowed presses keep anything from taking focus back. The editor's
 * own read-only flag is left alone: it follows whether the open note is
 * loaded, which can change during a hold, and restoring a copy of it would
 * leave a loaded note read-only or an unloaded one editable.
 */
export function holdInput(editor: HoldableEditor | null): (() => void) | null {
  if (editor?.isComposing()) return null;
  if (holds === 0) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body) {
      focused.blur();
      // Back where the user left it if the install does not go ahead.
      restoreFocus = () => {
        if (focused.isConnected && document.activeElement === document.body) {
          focused.focus({ preventScroll: true });
        }
      };
    }
  }
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0) {
      restoreFocus?.();
      restoreFocus = null;
    }
  };
}
