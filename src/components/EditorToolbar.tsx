import { memo, useEffect, useRef, useState, useCallback } from "react";
import {
  Button,
  Tooltip,
  Divider,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  TextBoldRegular,
  TextItalicRegular,
  TextUnderlineRegular,
  TextStrikethroughRegular,
  CodeRegular,
  CodeBlockRegular,
  FlowchartRegular,
  TextBulletListRegular,
  TextNumberListLtrRegular,
  TaskListLtrRegular,
  TextQuoteOpeningRegular,
  LineHorizontal1Regular,
  ImageAddRegular,
  TableRegular,
  ArrowUndoRegular,
  ArrowRedoRegular,
  ChevronDownRegular,
  SearchRegular,
  TextBulletListTreeRegular,
  TextFirstLineRegular,
} from "@fluentui/react-icons";
import { pickAndInsertImage } from "../extensions/ImageDrop";
import { insertMermaidCodeBlock } from "../extensions/mermaidCommands";
import { t } from "../i18n";
import type { Editor } from "@tiptap/react";
import type { Locale } from "../hooks/useSettings";
import {
  MOTION_DURATION_BASE,
  MOTION_DURATION_SLOW,
  pressableButton,
} from "../styles/interactions";

const useStyles = makeStyles({
  bar: {
    flexShrink: 0,
    overflow: "hidden",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    zIndex: 5,
    pointerEvents: "auto",
    transitionProperty: "height, opacity, border-bottom-color",
    transitionDuration: MOTION_DURATION_SLOW,
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  barHidden: {
    pointerEvents: "none",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    columnGap: "6px",
    rowGap: "4px",
    padding: "10px 10px",
    transitionProperty: "transform, opacity",
    transitionDuration: MOTION_DURATION_SLOW,
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  gridHidden: {
    transform: "translateY(-18px)",
    opacity: 0,
  },
  tools: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    whiteSpace: "nowrap",
    gridColumn: "2",
    gridRow: "1",
    justifySelf: "center",
    overflow: "hidden",
    maxWidth: "1600px",
  },
  undo: {
    gridColumn: "1",
    gridRow: "1",
    justifySelf: "start",
    display: "flex",
    alignItems: "center",
    gap: "2px",
  },
  search: {
    gridColumn: "3",
    gridRow: "1",
    justifySelf: "end",
    display: "flex",
    alignItems: "center",
    gap: "2px",
  },
  searchIconNudge: {
    display: "inline-flex",
    transform: "translateY(-1px)",
  },
  divider: {
    height: "20px",
    marginLeft: "4px",
    marginRight: "4px",
  },
  toolBtn: {
    minWidth: "28px",
    height: "28px",
    padding: "0",
    borderRadius: "6px",
    border: "none",
    ...pressableButton,
  },
  toolBtnActive: {
    minWidth: "28px",
    height: "28px",
    padding: "0",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "var(--ui-active-bg)",
    fontWeight: 500,
    ...pressableButton,
  },
  headingBtn: {
    width: "64px",
    minWidth: "64px",
    maxWidth: "64px",
    height: "28px",
    padding: "0 4px",
    borderRadius: "6px",
    border: "none",
    fontSize: "12px",
    fontWeight: 400,
    gap: "2px",
    ...pressableButton,
  },
  headingBtnActive: {
    width: "64px",
    minWidth: "64px",
    maxWidth: "64px",
    height: "28px",
    padding: "0 4px",
    borderRadius: "6px",
    border: "none",
    fontSize: "12px",
    gap: "2px",
    fontWeight: 400,
    ...pressableButton,
  },
  popoverSurface: {
    animationName: {
      from: { opacity: 0, filter: "blur(4px)" },
      to: { opacity: 1, filter: "blur(0px)" },
    },
    animationDuration: MOTION_DURATION_BASE,
    animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
    animationFillMode: "backwards",
  },
});

const TABLE_PICKER_ROWS = 6;
const TABLE_PICKER_COLS = 8;

interface TablePickerProps {
  editor: Editor;
  locale: Locale;
  onPick: () => void;
}

function TableGridPicker({ editor, locale, onPick }: TablePickerProps) {
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const rows = hover ? hover.row + 1 : 0;
  const cols = hover ? hover.col + 1 : 0;
  const label = rows && cols
    ? `${rows} × ${cols}`
    : t("table.gridPlaceholder", locale);

  const insert = (r: number, c: number) => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: r, cols: c, withHeaderRow: true })
      .run();
    onPick();
  };

  const cells: React.ReactElement[] = [];
  for (let r = 0; r < TABLE_PICKER_ROWS; r++) {
    for (let c = 0; c < TABLE_PICKER_COLS; c++) {
      const active = hover != null && r <= hover.row && c <= hover.col;
      cells.push(
        <button
          key={`${r}-${c}`}
          type="button"
          className={
            active
              ? "tiptap-table-grid-picker-cell is-active"
              : "tiptap-table-grid-picker-cell"
          }
          onMouseEnter={() => setHover({ row: r, col: c })}
          onFocus={() => setHover({ row: r, col: c })}
          onClick={() => insert(r + 1, c + 1)}
          aria-label={`${r + 1} × ${c + 1}`}
        />,
      );
    }
  }

  return (
    <div className="tiptap-table-grid-picker" onMouseLeave={() => setHover(null)}>
      <div className="tiptap-table-grid-picker-grid">{cells}</div>
      <div className="tiptap-table-grid-picker-label">{label}</div>
    </div>
  );
}

