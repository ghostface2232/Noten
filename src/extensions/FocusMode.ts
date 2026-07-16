import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, type Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node } from "@tiptap/pm/model";

export const focusModePluginKey = new PluginKey("focusMode");

export const FOCUS_ACTIVE_CLASS = "noten-focus-active";

// Focus mode marks the ONE top-level block holding the caret with a node
// decoration; every other block is dimmed by CSS alone (see tiptap-editor.css,
// `.tiptap-focus-mode`). Cost per selection change is therefore constant
// regardless of document size — this plugin must never walk the document
// (no doc.descendants anywhere). Block boundaries come straight from the
// resolved selection head ($head.before(1) / $head.after(1)), and edits that
// keep the caret in the same block reuse the existing decoration set via
// tr.mapping (same pattern as WikiLink's incremental decoration state).

interface FocusModePluginState {
  active: boolean;
  decorations: DecorationSet;
  /** Boundaries of the decorated block; -1 when nothing is decorated. */
  from: number;
  to: number;
}

interface FocusModeStorage {
  active: boolean;
}

const INACTIVE: FocusModePluginState = {
  active: false,
  decorations: DecorationSet.empty,
  from: -1,
  to: -1,
};

/** Keep a restored EditorState aligned with the current React setting. */
export function syncFocusModeState(editor: Editor, active: boolean) {
  const pluginState = focusModePluginKey.getState(editor.state) as
    | FocusModePluginState
    | undefined;
  if (pluginState?.active === active) return;

  const tr = editor.state.tr.setMeta(focusModePluginKey, { active });
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

/**
 * Boundaries of the top-level (depth 1) block containing the selection head,
 * in constant time. Returns null when the selection sits outside any block
 * (gap cursor / AllSelection head at the very end of the document).
 */
export function topLevelBlockRange(
  selection: Selection,
): { from: number; to: number } | null {
  if (selection instanceof NodeSelection) {
    const $from = selection.$from;
    if ($from.depth === 0) {
      // A selected top-level node (image, table) IS the focus block.
      return { from: selection.from, to: selection.to };
    }
    return { from: $from.before(1), to: $from.after(1) };
  }

  const $head = selection.$head;
  if ($head.depth >= 1) {
    return { from: $head.before(1), to: $head.after(1) };
  }

  // Depth 0: the head sits between top-level blocks (gap cursor). Focus the
  // block right after the gap; at the document end there is none.
  const parent = $head.parent;
  const index = $head.index(0);
  if (index >= parent.childCount) return null;
  return { from: $head.pos, to: $head.pos + parent.child(index).nodeSize };
}

function decoratedState(
  doc: Node,
  range: { from: number; to: number } | null,
): FocusModePluginState {
  if (!range) {
    return { active: true, decorations: DecorationSet.empty, from: -1, to: -1 };
  }
  return {
    active: true,
    decorations: DecorationSet.create(doc, [
      Decoration.node(range.from, range.to, { class: FOCUS_ACTIVE_CLASS }),
    ]),
    from: range.from,
    to: range.to,
  };
}

export const FocusMode = Extension.create({
  name: "focusMode",

  addStorage(): FocusModeStorage {
    return { active: false };
  },

  addProseMirrorPlugins() {
    const storage = this.storage as FocusModeStorage;

    return [
      new Plugin<FocusModePluginState>({
        key: focusModePluginKey,
        state: {
          // Storage survives view.updateState() (how openDocument swaps
          // notes), so a note switch re-derives the plugin state instead of
          // silently dropping out of focus mode.
          init: (_, state) =>
            storage.active
              ? decoratedState(state.doc, topLevelBlockRange(state.selection))
              : INACTIVE,
          apply: (tr, prev, _oldState, newState) => {
            const meta = tr.getMeta(focusModePluginKey) as
              | { active: boolean }
              | undefined;
            const active = meta ? meta.active : prev.active;
            storage.active = active;

            if (!active) {
              return prev === INACTIVE ? prev : INACTIVE;
            }

            const range = topLevelBlockRange(newState.selection);
            if (!range) {
              return prev.active && prev.from === -1 && !meta
                ? prev
                : decoratedState(newState.doc, null);
            }

            if (prev.active && prev.from >= 0) {
              if (!tr.docChanged) {
                // Same block, no edit: the set is positionally identical —
                // reuse it so the view layer sees no decoration change.
                if (prev.from === range.from && prev.to === range.to) {
                  return prev;
                }
              } else {
                // Edit that keeps the caret in the same block (typing): remap
                // the existing set instead of rebuilding it. `to` maps with
                // assoc -1 so it stays glued to this block's end when content
                // lands exactly at the boundary.
                const mappedFrom = tr.mapping.map(prev.from);
                const mappedTo = tr.mapping.map(prev.to, -1);
                if (mappedFrom === range.from && mappedTo === range.to) {
                  const mapped = prev.decorations.map(tr.mapping, tr.doc);
                  if (mapped.find(range.from, range.to).length === 1) {
                    return {
                      active: true,
                      decorations: mapped,
                      from: range.from,
                      to: range.to,
                    };
                  }
                }
              }
            }

            return decoratedState(newState.doc, range);
          },
        },
        props: {
          decorations(state) {
            return (
              (this.getState(state) as FocusModePluginState | undefined)
                ?.decorations ?? null
            );
          },
        },
      }),
    ];
  },
});

export default FocusMode;
