import { useState, useRef, useEffect, useCallback } from "react";
import { Button, makeStyles, tokens, mergeClasses } from "@fluentui/react-components";
import {
  ArrowExportUpRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  DocumentAddRegular,
  DocumentCopyRegular,
  DocumentRegular,
  Folder16Regular,
  MoreHorizontalRegular,
  SettingsRegular,
} from "@fluentui/react-icons";
import { t } from "../i18n";
import type { NoteDoc } from "../hooks/useNotesLoader";
import type { Locale, NotesSortOrder } from "../hooks/useSettings";

const SIDE_PADDING = "8px";

const useStyles = makeStyles({
  sidebar: {
    display: "flex",
    flexDirection: "column",
    width: "var(--shell-sidebar-width)",
    height: "100%",
    backgroundColor: "transparent",
    flexShrink: 0,
  },
  body: {
    flex: 1,
    overflow: "auto",
    paddingTop: "54px",
    paddingLeft: SIDE_PADDING,
    paddingRight: SIDE_PADDING,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  docItemWrapper: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    width: "100%",
  },
  docItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
  },
  docItemActive: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    backgroundColor: "var(--ui-active-bg)",
    fontWeight: 500,
  },
  newDocItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    fontWeight: 500,
  },
  docName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    textAlign: "left",
  },
  /* WinUI3-style TextBox — replaces the entire Button row when renaming */
  renameBox: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    minHeight: "32px",
    borderRadius: "4px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.colorBrandStroke1,
    position: "relative",
    boxSizing: "border-box",
  },
  renameInput: {
    flex: 1,
    border: "none",
    outline: "none",
    fontSize: "13px",
    fontFamily: "inherit",
    lineHeight: "20px",
    padding: "4px 8px 4px 34px",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    minWidth: 0,
    caretColor: tokens.colorBrandForeground1,
  },
  renameIcon: {
    position: "absolute",
    left: "8px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    color: tokens.colorNeutralForeground3,
    pointerEvents: "none",
  },
  moreBtn: {
    position: "absolute",
    right: "4px",
    top: "50%",
    transform: "translateY(-50%)",
    border: "none",
    borderRadius: "4px",
    minWidth: "auto",
    width: "24px",
    height: "24px",
    padding: "0",
    opacity: 0,
    pointerEvents: "none",
    transitionProperty: "opacity",
    transitionDuration: "0.1s",
  },
  moreBtnVisible: {
    opacity: 1,
    pointerEvents: "auto",
  },
  moreBtnActive: {
    opacity: 1,
    pointerEvents: "auto",
    backgroundColor: "var(--ui-active-bg)",
  },
  docTrailing: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
    transitionProperty: "opacity",
    transitionDuration: "0.1s",
  },
  docTrailingHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
  docTimestamp: {
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    opacity: 0.7,
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  dirtyDot: {
    fontSize: "8px",
    color: tokens.colorNeutralForeground3,
    opacity: 0.7,
    flexShrink: 0,
    lineHeight: 1,
  },
  empty: {
    fontSize: "13px",
    color: tokens.colorNeutralForeground3,
    lineHeight: "1.6",
    paddingTop: "10px",
    paddingLeft: "8px",
    paddingRight: "8px",
  },
  footer: {
    flexShrink: 0,
    paddingLeft: SIDE_PADDING,
    paddingRight: SIDE_PADDING,
    paddingBottom: "12px",
  },
  settingsBtn: {
    width: "100%",
    justifyContent: "flex-start",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "36px",
    paddingLeft: "8px",
    paddingRight: "8px",
  },
  contextMenu: {
    position: "fixed",
    zIndex: 1000,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    padding: "4px",
    minWidth: "160px",
  },
  contextMenuItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "4px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "12px",
  },
  contextMenuDanger: {
    color: tokens.colorPaletteRedForeground1,
  },
});

