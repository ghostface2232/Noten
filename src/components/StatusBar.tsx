import { memo, useState, useEffect } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { t } from "../i18n";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import type { Locale } from "../hooks/useSettings";
import { buildLineIndex, posToLine, type LineIndex } from "../utils/documentLines";
import { MOTION_DURATION_SLOW } from "../styles/interactions";

const useStyles = makeStyles({
  shell: {
    flexShrink: 0,
    height: "24px",
    overflow: "hidden",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    transitionProperty: "height, border-top-color, background-color",
    transitionDuration: MOTION_DURATION_SLOW,
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  shellHidden: {
    pointerEvents: "none",
    height: "0px",
    borderTopColor: "transparent",
    backgroundColor: "transparent",
  },
  statusBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: "24px",
    paddingLeft: "12px",
    paddingRight: "12px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    userSelect: "none",
    transitionProperty: "transform, opacity",
    transitionDuration: MOTION_DURATION_SLOW,
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  statusBarHidden: {
    transform: "translateY(18px)",
    opacity: 0,
  },
  left: {
    display: "flex",
    gap: "16px",
  },
});

// While the document keeps changing (typing, IME, but also paste, undo or a
// reload), the counts wait until no edit has arrived for STATS_SETTLE_MS,
// and never longer than STATS_MAX_WAIT_MS. Each update is a React commit,
// and any commit that touches the DOM while the editor is focused walks the
// entire editor DOM (React's selection bookkeeping): ~7 ms per frame in a
// 1 MB note.
export const STATS_SETTLE_MS = 300;
export const STATS_MAX_WAIT_MS = 1000;

function useEditorStats(editor: Editor | null, enabled: boolean) {
  const [stats, setStats] = useState({ charCount: 0, wordCount: 0, lineCount: 0, cursorRow: 1 });

  useEffect(() => {
    if (!editor || !enabled) return;

    // Keep the expensive document-wide counts keyed to ProseMirror's immutable
    // doc identity. Selection-only transactions reuse the same node, so cursor
    // movement reuses the cached line index and only re-resolves the caret.
    let frame: number | null = null;
    let lastDoc: Editor["state"]["doc"] | null = null;
    let lineIndex: LineIndex | null = null;
    const compute = () => {
      frame = null;
      const doc = editor.state.doc;
      if (doc !== lastDoc) {
        lastDoc = doc;
        // Lines, characters, and words come from per-block stats cached by
        // node identity, so only edited blocks are re-counted. Counting words
        // from `doc.textContent` instead would fuse each block's last word to
        // the next block's first — a three-item list read as one word.
        lineIndex = buildLineIndex(doc);
      }
      const row = lineIndex ? posToLine(lineIndex, editor.state.selection.head) : 1;
      setStats((prev) => {
        const next = {
          charCount: lineIndex?.chars ?? 0,
          wordCount: lineIndex?.words ?? 0,
          lineCount: lineIndex?.total ?? 0,
          cursorRow: row,
        };
        if (
          prev.charCount === next.charCount
          && prev.wordCount === next.wordCount
          && prev.lineCount === next.lineCount
          && prev.cursorRow === next.cursorRow
        ) {
          return prev;
        }
        return next;
      });
    };
    // The caret row waits with the counts: it is resolved against the line
    // index, which must be rebuilt for the new document first.
    let settle: ReturnType<typeof setTimeout> | null = null;
    let deadline = 0;
    const schedule = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) {
        // An update already due reads the newest document anyway.
        if (frame !== null) return;
        const now = Date.now();
        if (settle === null) deadline = now + STATS_MAX_WAIT_MS;
        else clearTimeout(settle);
        settle = setTimeout(() => {
          settle = null;
          frame = requestAnimationFrame(compute);
        }, Math.min(STATS_SETTLE_MS, deadline - now));
        return;
      }
      if (frame !== null || settle !== null) return;
      frame = requestAnimationFrame(compute);
    };

    compute();
    editor.on("transaction", schedule);
    return () => {
      editor.off("transaction", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      if (settle !== null) clearTimeout(settle);
    };
  }, [editor, enabled]);

  return stats;
}

interface StatusBarProps {
  editor: Editor | null;
  hidden: boolean;
  locale: Locale;
}

function StatusBarImpl({ editor, hidden, locale }: StatusBarProps) {
  const styles = useStyles();
  const { charCount, wordCount, lineCount, cursorRow } = useEditorStats(editor, !hidden);
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  return (
    <div
      className={hidden ? `${styles.shell} ${styles.shellHidden}` : styles.shell}
    >
      <div className={hidden ? `${styles.statusBar} ${styles.statusBarHidden}` : styles.statusBar}>
        <div className={styles.left}>
          <span>{charCount.toLocaleString()}{i("status.chars")}</span>
          <span>{wordCount.toLocaleString()}{i("status.words")}</span>
          <span>{lineCount.toLocaleString()}{i("status.lines")}</span>
        </div>
        <span>{i("status.cursorRow")}{cursorRow}{i("status.cursorRowSuffix")}</span>
      </div>
    </div>
  );
}

// Memoized so unrelated App state changes (e.g. a sidebar group toggle) don't
// re-render the status bar. Cursor/char stats come from its own editor hook.
export const StatusBar = memo(StatusBarImpl);
