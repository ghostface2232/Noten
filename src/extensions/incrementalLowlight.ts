import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import highlight from "highlight.js/lib/core";

// Drop-in replacement for @tiptap/extension-code-block-lowlight's plugin with
// the same decorations and O(change) cost per transaction.
//
// The stock plugin walks the whole document twice (`findChildren` on the old
// and new doc) on EVERY transaction — caret moves included — and whenever the
// selection sits in a code block it re-highlights every code block in the
// document. Typing inside one code block of a 1 MiB note cost 3.3 s per key.
//
// Here a transaction that leaves the document untouched returns the previous
// set as-is. Otherwise the changed code blocks are found by node identity
// (ProseMirror shares every untouched node between the old and new document),
// checked against the mapping so a node that was deleted and re-inserted is
// not mistaken for an untouched one. Identity covers every step type,
// including attribute-only steps whose step map is empty. Only changed blocks
// are re-highlighted, and each block's highlight is cached per immutable node,
// so undo or a return to an earlier state reuses it.

interface HighlightRun {
  offset: number;
  length: number;
  className: string;
}

interface LowlightLike {
  highlight: (language: string, value: string) => { children?: unknown[] };
  highlightAuto: (value: string) => { children?: unknown[] };
  listLanguages: () => string[];
  registered?: (language: string) => boolean;
}