function formatTimestamp(ts: number, locale: Locale): string {
  const now = Date.now();
  const diff = now - ts;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  if (diff < ONE_DAY) {
    const date = new Date(ts);
    const h = date.getHours();
    const m = date.getMinutes().toString().padStart(2, "0");
    if (locale === "ko") {
      return `${h >= 12 ? "오후" : "오전"} ${h % 12 || 12}:${m}`;
    }
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${m} ${ampm}`;
  }

  const date = new Date(ts);
  if (locale === "ko") {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

interface SidebarProps {
  docs: NoteDoc[];
  activeIndex: number;
  onSwitchDocument: (index: number) => void;
  onNewNote: () => void;
  onDeleteNote: (index: number) => void;
  onCloseNote: (index: number) => void;
  onDuplicateNote: (index: number) => void;
  onExportNote: (index: number) => void;
  onRenameNote: (index: number, newName: string) => void;
  notesSortOrder: NotesSortOrder;
  locale: Locale;
  onOpenSettings: () => void;
}

interface ContextMenuState {
  index: number;
  x: number;
  y: number;
}

export function Sidebar({
  docs,
  activeIndex,
  onSwitchDocument,
  onNewNote,
  onDeleteNote,
  onCloseNote,
  onDuplicateNote,
  onExportNote,
  onRenameNote,
  notesSortOrder,
  locale,
  onOpenSettings,
}: SidebarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when editing starts
  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      const doc = docs[editingIndex];
      if (doc?.isExternal) {
        // Select only the name part, not the extension
        const dotIndex = editingValue.lastIndexOf(".");
        if (dotIndex > 0) {
          inputRef.current.setSelectionRange(0, dotIndex);
        } else {
          inputRef.current.select();
        }
      } else {
        inputRef.current.select();
      }
    }
  }, [editingIndex]);

  const commitRename = useCallback(() => {
    if (editingIndex !== null) {
      const trimmed = editingValue.trim();
      if (trimmed && trimmed !== docs[editingIndex]?.fileName) {
        onRenameNote(editingIndex, trimmed);
      }
      setEditingIndex(null);
    }
  }, [editingIndex, editingValue, docs, onRenameNote]);

  const handleDoubleClick = useCallback((index: number) => {
    setEditingIndex(index);
    setEditingValue(docs[index].fileName);
  }, [docs]);

  const handleMoreClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ index, x: rect.left, y: rect.bottom + 2 });
  }, []);

  const handleContextMenu = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Use the ... button position for consistent menu placement
    const wrapper = (e.currentTarget as HTMLElement);
    const moreBtn = wrapper.querySelector<HTMLElement>("[data-more-btn]");
    if (moreBtn) {
      const rect = moreBtn.getBoundingClientRect();
      setContextMenu({ index, x: rect.left, y: rect.bottom + 2 });
    } else {
      setContextMenu({ index, x: e.clientX, y: e.clientY });
    }
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click/right-click
  useEffect(() => {
    if (!contextMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    window.addEventListener("mousedown", handleOutside);
    return () => window.removeEventListener("mousedown", handleOutside);
  }, [contextMenu, closeContextMenu]);

  const handleCopyContent = useCallback((index: number) => {
    const doc = docs[index];
    if (doc) {
      navigator.clipboard.writeText(doc.content).catch(() => {});
    }
    closeContextMenu();
  }, [docs, closeContextMenu]);

  return (
    <div className={styles.sidebar}>
      <div className={styles.body}>
        <Button
          appearance="subtle"
          icon={<DocumentAddRegular />}
          className={styles.newDocItem}
          onClick={onNewNote}
          size="small"
        >
          {i("sidebar.newNote")}
        </Button>

        {docs.length === 0 ? (
          <span className={styles.empty}>{i("sidebar.empty")}</span>
        ) : (
          docs.map((doc, index) => (
            <div
              key={doc.id}
              className={styles.docItemWrapper}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              onContextMenu={(e) => handleContextMenu(index, e)}
            >
              {editingIndex === index ? (
                <div className={styles.renameBox}>
                  <span className={styles.renameIcon}>
                    <DocumentRegular fontSize={16} />
                  </span>
                  <input
                    ref={inputRef}
                    className={styles.renameInput}
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                      if (e.key === "Escape") { e.preventDefault(); setEditingIndex(null); }
                    }}
                  />
                </div>
              ) : (
                <>
                  <Button
                    appearance="subtle"
                    icon={doc.isExternal ? <Folder16Regular /> : <DocumentRegular />}
                    className={index === activeIndex ? styles.docItemActive : styles.docItem}
                    onClick={() => onSwitchDocument(index)}
                    onDoubleClick={() => handleDoubleClick(index)}
                    size="small"
                  >
                    <span className={styles.docName}>{doc.fileName}</span>
                    <span className={mergeClasses(
                      styles.docTrailing,
                      (hoveredIndex === index || contextMenu?.index === index) && styles.docTrailingHidden,
                    )}>
                      {doc.isDirty && doc.isExternal && (
                        <span className={styles.dirtyDot}>●</span>
                      )}
                      <span className={styles.docTimestamp}>
                        {formatTimestamp(
                          notesSortOrder.startsWith("created") ? doc.createdAt : doc.updatedAt,
                          locale,
                        )}
                      </span>
                    </span>
                  </Button>

                  <Button
                    data-more-btn
                    appearance="subtle"
                    className={mergeClasses(
                      styles.moreBtn,
                      contextMenu?.index === index
                        ? styles.moreBtnActive
                        : hoveredIndex === index && styles.moreBtnVisible,
                    )}
                    onClick={(e) => handleMoreClick(index, e)}
                    size="small"
                  >
                    <MoreHorizontalRegular fontSize={16} />
                  </Button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className={styles.footer}>
        <Button
          appearance="subtle"
          icon={<SettingsRegular />}
          className={styles.settingsBtn}
          size="small"
          onClick={onOpenSettings}
        >
          {i("sidebar.settings")}
        </Button>
      </div>

      {/* Context menu */}
      {contextMenu && (
          <div
            ref={contextMenuRef}
            className={styles.contextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <Button
              appearance="subtle"
              icon={<DocumentCopyRegular />}
              className={styles.contextMenuItem}
              onClick={() => { onDuplicateNote(contextMenu.index); closeContextMenu(); }}
              size="small"
            >
              {i("sidebar.duplicate")}
            </Button>
            <Button
              appearance="subtle"
              icon={<ArrowExportUpRegular />}
              className={styles.contextMenuItem}
              onClick={() => { onExportNote(contextMenu.index); closeContextMenu(); }}
              size="small"
            >
              {i("sidebar.export")}
            </Button>
            <Button
              appearance="subtle"
              icon={<CopyRegular />}
              className={styles.contextMenuItem}
              onClick={() => handleCopyContent(contextMenu.index)}
              size="small"
            >
              {i("sidebar.copyContent")}
            </Button>
            {docs[contextMenu.index]?.isExternal ? (
              <Button
                appearance="subtle"
                icon={<DismissRegular />}
                className={mergeClasses(styles.contextMenuItem, styles.contextMenuDanger)}
                onClick={() => { onCloseNote(contextMenu.index); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.close")}
              </Button>
            ) : (
              <Button
                appearance="subtle"
                icon={<DeleteRegular />}
                className={mergeClasses(styles.contextMenuItem, styles.contextMenuDanger)}
                onClick={() => { onDeleteNote(contextMenu.index); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.delete")}
              </Button>
            )}
          </div>
      )}
    </div>
  );
}
