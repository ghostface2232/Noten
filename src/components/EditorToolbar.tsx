import { useEffect, useRef, useState, useCallback } from "react";
import {
  Button,
  Tooltip,
  Divider,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
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
  ArrowUndoRegular,
  ArrowRedoRegular,
  ChevronDownRegular,
  SearchRegular,
  TextFirstLineRegular,
} from "@fluentui/react-icons";
import { pickAndInsertImage } from "../extensions/ImageDrop";
import { insertMermaidCodeBlock } from "../extensions/mermaidCommands";
import { t } from "../i18n";
import type { Editor } from "@tiptap/react";
import type { Locale } from "../hooks/useSettings";

const useStyles = makeStyles({
  bar: {
    flexShrink: 0,
    overflow: "hidden",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    zIndex: 5,
    pointerEvents: "auto",
    transitionProperty: "height, opacity, border-bottom-color",
    transitionDuration: "0.25s",
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
    transitionDuration: "0.25s",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  gridHidden: {
    transform: "translateY(-18px)",
    opacity: 0,
  },
  /* tools 기본: 1줄 모드 (grid-column/row 등은 JS에서 직접 설정) */
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
  },
  toolBtnActive: {
    minWidth: "28px",
    height: "28px",
    padding: "0",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "var(--ui-active-bg)",
    fontWeight: 500,
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
  },
});

function getHeadingLabel(editor: Editor | null, locale: Locale): string {
  if (!editor) return t("heading.body", locale);
  for (let lvl = 1; lvl <= 6; lvl++) {
    if (editor.isActive("heading", { level: lvl })) return `H${lvl}`;
  }
  return t("heading.body", locale);
}

interface EditorToolbarProps {
  editor: Editor | null;
  sidebarOpen: boolean;
  hidden: boolean;
  locale: Locale;
  onBarHeight?: (height: number) => void;
  onOpenSearch: () => void;
  onOpenGoToLine: () => void;
}

export function EditorToolbar({
  editor,
  sidebarOpen,
  hidden,
  locale,
  onBarHeight,
  onOpenSearch,
  onOpenGoToLine,
}: EditorToolbarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const gridRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const isTwoRows = useRef(false);

  const [barHeight, setBarHeight] = useState(0);

  /* 에디터 transaction 변경 시 툴바 리렌더 (transaction은 selectionUpdate를 포함) */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick((n) => n + 1);
    editor.on("transaction", bump);
    return () => { editor.off("transaction", bump); };
  }, [editor]);

  /**
   * ResizeObserver 콜백: DOM 직접 조작으로 1줄/2줄 전환.
   * React state를 건드리지 않으므로 re-render → observer 루프가 발생하지 않는다.
   * 레이아웃 확정 후 barHeight만 state로 전달한다.
   */
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

  const measure = useCallback(() => {
    const g = gridRef.current;
    const t = toolsRef.current;
    if (!g) return;

    if (t) {
      const needs = !!editor && g.clientWidth < BREAKPOINT;
      isTwoRows.current = needs;
      applyLayout(t, needs);
    }

    const h = g.offsetHeight;
    setBarHeight(h);
    onBarHeight?.(h);
  }, [applyLayout, editor, onBarHeight]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // toolbar content 변경 시 DOM 렌더 완료 후 measure (이중 rAF로 레이아웃 확정 보장)
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(measure));
  }, [measure]);

  const isHeading = editor?.isActive("heading") ?? false;
  const headingLabel = getHeadingLabel(editor, locale);

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
            !editor,
          )}
          {tb(
            i("tool.redo"),
            <ArrowRedoRegular />,
            () => editor?.chain().focus().redo().run(),
            false,
            !editor,
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
                <MenuPopover>
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
                editor?.isActive("bold") ?? false)}
              {tb(i("tool.italic"), <TextItalicRegular />,
                () => editor?.chain().focus().toggleItalic().run(),
                editor?.isActive("italic") ?? false)}
              {tb(i("tool.underline"), <TextUnderlineRegular />,
                () => editor?.chain().focus().toggleUnderline().run(),
                editor?.isActive("underline") ?? false)}
              {tb(i("tool.strike"), <TextStrikethroughRegular />,
                () => editor?.chain().focus().toggleStrike().run(),
                editor?.isActive("strike") ?? false)}
              {tb(i("tool.code"), <CodeRegular />,
                () => editor?.chain().focus().toggleCode().run(),
                editor?.isActive("code") ?? false)}

              <Divider vertical className={styles.divider} />

              {tb(i("tool.bulletList"), <TextBulletListRegular />,
                () => editor?.chain().focus().toggleBulletList().run(),
                editor?.isActive("bulletList") ?? false)}
              {tb(i("tool.orderedList"), <TextNumberListLtrRegular />,
                () => editor?.chain().focus().toggleOrderedList().run(),
                editor?.isActive("orderedList") ?? false)}
              {tb(i("tool.taskList"), <TaskListLtrRegular />,
                () => editor?.chain().focus().toggleTaskList().run(),
                editor?.isActive("taskList") ?? false)}
              {tb(i("tool.blockquote"), <TextQuoteOpeningRegular />,
                () => editor?.chain().focus().toggleBlockquote().run(),
                editor?.isActive("blockquote") ?? false)}
              {tb(i("tool.hr"), <LineHorizontal1Regular />,
                () => editor?.chain().focus().setHorizontalRule().run(),
                false)}
              {tb(i("tool.codeBlock"), <CodeBlockRegular />,
                () => editor?.chain().focus().toggleCodeBlock().run(),
                editor?.isActive("codeBlock") ?? false)}
              {tb(i("tool.mermaid"), <FlowchartRegular />,
                () => { if (editor) insertMermaidCodeBlock(editor); },
                editor?.isActive("codeBlock", { language: "mermaid" }) ?? false)}

              <Divider vertical className={styles.divider} />

              {tb(i("tool.image"), <ImageAddRegular />,
                () => { if (editor) pickAndInsertImage(editor); },
                false)}
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
        </div>
      </div>
    </div>
  );
}
