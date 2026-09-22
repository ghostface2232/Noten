import { useState, useRef, useEffect, useCallback } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  ArrowUpRegular,
  ArrowDownRegular,
  ArrowSwapRegular,
  DismissRegular,
  TextCaseTitleRegular,
} from "@fluentui/react-icons";
import type { Editor } from "@tiptap/core";
import {
  searchPluginKey,
  findSearchMatches,
  selectNonOverlappingMatches,
  type SearchPluginState,
} from "../extensions/SearchHighlight";
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
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    boxShadow: tokens.shadow8,
    width: "310px",
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
  countNoMatch: {
    color: tokens.colorPaletteRedForeground1,
  },
  // The visible counter is a glyph pair ("3/12") that reads poorly aloud, and
  // its empty state is carried by color alone. This is the spoken equivalent.
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: 0,
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
    ...pressableButton,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
});

// Ties the replace toggle to the row it discloses.
const REPLACE_ROW_ID = "search-bar-replace-row";

/**
 * A request to move focus back into the bar. The nonce changes per request;
 * the bar remembers the nonce it mounted with so a request left over from a
 * previous life of the bar is not replayed on reopen.
 */
export interface DocSearchFocusRequest {
  nonce: number;
  target: "find" | "replace";
}

export const NO_FOCUS_REQUEST: DocSearchFocusRequest = { nonce: 0, target: "find" };

// How long the spoken match status waits for the query to settle. Every
// keystroke recomputes the count, and a live region that changes ten times
// while a ten-letter query is typed queues ten announcements.
const STATUS_ANNOUNCE_DELAY_MS = 400;

interface SearchBarProps {
  editor: Editor | null;
  onClose: () => void;
  replaceOpen: boolean;
  onToggleReplace: (open: boolean) => void;
  locale: Locale;
  /** Announces how many matches a Replace all touched; nothing else reports it. */
  onNotice: (text: string) => void;
  /** Each new nonce moves focus to the named input and selects its text. */
  focusRequest?: DocSearchFocusRequest;
}

