import { findParentNodeClosestToPos, wrappingInputRule, type JSONContent } from "@tiptap/core";
import { OrderedList, detectMarkerType, markerToStart, toRoman } from "@tiptap/extension-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";

/**
 * The marker styles an ordered list can carry, as HTML `<ol type>` values.
 * `"1"` is stored as a null `type`, which is what a numeric Markdown list
 * parses to, so choosing numbers never leaves an attribute that no file holds.
 */
export type OrderedListStyle = "1" | "a" | "A" | "i" | "I";

export const ORDERED_LIST_STYLES: readonly OrderedListStyle[] = ["1", "a", "A", "i", "I"];

// `ol[type="a"]` cannot style these lists: HTML matches the `type` attribute
// case-insensitively in selectors, so it would also match `type="A"`.
const LIST_STYLE_TYPE: Record<Exclude<OrderedListStyle, "1">, string> = {
  a: "lower-alpha",
  A: "upper-alpha",
  i: "lower-roman",
  I: "upper-roman",
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    notenOrderedList: {
      /**
       * Give the innermost ordered list around the selection this marker
       * style, wrapping the selection in a new list when it is in none.
       */
      setOrderedListStyle: (style: OrderedListStyle) => ReturnType;
    };
  }
}

/** The style of an ordered list node; unknown and missing types read as numbers. */
export function orderedListStyleOf(node: ProseMirrorNode): OrderedListStyle {
  const type = node.attrs.type as unknown;
  return typeof type === "string" && (ORDERED_LIST_STYLES as readonly string[]).includes(type)
    ? (type as OrderedListStyle)
    : "1";
}

/** The style of the innermost list around the selection, or null when that list is not ordered. */
export function selectedOrderedListStyle(selection: Selection): OrderedListStyle | null {
  const list = findParentNodeClosestToPos(selection.$from, isList);
  return list?.node.type.name === "orderedList" ? orderedListStyleOf(list.node) : null;
}

const ITEM_MARKER = /^[ \t]*([A-Za-z]+)[.)]/;

function itemMarker(item: unknown): string | null {
  const raw = (item as { raw?: unknown } | null)?.raw;
  return typeof raw === "string" ? (raw.match(ITEM_MARKER)?.[1] ?? null) : null;
}

/**
 * Tiptap reads a list's style from its first marker alone and tries roman
 * before letters, so a list starting at `c.`, `d.`, `i.`, `l.`, `m.`, `v.` or
 * `x.` parsed as roman (100, 500, ...) and saved its next item as `ci.`,
 * `di.`, `ii.`: the reload rewrote the user's markers. A single letter is
 * read as a letter unless it is `i`/`I` (a roman list's usual start), and
 * the second item settles the choice whenever it follows one reading
 * (`v.` `w.` are letters, `v.` `vi.` roman numerals).
 */
export function alphaAttrsForAmbiguousMarkers(first: string, second: string | null): { type: "a" | "A"; start: number } | null {
  if (!/^[a-zA-Z]$/.test(first)) return null;
  const upper = first === first.toUpperCase();
  const code = first.toLowerCase().charCodeAt(0);
  const alphaNext = code < 122 ? String.fromCharCode(code + 1) : null;
  const romanNext = isRoman(first) ? toRoman(markerToStart(first) + 1) : null;
  const secondLower = second && (second === second.toUpperCase()) === upper ? second.toLowerCase() : null;
  let alpha: boolean;
  if (secondLower !== null && secondLower === alphaNext) alpha = true;
  else if (secondLower !== null && secondLower === romanNext) alpha = false;
  else alpha = first.toLowerCase() !== "i";
  return alpha ? { type: upper ? "A" : "a", start: code - 96 } : null;
}

function disambiguate(parsed: JSONContent, token: { items?: unknown[] }): JSONContent {
  const type = parsed.attrs?.type as unknown;
  if (type !== "i" && type !== "I") return parsed;
  const items = token.items ?? [];
  const first = itemMarker(items[0]);
  if (!first) return parsed;
  const alpha = alphaAttrsForAmbiguousMarkers(first, itemMarker(items[1]));
  if (!alpha) return parsed;
  const { start: _start, ...rest } = parsed.attrs ?? {};
  return {
    ...parsed,
    attrs: { ...rest, type: alpha.type, ...(alpha.start !== 1 ? { start: alpha.start } : {}) },
  };
}

function isList(node: ProseMirrorNode): boolean {
  return (node.type.spec.group ?? "").split(" ").includes("list");
}

// 1-based position of a letter marker: a = 1, z = 26, aa = 27.
function alphaValue(marker: string): number {
  const lower = marker.toLowerCase();
  const value = (index: number) => lower.charCodeAt(index) - 96;
  return lower.length === 1 ? value(0) : value(0) * 26 + value(1);
}

// Same as @tiptap/extension-list's ORDERED_LIST_ITEM_REGEX.
const ORDERED_ITEM = /^(\s*)(\d+|[ivxlcdmIVXLCDM]+|[a-zA-Z]{1,2})[.)]\s+/;

function markerKind(marker: string): "number" | "lower" | "upper" {
  if (/^\d/.test(marker)) return "number";
  return marker === marker.toLowerCase() ? "lower" : "upper";
}

function isRoman(marker: string): boolean {
  const type = detectMarkerType(marker);
  return type === "i" || type === "I";
}

