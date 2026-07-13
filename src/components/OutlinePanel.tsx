import { memo, useEffect, useRef, useState } from "react";
import { Button, Tooltip, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import type { Editor, EditorEvents } from "@tiptap/react";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";
import { pressableButton } from "../styles/interactions";
import {
  activeHeadingIndex,
  extractHeadings,
  headingsSignature,
  outlineIndentDepth,
  type OutlineHeading,
} from "../utils/outline";

const useStyles = makeStyles({
  panel: {
    width: "240px",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    userSelect: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    padding: "10px 8px 6px 16px",
  },
  title: {
    fontSize: "12px",
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
  },
  closeBtn: {
    minWidth: "24px",
    height: "24px",
    padding: "0",
    borderRadius: "6px",
    border: "none",
    ...pressableButton,
  },
  list: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    margin: 0,
    padding: "0 8px 12px",
    listStyleType: "none",
  },
  item: {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    backgroundColor: "transparent",
    fontSize: "13px",
    lineHeight: "20px",
    fontFamily: "inherit",
    padding: "4px 8px",
    color: tokens.colorNeutralForeground2,
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    ...pressableButton,
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  itemActive: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
    color: tokens.colorNeutralForeground1,
    fontWeight: 500,
    ":hover": {
      backgroundColor: tokens.colorSubtleBackgroundSelected,
    },
  },
  itemUntitled: {
    fontStyle: "italic",
    color: tokens.colorNeutralForeground4,
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    padding: "0 16px 24px",
  },
});

/**
 * Heading list derived from the live document. Follows the StatusBar
 * useEditorStats pattern: subscribe to `transaction`, coalesce to one pass per
 * frame via rAF, unsubscribe + cancel on unmount. Two extra rules on top:
 * (a) a frame whose transactions were all selection-only skips the doc walk
 * and only refreshes the current-heading highlight, and (b) after a doc walk
 * the result is compared by signature so unchanged outlines skip setState.
 */
function useOutline(editor: Editor | null) {
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (!editor) {
      setHeadings([]);
      setActiveIndex(-1);
      return;
    }

    let frame: number | null = null;
    let docDirty = true;
    let lastSignature: string | null = null;
    let current: OutlineHeading[] = [];

    const compute = () => {
      frame = null;
      if (docDirty) {
        docDirty = false;
        const next = extractHeadings(editor.state.doc);
        const signature = headingsSignature(next);
        if (signature !== lastSignature) {
          lastSignature = signature;
          current = next;
          setHeadings(next);
        }
      }
      setActiveIndex(activeHeadingIndex(current, editor.state.selection.$head.pos));
    };

    const schedule = ({ transaction }: EditorEvents["transaction"]) => {
      if (transaction.docChanged) docDirty = true;
      if (frame === null) frame = requestAnimationFrame(compute);
    };

    compute();
    editor.on("transaction", schedule);
    return () => {
      editor.off("transaction", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [editor]);

  return { headings, activeIndex };
}

export interface OutlinePanelProps {
  editor: Editor | null;
  locale: Locale;
  onClose: () => void;
  /** Jump to a heading pos — chrome lock, selection, and scroll live in App. */
  onNavigate: (pos: number) => void;
}

function OutlinePanelImpl({ editor, locale, onClose, onNavigate }: OutlinePanelProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);
  const { headings, activeIndex } = useOutline(editor);
  const listRef = useRef<HTMLUListElement>(null);

  const close = () => {
    onClose();
    // Return focus to the editor so it doesn't die inside the hidden panel.
    editor?.commands.focus();
  };

  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Stop before the window-level shortcut handler, which would also close
    // an open find/go-to-line bar on the same press.
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-outline-item]") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : Math.min(current + 1, items.length - 1);
    else next = current < 0 ? 0 : Math.max(current - 1, 0);
    e.preventDefault();
    items[next]?.focus();
  };

  // Roving tabindex: one tab stop for the whole list — the current heading,
  // or the first item when the caret is above every heading.
  const tabStopIndex = activeIndex >= 0 ? activeIndex : 0;

  return (
    <nav
      className={styles.panel}
      aria-label={i("outline.title")}
      onKeyDown={handlePanelKeyDown}
    >
      <div className={styles.header}>
        <span className={styles.title}>{i("outline.title")}</span>
        <Tooltip content={i("outline.close")} relationship="label">
          <Button
            appearance="subtle"
            icon={<DismissRegular />}
            className={styles.closeBtn}
            onClick={close}
            aria-label={i("outline.close")}
          />
        </Tooltip>
      </div>
      {headings.length === 0 ? (
        <div className={styles.empty}>{i("outline.empty")}</div>
      ) : (
        <ul ref={listRef} className={styles.list} onKeyDown={handleListKeyDown}>
          {headings.map((h, idx) => {
            const untitled = h.text.trim().length === 0;
            return (
              <li key={`${h.pos}-${idx}`}>
                <button
                  type="button"
                  data-outline-item
                  className={mergeClasses(
                    styles.item,
                    idx === activeIndex && styles.itemActive,
                    untitled && styles.itemUntitled,
                  )}
                  style={{ paddingLeft: `${8 + outlineIndentDepth(h.level) * 14}px` }}
                  tabIndex={idx === tabStopIndex ? 0 : -1}
                  aria-current={idx === activeIndex ? "true" : undefined}
                  onClick={() => onNavigate(h.pos)}
                  title={untitled ? undefined : h.text}
                >
                  {untitled ? i("outline.untitled") : h.text}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

// Memoized like StatusBar/EditorToolbar: unrelated App state changes don't
// re-render the panel; it re-renders from its own transaction subscription.
export const OutlinePanel = memo(OutlinePanelImpl);
