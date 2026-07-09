import { useState, useRef, useEffect, useCallback } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  ArrowUpRegular,
  ArrowDownRegular,
  ArrowSwapRegular,
  DismissRegular,
} from "@fluentui/react-icons";
import type { Editor } from "@tiptap/core";
import { searchPluginKey, findSearchMatches, type SearchPluginState } from "../extensions/SearchHighlight";
import { scrollToPos } from "../utils/scrollToPos";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";

const useStyles = makeStyles({
  wrapper: {
    position: "absolute",
    top: "8px",
    right: "20px",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    boxShadow: tokens.shadow8,
    width: "280px",
    pointerEvents: "auto",
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "6px 5px 6px 12px",
  },
  replaceRow: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "0 5px 6px 12px",
    overflow: "hidden",
    animationName: {
      from: { opacity: 0, transform: "translateY(-4px)", filter: "blur(4px)" },
      to: { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
    },
    animationDuration: "0.16s",
    animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
    animationFillMode: "backwards",
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
    transitionProperty: "background-color, color, scale",
    transitionDuration: "0.12s",
    transitionTimingFunction: "ease-out",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ":active": {
      scale: 0.96,
    },
  },
  btnActive: {
    backgroundColor: tokens.colorNeutralBackground1Pressed,
  },
  textBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: "28px",
    border: "none",
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground2,
    cursor: "pointer",
    flexShrink: 0,
    padding: "0 8px",
    fontSize: "12px",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    transitionProperty: "background-color, color, scale",
    transitionDuration: "0.12s",
    transitionTimingFunction: "ease-out",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ":active": {
      scale: 0.96,
    },
  },
});

interface SearchBarProps {
  editor: Editor | null;
  onClose: () => void;
  replaceOpen: boolean;
  onToggleReplace: (open: boolean) => void;
  locale: Locale;
}

export function SearchBar({ editor, onClose, replaceOpen, onToggleReplace, locale }: SearchBarProps) {
  const styles = useStyles();
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (replaceOpen) replaceInputRef.current?.focus(); }, [replaceOpen]);

  const dispatchTiptap = useCallback(
    (q: string, activeIdx: number) => {
      if (!editor) return { count: 0, clamped: 0 };
      const matches = findSearchMatches(editor.state.doc, q);
      const clamped = matches.length > 0
        ? ((activeIdx % matches.length) + matches.length) % matches.length
        : 0;

      const { tr } = editor.state;
      tr.setMeta(searchPluginKey, { query: q, activeIndex: clamped, matches } satisfies SearchPluginState);
      editor.view.dispatch(tr);

      if (matches.length > 0) {
        const match = matches[clamped];
        scrollToPos(editor.view.dom, () => editor.view.coordsAtPos(match.from));
      }
      return { count: matches.length, clamped };
    },
    [editor],
  );

  const dispatchSearch = useCallback(
    (q: string, idx: number) => {
      const result = dispatchTiptap(q, idx);
      setMatchCount(result.count);
      setActiveIndex(result.clamped);
    },
    [dispatchTiptap],
  );

  const handleQueryChange = useCallback(
    (value: string) => { setQuery(value); dispatchSearch(value, 0); },
    [dispatchSearch],
  );

  const goNext = useCallback(() => dispatchSearch(query, activeIndex + 1), [dispatchSearch, query, activeIndex]);
  const goPrev = useCallback(() => dispatchSearch(query, activeIndex - 1), [dispatchSearch, query, activeIndex]);

  const handleClose = useCallback(() => {
    if (editor) {
      const { tr } = editor.state;
      tr.setMeta(searchPluginKey, { query: "", activeIndex: 0, matches: [] } satisfies SearchPluginState);
      editor.view.dispatch(tr);
    }
    setReplaceText("");
    onToggleReplace(false);
    onClose();
  }, [editor, onClose, onToggleReplace]);

  const syncAfterReplace = useCallback(
    (desiredIndex: number) => {
      if (!editor) return;
      // Plugin already recomputed matches in apply().
      const ps = searchPluginKey.getState(editor.state) as SearchPluginState;
      const count = ps.matches.length;
      const idx = count > 0
        ? ((desiredIndex % count) + count) % count
        : 0;

      if (idx !== ps.activeIndex) {
        const { tr } = editor.state;
        tr.setMeta(searchPluginKey, { query, activeIndex: idx, matches: ps.matches } satisfies SearchPluginState);
        editor.view.dispatch(tr);
      }

      setMatchCount(count);
      setActiveIndex(idx);
      if (count > 0 && ps.matches[idx]) {
        scrollToPos(editor.view.dom, () => editor.view.coordsAtPos(ps.matches[idx].from));
      }
    },
    [editor, query],
  );

  const handleReplace = useCallback(() => {
    if (!editor || !query || matchCount === 0) return;
    const ps = searchPluginKey.getState(editor.state) as SearchPluginState;
    const match = ps.matches[ps.activeIndex];
    if (!match) return;

    const { tr } = editor.state;
    tr.insertText(replaceText, match.from, match.to);
    editor.view.dispatch(tr);
    syncAfterReplace(activeIndex);
  }, [editor, query, replaceText, matchCount, activeIndex, syncAfterReplace]);

  const handleReplaceAll = useCallback(() => {
    if (!editor || !query || matchCount === 0) return;
    const ps = searchPluginKey.getState(editor.state) as SearchPluginState;
    const { matches } = ps;

    const { tr } = editor.state;
    for (let idx = matches.length - 1; idx >= 0; idx--) {
      tr.insertText(replaceText, matches[idx].from, matches[idx].to);
    }
    editor.view.dispatch(tr);
    syncAfterReplace(0);
  }, [editor, query, replaceText, matchCount, syncAfterReplace]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleClose(); }
      else if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goPrev() : goNext(); }
    },
    [handleClose, goNext, goPrev],
  );

  const handleReplaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleClose(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleReplaceAll(); }
      else if (e.key === "Enter") { e.preventDefault(); handleReplace(); }
    },
    [handleClose, handleReplace, handleReplaceAll],
  );

  return (
    <div className={styles.wrapper}>
      <div className={styles.topRow}>
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={i("search.placeholder")}
          spellCheck={false}
        />
        <span className={styles.count} style={{ visibility: query ? "visible" : "hidden" }}>
          {query ? (matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "0") : "0/0"}
        </span>
        <button
          className={mergeClasses(styles.btn, replaceOpen && styles.btnActive)}
          onClick={() => onToggleReplace(!replaceOpen)}
          tabIndex={-1}
          title={i("search.replace")}
        >
          <ArrowSwapRegular fontSize={16} />
        </button>
        <button className={styles.btn} onClick={goPrev} tabIndex={-1}>
          <ArrowUpRegular fontSize={16} />
        </button>
        <button className={styles.btn} onClick={goNext} tabIndex={-1}>
          <ArrowDownRegular fontSize={16} />
        </button>
        <button className={styles.btn} onClick={handleClose} tabIndex={-1}>
          <DismissRegular fontSize={16} />
        </button>
      </div>

      {replaceOpen && (
        <div className={styles.replaceRow}>
          <input
            ref={replaceInputRef}
            className={styles.input}
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder={i("search.replacePlaceholder")}
            spellCheck={false}
          />
          <button className={styles.textBtn} onClick={handleReplace} tabIndex={-1}>
            {i("search.replace")}
          </button>
          <button className={styles.textBtn} onClick={handleReplaceAll} tabIndex={-1}>
            {i("search.replaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}
