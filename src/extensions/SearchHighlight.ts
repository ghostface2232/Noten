import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node } from "@tiptap/pm/model";

export const searchPluginKey = new PluginKey("searchHighlight");

export interface SearchMatch {
  from: number;
  to: number;
}

// Public contract set by SearchBar. `matches` is the complete list so the
// counter, next/prev navigation and replace-all stay accurate regardless of how
// many are actually drawn.
export interface SearchPluginState {
  query: string;
  activeIndex: number;
  matches: SearchMatch[];
}

interface InternalSearchState extends SearchPluginState {
  // Last known visible position range, fed by the scroll-driven plugin view.
  // Null until the first scroll/update or when it cannot be computed.
  viewport: { from: number; to: number } | null;
}

interface ViewportMeta {
  viewportUpdate: { from: number; to: number } | null;
}

// Cap on how many matches become DOM decorations at once. Drawing tens of
// thousands of inline decorations floods the view layer and stalls the editor.
// The match list stays complete; only this many nearest the viewport are drawn.
export const SEARCH_DECORATION_CAP = 2000;

// Absolute guard so a degenerate document can't build an unbounded match array.
// Far above any realistic single-note match count.
const SEARCH_MATCH_LIMIT = 50000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findSearchMatches(doc: Node, query: string): SearchMatch[] {
  const results: SearchMatch[] = [];
  if (!query) return results;
  // Case-insensitive regex over the ORIGINAL text. The previous
  // implementation searched text.toLowerCase() and reused those indices as
  // document positions; case folding can change string length (İ → i̇), so
  // every index after such a character drifted and Replace deleted the wrong
  // characters. Regex 'i' matching never changes offsets.
  const re = new RegExp(escapeRegExp(query), "gi");
  let stop = false;

  doc.descendants((node, pos) => {
    if (stop) return false;
    if (!node.isTextblock) return undefined; // keep descending

    // Aggregate the block's inline content so a match can span mark
    // boundaries — per-text-node search reported "0 matches" for any phrase
    // with mixed formatting (e.g. one bold word inside it). Inline leaf nodes
    // (hard breaks, inline images) map to a single placeholder char, which
    // keeps string index i aligned with document position pos + 1 + i; the
    // placeholder can never match query characters.
    const text = node.textBetween(0, node.content.size, undefined, "￼");
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (results.length >= SEARCH_MATCH_LIMIT) { stop = true; break; }
      results.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      // Restart one char after the match start (not its end) to keep the old
      // overlapping-match semantics of indexOf(idx + 1).
      re.lastIndex = m.index + 1;
    }
    return false; // inline content already covered
  });

  return results;
}

// First index whose match ends at or after `pos` (lower bound). `matches` is
// sorted ascending by position.
function firstIndexFrom(matches: SearchMatch[], pos: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].to < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Pick the indices of up to `cap` matches to decorate, preferring those nearest
// the visible range. Falls back to a window centred on the active match when no
// viewport is known (initial search, just after an edit, or no scroll parent).
export function selectMatchesToDecorate(
  matches: SearchMatch[],
  range: { from: number; to: number } | null,
  anchorIndex: number,
  cap = SEARCH_DECORATION_CAP,
): number[] {
  const all = (): number[] => matches.map((_, i) => i);
  if (matches.length <= cap) return all();

  let centerLo: number;
  let centerHi: number;
  if (range) {
    centerLo = firstIndexFrom(matches, range.from);
    centerHi = firstIndexFrom(matches, range.to);
  } else {
    const clamped = Math.min(Math.max(anchorIndex, 0), matches.length - 1);
    centerLo = clamped;
    centerHi = clamped;
  }

  const span = Math.max(0, centerHi - centerLo);
  let start = span >= cap ? centerLo : Math.max(0, centerLo - Math.floor((cap - span) / 2));
  const end = Math.min(matches.length, start + cap);
  start = Math.max(0, end - cap);

  const indices: number[] = [];
  for (let i = start; i < end; i++) indices.push(i);
  return indices;
}