// Tiptap's letter marker for a 1-based position: a-z, then aa, ab, ...
function alphaMarker(position: number): string {
  const letter = (index: number) => String.fromCharCode(97 + index);
  if (position <= 26) return letter(position - 1);
  return letter(Math.floor((position - 1) / 26) - 1) + letter((position - 1) % 26);
}

/**
 * The prefix of `src` that holds only the list its first line starts.
 *
 * The stock tokenizer takes every following item line into one list, across
 * blank lines and changes of marker, and restyles them all after the first.
 * The serializer writes adjacent lists a blank line apart, so a numbered list
 * followed by a letter list reloaded as one numbered list and saved the
 * letters as numbers. An item at the list's own indent starts a new list
 * when its marker is of another kind (numbers, lowercase, uppercase), or of
 * the same case but the other letter style: a roman numeral that is not the
 * next letter of a letter list (`i.` after `a.` `b.`, but not after `h.`),
 * or a non-roman letter in a roman list. Nested lists keep the stock reading.
 */
export function cutAtMarkerKindChange(src: string): string {
  const firstEnd = src.indexOf("\n");
  const first = (firstEnd < 0 ? src : src.slice(0, firstEnd)).match(ORDERED_ITEM);
  if (!first || firstEnd < 0) return src;
  const indent = first[1].length;
  const firstMarker = first[2];
  const kind = markerKind(firstMarker);
  // Letter style, once known: a lone roman letter waits for the second item.
  let letters: "alpha" | "roman" | null =
    kind === "number" ? null : !isRoman(firstMarker) ? "alpha" : firstMarker.length > 1 ? "roman" : null;
  let items = 1;
  let start = firstEnd + 1;
  while (start <= src.length) {
    const nl = src.indexOf("\n", start);
    const line = src.slice(start, nl < 0 ? src.length : nl);
    const item = line.match(ORDERED_ITEM);
    if (item && item[1].length <= indent) {
      const marker = item[2];
      if (markerKind(marker) !== kind) return src.slice(0, start - 1);
      if (kind !== "number") {
        letters ??= alphaAttrsForAmbiguousMarkers(firstMarker, marker) ? "alpha" : "roman";
        const expected = alphaMarker(alphaValue(firstMarker) + items);
        const other =
          letters === "alpha" ? isRoman(marker) && marker.toLowerCase() !== expected : !isRoman(marker);
        if (other) return src.slice(0, start - 1);
      }
      items++;
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  return src;
}

const stockTokenizer = OrderedList.config.markdownTokenizer!;

// `a. `, `B. `, `i. `, `I. ` at the start of a textblock. Multi-letter
// markers are left alone: `ii. ` or `iv. ` typed as prose is likelier than a
// list meant to start there, and the toolbar sets any style.
const LETTER_INPUT = /^([a-zA-Z])\.\s$/;

export const NotenOrderedList = OrderedList.extend({
  renderHTML({ node, HTMLAttributes }) {
    const rendered = this.parent?.({ node, HTMLAttributes }) as ["ol", Record<string, unknown>, 0];
    const style = LIST_STYLE_TYPE[HTMLAttributes.type as keyof typeof LIST_STYLE_TYPE];
    return style ? ["ol", { ...rendered[1], "data-list-style": style }, 0] : rendered;
  },

  parseMarkdown(token, helpers) {
    // Markdown fields get no `this.parent`; the stock one is a plain arrow function.
    const parsed = OrderedList.config.parseMarkdown?.call(this, token, helpers);
    if (!parsed || Array.isArray(parsed)) return parsed ?? [];
    return disambiguate(parsed, token as { items?: unknown[] });
  },

  markdownTokenizer: {
    ...stockTokenizer,
    tokenize: (src, tokens, lexer) => stockTokenizer.tokenize(cutAtMarkerKindChange(src), tokens, lexer),
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setOrderedListStyle:
        (style) =>
        ({ tr, commands, dispatch }) => {
          // The innermost list decides: a bullet list nested in a numbered one
          // is converted, rather than restyling the numbered list around it.
          const innermostList = () => findParentNodeClosestToPos(tr.selection.$from, isList);
          if (innermostList()?.node.type.name !== this.name && !commands.toggleOrderedList()) return false;
          const list = innermostList();
          if (!list || list.node.type.name !== this.name) return false;
          if (dispatch) tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, type: style === "1" ? null : style });
          return true;
        },
    };
  },

  addInputRules() {
    const letterRule = wrappingInputRule({
      find: LETTER_INPUT,
      type: this.type,
      getAttributes: (match) => {
        const marker = match[1];
        const upper = marker === marker.toUpperCase();
        if (marker.toLowerCase() === "i") return { type: upper ? "I" : "i" };
        const start = alphaValue(marker);
        return { type: upper ? "A" : "a", ...(start !== 1 ? { start } : {}) };
      },
      // Continue the letter list right above when this is its next marker,
      // e.g. `c. ` after `a.`/`b.`, or `i. ` after `a.`-`h.`.
      joinPredicate: (match, node) => {
        const marker = match[1];
        const upper = marker === marker.toUpperCase();
        const next = node.childCount + ((node.attrs.start as number | undefined) ?? 1);
        return orderedListStyleOf(node) === (upper ? "A" : "a") && alphaValue(marker) === next;
      },
    });
    return [...(this.parent?.() ?? []), letterRule];
  },
});
