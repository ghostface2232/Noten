import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface OutlineHeading {
  /** Plain text of the heading (inline marks flattened); may be "". */
  text: string;
  /** Heading level 1-6 as authored. */
  level: number;
  /** Position of the heading node in the document. */
  pos: number;
}

/** Deepest indent step shown in the panel — h3..h6 render at the same depth. */
export const OUTLINE_MAX_INDENT_LEVEL = 3;

export function extractHeadings(doc: ProseMirrorNode): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      headings.push({
        text: node.textContent,
        level: Number(node.attrs.level) || 1,
        pos,
      });
      // Headings hold only inline content — nothing to descend into.
      return false;
    }
    // Textblocks can't nest, so a non-heading textblock (paragraph, code
    // block) can't contain a heading — skip its inline content. Block
    // containers (blockquote, list) can, so keep descending into those.
    return !node.isTextblock;
  });
  return headings;
}

/**
 * Cheap change signature so the panel can skip setState (and the re-render)
 * when a doc-changing transaction left every heading's level/text/pos intact.
 */
export function headingsSignature(headings: OutlineHeading[]): string {
  // "\n" cannot occur in heading textContent (headings hold single-line
  // inline content), so it is a collision-free entry separator.
  return headings.map((h) => `${h.level}:${h.pos}:${h.text}`).join("\n");
}

/**
 * Index of the last heading at or before the selection head — the section the
 * caret is currently in. -1 when the caret sits before the first heading or
 * the document has none.
 */
export function activeHeadingIndex(headings: OutlineHeading[], headPos: number): number {
  let active = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].pos > headPos) break;
    active = i;
  }
  return active;
}

/**
 * Clamp a possibly-stale outline pos into the current document so a jump can
 * never throw (a click can race the rAF-coalesced recompute by one frame).
 */
export function clampOutlinePos(pos: number, docContentSize: number): number {
  if (pos < 0) return 0;
  return Math.min(pos, docContentSize);
}

/** Indent depth (0-based) for a heading level, clamped to reduce visual noise. */
export function outlineIndentDepth(level: number): number {
  return Math.max(0, Math.min(level, OUTLINE_MAX_INDENT_LEVEL) - 1);
}