interface TableInsertButtonProps {
  editor: Editor;
  locale: Locale;
  tooltip: string;
  buttonClassName: string;
  popoverClassName: string;
}

function TableInsertButton({ editor, locale, tooltip, buttonClassName, popoverClassName }: TableInsertButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(_, data) => setOpen(data.open)}
      positioning="below"
      withArrow={false}
      trapFocus={false}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Tooltip content={tooltip} relationship="label">
          <Button
            appearance="subtle"
            icon={<TableRegular />}
            className={buttonClassName}
            aria-label={tooltip}
          />
        </Tooltip>
      </PopoverTrigger>
      <PopoverSurface tabIndex={-1} className={popoverClassName} style={{ padding: 8 }}>
        <TableGridPicker
          editor={editor}
          locale={locale}
          onPick={() => setOpen(false)}
        />
      </PopoverSurface>
    </Popover>
  );
}

// Everything the toolbar shows that comes from the editor. The render reads
// this and the transaction subscription compares it, so a state the toolbar
// shows can never be missing from the comparison.
function readToolbarState(editor: Editor | null) {
  const active = (name: string, attrs?: Record<string, unknown>) => editor?.isActive(name, attrs) ?? false;
  let headingLevel = 0;
  for (let lvl = 1; lvl <= 6 && !headingLevel; lvl++) {
    if (active("heading", { level: lvl })) headingLevel = lvl;
  }
  return {
    // Not implied by headingLevel: a selection across an H1 and an H2 is in
    // headings without being at any one level.
    heading: active("heading"),
    headingLevel,
    canUndo: editor?.can().undo() ?? false,
    canRedo: editor?.can().redo() ?? false,
    bold: active("bold"),
    italic: active("italic"),
    underline: active("underline"),
    strike: active("strike"),
    code: active("code"),
    bulletList: active("bulletList"),
    orderedList: active("orderedList"),
    taskList: active("taskList"),
    blockquote: active("blockquote"),
    codeBlock: active("codeBlock"),
    mermaid: active("codeBlock", { language: "mermaid" }),
  };
}

type ToolbarState = ReturnType<typeof readToolbarState>;

function sameToolbarState(a: ToolbarState, b: ToolbarState): boolean {
  return (Object.keys(a) as Array<keyof ToolbarState>).every((key) => a[key] === b[key]);
}

interface EditorToolbarProps {
  editor: Editor | null;
  sidebarOpen: boolean;
  hidden: boolean;
  locale: Locale;
  onBarHeight?: (height: number) => void;
  onOpenSearch: () => void;
  onOpenGoToLine: () => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
}

