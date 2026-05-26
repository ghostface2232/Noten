import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Tooltip } from "@fluentui/react-components";
import {
  TableMoveAboveRegular,
  TableMoveBelowRegular,
  TableDeleteRowRegular,
  TableMoveLeftRegular,
  TableMoveRightRegular,
  TableDeleteColumnRegular,
  TableFreezeRowRegular,
  TableDismissRegular,
} from "@fluentui/react-icons";
import type { Editor } from "@tiptap/react";
import { usePopoverAnchor, type PopoverReference } from "../hooks/usePopoverAnchor";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";

interface TableBubbleMenuProps {
  editor: Editor | null;
  locale: Locale;
}

function findTableElement(editor: Editor): HTMLTableElement | null {
  const { state, view } = editor;
  const { from } = state.selection;
  try {
    const domAt = view.domAtPos(from);
    let el: Node | null = domAt.node;
    while (el && !(el instanceof HTMLTableElement)) {
      el = el.parentNode;
    }
    return el instanceof HTMLTableElement ? el : null;
  } catch {
    return null;
  }
}

function TableBubbleMenuImpl({ editor, locale }: TableBubbleMenuProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // tableEl as state (not ref) so getReference's identity changes when the
  // user moves between tables — this re-triggers usePopoverAnchor's autoUpdate
  // against the new element instead of holding a stale closure.
  const [tableEl, setTableEl] = useState<HTMLTableElement | null>(null);
  // Re-render tick so .can() booleans stay fresh on each rAF inside the same table.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!editor) return;
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      const nextEl = editor.isActive("table") ? findTableElement(editor) : null;
      setTableEl((prev) => (prev === nextEl ? prev : nextEl));
      setTick((n) => n + 1);
    };
    const bump = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(sync);
    };
    editor.on("transaction", bump);
    editor.on("focus", bump);
    editor.on("blur", bump);
    bump();
    return () => {
      editor.off("transaction", bump);
      editor.off("focus", bump);
      editor.off("blur", bump);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [editor]);

  const getReference = useCallback((): PopoverReference | null => {
    if (!tableEl) return null;
    return {
      contextElement: tableEl,
      getBoundingClientRect: () => tableEl.getBoundingClientRect(),
    };
  }, [tableEl]);

  const open = tableEl !== null;

  usePopoverAnchor({
    open,
    popoverRef,
    getReference,
    placement: "top",
    offsetPx: 8,
  });

  if (!editor || !open) return null;

  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  // Tiptap table commands' .can() returns false when cursor isn't in a cell —
  // open=true already implies isActive("table"), so these should normally pass.
  const canAddRowBefore = editor.can().addRowBefore?.() ?? false;
  const canAddRowAfter = editor.can().addRowAfter?.() ?? false;
  const canDeleteRow = editor.can().deleteRow?.() ?? false;
  const canAddColBefore = editor.can().addColumnBefore?.() ?? false;
  const canAddColAfter = editor.can().addColumnAfter?.() ?? false;
  const canDeleteCol = editor.can().deleteColumn?.() ?? false;
  const canToggleHeader = editor.can().toggleHeaderRow?.() ?? false;
  const canDeleteTable = editor.can().deleteTable?.() ?? false;

  // preventDefault on mousedown so the editor selection (and therefore the
  // table context the command resolves against) survives the click.
  const stopFocusLoss = (e: React.MouseEvent) => e.preventDefault();

  const btn = (
    tooltip: string,
    icon: React.ReactElement,
    action: () => void,
    disabled: boolean,
    danger = false,
  ) => (
    <Tooltip content={tooltip} relationship="label">
      <button
        type="button"
        className={
          danger
            ? "tiptap-table-bubble-button tiptap-table-bubble-button-danger"
            : "tiptap-table-bubble-button"
        }
        aria-label={tooltip}
        disabled={disabled}
        onMouseDown={stopFocusLoss}
        onClick={action}
      >
        {icon}
      </button>
    </Tooltip>
  );

  return (
    <div
      ref={popoverRef}
      className="tiptap-table-bubble"
      role="toolbar"
      aria-label={i("tool.table")}
      onMouseDown={stopFocusLoss}
    >
      {btn(
        i("table.addRowBefore"),
        <TableMoveAboveRegular fontSize={16} />,
        () => editor.chain().focus().addRowBefore().run(),
        !canAddRowBefore,
      )}
      {btn(
        i("table.addRowAfter"),
        <TableMoveBelowRegular fontSize={16} />,
        () => editor.chain().focus().addRowAfter().run(),
        !canAddRowAfter,
      )}
      {btn(
        i("table.deleteRow"),
        <TableDeleteRowRegular fontSize={16} />,
        () => editor.chain().focus().deleteRow().run(),
        !canDeleteRow,
      )}
      <span className="tiptap-table-bubble-divider" aria-hidden="true" />
      {btn(
        i("table.addColumnBefore"),
        <TableMoveLeftRegular fontSize={16} />,
        () => editor.chain().focus().addColumnBefore().run(),
        !canAddColBefore,
      )}
      {btn(
        i("table.addColumnAfter"),
        <TableMoveRightRegular fontSize={16} />,
        () => editor.chain().focus().addColumnAfter().run(),
        !canAddColAfter,
      )}
      {btn(
        i("table.deleteColumn"),
        <TableDeleteColumnRegular fontSize={16} />,
        () => editor.chain().focus().deleteColumn().run(),
        !canDeleteCol,
      )}
      <span className="tiptap-table-bubble-divider" aria-hidden="true" />
      {btn(
        i("table.toggleHeader"),
        <TableFreezeRowRegular fontSize={16} />,
        () => editor.chain().focus().toggleHeaderRow().run(),
        !canToggleHeader,
      )}
      <span className="tiptap-table-bubble-divider" aria-hidden="true" />
      {btn(
        i("table.delete"),
        <TableDismissRegular fontSize={16} />,
        () => editor.chain().focus().deleteTable().run(),
        !canDeleteTable,
        true,
      )}
    </div>
  );
}

export const TableBubbleMenu = memo(TableBubbleMenuImpl);
