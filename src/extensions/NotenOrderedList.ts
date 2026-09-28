import {
  findParentNodeClosestToPos,
  renderNestedMarkdownContent,
  wrappingInputRule,
  type JSONContent,
} from "@tiptap/core";
import { ListItem, OrderedList, detectMarkerType, getListMarker, markerToStart, toRoman } from "@tiptap/extension-list";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { EditorState, NodeSelection, type Selection, type Transaction } from "@tiptap/pm/state";
import { wrapInList } from "@tiptap/pm/schema-list";
import { StepMap, canJoin } from "@tiptap/pm/transform";
import { tokenizeOrderedList } from "./orderedListTokenizer";

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
       * Give a selected list, else the innermost list around the selection,
       * this marker style, converting a bullet or task list; or wrap the
       * selection in a new list of that style when it is in none. Refuses a
       * selected node outside a list and a table cell.
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

/**
 * The style of the list setOrderedListStyle would restyle (a selected list,
 * else the innermost one around the selection), or null when it is not ordered.
 */
export function selectedOrderedListStyle(selection: Selection): OrderedListStyle | null {
  const list = targetList(selection);
  return list?.node.type.name === "orderedList" ? orderedListStyleOf(list.node) : null;
}

/**
 * The list a style applies to: a selected list node itself, else the
 * innermost list around the selection's start, which includes a selected
 * image or table inside a list.
 */
function targetList(selection: Selection): { node: ProseMirrorNode; pos: number } | null {
  if (selection instanceof NodeSelection && isList(selection.node)) return { node: selection.node, pos: selection.from };
  return findParentNodeClosestToPos(selection.$from, isList) ?? null;
}

// Whether the selection starts inside a table cell; a CellSelection (what
// prosemirror-tables makes of a selected table) starts in its first cell.
function inTableCell(selection: Selection): boolean {
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

// Turn every heading and code block the selection touches into a paragraph,
// where it stands. Sizes do not change, so positions and the selection hold.
function textblocksToParagraphs(tr: Transaction): void {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  const { from, to } = tr.selection;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type !== paragraph && paragraph.validContent(node.content)) tr.setNodeMarkup(pos, paragraph);
    return false;
  });
}

// Whether a list wraps the selection once its textblocks are paragraphs,
// tried on a scratch state so nothing is changed to find out.
function wrapsAfterParagraphs(tr: Transaction, listType: NodeType, attrs: Record<string, unknown>): boolean {
  const scratch = EditorState.create({ doc: tr.doc, selection: tr.selection });
  const trial = scratch.tr;
  textblocksToParagraphs(trial);
  return wrapInList(listType, attrs)(scratch.apply(trial));
}

const ITEM_MARKER = /^[ \t]*(\d+|[A-Za-z]+)[.)]/;

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

