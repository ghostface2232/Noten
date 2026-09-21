import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";

/**
 * Line, character, and word accounting for the status bar and Go to Line.
 *
 * Line counting used to be `doc.childCount`, so a ten-item list and a
 * twenty-line code block each read as one "line" — nothing like the Markdown
 * file on disk. A *logical line* here is one textblock, plus one more for every
 * line break inside it: a newline character (code blocks keep theirs as text)
 * or a hard break. That tracks what a writer sees.
 *
 * It is deliberately not a byte-exact map of the serialized Markdown: blank
 * separator lines, list markers, and table syntax are structure, not content,
 * and counting them would make the number drift from the visible document.
 *
 * All offsets here are ProseMirror *positions*, never string indexes. A
 * textblock's inline content can mix text nodes, hard breaks, and inline
 * leaves, so the two are not interchangeable.
 */
export interface LineIndex {
  /** Total logical lines; at least 1, even for an empty document. */
  total: number;
  /**
   * `prefix[i]` is how many logical lines precede top-level block `i`, so
   * block `i` starts at line `prefix[i] + 1`. Length is `childCount + 1`.
   */
  prefix: number[];
  /** `starts[i]` is the document position immediately before top-level block `i`. */
  starts: number[];
  /** Characters of text content, matching `doc.textContent.length`. */
  chars: number;
  /**
   * Whitespace-delimited words. Counted per textblock — `doc.textContent`
   * concatenates blocks with no separator, which fuses the last word of one
   * block to the first word of the next and under-counts by roughly the block
   * count (a three-item shopping list read as "1 word").
   */
  words: number;
  /** Document the index was built from, so callers can check staleness by identity. */
  doc: ProseMirrorNode;
}

/** Matches the JavaScript regexp `\s` class, without allocating per character. */
function isSpaceCode(code: number): boolean {
  return code === 0x20
    || (code >= 0x09 && code <= 0x0d)
    || code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function isHardBreak(node: ProseMirrorNode): boolean {
  return node.isInline
    && node.isLeaf
    && (node.type.spec.linebreakReplacement === true || node.type.name === "hardBreak");
}

/**
 * Logical lines in a textblock: one, plus one per newline character and one per
 * hard break.
 */
function textblockLineCount(node: ProseMirrorNode): number {
  let breaks = 0;
  node.forEach((child) => {
    if (child.isText) {
      const text = child.text ?? "";
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) breaks++;
      }
    } else if (isHardBreak(child)) {
      breaks++;
    }
  });
  return breaks + 1;
}

/** Line breaks inside a textblock that occur at or before `offset` (content-relative). */
function textblockBreaksBefore(node: ProseMirrorNode, offset: number): number {
  let breaks = 0;
  node.forEach((child, childOffset) => {
    if (childOffset >= offset) return;
    if (child.isText) {
      const text = child.text ?? "";
      for (let i = 0; i < text.length; i++) {
        // The line starts just after the newline.
        if (text.charCodeAt(i) === 10 && childOffset + i + 1 <= offset) breaks++;
      }
    } else if (isHardBreak(child) && childOffset + child.nodeSize <= offset) {
      breaks++;
    }
  });
  return breaks;
}

/** Content-relative offset where line `line` (0-based) starts inside a textblock. */
function textblockOffsetForLine(node: ProseMirrorNode, line: number): number {
  if (line <= 0) return 0;
  let seen = 0;
  let found = -1;
  node.forEach((child, childOffset) => {
    if (found >= 0) return;
    if (child.isText) {
      const text = child.text ?? "";
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue;
        if (++seen === line) { found = childOffset + i + 1; return; }
      }
    } else if (isHardBreak(child)) {
      if (++seen === line) found = childOffset + child.nodeSize;
    }
  });
  return found >= 0 ? found : 0;
}

interface CountState {
  chars: number;
  words: number;
  /** Whether the previous character was a separator, within the current block. */
  atBoundary: boolean;
}

function countRun(text: string, state: CountState): void {
  state.chars += text.length;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) {
      state.atBoundary = true;
    } else if (state.atBoundary) {
      state.words++;
      state.atBoundary = false;
    }
  }
}

