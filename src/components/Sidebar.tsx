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
  FolderOpenRegular,
  MoreHorizontalRegular,
  RenameRegular,
  SettingsRegular,
  WindowNewRegular,
} from "@fluentui/react-icons";
import { t } from "../i18n";
import type { NoteDoc } from "../hooks/useNotesLoader";
import type { Locale, NotesSortOrder } from "../hooks/useSettings";
import { openNewWindow } from "../utils/newWindow";

const SIDE_PADDING = "4px";

const useStyles = makeStyles({
  sidebar: {
    display: "flex",
    flexDirection: "column",
    width: "var(--shell-sidebar-width)",
    height: "100%",
    backgroundColor: "transparent",
    flexShrink: 0,
    userSelect: "none",
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
  docItemNew: {
    animationName: "docSlideIn",
    animationDuration: "0.2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    animationFillMode: "backwards",
  },
  docItemSlideUp: {
    animationName: "docSlideUp",
    animationDuration: "0.2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
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
  renameInput: {
    border: "none",
    outline: "none",
    fontSize: "13px",
    fontFamily: "inherit",
    lineHeight: "20px",
    padding: "2px 6px",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    minWidth: 0,
    flex: 1,
    borderRadius: "3px",
    marginLeft: "-6px",
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
    paddingBottom: "6px",
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
  searchBoxWrapper: {
    overflow: "hidden",
    maxHeight: "0px",
    opacity: 0,
    transitionProperty: "max-height, opacity, margin-bottom",
    transitionDuration: "0.2s",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    marginBottom: "0px",
  },
  searchBoxWrapperOpen: {
    maxHeight: "40px",
    opacity: 1,
    marginBottom: "4px",
  },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    paddingLeft: "6px",
    paddingRight: "2px",
  },
  searchInput: {
    flex: 1,
    border: "none",
    outline: "none",
    fontSize: "13px",
    fontFamily: "inherit",
    lineHeight: "28px",
    padding: "0 8px 0 14px",
    backgroundColor: "var(--sidebar-search-bg, rgba(0, 0, 0, 0.06))",
    color: tokens.colorNeutralForeground1,
    borderRadius: "6px",
    minWidth: 0,
    "::placeholder": {
      color: tokens.colorNeutralForeground4,
    },
  },
  searchCloseBtn: {
    border: "none",
    borderRadius: "4px",
    minWidth: "auto",
    width: "24px",
    height: "24px",
    padding: "0",
    flexShrink: 0,
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
  onOpenFile: () => void;
  notesSortOrder: NotesSortOrder;
  locale: Locale;
  onOpenSettings: () => void;
  sidebarSearchOpen: boolean;
  sidebarSearchQuery: string;
  onSidebarSearchQueryChange: (query: string) => void;
  onSidebarSearchClose: () => void;
}

interface ContextMenuState {
  index: number; // -1 for empty area
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
  onOpenFile,
  notesSortOrder,
  locale,
  onOpenSettings,
  sidebarSearchOpen,
  sidebarSearchQuery,
  onSidebarSearchQueryChange,
  onSidebarSearchClose,
}: SidebarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus sidebar search input when opened
  useEffect(() => {
    if (sidebarSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [sidebarSearchOpen]);

  // Detect added/removed docs for animation
  const prevDocListRef = useRef<string[]>(docs.map((d) => d.id));
  const [newDocIds, setNewDocIds] = useState<Set<string>>(new Set());
  const [slideUpFromIndex, setSlideUpFromIndex] = useState(-1);

  useEffect(() => {
    const prevList = prevDocListRef.current;
    const prevSet = new Set(prevList);
    const currentIds = docs.map((d) => d.id);
    const currentSet = new Set(currentIds);
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Additions
    const added = new Set<string>();
    for (const id of currentIds) {
      if (!prevSet.has(id)) added.add(id);
    }
    if (added.size > 0) {
      setNewDocIds(added);
      timers.push(setTimeout(() => setNewDocIds(new Set()), 250));
    }

    // Removal — find position of removed item in previous list
    if (currentIds.length < prevList.length) {
      for (let i = 0; i < prevList.length; i++) {
        if (!currentSet.has(prevList[i])) {
          setSlideUpFromIndex(i);
          timers.push(setTimeout(() => setSlideUpFromIndex(-1), 250));
          break;
        }
      }
    }

    prevDocListRef.current = currentIds;
    return () => timers.forEach(clearTimeout);
  }, [docs]);

  // Filter docs by search query (match against fileName, plain text only)
  const filteredDocs = sidebarSearchQuery
    ? docs
        .map((doc, index) => ({ doc, originalIndex: index }))
        .filter(({ doc }) =>
          doc.fileName.toLowerCase().includes(sidebarSearchQuery.toLowerCase()),
        )
    : docs.map((doc, index) => ({ doc, originalIndex: index }));

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
      <div
        className={styles.body}
        data-sidebar-body
        onContextMenu={(e) => {
          // Only trigger if clicking on the body itself or empty space, not on a doc item
          if ((e.target as HTMLElement).closest("[data-doc-item]")) return;
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ index: -1, x: e.clientX, y: e.clientY });
        }}
      >
        <div className={mergeClasses(styles.searchBoxWrapper, sidebarSearchOpen && styles.searchBoxWrapperOpen)}>
          <div className={styles.searchBox}>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              value={sidebarSearchQuery}
              onChange={(e) => onSidebarSearchQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onSidebarSearchClose();
                }
              }}
              placeholder={i("search.sidebarPlaceholder")}
              spellCheck={false}
              tabIndex={sidebarSearchOpen ? 0 : -1}
            />
            <Button
              appearance="subtle"
              className={styles.searchCloseBtn}
              onClick={onSidebarSearchClose}
              size="small"
              tabIndex={sidebarSearchOpen ? 0 : -1}
            >
              <DismissRegular fontSize={14} />
            </Button>
          </div>
        </div>

        <Button
          appearance="subtle"
          icon={<DocumentAddRegular />}
          className={styles.newDocItem}
          onClick={onNewNote}
          size="small"
        >
          {i("sidebar.newNote")}
        </Button>

        {filteredDocs.length === 0 ? (
          <span className={styles.empty}>{sidebarSearchQuery ? "" : i("sidebar.empty")}</span>
        ) : (
          filteredDocs.map(({ doc, originalIndex }) => (
            <div
              key={doc.id}
              data-doc-item
              className={mergeClasses(
                styles.docItemWrapper,
                newDocIds.has(doc.id) && styles.docItemNew,
                slideUpFromIndex >= 0 && originalIndex >= slideUpFromIndex && styles.docItemSlideUp,
              )}
              onMouseEnter={() => setHoveredIndex(originalIndex)}
              onMouseLeave={() => setHoveredIndex(null)}
              onContextMenu={(e) => handleContextMenu(originalIndex, e)}
            >
              {editingIndex === originalIndex ? (
                <>
                  <Button
                    appearance="subtle"
                    icon={doc.isExternal ? <Folder16Regular /> : <DocumentRegular />}
                    className={originalIndex === activeIndex ? styles.docItemActive : styles.docItem}
                    size="small"
                    style={{ pointerEvents: "none" }}
                  >
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
                      style={{ pointerEvents: "auto" }}
                    />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    appearance="subtle"
                    icon={doc.isExternal ? <Folder16Regular /> : <DocumentRegular />}
                    className={originalIndex === activeIndex ? styles.docItemActive : styles.docItem}
                    onClick={() => onSwitchDocument(originalIndex)}
                    size="small"
                  >
                    <span className={styles.docName}>{doc.fileName}</span>
                    <span className={mergeClasses(
                      styles.docTrailing,
                      (hoveredIndex === originalIndex || contextMenu?.index === originalIndex) && styles.docTrailingHidden,
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
                      contextMenu?.index === originalIndex
                        ? styles.moreBtnActive
                        : hoveredIndex === originalIndex && styles.moreBtnVisible,
                    )}
                    onClick={(e) => handleMoreClick(originalIndex, e)}
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
            {contextMenu.index === -1 ? (
              <>
                <Button
                  appearance="subtle"
                  icon={<DocumentAddRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => { onNewNote(); closeContextMenu(); }}
                  size="small"
                >
                  {i("sidebar.newNote")}
                </Button>
                <Button
                  appearance="subtle"
                  icon={<FolderOpenRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => { onOpenFile(); closeContextMenu(); }}
                  size="small"
                >
                  {i("sidebar.open")}
                </Button>
                <Button
                  appearance="subtle"
                  icon={<WindowNewRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => { openNewWindow(); closeContextMenu(); }}
                  size="small"
                >
                  {i("menu.newWindow")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  appearance="subtle"
                  icon={<RenameRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => { handleDoubleClick(contextMenu.index); closeContextMenu(); }}
                  size="small"
                >
                  {i("sidebar.rename")}
                </Button>
                <Button
                  appearance="subtle"
                  icon={<WindowNewRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => { openNewWindow(docs[contextMenu.index]?.filePath); closeContextMenu(); }}
                  size="small"
                >
                  {i("sidebar.openInNewWindow")}
                </Button>
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
              </>
            )}
          </div>
      )}
    </div>
  );
}
