import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// Off-screen skipping for DOM-heavy top-level blocks (lists, code blocks,
// tables).
//
// Chromium does work proportional to the whole editable on every keystroke
// and, much more, on every IME composition update: it lays out, paints and
// walks the text of the entire contenteditable to hand the IME its context.
// For a 1 MB note of lists or tables that is ~1 s per Hangul jamo. With
// `content-visibility: auto` the browser skips blocks far from the viewport,
// which brings the same composition update down to ~5-25 ms.
//
// A skipped block's height is its `contain-intrinsic-size`. With a guessed
// height every position below it is wrong, so outline jumps, find, go-to-line,
// undo scrolling and the scrollbar land thousands of pixels off. The fix is
// to never guess: `contain-intrinsic-size: auto` makes the browser remember a
// block's real size whenever it is rendered, so this plugin renders every
// block once (drops the class for a frame — a normal full layout) whenever
// remembered sizes could be missing or stale:
//
// - a transaction created or changed a skippable block that is off screen
//   (opening a note, bulk edits, undo far away, replace-all);
// - the editor's width changed (window resize, side panels);
// - a web font finished loading;
// - a typography setting changed (callers invoke `remeasure()`).
//
// Everything else keeps its exact size: a block the user edits is on screen
// and is re-measured by the browser as it renders.
//
// The CSS half lives in tiptap-editor.css ("Off-screen skipping"); the
// selector below must match it.

const SKIPPABLE_KIND = ":is(ul, ol, .noten-code-block:not(.is-mermaid), .tableWrapper)";
export const SKIPPABLE_BLOCK =
  `${SKIPPABLE_KIND}:not(:has(hr, h1, h2, h3, h4, h5, h6, blockquote, .tiptap-image-node, .is-mermaid))`;
export const SKIP_OFFSCREEN_CLASS = "noten-skip-offscreen";

// More changed top-level blocks than this in one update is a document swap or
// a bulk edit: re-measure without inspecting each one.
const MAX_INSPECTED_BLOCKS = 32;

export interface OffscreenBlocksStorage {
  /** Re-render every block once so remembered sizes match the current layout. */
  remeasure: () => void;
}

declare module "@tiptap/core" {
  interface Storage {
    offscreenBlocks: OffscreenBlocksStorage;
  }
}

export const offscreenBlocksPluginKey = new PluginKey("offscreenBlocks");

class OffscreenMeasure {
  private frame = 0;
  private width = -1;
  private scroller: HTMLElement | null = null;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(private readonly view: EditorView) {
    // Without ResizeObserver (non-browser environments) the editor never
    // learns its width, so skipping stays off.
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const width = entries[entries.length - 1].contentRect.width;
      if (width === this.width) return;
      this.width = width;
      this.remeasure();
    });
    this.resizeObserver?.observe(view.dom);
    document.fonts?.addEventListener("loadingdone", this.remeasure);
    this.watchResolution();
    this.remeasure();
  }

  // Moving the window to a monitor with another scale can rewrap text at the
  // same CSS width, which the width observer does not see.
  private resolutionQuery: MediaQueryList | null = null;
  private readonly onResolutionChange = () => {
    this.watchResolution();
    this.remeasure();
  };

  private watchResolution() {
    this.resolutionQuery?.removeEventListener("change", this.onResolutionChange);
    if (typeof matchMedia !== "function") return;
    this.resolutionQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.resolutionQuery.addEventListener("change", this.onResolutionChange);
  }

  // Drop the class so the next frame lays out (and the browser records the
  // size of) every block, then restore it. Two frames: the first rAF runs
  // before the measuring frame's layout, the second after it.
  readonly remeasure = () => {
    const dom = this.view.dom;
    dom.classList.remove(SKIP_OFFSCREEN_CLASS);
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        // A hidden editor has no layout to remember; the width observer
        // re-measures once it is shown.
        if (this.width > 0) dom.classList.add(SKIP_OFFSCREEN_CLASS);
      });
    });
  };

  update(view: EditorView, prev: EditorState) {
    const doc = view.state.doc;
    const old = prev.doc;
    if (doc === old) return;
    // The changed top-level range, by node identity rather than content:
    // ProseMirror redraws only nodes that are new objects, and when a whole
    // document is replaced with equal-looking content (window sync, file
    // reload, undoing one) it reuses the old elements in order, so a
    // content-equal block can end up in another block's element. Every new
    // object is a block whose element may have changed.
    let first = 0;
    while (first < doc.childCount && first < old.childCount && doc.child(first) === old.child(first)) first++;
    let end = doc.childCount;
    let oldEnd = old.childCount;
    while (end > first && oldEnd > first && doc.child(end - 1) === old.child(oldEnd - 1)) {
      end--;
      oldEnd--;
    }
    // Pure deletions leave no new element to measure.
    if (end <= first) return;
    if (end - first > MAX_INSPECTED_BLOCKS) {
      this.remeasure();
      return;
    }
    let pos = 0;
    for (let i = 0; i < first; i++) pos += doc.child(i).nodeSize;
    for (let i = first; i < end; i++) {
      const dom = view.nodeDOM(pos);
      pos += doc.child(i).nodeSize;
      // Cheapest test first: the full selector's :has() walks the block's
      // subtree, and the block being edited is almost always on screen.
      if (
        dom instanceof HTMLElement
        && dom.matches(SKIPPABLE_KIND)
        && this.isOffscreen(dom)
        && dom.matches(SKIPPABLE_BLOCK)
      ) {
        this.remeasure();
        return;
      }
    }
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.resolutionQuery?.removeEventListener("change", this.onResolutionChange);
    document.fonts?.removeEventListener("loadingdone", this.remeasure);
    cancelAnimationFrame(this.frame);
    this.view.dom.classList.remove(SKIP_OFFSCREEN_CLASS);
  }

  private isOffscreen(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const box = this.viewport();
    return rect.bottom < box.top || rect.top > box.bottom;
  }

  private viewport(): { top: number; bottom: number } {
    if (!this.scroller?.contains(this.view.dom)) {
      this.scroller = null;
      for (let el = this.view.dom.parentElement; el; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === "auto" || overflowY === "scroll") {
          this.scroller = el;
          break;
        }
      }
    }
    return this.scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  }
}

export const OffscreenBlocks = Extension.create<Record<string, never>, OffscreenBlocksStorage>({
  name: "offscreenBlocks",

  addStorage() {
    return { remeasure: () => {} };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: offscreenBlocksPluginKey,
        view: (view) => {
          const measure = new OffscreenMeasure(view);
          storage.remeasure = measure.remeasure;
          return {
            update: (updated, prev) => measure.update(updated, prev),
            destroy: () => {
              measure.destroy();
              storage.remeasure = () => {};
            },
          };
        },
      }),
    ];
  },
});

export default OffscreenBlocks;
