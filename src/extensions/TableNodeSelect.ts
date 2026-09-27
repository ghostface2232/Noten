import { Extension, callOrReturn, getExtensionField, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// Arrow keys at a textblock's edge next to a table select the whole table
// instead of dropping the caret into its first or last cell. Only the edge
// takes over: anywhere else the key moves the caret as usual, which the
// browser does natively once this returns false.

type Direction = "forward" | "backward";

const ARROWS: Record<string, { direction: Direction; edge: "left" | "right" | "up" | "down" }> = {
  ArrowRight: { direction: "forward", edge: "right" },
  ArrowDown: { direction: "forward", edge: "down" },
  ArrowLeft: { direction: "backward", edge: "left" },
  ArrowUp: { direction: "backward", edge: "up" },
};

function exitableMarkNames(editor: Editor): Set<string> {
  return new Set(
    editor.extensionManager.extensions
      .filter((extension) => extension.type === "mark" && callOrReturn(getExtensionField(extension, "exitable")))
      .map((extension) => extension.name),
  );
}

function atEdge(view: EditorView, edge: "left" | "right" | "up" | "down"): boolean {
  const { $from } = view.state.selection;
  if (edge === "right") return $from.parentOffset === $from.parent.content.size;
  if (edge === "left") return $from.parentOffset === 0;
  // Whether the caret sits on the textblock's last or first visual line needs
  // layout, so only the view can answer it.
  return view.endOfTextblock(edge);
}

export const TableNodeSelect = Extension.create({
  name: "tableNodeSelect",

  addProseMirrorPlugins() {
    const editor = this.editor;
    let exitable: Set<string> | null = null;

    return [
      new Plugin({
        key: new PluginKey("tableNodeSelect"),
        props: {
          handleKeyDown(view, event) {
            const arrow = ARROWS[event.key];
            if (!arrow) return false;

            const { selection, doc } = view.state;
            if (!(selection instanceof TextSelection) || !selection.empty) return false;
            if (!atEdge(view, arrow.edge)) return false;

            const $pos = selection.$from;

            if (arrow.direction === "forward") {
              const after = $pos.after();
              if (after >= doc.content.size) return false;
              const nodeAfter = doc.resolve(after).nodeAfter;
              if (nodeAfter?.type.name !== "table") return false;
              // An exitable mark (inline code, a link) ending the textblock
              // takes the first ArrowRight to step out of the mark, as it does
              // before any other block. It runs after this plugin, so defer.
              if (arrow.edge === "right") {
                exitable ??= exitableMarkNames(editor);
                if ($pos.marks().some((mark) => exitable!.has(mark.type.name))) return false;
              }
              event.preventDefault();
              view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, after)));
              return true;
            }

            const before = $pos.before();
            if (before <= 0) return false;
            const nodeBefore = doc.resolve(before).nodeBefore;
            if (nodeBefore?.type.name !== "table") return false;
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, before - nodeBefore.nodeSize)));
            return true;
          },
        },
      }),
    ];
  },
});

export default TableNodeSelect;
