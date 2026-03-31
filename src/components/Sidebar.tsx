import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button, Tooltip, makeStyles, tokens, mergeClasses } from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  ArrowExportUpRegular,
  ChevronRightRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  DocumentAddRegular,
  DocumentCopyRegular,
  DocumentRegular,
  FolderAddRegular,
  FolderArrowRightRegular,
  FolderRegular,
  MoreHorizontalRegular,
  RenameRegular,
  SettingsRegular,
  WindowNewRegular,
} from "@fluentui/react-icons";
import { t } from "../i18n";
import type { NoteDoc, NoteGroup } from "../hooks/useNotesLoader";
import type { GroupLayout, Locale, NotesSortOrder } from "../hooks/useSettings";
import { openNewWindow } from "../utils/newWindow";
import { clampMenuToViewport } from "../utils/clampMenuPosition";

/* FolderAddRegular의 + 를 − 로 바꾼 커스텀 아이콘 */
const FolderSubtractRegular = () => (
  <svg fill="currentColor" aria-hidden="true" width="1em" height="1em" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.5 3A2.5 2.5 0 0 0 2 5.5v9A2.5 2.5 0 0 0 4.5 17h5.1c-.16-.32-.3-.65-.4-1H4.5A1.5 1.5 0 0 1 3 14.5V8h4.09c.4 0 .78-.16 1.06-.44L9.7 6h5.79c.83 0 1.5.67 1.5 1.5v2.1c.36.18.7.4 1 .66V7.5A2.5 2.5 0 0 0 15.5 5H9.7L8.23 3.51A1.75 1.75 0 0 0 6.98 3H4.5ZM3 5.5C3 4.67 3.67 4 4.5 4h2.48c.2 0 .4.08.53.22L8.8 5.5 7.44 6.85a.5.5 0 0 1-.35.15H3V5.5Zm16 9a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-6.5-.5a.5.5 0 0 0 0 1h4.5a.5.5 0 0 0 0-1h-4.5Z" fill="currentColor" />
  </svg>
);

const SIDE_PADDING = "6px";

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
    paddingTop: "58px",
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
    animationDuration: "0.3s",
    animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
    animationFillMode: "backwards",
  },
  docItemSlideUp: {
    animationName: "docSlideUp",
    animationDuration: "0.2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  docItemExit: {
    animationName: "docSlideOut",
    animationDuration: "0.25s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    animationFillMode: "forwards",
    pointerEvents: "none" as const,
    overflow: "hidden",
  },
  groupChildExpand: {
    animationName: "groupChildExpand",
    animationDuration: "0.2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    animationFillMode: "backwards",
  },
  groupCollapseOut: {
    animationName: "groupCollapseOut",
    animationDuration: "0.2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    animationFillMode: "forwards",
    overflow: "hidden",
    pointerEvents: "none",
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
    gap: "5px",
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
    gap: "5px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    backgroundColor: "var(--ui-active-bg)",
    fontWeight: 500,
  },
  docItemIndented: {
    paddingLeft: "20px",
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
    paddingBottom: SIDE_PADDING,
  },
  settingsBtn: {
    width: "100%",
    justifyContent: "flex-start",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "5px",
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
    minWidth: "210px",
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
  shortcutHint: {
    marginLeft: "auto",
    paddingLeft: "24px",
    fontSize: "12px",
    opacity: 0.45,
    whiteSpace: "nowrap" as const,
  },
  submenuParent: {
    position: "relative",
  },
  submenuArrow: {
    marginLeft: "auto",
    fontSize: "10px",
    color: tokens.colorNeutralForeground3,
  },
  submenu: {
    position: "fixed",
    zIndex: 1001,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    padding: "4px",
    minWidth: "140px",
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
  /* ─── Group styles ─── */
  groupHeader: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "4px",
    minHeight: "32px",
    paddingLeft: "6px",
    paddingRight: "8px",
    cursor: "pointer",
  },
  groupChevron: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "16px",
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    transitionProperty: "transform",
    transitionDuration: "0.15s",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  groupChevronExpanded: {
    transform: "rotate(90deg)",
  },
  groupName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    textAlign: "left",
  },
  groupCount: {
    fontSize: "9px",
    fontWeight: 600,
    color: tokens.colorNeutralBackground1,
    backgroundColor: tokens.colorNeutralForeground3,
    opacity: 0.7,
    mixBlendMode: "soft-light",
    borderRadius: "100px",
    minWidth: "15px",
    height: "15px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: "4px",
    paddingRight: "4px",
    paddingTop: "1px",
    flexShrink: 0,
    lineHeight: 1,
    transitionProperty: "opacity",
    transitionDuration: "0.1s",
  },
  groupNameInput: {
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
  },
  /* ─── Multi-select ─── */
  selectCheckbox: {
    width: 0,
    height: "16px",
    flexShrink: 0,
    cursor: "pointer",
    borderRadius: "3px",
    border: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.colorNeutralForeground1,
    opacity: 0,
    transitionProperty: "width, opacity, background-color, margin",
    transitionDuration: "0.15s",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    padding: 0,
    marginLeft: 0,
    overflow: "hidden",
    color: tokens.colorNeutralForeground1,
    fontSize: "14px",
    lineHeight: 1,
    pointerEvents: "none",
  },
  selectCheckboxVisible: {
    width: "16px",
    opacity: 0.15,
    marginLeft: "4px",
    pointerEvents: "auto",
  },
  selectCheckboxChecked: {
    opacity: 1,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralBackground1,
  },
  selectToolbar: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    paddingLeft: SIDE_PADDING,
    paddingRight: SIDE_PADDING,
    paddingBottom: "4px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "4px",
    flexWrap: "wrap",
  },
  selectInfo: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
    paddingLeft: "4px",
    paddingRight: "4px",
    flexShrink: 0,
  },
  selectActionBtn: {
    border: "none",
    borderRadius: "6px",
    minWidth: "auto",
    height: "28px",
    width: "28px",
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
  onSwitchDocument: (index: number) => void | Promise<void>;
  onNewNote: () => void;
  onDeleteNote: (index: number) => void;
  onDuplicateNote: (index: number) => void;
  onExportNote: (index: number) => void;
  onRenameNote: (index: number, newName: string) => void;
  onImportFile: () => void;
  notesSortOrder: NotesSortOrder;
  locale: Locale;
  onOpenSettings: () => void;
  sidebarSearchOpen: boolean;
  sidebarSearchQuery: string;
  onSidebarSearchQueryChange: (query: string) => void;
  onSidebarSearchClose: () => void;
  /* ─── Group props ─── */
  groups: NoteGroup[];
  groupLayout: GroupLayout;
  onCreateGroup: (name: string, initialNoteIds?: string[]) => string;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onUngroupGroup: (groupId: string) => void;
  onAddNoteToGroup: (noteId: string, groupId: string) => void;
  onRemoveNoteFromGroup: (noteId: string) => void;
  onMoveNotesToGroup: (noteIds: string[], groupId: string) => void;
  onToggleGroupCollapsed: (groupId: string) => void;
  onDeleteNotes: (indices: number[]) => void;
  /* ─── Select mode (controlled from App) ─── */
  selectMode: boolean;
  onSelectModeChange: (mode: boolean) => void;
  pendingRenameGroupId: string | null;
  onPendingRenameGroupIdClear: () => void;
}