function countTextblock(node: ProseMirrorNode, state: CountState): void {
  // A word never spans a block boundary, so each textblock starts fresh.
  state.atBoundary = true;
  node.forEach((child) => {
    if (isHardBreak(child)) {
      state.atBoundary = true;
      return;
    }
    if (child.isText) {
      countRun(child.text ?? "", state);
      return;
    }
    // An inline leaf contributes to `doc.textContent` only through `leafText`.
    // Honouring it keeps `chars` equal to `doc.textContent.length` even if the
    // schema later gains such a node; its own newlines are NOT treated as line
    // breaks, because a position inside an atom is not addressable.
    const leafText = child.type.spec.leafText;
    if (leafText) countRun(leafText(child), state);
  });
}

interface NodeStats {
  lines: number;
  chars: number;
  words: number;
}

const LEAF_BLOCK_STATS: NodeStats = { lines: 1, chars: 0, words: 0 };
const INLINE_LEAF_STATS: NodeStats = { lines: 0, chars: 0, words: 0 };

// Lines, characters, and words are pure functions of an immutable node, and
// ProseMirror reuses untouched nodes across transactions — so caching by node
// identity makes a rebuild after an edit visit only the changed blocks. All
// three are additive over child blocks because a word never spans a block
// boundary. Without the cache, moving the caret inside a 5000-item list
// re-counted every preceding item, and every keystroke re-scanned every
// character of the document for the word count.
const statsCache = new WeakMap<ProseMirrorNode, NodeStats>();

function nodeStats(node: ProseMirrorNode): NodeStats {
  if (node.isLeaf && !node.isTextblock) return node.isBlock ? LEAF_BLOCK_STATS : INLINE_LEAF_STATS;
  const cached = statsCache.get(node);
  if (cached !== undefined) return cached;
  let stats: NodeStats;
  if (node.isTextblock) {
    const counts: CountState = { chars: 0, words: 0, atBoundary: true };
    countTextblock(node, counts);
    stats = { lines: textblockLineCount(node), chars: counts.chars, words: counts.words };
  } else {
    let lines = 0;
    let chars = 0;
    let words = 0;
    node.forEach((child) => {
      const s = nodeStats(child);
      lines += s.lines;
      chars += s.chars;
      words += s.words;
    });
    // A block container holding no textblock at all still occupies a line
    // rather than vanishing from the count.
    stats = { lines: lines || 1, chars, words };
  }
  statsCache.set(node, stats);
  return stats;
}

/** Logical lines inside one node, counting nested textblocks. */
function linesInNode(node: ProseMirrorNode): number {
  return nodeStats(node).lines;
}

/**
 * Build the per-block line offsets and the document-wide character/word counts.
 * Unchanged blocks come from the per-node cache, so a rebuild after an edit
 * costs O(top-level blocks) plus the changed blocks' text; callers still cache
 * it against `doc` identity, which ProseMirror preserves across selection-only
 * transactions.
 */
export function buildLineIndex(doc: ProseMirrorNode): LineIndex {
  const prefix: number[] = [0];
  const starts: number[] = [];
  let chars = 0;
  let words = 0;
  let lines = 0;
  let pos = 0;
  doc.forEach((block) => {
    starts.push(pos);
    pos += block.nodeSize;
    const stats = nodeStats(block);
    lines += stats.lines;
    chars += stats.chars;
    words += stats.words;
    prefix.push(lines);
  });
  return {
    total: Math.max(1, lines),
    prefix,
    starts,
    chars,
    words,
    doc,
  };
}

/**
 * Logical lines inside `node` that end before `pos`. Mirrors `linesInNode`, so
 * a position in the third list item of a bullet list reports offset 2 — the
 * lines of a container come from its nested textblocks, not from the container.
 * `nodePos` is the position immediately before `node`.
 */
function lineOffsetForPos(node: ProseMirrorNode, nodePos: number, pos: number): number {
  if (node.isTextblock) {
    const contentStart = nodePos + 1;
    if (pos <= contentStart) return 0;
    const offset = Math.min(pos - contentStart, node.content.size);
    return textblockBreaksBefore(node, offset);
  }
  if (node.isLeaf) return 0;

  let seen = 0;
  let childPos = nodePos + 1;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childEnd = childPos + child.nodeSize;
    if (pos < childEnd) return seen + lineOffsetForPos(child, childPos, pos);
    seen += linesInNode(child);
    childPos = childEnd;
  }
  // Past the last child: the caret belongs to this node's final line.
  return Math.max(0, seen - 1);
}