function isViewportMeta(meta: unknown): meta is ViewportMeta {
  return !!meta && typeof meta === "object" && "viewportUpdate" in meta;
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = typeof getComputedStyle === "function" ? getComputedStyle(node).overflowY : "";
    if (/(auto|scroll|overlay)/.test(overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

// Visible position range derived from the scroll container, so decorations track
// the user's scroll position. Probes the exact viewport edges — no pixel margin,
// because the decoration window (selectMatchesToDecorate) already pads to the cap
// (~hundreds of matches above and below the fold), and an over-wide probe at the
// document bottom collapses `from` to 0 and pulls the window back to the top.
// Returns null if coordinates can't be resolved (e.g. detached / no layout).
function computeVisibleRange(
  view: EditorView,
  scroller: HTMLElement | null,
): { from: number; to: number } | null {
  try {
    const domRect = view.dom.getBoundingClientRect();
    const left = domRect.left + Math.min(8, domRect.width / 2);
    const rect = scroller ? scroller.getBoundingClientRect() : null;
    const top = rect ? rect.top : 0;
    const bottom = rect ? rect.bottom : (typeof window !== "undefined" ? window.innerHeight : 0);
    const topHit = view.posAtCoords({ left, top });
    const botHit = view.posAtCoords({ left, top: bottom });
    const from = topHit ? topHit.pos : 0;
    const to = botHit ? botHit.pos : view.state.doc.content.size;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  } catch {
    return null;
  }
}

export const SearchHighlight = Extension.create({
  name: "searchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<InternalSearchState>({
        key: searchPluginKey,
        state: {
          init(): InternalSearchState {
            return { query: "", activeIndex: 0, matches: [], viewport: null };
          },
          apply(tr, prev): InternalSearchState {
            const meta = tr.getMeta(searchPluginKey);
            if (isViewportMeta(meta)) {
              return { ...prev, viewport: meta.viewportUpdate };
            }
            if (meta) {
              const next = meta as SearchPluginState;
              // A fresh match set invalidates the old viewport indices; let the
              // next scroll tick (or the active-centred fallback) repopulate it.
              return { ...next, viewport: null };
            }
            if (tr.docChanged && prev.query) {
              const matches = findSearchMatches(tr.doc, prev.query);
              const activeIndex = Math.min(prev.activeIndex, Math.max(0, matches.length - 1));
              return { ...prev, matches, activeIndex, viewport: null };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            const ps = searchPluginKey.getState(state) as InternalSearchState | undefined;
            if (!ps || !ps.query || ps.matches.length === 0) return DecorationSet.empty;

            const indices = selectMatchesToDecorate(ps.matches, ps.viewport, ps.activeIndex);
            const chosen = new Set(indices);
            // The active match must always be visible, even if it falls outside
            // the current decoration window.
            if (ps.activeIndex >= 0 && ps.activeIndex < ps.matches.length) {
              chosen.add(ps.activeIndex);
            }

            const decos: Decoration[] = [];
            chosen.forEach((i) => {
              const m = ps.matches[i];
              decos.push(
                Decoration.inline(m.from, m.to, {
                  class: i === ps.activeIndex ? "search-match-active" : "search-match",
                }),
              );
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
        view(editorView) {
          const scroller = findScrollParent(editorView.dom);
          const target: HTMLElement | Window = scroller ?? window;
          let frame: number | null = null;

          const needsViewportTracking = (): boolean => {
            const ps = searchPluginKey.getState(editorView.state) as InternalSearchState | undefined;
            return !!ps && !!ps.query && ps.matches.length > SEARCH_DECORATION_CAP;
          };

          const dispatchViewport = () => {
            frame = null;
            if (!needsViewportTracking()) return;
            const range = computeVisibleRange(editorView, scroller);
            const tr = editorView.state.tr.setMeta(searchPluginKey, { viewportUpdate: range });
            tr.setMeta("addToHistory", false);
            editorView.dispatch(tr);
          };

          const onScroll = () => {
            if (!needsViewportTracking()) return;
            if (frame === null) frame = requestAnimationFrame(dispatchViewport);
          };

          target.addEventListener("scroll", onScroll, { passive: true });
          return {
            destroy() {
              target.removeEventListener("scroll", onScroll);
              if (frame !== null) cancelAnimationFrame(frame);
            },
          };
        },
      }),
    ];
  },
});