interface ContextMenuState {
  type: "note" | "empty" | "group";
  index: number;
  groupId?: string;
  x: number;
  y: number;
}

export function Sidebar({
  docs,
  activeIndex,
  onSwitchDocument,
  onNewNote,
  onDeleteNote,
  onDuplicateNote,
  onExportNote,
  onRenameNote,
  onImportFile,
  notesSortOrder,
  locale,
  onOpenSettings,
  sidebarSearchOpen,
  sidebarSearchQuery,
  onSidebarSearchQueryChange,
  onSidebarSearchClose,
  groups,
  groupLayout,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onUngroupGroup,
  onAddNoteToGroup,
  onRemoveNoteFromGroup,
  onMoveNotesToGroup,
  onToggleGroupCollapsed,
  onDeleteNotes,
  selectMode,
  onSelectModeChange,
  pendingRenameGroupId,
  onPendingRenameGroupIdClear,
}: SidebarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupValue, setEditingGroupValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);
  const groupInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const submenuParentRef = useRef<HTMLDivElement>(null);
  const submenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup submenu timer on unmount
  useEffect(() => {
    return () => { if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current); };
  }, []);

  // Build grouped note id set
  const groupedNoteIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) for (const id of g.noteIds) set.add(id);
    return set;
  }, [groups]);

  // Focus sidebar search input when opened
  useEffect(() => {
    if (sidebarSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [sidebarSearchOpen]);

  // Detect added/removed docs for animation
  const prevDocListRef = useRef<string[]>(docs.map((d) => d.id));
  const prevDocsSnapshotRef = useRef<Map<string, NoteDoc>>(new Map(docs.map((d) => [d.id, d])));
  const [newDocIds, setNewDocIds] = useState<Set<string>>(new Set());
  const [slideUpFromIndex, setSlideUpFromIndex] = useState(-1);
  const [exitingDoc, setExitingDoc] = useState<{ doc: NoteDoc; index: number } | null>(null);

  // Track groups that just expanded (for child animation)
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const prevGroupCollapsedRef = useRef<Map<string, boolean>>(new Map());

  // Track newly created groups (for slide-in animation)
  const prevGroupIdsRef = useRef<Set<string>>(new Set(groups.map((g) => g.id)));

  // Track groups being removed (for collapse-out animation)
  const [removingGroupIds, setRemovingGroupIds] = useState<Set<string>>(new Set());
  const [newGroupIds, setNewGroupIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const prevList = prevDocListRef.current;
    const prevSet = new Set(prevList);
    const currentIds = docs.map((d) => d.id);
    const currentSet = new Set(currentIds);
    const timers: ReturnType<typeof setTimeout>[] = [];

    const added = new Set<string>();
    for (const id of currentIds) {
      if (!prevSet.has(id)) added.add(id);
    }
    let removedId: string | null = null;
    let removedIdx = -1;
    for (let idx = 0; idx < prevList.length; idx++) {
      if (!currentSet.has(prevList[idx])) {
        removedId = prevList[idx];
        removedIdx = idx;
        break;
      }
    }

    if (added.size > 0) {
      setNewDocIds(added);
      timers.push(setTimeout(() => setNewDocIds(new Set()), 300));
    }

    if (removedId && added.size === 0) {
      const snapshot = prevDocsSnapshotRef.current.get(removedId);
      if (snapshot) {
        // Exit animation handles the space collapse — no slideUp needed
        setExitingDoc({ doc: snapshot, index: removedIdx });
        timers.push(setTimeout(() => setExitingDoc(null), 280));
      } else {
        // Fallback: no snapshot, use slideUp
        setSlideUpFromIndex(removedIdx);
        timers.push(setTimeout(() => setSlideUpFromIndex(-1), 250));
      }
    }

    prevDocListRef.current = currentIds;
    prevDocsSnapshotRef.current = new Map(docs.map((d) => [d.id, d]));
    return () => timers.forEach(clearTimeout);
  }, [docs]);

  // Detect group expand/collapse and new groups for animation
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const prevCollapsed = prevGroupCollapsedRef.current;
    const justExpanded = new Set<string>();

    for (const g of groups) {
      const wasColl = prevCollapsed.get(g.id);
      if (wasColl === true && !g.collapsed) {
        justExpanded.add(g.id);
      }
    }
    if (justExpanded.size > 0) {
      setExpandedGroupIds(justExpanded);
      timers.push(setTimeout(() => setExpandedGroupIds(new Set()), 250));
    }

    // Detect newly created groups
    const prevIds = prevGroupIdsRef.current;
    const addedGroups = new Set<string>();
    for (const g of groups) {
      if (!prevIds.has(g.id)) addedGroups.add(g.id);
    }
    if (addedGroups.size > 0) {
      setNewGroupIds(addedGroups);
      timers.push(setTimeout(() => setNewGroupIds(new Set()), 250));
    }

    prevGroupCollapsedRef.current = new Map(groups.map((g) => [g.id, g.collapsed]));
    prevGroupIdsRef.current = new Set(groups.map((g) => g.id));
    return () => timers.forEach(clearTimeout);
  }, [groups]);

  // Enter rename mode for a newly created group (from header button or context menu)
  useEffect(() => {
    if (!pendingRenameGroupId) return;
    const group = groups.find((g) => g.id === pendingRenameGroupId);
    if (group) {
      setEditingGroupId(group.id);
      setEditingGroupValue(group.name);
      onPendingRenameGroupIdClear();
    }
  }, [pendingRenameGroupId, groups, onPendingRenameGroupIdClear]);

  // Clear selection when exiting select mode
  useEffect(() => {
    if (!selectMode) setSelectedNoteIds(new Set());
  }, [selectMode]);


  // Filter docs by search query
  const filteredDocs = useMemo(() => {
    if (!sidebarSearchQuery) return docs.map((doc, index) => ({ doc, originalIndex: index }));
    const q = sidebarSearchQuery.toLowerCase();
    return docs
      .map((doc, index) => ({ doc, originalIndex: index }))
      .filter(({ doc }) => doc.fileName.toLowerCase().includes(q));
  }, [docs, sidebarSearchQuery]);

  // Focus the rename input when editing starts
  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIndex]);

  // Focus group rename input
  useEffect(() => {
    if (editingGroupId !== null && groupInputRef.current) {
      groupInputRef.current.focus();
      groupInputRef.current.select();
    }
  }, [editingGroupId]);

  /* ─── Callbacks ─── */

  const commitRename = useCallback(() => {
    if (editingIndex !== null) {
      const trimmed = editingValue.trim();
      if (trimmed && trimmed !== docs[editingIndex]?.fileName) {
        onRenameNote(editingIndex, trimmed);
      }
      setEditingIndex(null);
    }
  }, [editingIndex, editingValue, docs, onRenameNote]);

  const commitGroupRename = useCallback(() => {
    if (editingGroupId !== null) {
      const trimmed = editingGroupValue.trim();
      if (trimmed) {
        onRenameGroup(editingGroupId, trimmed);
      }
      setEditingGroupId(null);
    }
  }, [editingGroupId, editingGroupValue, onRenameGroup]);

  // Create group immediately with default name, then enter rename mode
  const handleCreateGroup = useCallback(() => {
    const defaultName = i("sidebar.newGroup");
    const newId = onCreateGroup(defaultName);
    if (newId) {
      setEditingGroupId(newId);
      setEditingGroupValue(defaultName);
    }
  }, [locale, onCreateGroup]);

  const animateGroupRemoval = useCallback((groupId: string, noteIds: string[], callback: () => void) => {
    // Collect all IDs to animate: group header + its child notes
    const allIds = new Set<string>([groupId, ...noteIds]);
    setRemovingGroupIds(allIds);
    setTimeout(() => {
      callback();
      setRemovingGroupIds(new Set());
    }, 200);
  }, []);

  const handleDoubleClick = useCallback((index: number) => {
    setEditingIndex(index);
    setEditingValue(docs[index].fileName);
  }, [docs]);

  const handleMoreClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ type: "note", index, x: rect.left, y: rect.bottom + 2 });
  }, []);

  const handleGroupMoreClick = useCallback((groupId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ type: "group", index: -1, groupId, x: rect.left, y: rect.bottom + 2 });
  }, []);

  const handleContextMenu = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wrapper = (e.currentTarget as HTMLElement);
    const moreBtn = wrapper.querySelector<HTMLElement>("[data-more-btn]");
    if (moreBtn) {
      const rect = moreBtn.getBoundingClientRect();
      setContextMenu({ type: "note", index, x: rect.left, y: rect.bottom + 2 });
    } else {
      setContextMenu({ type: "note", index, x: e.clientX, y: e.clientY });
    }
  }, []);

  const handleGroupContextMenu = useCallback((groupId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wrapper = (e.currentTarget as HTMLElement);
    const moreBtn = wrapper.querySelector<HTMLElement>("[data-more-btn]");
    if (moreBtn) {
      const rect = moreBtn.getBoundingClientRect();
      setContextMenu({ type: "group", index: -1, groupId, x: rect.left, y: rect.bottom + 2 });
    } else {
      setContextMenu({ type: "group", index: -1, groupId, x: e.clientX, y: e.clientY });
    }
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setSubmenuOpen(false);
    setSubmenuPos(null);
  }, []);

  // Close context menu on outside click
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

  // Clamp context menu to viewport
  useEffect(() => {
    if (contextMenu && contextMenuRef.current) {
      clampMenuToViewport(contextMenuRef.current);
    }
  }, [contextMenu]);

  const handleCopyContent = useCallback((index: number) => {
    const doc = docs[index];
    if (doc) {
      navigator.clipboard.writeText(doc.content).catch(() => {});
    }
    closeContextMenu();
  }, [docs, closeContextMenu]);

  // Sidebar keyboard shortcuts — only when focus is inside the sidebar (not editor)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if editing a note name inline or a group name
      if (editingIndex !== null || editingGroupId !== null) return;
      // Skip if focus is inside an input/textarea/contenteditable
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      // Skip if no sidebar focus — check if the sidebar container contains focus
      const sidebar = document.querySelector("[data-sidebar]");
      if (!sidebar?.contains(document.activeElement) && !sidebar?.contains(e.target as Node)) return;

      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === "d") {
        e.preventDefault();
        onDuplicateNote(activeIndex);
      } else if (ctrl && e.shiftKey && e.key === "E") {
        e.preventDefault();
        onExportNote(activeIndex);
      } else if (ctrl && e.key === "r") {
        e.preventDefault();
        handleDoubleClick(activeIndex);
      } else if (ctrl && e.altKey && e.key === "c") {
        e.preventDefault();
        const doc = docs[activeIndex];
        if (doc) navigator.clipboard.writeText(doc.content).catch(() => {});
      } else if (e.key === "Delete" && !ctrl && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        onDeleteNote(activeIndex);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIndex, docs, editingIndex, editingGroupId, onDuplicateNote, onExportNote, onDeleteNote, handleDoubleClick]);

  const toggleNoteSelection = useCallback((noteId: string) => {
    setSelectedNoteIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const getGroupForNote = useCallback((noteId: string): NoteGroup | null => {
    return groups.find((g) => g.noteIds.includes(noteId)) ?? null;
  }, [groups]);

  /* ─── Submenu position calculation ─── */
  const showSubmenu = useCallback(() => {
    if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
    setSubmenuOpen(true);
    if (submenuParentRef.current) {
      const rect = submenuParentRef.current.getBoundingClientRect();
      setSubmenuPos({ x: rect.right - 4, y: rect.top });
    }
  }, []);

  const hideSubmenu = useCallback(() => {
    submenuTimerRef.current = setTimeout(() => {
      setSubmenuOpen(false);
      setSubmenuPos(null);
    }, 150);
  }, []);

  const keepSubmenu = useCallback(() => {
    if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current);
  }, []);

  /* ─── Render helpers ─── */

  const isSearching = !!sidebarSearchQuery;

  // Compute render items: when not searching, organize by groups
  type RenderItem =
    | { kind: "note"; doc: NoteDoc; originalIndex: number; indented: boolean }
    | { kind: "group"; group: NoteGroup }

  const renderItems = useMemo((): RenderItem[] => {
    if (isSearching) {
      return filteredDocs.map(({ doc, originalIndex }) => ({
        kind: "note" as const,
        doc,
        originalIndex,
        indented: false,
      }));
    }

    const items: RenderItem[] = [];
    const docsMap = new Map(docs.map((d, i) => [d.id, { doc: d, originalIndex: i }]));

    const ungrouped = filteredDocs.filter(({ doc }) => !groupedNoteIds.has(doc.id));

    if (groupLayout === "groups-first") {
      // Groups first
      for (const group of groups) {
        items.push({ kind: "group", group });
        if (!group.collapsed) {
          for (const noteId of group.noteIds) {
            const entry = docsMap.get(noteId);
            if (entry) items.push({ kind: "note", doc: entry.doc, originalIndex: entry.originalIndex, indented: true });
          }
        }
      }
      // Ungrouped notes
      for (const { doc, originalIndex } of ungrouped) {
        items.push({ kind: "note", doc, originalIndex, indented: false });
      }
    } else {
      // Mixed: interleave groups and ungrouped notes by timestamp
      type Slot =
        | { ts: number; entry: RenderItem; children?: RenderItem[] }
        ;

      const slots: Slot[] = [];

      for (const group of groups) {
        const children: RenderItem[] = [];
        if (!group.collapsed) {
          for (const noteId of group.noteIds) {
            const entry = docsMap.get(noteId);
            if (entry) children.push({ kind: "note", doc: entry.doc, originalIndex: entry.originalIndex, indented: true });
          }
        }
        slots.push({ ts: group.createdAt, entry: { kind: "group", group }, children });
      }

      for (const { doc, originalIndex } of ungrouped) {
        const ts = notesSortOrder.startsWith("created") ? doc.createdAt : doc.updatedAt;
        slots.push({ ts, entry: { kind: "note", doc, originalIndex, indented: false } });
      }

      const desc = notesSortOrder.endsWith("-desc");
      slots.sort((a, b) => desc ? b.ts - a.ts : a.ts - b.ts);

      for (const slot of slots) {
        items.push(slot.entry);
        if (slot.children) items.push(...slot.children);
      }

    }

    return items;
  }, [isSearching, filteredDocs, docs, groups, groupedNoteIds, groupLayout, notesSortOrder]);

  const renderNoteItem = (doc: NoteDoc, originalIndex: number, indented: boolean) => {
    const isSelected = selectedNoteIds.has(doc.id);
    const isHovered = hoveredIndex === originalIndex;
    const isContextTarget = contextMenu?.type === "note" && contextMenu.index === originalIndex;

    // Check if this note's group just expanded
    const noteGroup = indented ? getGroupForNote(doc.id) : null;
    const isInExpandingGroup = noteGroup ? expandedGroupIds.has(noteGroup.id) : false;
    const isInRemovingGroup = removingGroupIds.has(doc.id);
    const expandStagger = isInExpandingGroup && noteGroup
      ? noteGroup.noteIds.indexOf(doc.id) * 0.03
      : 0;

    return (
      <div
        key={doc.id}
        data-doc-item
        className={mergeClasses(
          styles.docItemWrapper,
          newDocIds.has(doc.id) && styles.docItemNew,
          slideUpFromIndex >= 0 && originalIndex >= slideUpFromIndex && styles.docItemSlideUp,
          isInExpandingGroup && styles.groupChildExpand,
          isInRemovingGroup && styles.groupCollapseOut,
        )}
        style={expandStagger > 0 ? { animationDelay: `${expandStagger}s` } : undefined}
        onMouseEnter={() => setHoveredIndex(originalIndex)}
        onMouseLeave={() => setHoveredIndex(null)}
        onContextMenu={(e) => {
          if (selectMode) {
            // In select mode, auto-select this note if not already, then show bulk menu
            if (!selectedNoteIds.has(doc.id)) toggleNoteSelection(doc.id);
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ type: "empty", index: -3, x: e.clientX, y: e.clientY });
          } else {
            handleContextMenu(originalIndex, e);
          }
        }}
      >
        <button
          className={mergeClasses(
            styles.selectCheckbox,
            selectMode && styles.selectCheckboxVisible,
            selectMode && isSelected && styles.selectCheckboxChecked,
          )}
          onClick={(e) => { e.stopPropagation(); toggleNoteSelection(doc.id); }}
          style={selectMode && indented ? { marginLeft: "16px" } : undefined}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ opacity: isSelected ? 1 : 0, transition: "opacity 0.1s" }}>
            <path d="M1.5 5.5L4 8L8.5 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {editingIndex === originalIndex ? (
          <Button
            appearance="subtle"
            icon={<DocumentRegular />}
            className={mergeClasses(
              originalIndex === activeIndex ? styles.docItemActive : styles.docItem,
              indented && !selectMode && styles.docItemIndented,
            )}
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
        ) : (
          <>
            <Button
              appearance="subtle"
              icon={<DocumentRegular />}
              className={mergeClasses(
                originalIndex === activeIndex ? styles.docItemActive : styles.docItem,
                indented && !selectMode && styles.docItemIndented,
              )}
              onClick={() => {
                if (selectMode) {
                  toggleNoteSelection(doc.id);
                } else {
                  onSwitchDocument(originalIndex);
                }
              }}
              size="small"
            >
              <span className={styles.docName}>{doc.fileName}</span>
              <span className={mergeClasses(
                styles.docTrailing,
                (isHovered || isContextTarget) && styles.docTrailingHidden,
              )}>
                {doc.isDirty && (
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

            {!selectMode && (
              <Button
                data-more-btn
                appearance="subtle"
                className={mergeClasses(
                  styles.moreBtn,
                  isContextTarget
                    ? styles.moreBtnActive
                    : isHovered && styles.moreBtnVisible,
                )}
                onClick={(e) => handleMoreClick(originalIndex, e)}
                size="small"
              >
                <MoreHorizontalRegular fontSize={16} />
              </Button>
            )}
          </>
        )}
      </div>
    );
  };

  const renderGroupHeader = (group: NoteGroup) => {
    const isEditing = editingGroupId === group.id;
    const isGroupHovered = hoveredGroupId === group.id;
    const isContextTarget = contextMenu?.type === "group" && contextMenu.groupId === group.id;
    const noteCount = group.noteIds.filter((id) => docs.some((d) => d.id === id)).length;
    const isRemoving = removingGroupIds.has(group.id);

    return (
      <div
        key={`group-${group.id}`}
        data-group-item
        className={mergeClasses(
          styles.docItemWrapper,
          newGroupIds.has(group.id) && styles.docItemNew,
          isRemoving && styles.groupCollapseOut,
        )}
        onMouseEnter={() => setHoveredGroupId(group.id)}
        onMouseLeave={() => setHoveredGroupId(null)}
        onContextMenu={(e) => handleGroupContextMenu(group.id, e)}
      >
        <Button
          appearance="subtle"
          className={styles.groupHeader}
          size="small"
          onClick={() => !isEditing && onToggleGroupCollapsed(group.id)}
        >
          <span className={mergeClasses(
            styles.groupChevron,
            !group.collapsed && styles.groupChevronExpanded,
          )}>
            <ChevronRightRegular fontSize={12} />
          </span>
          {isEditing ? (
            <input
              ref={groupInputRef}
              className={styles.groupNameInput}
              value={editingGroupValue}
              onChange={(e) => setEditingGroupValue(e.target.value)}
              onBlur={commitGroupRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitGroupRename(); }
                if (e.key === "Escape") { e.preventDefault(); setEditingGroupId(null); }
              }}
              onClick={(e) => e.stopPropagation()}
              style={{ pointerEvents: "auto" }}
            />
          ) : (
            <>
              <span className={styles.groupName}>{group.name}</span>
              <span className={mergeClasses(
                styles.groupCount,
                (isGroupHovered || isContextTarget) && styles.docTrailingHidden,
              )}>{noteCount}</span>
            </>
          )}
        </Button>

        {!isEditing && (
          <Button
            data-more-btn
            appearance="subtle"
            className={mergeClasses(
              styles.moreBtn,
              isContextTarget
                ? styles.moreBtnActive
                : isGroupHovered && styles.moreBtnVisible,
            )}
            onClick={(e) => handleGroupMoreClick(group.id, e)}
            size="small"
          >
            <MoreHorizontalRegular fontSize={16} />
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className={styles.sidebar} data-sidebar>
      <div
        className={styles.body}
        data-sidebar-body
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest("[data-doc-item]")) return;
          if ((e.target as HTMLElement).closest("[data-group-item]")) return;
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ type: "empty", index: -1, x: e.clientX, y: e.clientY });
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

        {renderItems.length === 0 && !exitingDoc ? (
          <span className={styles.empty}>{sidebarSearchQuery ? "" : i("sidebar.empty")}</span>
        ) : (
          <>
            {exitingDoc && exitingDoc.index === 0 && (
              <div key={`exit-${exitingDoc.doc.id}`} className={mergeClasses(styles.docItemWrapper, styles.docItemExit)}>
                <div className={styles.docItem} style={{ opacity: 0.5 }}>
                  <span className={styles.docName}>{exitingDoc.doc.fileName}</span>
                </div>
              </div>
            )}
            {renderItems.map((item, i) => {
              const elements = [];
              if (item.kind === "note") {
                elements.push(renderNoteItem(item.doc, item.originalIndex, item.indented));
              } else if (item.kind === "group") {
                elements.push(renderGroupHeader(item.group));
              }
              if (exitingDoc && exitingDoc.index === i + 1) {
                elements.unshift(
                  <div key={`exit-${exitingDoc.doc.id}`} className={mergeClasses(styles.docItemWrapper, styles.docItemExit)}>
                    <div className={styles.docItem} style={{ opacity: 0.5 }}>
                      <span className={styles.docName}>{exitingDoc.doc.fileName}</span>
                    </div>
                  </div>
                );
              }
              return elements;
            })}
          </>
        )}
      </div>

      {/* Multi-select toolbar */}
      {selectMode && (
        <div className={styles.selectToolbar}>
          <span className={styles.selectInfo}>
            {selectedNoteIds.size}{i("sidebar.nSelected")}
          </span>
          <span style={{ flex: 1 }} />
          {selectedNoteIds.size > 0 && groups.length > 0 && (
            <Tooltip content={i("sidebar.moveToGroup")} relationship="label" positioning="above">
              <Button
                appearance="subtle"
                icon={<FolderArrowRightRegular />}
                className={styles.selectActionBtn}
                size="small"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setContextMenu({ type: "empty", index: -2, x: rect.left, y: rect.top - 4 });
                }}
              />
            </Tooltip>
          )}
          {selectedNoteIds.size > 0 && (
            <Tooltip content={i("sidebar.newGroupFromSelection")} relationship="label" positioning="above">
              <Button
                appearance="subtle"
                icon={<FolderAddRegular />}
                className={styles.selectActionBtn}
                size="small"
                onClick={() => {
                  const ids = Array.from(selectedNoteIds);
                  onCreateGroup(i("sidebar.newGroup"), ids);
                  onSelectModeChange(false);
                }}
              />
            </Tooltip>
          )}
          {selectedNoteIds.size > 0 && Array.from(selectedNoteIds).some((id) => groupedNoteIds.has(id)) && (
            <Tooltip content={i("sidebar.removeFromGroup")} relationship="label" positioning="above">
              <Button
                appearance="subtle"
                icon={<FolderSubtractRegular />}
                className={styles.selectActionBtn}
                size="small"
                onClick={() => {
                  for (const id of selectedNoteIds) onRemoveNoteFromGroup(id);
                  onSelectModeChange(false);
                }}
              />
            </Tooltip>
          )}
          {selectedNoteIds.size > 0 && (
            <Tooltip content={i("sidebar.deleteSelected")} relationship="label" positioning="above">
              <Button
                appearance="subtle"
                icon={<DeleteRegular />}
                className={mergeClasses(styles.selectActionBtn, styles.contextMenuDanger)}
                size="small"
                onClick={() => {
                  const indices = docs
                    .map((d, idx) => selectedNoteIds.has(d.id) ? idx : -1)
                    .filter((idx) => idx >= 0);
                  onDeleteNotes(indices);
                  onSelectModeChange(false);
                }}
              />
            </Tooltip>
          )}
          <span style={{ width: "1px", height: "16px", backgroundColor: tokens.colorNeutralStroke2, marginLeft: "2px", marginRight: "2px", flexShrink: 0 }} />
          <Tooltip content={i("sidebar.cancelSelect")} relationship="label" positioning="above">
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              className={styles.selectActionBtn}
              size="small"
              style={{ opacity: 0.5 }}
              onClick={() => onSelectModeChange(false)}
            />
          </Tooltip>
        </div>
      )}

      {!selectMode && (
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
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.type === "empty" && contextMenu.index === -1 && (
            <>
              <Button
                appearance="subtle"
                icon={<DocumentAddRegular />}
                className={styles.contextMenuItem}
                onClick={() => { onNewNote(); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.newNote")}<span className={styles.shortcutHint}>Ctrl+N</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<ArrowDownloadRegular />}
                className={styles.contextMenuItem}
                onClick={() => { onImportFile(); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.import")}<span className={styles.shortcutHint}>Ctrl+O</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<WindowNewRegular />}
                className={styles.contextMenuItem}
                onClick={() => { openNewWindow(); closeContextMenu(); }}
                size="small"
              >
                {i("menu.newWindow")}<span className={styles.shortcutHint}>Ctrl+Shift+N</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<FolderAddRegular />}
                className={styles.contextMenuItem}
                onClick={() => { handleCreateGroup(); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.newGroup")}
              </Button>
            </>
          )}

          {/* Select-mode move-to-group menu */}
          {contextMenu.type === "empty" && contextMenu.index === -2 && (
            <>
              {groups.map((g) => (
                <Button
                  key={g.id}
                  appearance="subtle"
                  icon={<FolderRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => {
                    onMoveNotesToGroup(Array.from(selectedNoteIds), g.id);
                    onSelectModeChange(false);
                    closeContextMenu();
                  }}
                  size="small"
                >
                  {g.name}
                </Button>
              ))}
            </>
          )}

          {/* Select-mode bulk actions (right-click) */}
          {contextMenu.type === "empty" && contextMenu.index === -3 && (
            <>
              {groups.length > 0 && (
                <div
                  ref={submenuParentRef}
                  className={styles.submenuParent}
                  onMouseEnter={showSubmenu}
                  onMouseLeave={hideSubmenu}
                >
                  <Button
                    appearance="subtle"
                    icon={<FolderArrowRightRegular />}
                    className={styles.contextMenuItem}
                    size="small"
                  >
                    {i("sidebar.moveToGroup")}
                    <span className={styles.submenuArrow}>▶</span>
                  </Button>
                  {submenuOpen && submenuPos && (
                    <div
                      className={styles.submenu}
                      style={{ left: submenuPos.x, top: submenuPos.y }}
                      ref={(el) => { if (el) clampMenuToViewport(el); }}
                      onMouseEnter={keepSubmenu}
                      onMouseLeave={hideSubmenu}
                    >
                      {groups.map((g) => (
                        <Button
                          key={g.id}
                          appearance="subtle"
                          className={styles.contextMenuItem}
                          onClick={() => {
                            onMoveNotesToGroup(Array.from(selectedNoteIds), g.id);
                            onSelectModeChange(false);
                            closeContextMenu();
                          }}
                          size="small"
                        >
                          {g.name}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <Button
                appearance="subtle"
                icon={<FolderAddRegular />}
                className={styles.contextMenuItem}
                onClick={() => {
                  onCreateGroup(i("sidebar.newGroup"), Array.from(selectedNoteIds));
                  onSelectModeChange(false);
                  closeContextMenu();
                }}
                size="small"
              >
                {i("sidebar.newGroupFromSelection")}
              </Button>
              {Array.from(selectedNoteIds).some((id) => groupedNoteIds.has(id)) && (
              <Button
                appearance="subtle"
                icon={<FolderSubtractRegular />}
                className={styles.contextMenuItem}
                onClick={() => {
                  for (const id of selectedNoteIds) onRemoveNoteFromGroup(id);
                  onSelectModeChange(false);
                  closeContextMenu();
                }}
                size="small"
              >
                {i("sidebar.removeFromGroup")}
              </Button>
              )}
              <Button
                appearance="subtle"
                icon={<DeleteRegular />}
                className={mergeClasses(styles.contextMenuItem, styles.contextMenuDanger)}
                onClick={() => {
                  const indices = docs
                    .map((d, idx) => selectedNoteIds.has(d.id) ? idx : -1)
                    .filter((idx) => idx >= 0);
                  onDeleteNotes(indices);
                  onSelectModeChange(false);
                  closeContextMenu();
                }}
                size="small"
              >
                {i("sidebar.deleteSelected")}
              </Button>
            </>
          )}

          {contextMenu.type === "note" && (
            <>
              <Button
                appearance="subtle"
                icon={<RenameRegular />}
                className={styles.contextMenuItem}
                onClick={() => { handleDoubleClick(contextMenu.index); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.rename")}<span className={styles.shortcutHint}>Ctrl+R</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<WindowNewRegular />}
                className={styles.contextMenuItem}
                onClick={() => { openNewWindow(docs[contextMenu.index]?.id); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.openInNewWindow")}<span className={styles.shortcutHint}>Ctrl+Shift+N</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<DocumentCopyRegular />}
                className={styles.contextMenuItem}
                onClick={() => { onDuplicateNote(contextMenu.index); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.duplicate")}<span className={styles.shortcutHint}>Ctrl+D</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<ArrowExportUpRegular />}
                className={styles.contextMenuItem}
                onClick={() => { onExportNote(contextMenu.index); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.export")}<span className={styles.shortcutHint}>Ctrl+Shift+E</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<CopyRegular />}
                className={styles.contextMenuItem}
                onClick={() => handleCopyContent(contextMenu.index)}
                size="small"
              >
                {i("sidebar.copyContent")}<span className={styles.shortcutHint}>Ctrl+Alt+C</span>
              </Button>

              {/* Add to group submenu */}
              {groups.length > 0 && (
                <div
                  ref={submenuParentRef}
                  className={styles.submenuParent}
                  onMouseEnter={showSubmenu}
                  onMouseLeave={hideSubmenu}
                >
                  <Button
                    appearance="subtle"
                    icon={<FolderArrowRightRegular />}
                    className={styles.contextMenuItem}
                    size="small"
                  >
                    {i("sidebar.addToGroup")}
                    <span className={styles.submenuArrow}>▶</span>
                  </Button>
                  {submenuOpen && submenuPos && (
                    <div
                      className={styles.submenu}
                      style={{ left: submenuPos.x, top: submenuPos.y }}
                      ref={(el) => { if (el) clampMenuToViewport(el); }}
                      onMouseEnter={keepSubmenu}
                      onMouseLeave={hideSubmenu}
                    >
                      {groups.map((g) => (
                        <Button
                          key={g.id}
                          appearance="subtle"
                          className={styles.contextMenuItem}
                          onClick={() => {
                            const doc = docs[contextMenu.index];
                            if (doc) onAddNoteToGroup(doc.id, g.id);
                            closeContextMenu();
                          }}
                          size="small"
                        >
                          {g.name}
                        </Button>
                      ))}
                      <Button
                        appearance="subtle"
                        icon={<FolderAddRegular />}
                        className={styles.contextMenuItem}
                        onClick={() => {
                          const doc = docs[contextMenu.index];
                          if (doc) {
                            onCreateGroup(
                              i("sidebar.newGroup"),
                              [doc.id],
                            );
                          }
                          closeContextMenu();
                        }}
                        size="small"
                      >
                        {i("sidebar.newGroup")}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Add to group: direct option when no groups exist */}
              {groups.length === 0 && (
                <Button
                  appearance="subtle"
                  icon={<FolderAddRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => {
                    const doc = docs[contextMenu.index];
                    if (doc) {
                      onCreateGroup(
                        i("sidebar.newGroup"),
                        [doc.id],
                      );
                    }
                    closeContextMenu();
                  }}
                  size="small"
                >
                  {i("sidebar.addToGroup")}
                </Button>
              )}

              {/* Remove from group */}
              {docs[contextMenu.index] && getGroupForNote(docs[contextMenu.index].id) && (
                <Button
                  appearance="subtle"
                  icon={<FolderSubtractRegular />}
                  className={styles.contextMenuItem}
                  onClick={() => {
                    const doc = docs[contextMenu.index];
                    if (doc) onRemoveNoteFromGroup(doc.id);
                    closeContextMenu();
                  }}
                  size="small"
                >
                  {i("sidebar.removeFromGroup")}
                </Button>
              )}

              <Button
                appearance="subtle"
                icon={<DeleteRegular />}
                className={mergeClasses(styles.contextMenuItem, styles.contextMenuDanger)}
                onClick={() => { onDeleteNote(contextMenu.index); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.delete")}<span className={styles.shortcutHint}>Delete</span>
              </Button>
            </>
          )}

          {contextMenu.type === "group" && contextMenu.groupId && (
            <>
              <Button
                appearance="subtle"
                icon={<RenameRegular />}
                className={styles.contextMenuItem}
                onClick={() => {
                  const group = groups.find((g) => g.id === contextMenu.groupId);
                  if (group) {
                    setEditingGroupId(group.id);
                    setEditingGroupValue(group.name);
                  }
                  closeContextMenu();
                }}
                size="small"
              >
                {i("sidebar.renameGroup")}
              </Button>
              <Button
                appearance="subtle"
                icon={<FolderSubtractRegular />}
                className={styles.contextMenuItem}
                onClick={() => {
                  const gid = contextMenu.groupId!;
                  closeContextMenu();
                  animateGroupRemoval(gid, [], () => onUngroupGroup(gid));
                }}
                size="small"
              >
                {i("sidebar.ungroupGroup")}
              </Button>
              <Button
                appearance="subtle"
                icon={<DeleteRegular />}
                className={mergeClasses(styles.contextMenuItem, styles.contextMenuDanger)}
                onClick={() => {
                  const gid = contextMenu.groupId!;
                  const group = groups.find((g) => g.id === gid);
                  const noteIds = group?.noteIds ?? [];
                  closeContextMenu();
                  animateGroupRemoval(gid, noteIds, () => {
                    if (group) {
                      const indices = noteIds
                        .map((nid) => docs.findIndex((d) => d.id === nid))
                        .filter((idx) => idx >= 0);
                      onDeleteNotes(indices);
                    }
                    onDeleteGroup(gid);
                  });
                }}
                size="small"
              >
                {i("sidebar.deleteGroupAndNotes")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
