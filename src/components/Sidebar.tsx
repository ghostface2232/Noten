import { Fragment, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button, Tooltip, tokens, mergeClasses } from "@fluentui/react-components";
import {
  ChevronLeftRegular,
  ChevronRightRegular,
  DeleteRegular,
  DismissRegular,
  DocumentAddRegular,
  DocumentMultipleRegular,
  DocumentRegular,
  FolderAddRegular,
  FolderArrowRightRegular,
  MoreHorizontalRegular,
  PinRegular,
  SettingsRegular,
} from "@fluentui/react-icons";
import { t } from "../i18n";
import type { NoteDoc, NoteGroup } from "../hooks/useNotesLoader";
import { stripMarkdownContent } from "../hooks/useNotesLoader";
import type { Locale, NotesSortOrder } from "../hooks/useSettings";
import { colorHex, type NoteColorId } from "../utils/noteColors";
import { useSidebarDrag } from "../hooks/useSidebarDrag";
import { useSidebarGroupDrag } from "../hooks/useSidebarGroupDrag";
import { useSidebarAnimations } from "../hooks/useSidebarAnimations";
import { useStyles } from "./Sidebar.styles";
import { SidebarContextMenus, FolderSubtractRegular } from "./SidebarContextMenus";
import type { ContextMenuState } from "./SidebarContextMenus";

interface SearchSnippet { before: string; match: string; after: string }
type MatchType = "title" | "body" | "both";
const MATCH_TYPE_ORDER: Record<MatchType, number> = { both: 0, title: 1, body: 2 };

function compareNotesForSidebar(a: NoteDoc, b: NoteDoc, order: NotesSortOrder, locale: Locale): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;

  const desc = order.endsWith("-desc");
  const byTitle = order.startsWith("title");
  const byCreated = order.startsWith("created");
  const dir = desc ? -1 : 1;

  if (byTitle) {
    const cmp = a.fileName.localeCompare(b.fileName, locale);
    if (cmp !== 0) return cmp * dir;
    return b.updatedAt - a.updatedAt;
  }

  const primary = byCreated
    ? a.createdAt - b.createdAt
    : a.updatedAt - b.updatedAt;
  if (primary !== 0) return primary * dir;

  const secondary = byCreated
    ? a.updatedAt - b.updatedAt
    : a.createdAt - b.createdAt;
  if (secondary !== 0) return secondary * dir;

  return a.fileName.localeCompare(b.fileName, locale);
}

function extractSnippet(text: string, query: string, windowSize = 80): SearchSnippet | null {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return null;

  const matchEnd = idx + query.length;
  const half = Math.floor((windowSize - query.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, matchEnd + half);

  return {
    before: (start > 0 ? "..." : "") + text.slice(start, idx),
    match: text.slice(idx, matchEnd),
    after: text.slice(matchEnd, end) + (end < text.length ? "..." : ""),
  };
}

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
  getDocumentContent: (index: number) => string;
  onSwitchDocument: (index: number) => void | Promise<void>;
  onNewNote: () => void;
  onDeleteNote: (index: number) => void;
  onDuplicateNote: (index: number) => void;
  onExportNote: (index: number) => void;
  onRenameNote: (index: number, newName: string) => void;
  onToggleNotePinned: (index: number) => void;
  onSetNoteColor: (index: number, color: NoteColorId | null) => void;
  onSetNotesColor: (noteIds: string[], color: NoteColorId | null) => void;
  onSetNotesPinned: (noteIds: string[], pinned: boolean) => void;
  onImportFile: () => void;
  notesSortOrder: NotesSortOrder;
  locale: Locale;
  onOpenSettings: () => void;
  sidebarSearchOpen: boolean;
  sidebarSearchQuery: string;
  onSidebarSearchQueryChange: (query: string) => void;
  onSidebarSearchClose: () => void;
  groups: NoteGroup[];
  onCreateGroup: (name: string, initialNoteIds?: string[]) => string;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onUngroupGroup: (groupId: string) => void;
  onAddNoteToGroup: (noteId: string, groupId: string) => void;
  onRemoveNoteFromGroup: (noteId: string) => void;
  onRemoveNotesFromGroups: (noteIds: string[]) => void;
  onMoveNotesToGroup: (noteIds: string[], groupId: string) => void;
  onToggleGroupCollapsed: (groupId: string) => void;
  onReorderGroups: (fromIndex: number, insertionIndex: number) => void;
  onDeleteNotes: (indices: number[]) => void;
  selectMode: boolean;
  onSelectModeChange: (mode: boolean) => void;
  pendingRenameGroupId: string | null;
  onPendingRenameGroupIdClear: () => void;
  updateAvailable: boolean;
  isDarkMode: boolean;
  colorFilter: NoteColorId | null;
  onClearColorFilter: () => void;
}