/**
 * Inverse of `lineOffsetForPos`: the position starting the `offset`-th logical
 * line inside `node`.
 *
 * For a leaf block (horizontal rule, block image) this is the position *before*
 * the node — block content, not a text position. Callers that place a cursor
 * there must go through `Selection.near` / `NodeSelection`, never
 * `TextSelection.create`, which would build a selection whose parent has no
 * inline content and make the next keystroke insert a new block.
 */
function positionForLineOffset(node: ProseMirrorNode, nodePos: number, offset: number): number {
  if (node.isTextblock) {
    return nodePos + 1 + textblockOffsetForLine(node, Math.max(0, offset));
  }
  if (node.isLeaf) return nodePos;

  let remaining = offset;
  let childPos = nodePos + 1;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const lines = linesInNode(child);
    if (remaining < lines) return positionForLineOffset(child, childPos, remaining);
    remaining -= lines;
    childPos += child.nodeSize;
  }
  return nodePos + 1;
}

/** Index of the top-level block containing `pos`, clamped into range. */
function topLevelIndexAt(doc: ProseMirrorNode, pos: number): number {
  const lastBlock = Math.max(0, doc.childCount - 1);
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  // `index(0)` is the block index at depth 1, or — when the position sits in
  // the gap between blocks (depth 0) — the number of blocks before that gap,
  // which can land one past the last block. Clamping covers both.
  return Math.max(0, Math.min(doc.resolve(clamped).index(0), lastBlock));
}

/** 1-based logical line containing `pos`. */
export function posToLine(index: LineIndex, pos: number): number {
  const doc = index.doc;
  if (doc.childCount === 0) return 1;
  const blockIndex = topLevelIndexAt(doc, pos);
  const base = index.prefix[blockIndex] ?? 0;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const within = lineOffsetForPos(doc.child(blockIndex), index.starts[blockIndex], clamped);
  return Math.min(index.total, base + within + 1);
}

/**
 * Document position at the start of 1-based logical `line`, clamped into the
 * document. See `positionForLineOffset` on leaf blocks: the result is not
 * always a valid text position.
 */
export function lineToPos(index: LineIndex, line: number): number {
  const doc = index.doc;
  if (doc.childCount === 0) return 0;
  const target = Math.max(1, Math.min(Math.floor(line) || 1, index.total));

  // Last block whose first line is <= target.
  let lo = 0;
  let hi = doc.childCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.prefix[mid] < target) lo = mid;
    else hi = mid - 1;
  }

  const remaining = target - (index.prefix[lo] ?? 0) - 1;
  const pos = positionForLineOffset(doc.child(lo), index.starts[lo], remaining);
  return Math.max(0, Math.min(pos, doc.content.size));
}

/**
 * Selection to place at a `lineToPos` result.
 *
 * A line that *is* a leaf block — a horizontal rule or a block image —
 * resolves to a position in block content. `TextSelection.create` does not
 * throw there; it silently builds a selection whose parent has no inline
 * content, and the next keystroke inserts a whole new paragraph before the node
 * the user jumped to. Select the node itself instead, and fall back to the
 * nearest valid selection for anything else unexpected.
 */
export function selectionForLinePos(doc: ProseMirrorNode, pos: number): Selection {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.parent.inlineContent) return TextSelection.create(doc, $pos.pos);
  const nodeAfter = $pos.nodeAfter;
  if (nodeAfter && NodeSelection.isSelectable(nodeAfter)) {
    return NodeSelection.create(doc, $pos.pos);
  }
  // Last resort, and it can land on a neighbouring line: `Selection.near`
  // searches outward for any valid selection. Every block leaf in this app's
  // schema (horizontal rule, image) is selectable, so the branch above always
  // wins. A future NON-selectable block atom would silently make Go to Line
  // jump to the wrong line — give such a node `selectable: true`, or teach
  // this function to hold the line some other way.
  return Selection.near($pos, 1);
}

/**
 * Word count for a plain string. Whitespace-delimited runs, which matches both
 * English words and Korean 어절; the character count beside it covers the CJK
 * reading where each glyph counts.
 *
 * Prefer `buildLineIndex(...).words` for a document — passing
 * `doc.textContent` here silently fuses adjacent blocks into one word.
 */
export function countWords(text: string): number {
  let words = 0;
  let atBoundary = true;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) atBoundary = true;
    else if (atBoundary) { words++; atBoundary = false; }
  }
  return words;
}
