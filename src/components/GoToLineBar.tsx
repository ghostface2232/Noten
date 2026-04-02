import { useState, useRef, useEffect, useCallback } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import type { EditorView as CmEditorView } from "@codemirror/view";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";

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
    padding: "4px 4px 4px 10px",
    boxShadow: tokens.shadow8,
    width: "220px",
    pointerEvents: "auto",
  },
  input: {
    flex: 1,
    border: "none",
    outline: "none",
    fontSize: "13px",
    fontFamily: "inherit",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    minWidth: 0,
    lineHeight: "24px",
    "::placeholder": {
      color: tokens.colorNeutralForeground4,
    },
  },
  count: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
    paddingRight: "4px",
    minWidth: "36px",
    textAlign: "right",
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    border: "none",
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground2,
    cursor: "pointer",
    flexShrink: 0,
    padding: 0,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
});

interface GoToLineBarProps {
  cmView: CmEditorView | null;
  onClose: () => void;
  locale: Locale;
}

export function GoToLineBar({ cmView, onClose, locale }: GoToLineBarProps) {
  const styles = useStyles();
  const inputRef = useRef<HTMLInputElement>(null);
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);
  const totalLines = cmView?.state.doc.lines ?? 0;
  const currentLine = cmView
    ? cmView.state.doc.lineAt(cmView.state.selection.main.head).number
    : 1;
  const [lineValue, setLineValue] = useState(String(currentLine));

  useEffect(() => {
    setLineValue(String(currentLine));
  }, [currentLine]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const jumpToLine = useCallback((rawValue: string) => {
    if (!cmView) return;
    const trimmed = rawValue.trim();
    if (!/^\d+$/.test(trimmed)) return;
    const parsed = Number.parseInt(trimmed, 10);
    const clamped = Math.max(1, Math.min(cmView.state.doc.lines, parsed));
    const line = cmView.state.doc.line(clamped);
    cmView.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    cmView.focus();
    if (String(clamped) !== rawValue) {
      setLineValue(String(clamped));
    }
  }, [cmView]);

  const handleClose = useCallback(() => {
    cmView?.focus();
    onClose();
  }, [cmView, onClose]);

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
        <DismissRegular fontSize={14} />
      </button>
    </div>
  );
}
