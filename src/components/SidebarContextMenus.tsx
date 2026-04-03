import { useState, useRef, useEffect, useCallback } from "react";
import { Button, tokens, mergeClasses } from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  ArrowExportUpRegular,
  CopySelectRegular,
  DeleteRegular,
  DocumentAddRegular,
  DocumentCopyRegular,
  FolderAddRegular,
  FolderArrowRightRegular,
  FolderRegular,
  RenameRegular,
  WindowNewRegular,
} from "@fluentui/react-icons";
import { t } from "../i18n";
import type { NoteDoc, NoteGroup } from "../hooks/useNotesLoader";
import type { Locale } from "../hooks/useSettings";
import { openNewWindow } from "../utils/newWindow";
import { clampMenuToViewport } from "../utils/clampMenuPosition";
import { useStyles } from "./Sidebar.styles";

/* FolderAddRegular의 + 를 − 로 바꾼 커스텀 아이콘 */
export const FolderSubtractRegular = () => (
  <svg fill="currentColor" aria-hidden="true" width="1em" height="1em" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.5 3A2.5 2.5 0 0 0 2 5.5v9A2.5 2.5 0 0 0 4.5 17h5.1c-.16-.32-.3-.65-.4-1H4.5A1.5 1.5 0 0 1 3 14.5V8h4.09c.4 0 .78-.16 1.06-.44L9.7 6h5.79c.83 0 1.5.67 1.5 1.5v2.1c.36.18.7.4 1 .66V7.5A2.5 2.5 0 0 0 15.5 5H9.7L8.23 3.51A1.75 1.75 0 0 0 6.98 3H4.5ZM3 5.5C3 4.67 3.67 4 4.5 4h2.48c.2 0 .4.08.53.22L8.8 5.5 7.44 6.85a.5.5 0 0 1-.35.15H3V5.5Zm16 9a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-6.5-.5a.5.5 0 0 0 0 1h4.5a.5.5 0 0 0 0-1h-4.5Z" fill="currentColor" />
  </svg>
);

export interface ContextMenuState {
  type: "note" | "empty" | "group";
  index: number;
  groupId?: string;
  x: number;
  y: number;
}

interface SidebarContextMenusProps {
  docs: NoteDoc[];
  groups: NoteGroup[];
  groupedNoteIds: Set<string>;
  selectedNoteIds: Set<string>;
  locale: Locale;
  contextMenu: ContextMenuState | null;
  onContextMenuChange: (menu: ContextMenuState | null) => void;
  onNewNote: () => void;
  onDeleteNote: (index: number) => void;
  onDuplicateNote: (index: number) => void;
  onExportNote: (index: number) => void;
  onImportFile: () => void;
  onCreateGroup: (name: string, initialNoteIds?: string[]) => string;
  onDeleteGroup: (groupId: string) => void;
  onUngroupGroup: (groupId: string) => void;
  onAddNoteToGroup: (noteId: string, groupId: string) => void;
  onRemoveNoteFromGroup: (noteId: string) => void;
  onMoveNotesToGroup: (noteIds: string[], groupId: string) => void;
  onDeleteNotes: (indices: number[]) => void;
  onSelectModeChange: (mode: boolean) => void;
  getDocumentContent: (index: number) => string;
  getGroupForNote: (noteId: string) => NoteGroup | null;
  animateGroupRemoval: (groupId: string, noteIds: string[], callback: () => void) => void;
  onStartRename: (index: number) => void;
  onStartGroupRename: (groupId: string, currentName: string) => void;
  onCreateGroupAndRename: () => void;
}

export function SidebarContextMenus({
  docs,
  groups,
  groupedNoteIds,
  selectedNoteIds,
  locale,
  contextMenu,
  onContextMenuChange,
  onNewNote,
  onDeleteNote,
  onDuplicateNote,
  onExportNote,
  onImportFile,
  onCreateGroup,
  onDeleteGroup,
  onUngroupGroup,
  onAddNoteToGroup,
  onRemoveNoteFromGroup,
  onMoveNotesToGroup,
  onDeleteNotes,
  onSelectModeChange,
  getDocumentContent,
  getGroupForNote,
  animateGroupRemoval,
  onStartRename,
  onStartGroupRename,
  onCreateGroupAndRename,
}: SidebarContextMenusProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);

  const contextMenuRef = useRef<HTMLDivElement>(null);
  const submenuParentRef = useRef<HTMLDivElement>(null);
  const submenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup submenu timer on unmount
  useEffect(() => {
    return () => { if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current); };
  }, []);

  const closeContextMenu = useCallback(() => {
    onContextMenuChange(null);
    setSubmenuOpen(false);
    setSubmenuPos(null);
  }, [onContextMenuChange]);

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
    const content = getDocumentContent(index);
    navigator.clipboard.writeText(content).catch(() => {});
    closeContextMenu();
  }, [closeContextMenu, getDocumentContent]);

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

  return (
    <>
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
                onClick={() => { onCreateGroupAndRename(); closeContextMenu(); }}
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
                onClick={() => { onStartRename(contextMenu.index); closeContextMenu(); }}
                size="small"
              >
                {i("sidebar.rename")}<span className={styles.shortcutHint}>Ctrl+R / F2</span>
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
                {i("sidebar.export")}<span className={styles.shortcutHint}>Ctrl+E</span>
              </Button>
              <Button
                appearance="subtle"
                icon={<CopySelectRegular />}
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
                    onStartGroupRename(group.id, group.name);
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
                  if (noteIds.length > 0) {
                    setConfirmDeleteGroupId(gid);
                  } else {
                    animateGroupRemoval(gid, [], () => onDeleteGroup(gid));
                  }
                }}
                size="small"
              >
                {i("sidebar.deleteGroupAndNotes")}
              </Button>
            </>
          )}
        </div>
      )}

      {confirmDeleteGroupId && (() => {
        const group = groups.find((g) => g.id === confirmDeleteGroupId);
        const noteIds = group?.noteIds ?? [];
        return (
          <>
            <div className={styles.confirmOverlay} onClick={() => setConfirmDeleteGroupId(null)} />
            <div className={styles.confirmPopover}>
              <span className={styles.confirmMessage}>{i("sidebar.confirmDeleteGroup")}</span>
              <div className={styles.confirmActions}>
                <Button
                  appearance="subtle"
                  size="small"
                  onClick={() => setConfirmDeleteGroupId(null)}
                >
                  {i("sidebar.cancel")}
                </Button>
                <Button
                  appearance="primary"
                  size="small"
                  style={{ backgroundColor: tokens.colorPaletteRedBackground3, color: "#fff" }}
                  onClick={() => {
                    const gid = confirmDeleteGroupId;
                    setConfirmDeleteGroupId(null);
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
                >
                  {i("sidebar.confirmDelete")}
                </Button>
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
}