export function Sidebar({
  docs,
  activeIndex,
  getDocumentContent,
  onSwitchDocument,
  onNewNote,
  onDeleteNote,
  onDuplicateNote,
  onExportNote,
  onRenameNote,
  onToggleNotePinned,
  onSetNoteColor,
  onSetNotesColor,
  onSetNotesPinned,
  onImportFile,
  notesSortOrder,
  locale,
  onOpenSettings,
  sidebarSearchOpen,
  sidebarSearchQuery,
  onSidebarSearchQueryChange,
  onSidebarSearchClose,
  groups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onUngroupGroup,
  onAddNoteToGroup,
  onRemoveNoteFromGroup,
  onRemoveNotesFromGroups,
  onMoveNotesToGroup,
  onToggleGroupCollapsed,
  onReorderGroups,
  onDeleteNotes,
  selectMode,
  onSelectModeChange,
  pendingRenameGroupId,
  onPendingRenameGroupIdClear,
  updateAvailable,
  isDarkMode,
  colorFilter,
  onClearColorFilter,
}: SidebarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const colorFilterActive = colorFilter != null;

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupValue, setEditingGroupValue] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const [inAllNotes, setInAllNotes] = useState(false);

  const sidebarBodyRef = useRef<HTMLDivElement>(null);
  const [scrollAtTop, setScrollAtTop] = useState(true);
  const [scrollAtBottom, setScrollAtBottom] = useState(true);
  const [allScrollTop, setAllScrollTop] = useState(true);
  const [allScrollBottom, setAllScrollBottom] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const groupInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const groupedNoteIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) for (const id of g.noteIds) set.add(id);
    return set;
  }, [groups]);

  const { handleDragPointerDown, isDragging } = useSidebarDrag({
    groups,
    docs,
    selectedNoteIds,
    selectMode,
    editingIndex,
    editingGroupId,
    searchActive: !!sidebarSearchQuery || colorFilterActive,
    sidebarBodyRef,
    onAddNoteToGroup,
    onMoveNotesToGroup,
    onRemoveNotesFromGroups,
    onToggleGroupCollapsed,
  });

  const { handleGroupDragPointerDown, isDraggingGroup } = useSidebarGroupDrag({
    groups,
    searchActive: !!sidebarSearchQuery || colorFilterActive,
    editingIndex,
    editingGroupId,
    sidebarBodyRef,
    onReorderGroups,
  });

  useEffect(() => {
    if (sidebarSearchOpen) {
      sidebarBodyRef.current?.scrollTo({ top: 0 });
      searchInputRef.current?.focus();
    }
  }, [sidebarSearchOpen]);

  const {
    newDocIds, slideUpFromIndex, exitingDoc,
    collapsingGroupIds, removingGroupIds, newGroupIds,
    animateGroupRemoval,
  } = useSidebarAnimations({ docs, groups });

  useEffect(() => {
    if (!pendingRenameGroupId) return;
    const group = groups.find((g) => g.id === pendingRenameGroupId);
    if (group) {
      setEditingGroupId(group.id);
      setEditingGroupValue(group.name);
      onPendingRenameGroupIdClear();
    }
  }, [pendingRenameGroupId, groups, onPendingRenameGroupIdClear]);

  useEffect(() => {
    if (!selectMode) setSelectedNoteIds(new Set());
  }, [selectMode]);


  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    if (!sidebarSearchQuery) { setDebouncedQuery(""); return; }
    const timer = setTimeout(() => setDebouncedQuery(sidebarSearchQuery), 250);
    return () => clearTimeout(timer);
  }, [sidebarSearchQuery]);

  // Cache stripped note text by content to keep search cheap.
  const strippedCacheRef = useRef(new Map<string, { content: string; stripped: string }>());
  const strippedContentMap = useMemo(() => {
    const cache = strippedCacheRef.current;
    const activeIds = new Set<string>();
    for (const doc of docs) {
      activeIds.add(doc.id);
      const cached = cache.get(doc.id);
      if (cached && cached.content === doc.content) continue;
      cache.set(doc.id, { content: doc.content, stripped: stripMarkdownContent(doc.content) });
    }
    for (const id of cache.keys()) {
      if (!activeIds.has(id)) cache.delete(id);
    }
    return cache;
  }, [docs]);

  const filteredDocs = useMemo(() => {
    const colorOk = (doc: NoteDoc) => !colorFilter || doc.color === colorFilter;
    if (!debouncedQuery) return docs.map((doc, index) => ({
      doc, originalIndex: index, matchType: "title" as MatchType, snippet: null as SearchSnippet | null,
    })).filter(({ doc }) => colorOk(doc))
      .sort((a, b) => compareNotesForSidebar(a.doc, b.doc, notesSortOrder, locale));
    const q = debouncedQuery.toLowerCase();
    const results: { doc: NoteDoc; originalIndex: number; matchType: MatchType; snippet: SearchSnippet | null }[] = [];

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (!colorOk(doc)) continue;
      const titleMatch = doc.fileName.toLowerCase().includes(q);
      const stripped = strippedContentMap.get(doc.id)?.stripped ?? "";
      const bodyMatch = stripped.toLowerCase().includes(q);
      if (!titleMatch && !bodyMatch) continue;

      const matchType: MatchType = titleMatch && bodyMatch ? "both" : titleMatch ? "title" : "body";
      const snippet = bodyMatch ? extractSnippet(stripped, debouncedQuery) : null;
      results.push({ doc, originalIndex: i, matchType, snippet });
    }

    results.sort((a, b) => {
      if (!!a.doc.pinned !== !!b.doc.pinned) return a.doc.pinned ? -1 : 1;
      const matchDiff = MATCH_TYPE_ORDER[a.matchType] - MATCH_TYPE_ORDER[b.matchType];
      if (matchDiff !== 0) return matchDiff;
      return compareNotesForSidebar(a.doc, b.doc, notesSortOrder, locale);
    });
    return results;
  }, [docs, debouncedQuery, strippedContentMap, notesSortOrder, locale, colorFilter]);

  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIndex]);

  useEffect(() => {
    if (editingGroupId !== null && groupInputRef.current) {
      groupInputRef.current.focus();
      groupInputRef.current.select();
    }
  }, [editingGroupId]);


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

  const handleCreateGroup = useCallback(() => {
    const defaultName = i("sidebar.newGroup");
    const newId = onCreateGroup(defaultName);
    if (newId) {
      setEditingGroupId(newId);
      setEditingGroupValue(defaultName);
    }
  }, [locale, onCreateGroup]);

  const handleDoubleClick = useCallback((index: number) => {
    setEditingIndex(index);
    setEditingValue(docs[index].fileName);
  }, [docs]);

  const handleMoreClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu((prev) => {
      if (prev && prev.anchorIndex === index) return null;
      return { type: "note", index, anchorIndex: index, x: rect.left, y: rect.bottom + 2 };
    });
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

  const sidebarActiveRef = useRef(false);
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const sidebar = document.querySelector("[data-sidebar]");
      const active = !!sidebar?.contains(e.target as Node);
      sidebarActiveRef.current = active;
      document.documentElement.dataset.sidebarActive = active ? "1" : "";
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editingIndex !== null || editingGroupId !== null) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      if (!sidebarActiveRef.current) return;

      if (e.key === "Escape" && inAllNotes) {
        e.preventDefault();
        setInAllNotes(false);
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "d") {
        e.preventDefault();
        onDuplicateNote(activeIndex);
      } else if (ctrl && !e.shiftKey && !e.altKey && e.key === "e") {
        e.preventDefault();
        onExportNote(activeIndex);
      } else if ((ctrl && e.key === "r") || e.key === "F2") {
        e.preventDefault();
        handleDoubleClick(activeIndex);
      } else if (ctrl && e.altKey && e.key === "p") {
        e.preventDefault();
        onToggleNotePinned(activeIndex);
      } else if (ctrl && e.altKey && e.key === "c") {
        e.preventDefault();
        const content = getDocumentContent(activeIndex);
        navigator.clipboard.writeText(content).catch(() => {});
      } else if (e.key === "Delete" && !ctrl && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        onDeleteNote(activeIndex);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIndex, editingIndex, editingGroupId, getDocumentContent, onDuplicateNote, onExportNote, onToggleNotePinned, onDeleteNote, handleDoubleClick, inAllNotes]);

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


  const isSearching = !!debouncedQuery;
  const flatListMode = isSearching || colorFilterActive;

  type RenderItem =
    { kind: "note"; doc: NoteDoc; originalIndex: number; indented: boolean; matchType?: MatchType; snippet?: SearchSnippet | null }

  type GroupRender = { group: NoteGroup; notes: { doc: NoteDoc; originalIndex: number }[] };

  const { groupRenderList, noteItems } = useMemo(() => {
    if (flatListMode) {
      return {
        groupRenderList: [] as GroupRender[],
        noteItems: filteredDocs.map(({ doc, originalIndex, matchType, snippet }) => ({
          kind: "note" as const, doc, originalIndex, indented: false, matchType, snippet,
        })) as RenderItem[],
      };
    }

    const docsMap = new Map(docs.map((d, i) => [d.id, { doc: d, originalIndex: i }]));
    const gList: GroupRender[] = [];
    const nItems: RenderItem[] = [];

    const sortGroupNotes = (entries: { doc: NoteDoc; originalIndex: number }[]) => {
      return [...entries].sort((a, b) => compareNotesForSidebar(a.doc, b.doc, notesSortOrder, locale));
    };

    for (const group of groups) {
      const showNotes = !group.collapsed || collapsingGroupIds.has(group.id);
      let notes: { doc: NoteDoc; originalIndex: number }[] = [];
      if (showNotes) {
        const entries: { doc: NoteDoc; originalIndex: number }[] = [];
        for (const noteId of group.noteIds) {
          const entry = docsMap.get(noteId);
          if (entry) entries.push(entry);
        }
        notes = sortGroupNotes(entries);
      }
      gList.push({ group, notes });
    }

    const ungrouped = filteredDocs.filter(({ doc }) => !groupedNoteIds.has(doc.id));
    for (const { doc, originalIndex } of ungrouped) {
      nItems.push({ kind: "note", doc, originalIndex, indented: false });
    }

    return { groupRenderList: gList, noteItems: nItems };
  }, [flatListMode, filteredDocs, docs, groups, groupedNoteIds, notesSortOrder, locale, collapsingGroupIds]);

  const renderNoteItem = (
    doc: NoteDoc,
    originalIndex: number,
    indented: boolean,
    opts: { snippet?: SearchSnippet | null; searchIndex?: number; noDrag?: boolean; paneActive?: boolean; groupId?: string } = {},
  ) => {
    const { snippet = null, searchIndex, noDrag = false, paneActive = true, groupId } = opts;
    const isSelected = selectedNoteIds.has(doc.id);
    const isContextTarget = contextMenu?.type === "note" && contextMenu.index === originalIndex;

    return (
      <div
        key={doc.id}
        data-doc-item
        data-note-id={doc.id}
        data-group-id={groupId}
        className={mergeClasses(
          styles.docItemWrapper,
          selectMode && styles.docItemSelectRow,
          selectMode && originalIndex === activeIndex && styles.docItemWrapperActive,
          selectMode && originalIndex !== activeIndex && styles.docItemWrapperHoverable,
          newDocIds.has(doc.id) && styles.docItemNew,
          slideUpFromIndex >= 0 && originalIndex >= slideUpFromIndex && styles.docItemSlideUp,
          isSearching && searchIndex !== undefined && styles.searchResultFadeIn,
        )}
        style={
          isSearching && searchIndex !== undefined
            ? { animationDelay: `${searchIndex * 0.03}s` }
            : undefined
        }
        onPointerDown={noDrag ? undefined : (e) => handleDragPointerDown(e, doc.id)}
        onContextMenu={(e) => {
          if (isDragging.current) { e.preventDefault(); return; }
          if (selectMode) {
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
        {editingIndex === originalIndex && paneActive ? (
          <Button
            appearance="subtle"
            icon={<span className={styles.docItemIcon} style={doc.color ? { color: colorHex(doc.color) } : undefined}>{doc.pinned ? <PinRegular /> : <DocumentRegular />}</span>}
            className={mergeClasses(
              originalIndex === activeIndex ? styles.docItemActive : styles.docItem,
              selectMode && originalIndex === activeIndex && styles.docItemActiveBgClear,
              selectMode && styles.docItemSelectGap,
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
              icon={<span className={styles.docItemIcon} style={doc.color ? { color: colorHex(doc.color) } : undefined}>{doc.pinned ? <PinRegular /> : <DocumentRegular />}</span>}
              className={mergeClasses(
                originalIndex === activeIndex ? styles.docItemActive : styles.docItem,
                selectMode && originalIndex === activeIndex && styles.docItemActiveBgClear,
                selectMode && styles.docItemSelectGap,
                indented && !selectMode && styles.docItemIndented,
              )}
              onClick={() => {
                if (isDragging.current) return;
                if (selectMode) {
                  toggleNoteSelection(doc.id);
                } else {
                  onSwitchDocument(originalIndex);
                }
              }}
              size="small"
            >
              {isSearching && snippet ? (
                <div className={styles.searchResultContent}>
                  <span className={styles.docName}>{doc.fileName}</span>
                  <span className={styles.searchSnippet}>
                    {snippet.before}<mark className={styles.snippetHighlight}>{snippet.match}</mark>{snippet.after}
                  </span>
                </div>
              ) : (
                <span className={styles.docName}>{doc.fileName}</span>
              )}
              <span
                data-doc-trailing
                className={mergeClasses(
                  styles.docTrailing,
                  isContextTarget && styles.docTrailingHidden,
                )}
              >
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

            <Button
              data-more-btn
              appearance="subtle"
              className={mergeClasses(
                styles.moreBtn,
                isContextTarget && styles.moreBtnActive,
              )}
              onPointerDown={(e) => {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                e.stopPropagation();
                if (selectMode) {
                  if (contextMenu?.anchorIndex === originalIndex) {
                    setContextMenu(null);
                    return;
                  }
                  if (!selectedNoteIds.has(doc.id)) toggleNoteSelection(doc.id);
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setContextMenu({
                    type: "empty",
                    index: -3,
                    anchorIndex: originalIndex,
                    x: rect.left,
                    y: rect.bottom + 2,
                  });
                } else {
                  handleMoreClick(originalIndex, e);
                }
              }}
              onClick={(e) => e.stopPropagation()}
              size="small"
            >
              <MoreHorizontalRegular fontSize={16} />
            </Button>
          </>
        )}
      </div>
    );
  };

  const renderGroupHeader = (group: NoteGroup) => {
    const isEditing = editingGroupId === group.id;
    const isContextTarget = contextMenu?.type === "group" && contextMenu.groupId === group.id;
    const noteCount = group.noteIds.filter((id) => docs.some((d) => d.id === id)).length;
    const isRemoving = removingGroupIds.has(group.id);
    const activeDocId = docs[activeIndex]?.id ?? null;
    const isActiveGroup =
      !!activeDocId && group.collapsed && group.noteIds.includes(activeDocId);

    return (
      <div
        key={`group-${group.id}`}
        data-group-item
        data-group-id={group.id}
        className={mergeClasses(
          styles.docItemWrapper,
          newGroupIds.has(group.id) && styles.docItemNew,
          isRemoving && styles.groupCollapseOut,
        )}
        onPointerDown={(e) => handleGroupDragPointerDown(e, group.id)}
        onContextMenu={(e) => {
          if (isDraggingGroup.current) { e.preventDefault(); return; }
          handleGroupContextMenu(group.id, e);
        }}
      >
        <Button
          appearance="subtle"
          className={mergeClasses(
            styles.groupHeader,
            isActiveGroup && styles.groupHeaderActive,
          )}
          size="small"
          onClick={() => {
            if (isDraggingGroup.current) return;
            if (!isEditing) onToggleGroupCollapsed(group.id);
          }}
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
              <span
                data-doc-trailing
                className={mergeClasses(
                  styles.groupCount,
                  isContextTarget && styles.docTrailingHidden,
                )}
              >{noteCount}</span>
            </>
          )}
        </Button>

        {!isEditing && (
          <Button
            data-more-btn
            appearance="subtle"
            className={mergeClasses(
              styles.moreBtn,
              isContextTarget && styles.moreBtnActive,
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
    <div
      className={styles.sidebar}
      data-sidebar
      tabIndex={-1}
      style={{
        outline: "none",
        "--update-dot-color": isDarkMode ? tokens.colorBrandForeground1 : tokens.colorBrandBackground,
      } as React.CSSProperties}
    >
      <div className={styles.sidebarFixed}>
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
          <span className="new-doc-shortcut">Ctrl+N</span>
        </Button>

        {colorFilter && (
          <div className={styles.filterChip} role="status" aria-live="polite">
            <span
              className={styles.filterChipDot}
              style={{ backgroundColor: colorHex(colorFilter) }}
              aria-hidden
            />
            <span className={styles.filterChipText}>
              {i("sidebar.colorFilterChip")}
            </span>
            <Tooltip content={i("sidebar.colorFilterChip.clear")} relationship="label" withArrow>
              <Button
                appearance="subtle"
                size="small"
                className={styles.filterChipClear}
                icon={<DismissRegular fontSize={12} />}
                onClick={onClearColorFilter}
                aria-label={i("sidebar.colorFilterChip.clear")}
              />
            </Tooltip>
          </div>
        )}
      </div>

      <div className={styles.bodyArea}>
        <div className={mergeClasses(styles.viewTrack, inAllNotes && styles.viewTrackShifted)}>
          {/* Root view */}
          <div
            ref={sidebarBodyRef}
            className={styles.body}
            data-sidebar-body
            inert={inAllNotes}
            data-scroll-top={scrollAtTop ? "true" : "false"}
            data-scroll-bottom={scrollAtBottom ? "true" : "false"}
            onScroll={(e) => {
              const el = e.target as HTMLElement;
              setScrollAtTop(el.scrollTop <= 0);
              setScrollAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
            }}
            onContextMenu={(e) => {
              if ((e.target as HTMLElement).closest("[data-doc-item]")) return;
              if ((e.target as HTMLElement).closest("[data-group-item]")) return;
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ type: "empty", index: -1, x: e.clientX, y: e.clientY });
            }}
          >
            {!flatListMode && docs.length > 0 && groups.length > 0 && (
              <Button
                appearance="subtle"
                size="small"
                icon={<DocumentMultipleRegular />}
                className={styles.allNotesEntry}
                onClick={() => setInAllNotes(true)}
              >
                <span className={styles.allNotesEntryName}>{i("sidebar.allNotes")}</span>
                <span className={styles.allNotesEntryCount}>{docs.length}</span>
                <ChevronRightRegular fontSize={14} className={styles.allNotesEntryChevron} />
              </Button>
            )}
            {groupRenderList.length === 0 && noteItems.length === 0 && !exitingDoc ? (
              <span className={styles.empty}>{debouncedQuery ? i("search.noResults") : sidebarSearchQuery ? "" : colorFilterActive ? i("sidebar.colorFilterEmpty") : i("sidebar.empty")}</span>
            ) : (
              <>
                {!flatListMode && (
                  <div
                    data-groups-section
                    className={mergeClasses(styles.groupsSection, groups.length === 0 && styles.groupsSectionHidden)}
                  >
                    <div className={styles.groupsSectionInner}>
                      <span className={styles.sectionLabel}>{i("sidebar.groupsLabel")}</span>
                      {groupRenderList.map(({ group, notes }) => {
                        const collapsed = group.collapsed || removingGroupIds.has(group.id);
                        return (
                          <Fragment key={`grp-${group.id}`}>
                            {renderGroupHeader(group)}
                            <div
                              className={mergeClasses(
                                styles.groupNotesSlide,
                                collapsed && styles.groupNotesSlideCollapsed,
                              )}
                            >
                              <div className={styles.groupNotesSlideInner}>
                                {notes.map(({ doc, originalIndex }) =>
                                  renderNoteItem(doc, originalIndex, true, { paneActive: !inAllNotes, groupId: group.id }))}
                              </div>
                            </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div data-notes-section className={styles.notesSection}>
                  {!flatListMode && (noteItems.length > 0 || exitingDoc) && (
                    <span className={styles.sectionLabel}>{i("sidebar.notesLabel")}</span>
                  )}
                  {exitingDoc && exitingDoc.index === 0 && (
                    <div key={`exit-${exitingDoc.doc.id}`} className={mergeClasses(styles.docItemWrapper, styles.docItemExit)}>
                      <div className={styles.docItem} style={{ opacity: 0.5 }}>
                        <span className={styles.docName}>{exitingDoc.doc.fileName}</span>
                      </div>
                    </div>
                  )}
                  {noteItems.map((item, idx) => {
                    const elements = [renderNoteItem(item.doc, item.originalIndex, item.indented, { snippet: item.snippet, searchIndex: isSearching ? idx : undefined, paneActive: !inAllNotes })];
                    if (exitingDoc && exitingDoc.index === idx + 1) {
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
                </div>
              </>
            )}
          </div>

          {/* All Notes view */}
          <div className={styles.allNotesPane} inert={!inAllNotes}>
            <Button
              appearance="subtle"
              size="small"
              icon={<ChevronLeftRegular className={styles.allNotesHeaderIcon} />}
              className={styles.allNotesHeader}
              onClick={() => setInAllNotes(false)}
            >
              <span className={styles.allNotesHeaderLabel}>{i("sidebar.allNotes")}</span>
            </Button>
            <div
              className={styles.allNotesScroll}
              data-scroll-top={allScrollTop ? "true" : "false"}
              data-scroll-bottom={allScrollBottom ? "true" : "false"}
              onScroll={(e) => {
                const el = e.target as HTMLElement;
                setAllScrollTop(el.scrollTop <= 0);
                setAllScrollBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
              }}
              onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest("[data-doc-item]")) return;
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ type: "empty", index: -1, x: e.clientX, y: e.clientY });
              }}
            >
              {filteredDocs.length === 0 ? (
                <span className={styles.empty}>{debouncedQuery ? i("search.noResults") : colorFilterActive ? i("sidebar.colorFilterEmpty") : i("sidebar.empty")}</span>
              ) : (
                filteredDocs.map(({ doc, originalIndex, snippet }, idx) => (
                  renderNoteItem(doc, originalIndex, false, {
                    snippet,
                    searchIndex: isSearching ? idx : undefined,
                    noDrag: true,
                    paneActive: inAllNotes,
                  })
                ))
              )}
            </div>
          </div>
        </div>
      </div>

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
            {updateAvailable && <span className={styles.updateDot} />}
          </Button>
        </div>
      )}

      <SidebarContextMenus
        docs={docs}
        groups={groups}
        groupedNoteIds={groupedNoteIds}
        selectedNoteIds={selectedNoteIds}
        locale={locale}
        contextMenu={contextMenu}
        onContextMenuChange={setContextMenu}
        onNewNote={onNewNote}
        onDeleteNote={onDeleteNote}
        onDuplicateNote={onDuplicateNote}
        onExportNote={onExportNote}
        onToggleNotePinned={onToggleNotePinned}
        onSetNoteColor={onSetNoteColor}
        onSetNotesColor={onSetNotesColor}
        onSetNotesPinned={onSetNotesPinned}
        onImportFile={onImportFile}
        onCreateGroup={onCreateGroup}
        onDeleteGroup={onDeleteGroup}
        onUngroupGroup={onUngroupGroup}
        onAddNoteToGroup={onAddNoteToGroup}
        onRemoveNoteFromGroup={onRemoveNoteFromGroup}
        onMoveNotesToGroup={onMoveNotesToGroup}
        onDeleteNotes={onDeleteNotes}
        onSelectModeChange={onSelectModeChange}
        getDocumentContent={getDocumentContent}
        getGroupForNote={getGroupForNote}
        animateGroupRemoval={animateGroupRemoval}
        onStartRename={handleDoubleClick}
        onStartGroupRename={(groupId, name) => {
          setEditingGroupId(groupId);
          setEditingGroupValue(name);
        }}
        onCreateGroupAndRename={handleCreateGroup}
      />
    </div>
  );
}