export function SearchBar({ editor, onClose, replaceOpen, onToggleReplace, locale, onNotice, focusRequest = NO_FOCUS_REQUEST }: SearchBarProps) {
  const styles = useStyles();
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  // A replace that consumes the last match also drops the count to zero. Without
  // this the counter would then wear the same red "nothing found" state a failed
  // query gets, reporting a successful replace as a miss.
  const [emptiedByReplace, setEmptiedByReplace] = useState(false);
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const mountNonceRef = useRef(focusRequest.nonce);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (focusRequest.nonce === mountNonceRef.current) return;
    // The replace row renders in the same commit that requests it, so the ref
    // is populated by the time this effect runs.
    const input = focusRequest.target === "replace" ? replaceInputRef.current : inputRef.current;
    if (!input) return;
    input.focus();
    // On a return trip the text is usually about to be retyped.
    input.select();
  }, [focusRequest.nonce, focusRequest.target]);
  useEffect(() => { if (replaceOpen) replaceInputRef.current?.focus(); }, [replaceOpen]);

  const dispatchTiptap = useCallback(
    (q: string, activeIdx: number, matchCase: boolean) => {
      if (!editor) return { count: 0, clamped: 0 };
      const matches = findSearchMatches(editor.state.doc, q, matchCase);
      const clamped = matches.length > 0
        ? ((activeIdx % matches.length) + matches.length) % matches.length
        : 0;

      const { tr } = editor.state;
      tr.setMeta(searchPluginKey, { query: q, activeIndex: clamped, matches, caseSensitive: matchCase } satisfies SearchPluginState);
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
    (q: string, idx: number, matchCase: boolean = caseSensitive) => {
      const result = dispatchTiptap(q, idx, matchCase);
      setMatchCount(result.count);
      setActiveIndex(result.clamped);
      setEmptiedByReplace(false);
    },
    [dispatchTiptap, caseSensitive],
  );

  const handleQueryChange = useCallback(
    (value: string) => { setQuery(value); dispatchSearch(value, 0); },
    [dispatchSearch],
  );

  const toggleCaseSensitive = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    dispatchSearch(query, 0, next);
  }, [caseSensitive, dispatchSearch, query]);

  const goNext = useCallback(() => dispatchSearch(query, activeIndex + 1), [dispatchSearch, query, activeIndex]);
  const goPrev = useCallback(() => dispatchSearch(query, activeIndex - 1), [dispatchSearch, query, activeIndex]);

  const handleClose = useCallback(() => {
    if (editor) {
      const { tr } = editor.state;
      tr.setMeta(searchPluginKey, { query: "", activeIndex: 0, matches: [], caseSensitive } satisfies SearchPluginState);
      editor.view.dispatch(tr);
    }
    setReplaceText("");
    onToggleReplace(false);
    onClose();
  }, [editor, onClose, onToggleReplace, caseSensitive]);

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
        tr.setMeta(searchPluginKey, { query, activeIndex: idx, matches: ps.matches, caseSensitive } satisfies SearchPluginState);
        editor.view.dispatch(tr);
      }

      setMatchCount(count);
      setActiveIndex(idx);
      setEmptiedByReplace(count === 0);
      if (count > 0 && ps.matches[idx]) {
        scrollToPos(editor.view.dom, () => editor.view.coordsAtPos(ps.matches[idx].from));
      }
    },
    [editor, query, caseSensitive],
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
    const matches = selectNonOverlappingMatches(ps.matches);
    if (matches.length === 0) return;

    const { tr } = editor.state;
    for (const match of matches) {
      tr.insertText(replaceText, tr.mapping.map(match.from), tr.mapping.map(match.to));
    }
    editor.view.dispatch(tr);
    syncAfterReplace(0);
    onNotice(t("search.replaced", locale).replace("{n}", String(matches.length)));
  }, [editor, query, replaceText, matchCount, syncAfterReplace, onNotice, locale]);

  // The bar's buttons are pointer targets only, so every control it offers needs
  // a key that works from the input the focus never leaves. Alt+C is the one the
  // case switch would otherwise lack. Matched on the physical key: with a Korean
  // IME engaged, e.key can arrive as "Process" or a Hangul jamo rather than "c".
  const isCaseShortcut = (e: React.KeyboardEvent) =>
    e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyC";

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleClose(); }
      else if (isCaseShortcut(e)) { e.preventDefault(); toggleCaseSensitive(); }
      else if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goPrev() : goNext(); }
    },
    [handleClose, goNext, goPrev, toggleCaseSensitive],
  );

  const handleReplaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleClose(); }
      else if (isCaseShortcut(e)) { e.preventDefault(); toggleCaseSensitive(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleReplaceAll(); }
      else if (e.key === "Enter") { e.preventDefault(); handleReplace(); }
    },
    [handleClose, handleReplace, handleReplaceAll, toggleCaseSensitive],
  );

  const noMatch = query !== "" && matchCount === 0 && !emptiedByReplace;
  // Silent after a replace empties the matches. "No matches" would be wrong:
  // the query did match, the user consumed the hits. Replace all has already
  // reported its count through the notice; a single replace reports nothing,
  // so its final hit is announced only by the document changing.
  const matchStatus = query === "" || emptiedByReplace
    ? ""
    : matchCount > 0
      ? i("search.matchStatus").replace("{i}", String(activeIndex + 1)).replace("{n}", String(matchCount))
      : i("search.noMatches");
  const [spokenStatus, setSpokenStatus] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setSpokenStatus(matchStatus), STATUS_ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [matchStatus]);

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
        <span
          className={mergeClasses(styles.count, noMatch && styles.countNoMatch)}
          style={{ visibility: query ? "visible" : "hidden" }}
          aria-hidden="true"
        >
          {matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "0/0"}
        </span>
        <span role="status" className={styles.visuallyHidden}>
          {spokenStatus}
        </span>
        <button
          className={mergeClasses(styles.btn, caseSensitive && styles.btnActive)}
          onClick={toggleCaseSensitive}
          tabIndex={-1}
          title={`${i("search.caseSensitive")} (Alt+C)`}
          aria-label={i("search.caseSensitive")}
          aria-keyshortcuts="Alt+C"
          aria-pressed={caseSensitive}
        >
          <TextCaseTitleRegular fontSize={16} />
        </button>
        <button
          className={mergeClasses(styles.btn, replaceOpen && styles.btnActive)}
          onClick={() => onToggleReplace(!replaceOpen)}
          tabIndex={-1}
          title={i("search.replace")}
          aria-label={i("search.replace")}
          aria-expanded={replaceOpen}
          aria-controls={REPLACE_ROW_ID}
        >
          <ArrowSwapRegular fontSize={16} />
        </button>
        <button className={styles.btn} onClick={goPrev} tabIndex={-1} title={i("search.previous")} aria-label={i("search.previous")}>
          <ArrowUpRegular fontSize={16} />
        </button>
        <button className={styles.btn} onClick={goNext} tabIndex={-1} title={i("search.next")} aria-label={i("search.next")}>
          <ArrowDownRegular fontSize={16} />
        </button>
        <button className={styles.btn} onClick={handleClose} tabIndex={-1} title={i("search.close")} aria-label={i("search.close")}>
          <DismissRegular fontSize={16} />
        </button>
      </div>

      {replaceOpen && (
        <div className={styles.replaceRow} id={REPLACE_ROW_ID}>
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