interface HastNode {
  type?: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

export const incrementalLowlightKey = new PluginKey<DecorationSet>("incrementalLowlight");

// PluginKey names are uniquified per instance ("lowlight$", "lowlight$1", …),
// and the stock plugin mints a new key each time it is created.
export function isStockLowlightPlugin(plugin: unknown): boolean {
  return /^lowlight\$\d*$/.test((plugin as { key?: string }).key ?? "");
}

// Mirrors the stock plugin's `parseNodes`: flatten the hast tree into text runs
// carrying the accumulated class list.
function collectRuns(nodes: HastNode[], classes: string[], out: HighlightRun[], cursor: { offset: number }): void {
  for (const node of nodes) {
    const nextClasses = node.properties?.className ? [...classes, ...node.properties.className] : classes;
    if (node.children) {
      collectRuns(node.children, nextClasses, out, cursor);
      continue;
    }
    const length = (node.value ?? "").length;
    if (nextClasses.length) out.push({ offset: cursor.offset, length, className: nextClasses.join(" ") });
    cursor.offset += length;
  }
}

export function createIncrementalLowlightPlugin(options: {
  name: string;
  lowlight: LowlightLike;
  defaultLanguage?: string | null;
}): Plugin<DecorationSet> {
  const { name, lowlight, defaultLanguage } = options;
  const runsCache = new WeakMap<ProseMirrorNode, HighlightRun[]>();

  // Same language resolution as the stock `getDecorations`.
  const highlightRuns = (node: ProseMirrorNode): HighlightRun[] => {
    const cached = runsCache.get(node);
    if (cached) return cached;
    const language = node.attrs.language || defaultLanguage;
    const known = !!language && (
      lowlight.listLanguages().includes(language)
      || !!highlight.getLanguage(language)
      || !!lowlight.registered?.(language)
    );
    const text = node.textContent;
    const result = known ? lowlight.highlight(language, text) : lowlight.highlightAuto(text);
    const runs: HighlightRun[] = [];
    collectRuns((result.children ?? []) as HastNode[], [], runs, { offset: 0 });
    runsCache.set(node, runs);
    return runs;
  };

  const decorationsFor = (node: ProseMirrorNode, pos: number, out: Decoration[]) => {
    const start = pos + 1;
    for (const run of highlightRuns(node)) {
      out.push(Decoration.inline(start + run.offset, start + run.offset + run.length, { class: run.className }));
    }
  };

  // Code blocks can nest in lists and quotes, never in inline content, so no
  // walk ever descends into a textblock's text.
  const collectAll = (doc: ProseMirrorNode): Decoration[] => {
    const out: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === name) {
        decorationsFor(node, pos, out);
        return false;
      }
      return !node.isTextblock;
    });
    return out;
  };

  // A node shared by the old and new document keeps valid decorations only if
  // the transaction left it in place: ProseMirror also reuses node objects
  // that a step deleted and re-inserted (drag and drop, undo, a replace with
  // the same slice), and mapping drops the decorations of deleted content.
  // Textblocks other than code blocks carry no highlight, so any identical one
  // is fine; code blocks and containers (which may hold code blocks) must map
  // onto their new position without being deleted.
  const keptInPlace = (node: ProseMirrorNode, oldPos: number, newPos: number, mapping: Mapping): boolean => {
    if (node.isLeaf || (node.isTextblock && node.type.name !== name)) return true;
    const inside = mapping.mapResult(oldPos + 1);
    return !inside.deleted && inside.pos === newPos + 1;
  };

  // Textblocks of `cur` whose decorations cannot be carried over — code blocks
  // to re-highlight, and any other textblock because it may just have stopped
  // being a code block and must shed its old highlight. `oldStart`/`newStart`
  // are the content starts of `old`/`cur`. Siblings are matched in order; on a
  // mismatch the old cursor re-synchronises through the inverse mapping, and
  // since it only moves forward the walk stays linear however many blocks an
  // edit inserted or removed.
  const changedTextblocks = (
    old: ProseMirrorNode | null,
    oldStart: number,
    cur: ProseMirrorNode,
    newStart: number,
    tr: Transaction,
    inverse: () => Mapping,
    found: { node: ProseMirrorNode; pos: number }[],
  ) => {
    const oldCount = old?.childCount ?? 0;
    let j = 0;
    let oldPos = oldStart;
    let pos = newStart;
    for (let i = 0; i < cur.childCount; i++) {
      const child = cur.child(i);
      if (old && j < oldCount) {
        if (old.child(j) !== child) {
          const back = inverse().map(pos, 1);
          while (j < oldCount && oldPos < back) {
            oldPos += old.child(j).nodeSize;
            j++;
          }
        }
        if (j < oldCount && old.child(j) === child && keptInPlace(child, oldPos, pos, tr.mapping)) {
          oldPos += child.nodeSize;
          j++;
          pos += child.nodeSize;
          continue;
        }
      }
      if (child.isTextblock) {
        found.push({ node: child, pos });
      } else if (!child.isLeaf) {
        const counterpart = old && j < oldCount && old.child(j).sameMarkup(child) ? old.child(j) : null;
        changedTextblocks(counterpart, oldPos + 1, child, pos + 1, tr, inverse, found);
      }
      pos += child.nodeSize;
    }
  };

  return new Plugin<DecorationSet>({
    key: incrementalLowlightKey,
    state: {
      init: (_config, { doc }) => DecorationSet.create(doc, collectAll(doc)),
      apply: (tr, set, oldState, newState) => {
        if (!tr.docChanged) return set;
        const changed: { node: ProseMirrorNode; pos: number }[] = [];
        let inverse: Mapping | null = null;
        changedTextblocks(oldState.doc, 0, newState.doc, 0, tr, () => (inverse ??= tr.mapping.invert()), changed);
        let next = set.map(tr.mapping, tr.doc);
        if (changed.length === 0) return next;
        const stale: Decoration[] = [];
        const fresh: Decoration[] = [];
        for (const { node, pos } of changed) {
          stale.push(...next.find(pos + 1, pos + node.nodeSize - 1));
          if (node.type.name === name) decorationsFor(node, pos, fresh);
        }
        if (stale.length) next = next.remove(stale);
        return fresh.length ? next.add(tr.doc, fresh) : next;
      },
    },
    props: {
      decorations(state) {
        return incrementalLowlightKey.getState(state);
      },
    },
  });
}