function EditorToolbarImpl({
  editor,
  sidebarOpen,
  hidden,
  locale,
  onBarHeight,
  onOpenSearch,
  onOpenGoToLine,
  outlineOpen,
  onToggleOutline,
}: EditorToolbarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const gridRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const isTwoRows = useRef(false);

  const [barHeight, setBarHeight] = useState(0);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor || hidden) return;
    // rAF-coalesce: reading the state calls 10+ editor.isActive(...) plus
    // can().undo()/can().redo(), so a transaction storm (typing, IME) used to
    // re-render the whole toolbar per keystroke. One read per frame keeps
    // active-state feedback responsive without paying the cost N times per ms.
    // And only a changed state re-renders: every render hands the buttons new
    // handlers, and any React commit that touches the DOM while the editor is
    // focused walks the entire editor DOM (React's selection bookkeeping) —
    // ~7 ms per frame in a 1 MB note while typing plain text.
    let frame: number | null = null;
    // Unknown until the first transaction, which therefore always renders:
    // the state may have moved between this component's render and now.
    let last: ToolbarState | null = null;
    const bump = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const next = readToolbarState(editor);
        if (last && sameToolbarState(last, next)) return;
        last = next;
        setTick((n) => n + 1);
      });
    };
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [editor, hidden]);

  // ResizeObserver mutates layout styles directly to avoid render loops.
  const BREAKPOINT = 740;
  const TWO_ROW_LEFT_COMPENSATION = 36; // 46px(collapsed grid left) - 10px(default grid left)

  const applyLayout = useCallback((t: HTMLElement, twoRows: boolean) => {
    if (twoRows) {
      t.style.gridColumn = "1 / -1";
      t.style.gridRow = "2";
      t.style.justifySelf = "stretch";
      t.style.justifyContent = "space-between";
      t.style.marginLeft = sidebarOpen ? "" : `-${TWO_ROW_LEFT_COMPENSATION}px`;
      t.style.width = sidebarOpen ? "" : `calc(100% + ${TWO_ROW_LEFT_COMPENSATION}px)`;
    } else {
      t.style.gridColumn = "2";
      t.style.gridRow = "1";
      t.style.justifySelf = "center";
      t.style.justifyContent = "";
      t.style.marginLeft = "";
      t.style.width = "";
    }
  }, [sidebarOpen]);

  // Last applied layout, keyed by target element AND state — style writes
  // happen only when the two-row state or the sidebar-dependent offsets
  // actually change. Unconditional writes made the offsetHeight read below a
  // forced synchronous reflow on EVERY ResizeObserver tick (i.e. every frame
  // of a window resize drag); with the gate, steady-state ticks are pure
  // reads against already-clean layout. The element is part of the identity
  // because the tools div unmounts with a null editor — a recreated node
  // starts without the inline styles the key claims were applied.
  const lastLayoutRef = useRef<{ el: HTMLElement; key: string } | null>(null);

  const measure = useCallback(() => {
    const g = gridRef.current;
    const t = toolsRef.current;
    if (!g) return;

    if (t) {
      const needs = !!editor && g.clientWidth < BREAKPOINT;
      isTwoRows.current = needs;
      const layoutKey = `${needs}:${sidebarOpen}`;
      if (lastLayoutRef.current?.el !== t || lastLayoutRef.current.key !== layoutKey) {
        lastLayoutRef.current = { el: t, key: layoutKey };
        applyLayout(t, needs);
      }
    }

    const h = g.offsetHeight;
    setBarHeight(h);
    onBarHeight?.(h);
  }, [applyLayout, editor, onBarHeight, sidebarOpen]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Measure after toolbar content has committed to the DOM.
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(measure));
  }, [measure]);

  const state = readToolbarState(editor);
  const { canUndo, canRedo } = state;
  const isHeading = state.heading;
  const headingLabel = state.headingLevel ? `H${state.headingLevel}` : i("heading.body");

  const tb = (
    tooltip: string,
    icon: React.ReactElement,
    action: () => void,
    active: boolean,
    disabled = false,
  ) => (
    <Tooltip content={tooltip} relationship="label">
      <Button
        appearance="subtle"
        icon={icon}
        className={active ? styles.toolBtnActive : styles.toolBtn}
        onClick={action}
        disabled={disabled}
      />
    </Tooltip>
  );

  return (
    <div
      className={hidden ? `${styles.bar} ${styles.barHidden}` : styles.bar}
      style={{
        height: hidden ? 0 : barHeight,
        opacity: hidden ? 0 : 1,
        borderBottomColor: hidden ? "transparent" : undefined,
      }}
    >
      <div
        ref={gridRef}
        className={hidden ? `${styles.grid} ${styles.gridHidden}` : styles.grid}
        style={!sidebarOpen ? { paddingLeft: "46px" } : undefined}
      >
        <div className={styles.undo}>
          {tb(
            i("tool.undo"),
            <ArrowUndoRegular />,
            () => editor?.chain().focus().undo().run(),
            false,
            !canUndo,
          )}
          {tb(
            i("tool.redo"),
            <ArrowRedoRegular />,
            () => editor?.chain().focus().redo().run(),
            false,
            !canRedo,
          )}
        </div>

        {editor && (
          <>
            <div
              ref={toolsRef}
              className={styles.tools}
            >
              <Menu>
                <MenuTrigger>
                  <Button
                    appearance="subtle"
                    className={isHeading ? styles.headingBtnActive : styles.headingBtn}
                    icon={<ChevronDownRegular />}
                    iconPosition="after"
                  >
                    {headingLabel}
                  </Button>
                </MenuTrigger>
                <MenuPopover className={styles.popoverSurface}>
                  <MenuList>
                    <MenuItem onClick={() => editor?.chain().focus().setParagraph().run()}>
                      <span style={{ fontSize: "0.95em", fontWeight: 400 }}>{i("heading.body")}</span>
                    </MenuItem>
                    <MenuItem onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
                      <span style={{ fontSize: "1.4em", fontWeight: 600 }}>{i("heading.h1")}</span>
                    </MenuItem>
                    <MenuItem onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
                      <span style={{ fontSize: "1.2em", fontWeight: 500 }}>{i("heading.h2")}</span>
                    </MenuItem>
                    <MenuItem onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>
                      <span style={{ fontSize: "1.05em", fontWeight: 500 }}>{i("heading.h3")}</span>
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>

              <Divider vertical className={styles.divider} />

              {tb(i("tool.bold"), <TextBoldRegular />,
                () => editor?.chain().focus().toggleBold().run(),
                state.bold)}
              {tb(i("tool.italic"), <TextItalicRegular />,
                () => editor?.chain().focus().toggleItalic().run(),
                state.italic)}
              {tb(i("tool.underline"), <TextUnderlineRegular />,
                () => editor?.chain().focus().toggleUnderline().run(),
                state.underline)}
              {tb(i("tool.strike"), <TextStrikethroughRegular />,
                () => editor?.chain().focus().toggleStrike().run(),
                state.strike)}
              {tb(i("tool.code"), <CodeRegular />,
                () => editor?.chain().focus().toggleCode().run(),
                state.code)}

              <Divider vertical className={styles.divider} />

              {tb(i("tool.bulletList"), <TextBulletListRegular />,
                () => editor?.chain().focus().toggleBulletList().run(),
                state.bulletList)}
              {tb(i("tool.orderedList"), <TextNumberListLtrRegular />,
                () => editor?.chain().focus().toggleOrderedList().run(),
                state.orderedList)}
              {tb(i("tool.taskList"), <TaskListLtrRegular />,
                () => editor?.chain().focus().toggleTaskList().run(),
                state.taskList)}
              {tb(i("tool.blockquote"), <TextQuoteOpeningRegular />,
                () => editor?.chain().focus().toggleBlockquote().run(),
                state.blockquote)}
              {tb(i("tool.hr"), <LineHorizontal1Regular />,
                () => editor?.chain().focus().setHorizontalRule().run(),
                false)}
              {tb(i("tool.codeBlock"), <CodeBlockRegular />,
                () => editor?.chain().focus().toggleCodeBlock().run(),
                state.codeBlock)}
              {tb(i("tool.mermaid"), <FlowchartRegular />,
                () => { if (editor) insertMermaidCodeBlock(editor); },
                state.mermaid)}

              <Divider vertical className={styles.divider} />

              {tb(i("tool.image"), <ImageAddRegular />,
                () => { if (editor) pickAndInsertImage(editor); },
                false)}
              <TableInsertButton
                editor={editor}
                locale={locale}
                tooltip={i("tool.table")}
                buttonClassName={styles.toolBtn}
                popoverClassName={styles.popoverSurface}
              />
            </div>

          </>
        )}

        <div className={styles.search}>
          {tb(
            i("tool.search"),
            <span className={styles.searchIconNudge}><SearchRegular /></span>,
            onOpenSearch,
            false,
          )}
          {tb(i("tool.gotoLine"), <TextFirstLineRegular />, onOpenGoToLine, false)}
          <Tooltip content={i("outline.toggle")} relationship="label">
            <Button
              appearance="subtle"
              icon={<TextBulletListTreeRegular />}
              className={outlineOpen ? styles.toolBtnActive : styles.toolBtn}
              onClick={onToggleOutline}
              aria-pressed={outlineOpen}
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

// Memoized so unrelated App state changes (e.g. a sidebar group toggle) don't
// re-render the toolbar. While visible it still re-renders on its own editor
// `transaction` subscription; hidden chrome does not pay that cost.
export const EditorToolbar = memo(EditorToolbarImpl);