function disambiguate(parsed: JSONContent, markers: readonly (string | null)[]): JSONContent {
  const type = parsed.attrs?.type as unknown;
  if (type !== "i" && type !== "I") return parsed;
  const first = markers[0];
  if (!first) return parsed;
  const alpha = alphaAttrsForAmbiguousMarkers(first, markers[1] ?? null);
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

// Join a newly wrapped list with an ordered list of the same style right
// before or after it, as typing its next marker would.
function joinSameStyleNeighbours(tr: Transaction, listType: NodeType): void {
  const find = () => findParentNodeClosestToPos(tr.selection.$from, (node) => node.type === listType);
  const sameStyle = (node: ProseMirrorNode | null | undefined, list: ProseMirrorNode) =>
    node?.type === listType && orderedListStyleOf(node) === orderedListStyleOf(list);
  let list = find();
  if (!list) return;
  if (sameStyle(tr.doc.resolve(list.pos).nodeBefore, list.node) && canJoin(tr.doc, list.pos)) {
    tr.join(list.pos);
    list = find();
    if (!list) return;
  }
  const end = list.pos + list.node.nodeSize;
  if (sameStyle(tr.doc.resolve(end).nodeAfter, list.node) && canJoin(tr.doc, end)) tr.join(end);
}

// 1-based position of a letter marker: a = 1, z = 26, aa = 27.
function alphaValue(marker: string): number {
  const lower = marker.toLowerCase();
  const value = (index: number) => lower.charCodeAt(index) - 96;
  return lower.length === 1 ? value(0) : value(0) * 26 + value(1);
}

// As Tiptap reads the marker: three or more roman letters that are not a
// numeral (`iiii`, `mid`, `Civil`) read as a numbered item, so they must not
// split a numbered list, or the save would read back as a different list.
function markerKind(marker: string): "number" | "lower" | "upper" {
  const type = detectMarkerType(marker);
  if (type === undefined) return "number";
  return type === "a" || type === "i" ? "lower" : "upper";
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
 * Where each list begins among one list token's items, given their markers.
 *
 * The stock tokenizer takes every following item line at the list's indent
 * into one list, across blank lines and changes of marker, and restyles them
 * all after the first. The serializer writes adjacent lists a blank line
 * apart at the top level and a single newline apart inside a list item, so a
 * numbered list followed by a letter list reloaded as one numbered list and
 * saved the letters as numbers. An item starts a new list when its marker is
 * of another kind (numbers, lowercase, uppercase), or of the same case but
 * the other letter style: a roman numeral that is not the next letter of a
 * letter list (`i.` after `a.` `b.`, but not after `h.`), or in a roman list
 * any marker that is not its next numeral (`V.` after `I.` is a letter list,
 * the editor's own reading of a lone `V.`). An item whose marker cannot be
 * read never splits.
 *
 * A multi-letter marker that is not the next one is a word more often than a
 * skipped item (`PS.`, `OK.`, `im.`, `MIX.`), and renumbering it deleted the
 * word: `A.` `B.` then `PS. do not forget` was saved as `C. do not forget`.
 * It starts a new list instead, which is how a lone `PS. x` already reads, so
 * it keeps its spelling. In a letter list begun by such a marker, a letter
 * that is not the next one starts a new list too, or `E.` after `PS.` would
 * be renumbered from it (`PT.`). A skipped single letter in a letter list
 * (`f.` after `a.` `b.`), like a skipped number, still continues the list.
 */
export function listSegmentStarts(markers: readonly (string | null)[]): number[] {
  const starts = [0];
  let first = null as string | null;
  // Letter style, once known: a lone roman letter waits for the second item.
  let letters: "alpha" | "roman" | null = null;
  let count = 0;
  const begin = (marker: string | null) => {
    first = marker;
    letters = !marker || markerKind(marker) === "number" ? null : !isRoman(marker) ? "alpha" : marker.length > 1 ? "roman" : null;
    count = 1;
  };
  begin(markers[0] ?? null);
  for (let index = 1; index < markers.length; index++) {
    const marker = markers[index];
    let other = false;
    if (first && marker) {
      other = markerKind(marker) !== markerKind(first);
      if (!other && markerKind(first) !== "number") {
        letters ??= alphaAttrsForAmbiguousMarkers(first, marker) ? "alpha" : "roman";
        const next = letters === "alpha" ? alphaMarker(alphaValue(first) + count) : toRoman(markerToStart(first) + count);
        other =
          marker.toLowerCase() !== next &&
          (letters === "roman" || isRoman(marker) || marker.length > 1 || first.length > 1);
      }
    }
    if (other) {
      starts.push(index);
      begin(marker);
    } else {
      count++;
    }
  }
  return starts;
}

export const MAX_LIST_SEGMENTS = 10_000;

// `a. `, `B. `, `i. `, `I. ` at the start of a textblock. Multi-letter
// markers are left alone: `ii. ` or `iv. ` typed as prose is likelier than a
// list meant to start there, and the toolbar sets any style.
const LETTER_INPUT = /^([a-zA-Z])\.\s$/;

// The last position a letter marker can spell: Tiptap reads and writes one
// or two letters, `zz` being 702.
const MAX_LETTER_POSITION = 26 * 27;

/**
 * The stock marker for a list item, except that a letter list's items past
 * `zz.` are numbered. Tiptap has no letter marker there and wrote
 * `undefineda.`, `undefinedb.`, ..., which reads back as text of item 702: a
 * letter list of over 702 items (a toolbar restyle of a long list, or the
 * one-list fallback of a token past MAX_LIST_SEGMENTS) lost its items on save.
 * Numbered, they read back as a numbered list continuing at 703.
 */
export function listItemMarker(type: unknown, index: number): string {
  const position = index + 1;
  // Below 1 no letter or roman marker exists (Tiptap threw on `A` and wrote
  // `undefined.` or `.`), and a negative number is no marker either: all
  // read back as plain paragraphs. `0.` is the lowest marker Markdown has.
  if (position < 1) return `${Math.max(position, 0)}. `;
  if ((type === "a" || type === "A") && position > MAX_LETTER_POSITION) return `${position}. `;
  return getListMarker(type as string | undefined, index, ". ");
}

export const NotenListItem = ListItem.extend({
  // Transcribed from the stock renderMarkdown; only the marker differs.
  renderMarkdown: (node, h, ctx) =>
    renderNestedMarkdownContent(
      node,
      h,
      (context) => {
        if (context.parentType !== "orderedList") return "- ";
        const attrs = context.meta?.parentAttrs as { start?: number; type?: unknown } | undefined;
        return listItemMarker(attrs?.type, (attrs?.start || 1) - 1 + (context.index || 0));
      },
      ctx,
      { alignNestedToPrefix: ctx?.parentType === "orderedList" },
    ),
});

export const NotenOrderedList = OrderedList.extend({
  addAttributes() {
    const attributes = (this.parent?.() ?? {}) as Record<string, object>;
    return {
      ...attributes,
      // Pasted HTML can carry any `start`, and one below 1 broke the list on
      // save; Tiptap already reads and writes 0 as 1 (`start || 1`).
      start: {
        ...attributes.start,
        parseHTML: (element: HTMLElement) => {
          const start = parseInt(element.getAttribute("start") ?? "", 10);
          return Number.isNaN(start) ? 1 : Math.max(start, 1);
        },
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const rendered = this.parent?.({ node, HTMLAttributes }) as ["ol", Record<string, unknown>, 0];
    const style = LIST_STYLE_TYPE[HTMLAttributes.type as keyof typeof LIST_STYLE_TYPE];
    return style ? ["ol", { ...rendered[1], "data-list-style": style }, 0] : rendered;
  },

  // Stock except for the column continuation lines are dedented to; see
  // orderedListTokenizer.ts. Keeps the stock name, so boundedBlockTokenizers.ts
  // still bounds it and fastMarkdownLexer.ts's blockquote fallback finds it.
  markdownTokenizer: {
    ...OrderedList.config.markdownTokenizer!,
    tokenize: tokenizeOrderedList as NonNullable<typeof OrderedList.config.markdownTokenizer>["tokenize"],
  },

  parseMarkdown(token, helpers) {
    // Markdown fields get no `this.parent`; the stock one is a plain arrow function.
    const stock = OrderedList.config.parseMarkdown!;
    const items = (token as { items?: unknown[] }).items ?? [];
    const markers = items.map(itemMarker);
    let starts = listSegmentStarts(markers);
    // Tiptap spreads a nested list's parse result into call arguments
    // (`content.push(...)`), so 140,000 lists from one token (`a.`/`A.`
    // alternating 70,000 times) overflowed the stack, about 124,000 arguments
    // in V8, and the note would not open. Past the cap the token stays one
    // list, as the stock reading has it: every item takes the first item's
    // style, so the other markers are rewritten on save, but the note opens.
    if (starts.length > MAX_LIST_SEGMENTS) starts = [0];
    const lists: JSONContent[] = [];
    starts.forEach((start, index) => {
      const end = starts[index + 1] ?? items.length;
      const first = markers[start];
      // Each segment's start and style come from its own first marker. The
      // token's describe its first raw item, which for a nested list the stock
      // reading may have dropped (an item indented deeper than its siblings),
      // so the first segment could take a style its markers do not have.
      const segment = first
        ? { ...token, items: items.slice(start, end), start: markerToStart(first), typeMarker: detectMarkerType(first) }
        : { ...token, items: items.slice(start, end), ...(index === 0 ? {} : { start: 1, typeMarker: undefined }) };
      const parsed = stock.call(this, segment as typeof token, helpers);
      for (const list of Array.isArray(parsed) ? parsed : [parsed]) {
        if (list) lists.push(disambiguate(list, markers.slice(start, end)));
      }
    });
    return lists.length === 1 ? lists[0] : lists;
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setOrderedListStyle:
        (style) =>
        ({ tr, state, chain, can, dispatch }) => {
          const type = style === "1" ? null : style;
          const list = targetList(tr.selection);
          if (!list) {
            // Not toggleOrderedList: it joins the new list into a numbered one
            // next to it before the style is set, restyling that list too. A
            // heading or code block becomes a paragraph first, as it does there,
            // but in place: Tiptap's clearNodes also lifts blocks out of their
            // quote, flattens quotes, tables and lists, and can then fail to
            // wrap, and a failed chain still dispatches. Whether the wrap works
            // is decided on a scratch state, so a refused run changes nothing
            // and can() gives the same answer. A selected node outside a list
            // (a rule, an image) is not text to style.
            if (tr.selection instanceof NodeSelection) return false;
            // A GFM cell holds one line, so a list in it is saved as its text
            // (`| a. c1 |`) and reads back as a paragraph for good.
            if (inTableCell(tr.selection)) return false;
            const canWrap = can().wrapInList(this.name, { type });
            const wrapsAsParagraphs = !canWrap && wrapsAfterParagraphs(tr, this.type, { type });
            if (!dispatch) return canWrap || wrapsAsParagraphs;
            if (!canWrap && !wrapsAsParagraphs) return false;
            return chain()
              .command(({ tr: chained }) => {
                if (!canWrap) textblocksToParagraphs(chained);
                return true;
              })
              .wrapInList(this.name, { type })
              .command(({ tr: chained }) => {
                joinSameStyleNeighbours(chained, this.type);
                return true;
              })
              .run();
          }
          if (!dispatch) return true;
          if (list.node.type === this.type) {
            // Letters and roman numerals start at 1; a `0.` list restyled keeps
            // its items' order from there.
            const start = type && (list.node.attrs.start as number) < 1 ? 1 : list.node.attrs.start;
            tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, type, start });
            return true;
          }
          // A bullet or task list becomes an ordered list in place. Tiptap's
          // toggle lifts a task list nested in a numbered item out into that
          // numbered list, which is then what the style would land on.
          const itemType = state.schema.nodes[this.options.itemTypeName];
          const items: ProseMirrorNode[] = [];
          list.node.forEach((item) => items.push(item.type === itemType ? item : itemType.create(null, item.content)));
          const converted = this.type.create({ type }, items);
          if (!converted.type.validContent(converted.content)) return false;
          const selection = tr.selection;
          tr.replaceWith(list.pos, list.pos + list.node.nodeSize, converted);
          // Items keep their size, so every position inside is unchanged.
          tr.setSelection(selection.map(tr.doc, StepMap.empty));
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
