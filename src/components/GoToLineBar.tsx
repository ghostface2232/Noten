import { useState, useRef, useEffect, useCallback } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { scrollToPos } from "../utils/scrollToPos";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";
import { pressableButton } from "../styles/interactions";

const useStyles = makeStyles({
  wrapper: {
    position: "absolute",
    top: "8px",
    right: "20px",
    display: "flex",
    alignItems: "center",
    gap: "2px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    padding: "6px 5px 6px 12px",
    boxShadow: tokens.shadow8,
    minWidth: "100px",
    width: "fit-content",
    pointerEvents: "auto",
  },
  input: {
    width: "60px",
    border: "none",
    outline: "none",
    fontSize: "13px",
    fontFamily: "inherit",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    lineHeight: "28px",
    "::placeholder": {
      color: tokens.colorNeutralForeground4,
      opacity: 0.55,
    },
  },
  count: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
    paddingRight: "4px",
    minWidth: "36px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    border: "none",
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground2,
    cursor: "pointer",
    flexShrink: 0,
    padding: 0,
    ...pressableButton,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
});

interface GoToLineBarProps {
  editor: Editor | null;
  onClose: () => void;
  locale: Locale;
}

export function GoToLineBar({ editor, onClose, locale }: GoToLineBarProps) {
  const styles = useStyles();
  const inputRef = useRef<HTMLInputElement>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const totalLines = editor?.state.doc.childCount ?? 0;
  const currentLine = editor
    ? editor.state.doc.resolve(editor.state.selection.from).index(0) + 1
    : 1;

  const [lineValue, setLineValue] = useState(String(currentLine));

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const showIndicator = useCallback((dom: HTMLElement, coords: { top: number; bottom: number }) => {
    let scrollParent: HTMLElement | null = dom.parentElement;
    while (scrollParent) {
      const { overflowY } = window.getComputedStyle(scrollParent);
      if (overflowY === "auto" || overflowY === "scroll") break;
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) return;

    if (!indicatorRef.current) {
      const el = document.createElement("div");
      el.className = "goto-line-indicator";
      scrollParent.style.position = "relative";
      scrollParent.appendChild(el);
      indicatorRef.current = el;
    }

    const el = indicatorRef.current;
    const parentRect = scrollParent.getBoundingClientRect();
    const top = coords.top - parentRect.top + scrollParent.scrollTop;
    const height = coords.bottom - coords.top;
    el.style.cssText = `
      position: absolute; left: calc(var(--editor-padding-x, 2rem) - 8px); top: ${top}px;
      width: 3px; height: ${height}px; border-radius: 1.5px;
      background: var(--colorBrandForeground1, #0078d4);
      pointer-events: none; z-index: 5;
      transition: top var(--motion-base) ease, height var(--motion-base) ease, opacity var(--motion-base) ease;
      opacity: 1;
    `;
  }, []);

  const hideIndicator = useCallback(() => {
    if (indicatorRef.current) {
      indicatorRef.current.remove();
      indicatorRef.current = null;
    }
  }, []);

  useEffect(() => hideIndicator, [hideIndicator]);

  const jumpToLine = useCallback((rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!/^\d+$/.test(trimmed)) return;
    const parsed = Number.parseInt(trimmed, 10);
    if (!editor) return;

    const total = editor.state.doc.childCount;
    const clamped = Math.max(1, Math.min(total, parsed));
    const targetIndex = clamped - 1;
    let targetPos = 0;
    for (let idx = 0; idx < targetIndex; idx++) {
      targetPos += editor.state.doc.child(idx).nodeSize;
    }
    const pos = targetPos + 1;
    const { tr } = editor.state;
    tr.setSelection(TextSelection.create(editor.state.doc, pos));
    editor.view.dispatch(tr);
    // scrollIntoView requires focus, so we drive scroll manually via scrollToPos
    scrollToPos(editor.view.dom, () => editor.view.coordsAtPos(pos));
    requestAnimationFrame(() => {
      try {
        const coords = editor.view.coordsAtPos(pos);
        showIndicator(editor.view.dom, coords);
      } catch {}
    });
    if (String(clamped) !== rawValue) {
      setLineValue(String(clamped));
    }
  }, [editor, showIndicator]);

  const handleClose = useCallback(() => {
    hideIndicator();
    editor?.commands.focus();
    onClose();
  }, [editor, onClose, hideIndicator]);

  return (
    <div className={styles.wrapper}>
      <input
        ref={inputRef}
        className={styles.input}
        value={lineValue}
        onChange={(e) => {
          const next = e.target.value;
          setLineValue(next);
          jumpToLine(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            handleClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            jumpToLine(lineValue);
          }
        }}
        placeholder={i("search.gotoLinePlaceholder")}
        inputMode="numeric"
        spellCheck={false}
      />
      <span className={styles.count}>
        / {totalLines}
      </span>
      <button className={styles.btn} onClick={handleClose} tabIndex={-1}>
        <DismissRegular fontSize={16} />
      </button>
    </div>
  );
}
