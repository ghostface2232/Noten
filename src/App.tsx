import { useState, useEffect, useCallback, useRef } from "react";
import {
  FluentProvider,
  webLightTheme,
  webDarkTheme,
  makeStyles,
  mergeClasses,
  tokens,
  Button,
  Tooltip,
} from "@fluentui/react-components";
import {
  FolderAddRegular,
  CheckboxCheckedRegular,
  PanelLeftFilled,
  PanelLeftRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";
import { useMarkdownState } from "./hooks/useMarkdownState";
import { useFileSystem } from "./hooks/useFileSystem";
import { saveManifest, sortNotes, useNotesLoader, getNotesDir, setNotesDir, resetNotesDir, setMigrationInProgress } from "./hooks/useNotesLoader";
import { useAutoSave } from "./hooks/useAutoSave";
import { useNoteGroups } from "./hooks/useNoteGroups";
import { useSettings } from "./hooks/useSettings";

import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "./components/TiptapEditor";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { MarkdownEditor } from "./components/MarkdownEditor";
import { EditorToolbar } from "./components/EditorToolbar";
import { StatusBar } from "./components/StatusBar";
import { SettingsModal } from "./components/SettingsModal";
import { SearchBar } from "./components/SearchBar";
import { searchPluginKey, type SearchPluginState } from "./extensions/SearchHighlight";
import { setCmSearch } from "./extensions/cmSearchHighlight";
import { t } from "./i18n";
import { exportAsMarkdown, exportAsPdf, exportAsRtf } from "./utils/exportHandlers";
import { migrateNotesDir, hasManifest } from "./utils/migrateNotesDir";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { useWindowSync } from "./hooks/useWindowSync";
import { openNewWindow } from "./utils/newWindow";
import { open as openDialog, confirm, ask, message } from "@tauri-apps/plugin-dialog";
import "./App.css";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    color: tokens.colorNeutralForeground1,
    position: "relative",
    transitionProperty: "filter",
    transitionDuration: "0.2s",
    transitionTimingFunction: "ease",
  },
  rootBlurred: {
    filter: "blur(4px)",
    willChange: "filter",
  },
  micaOverlay: {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: 1,
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: "0.4s",
    transitionTimingFunction: "ease",
  },
  micaOverlayActive: {
    opacity: 1,
  },
  body: {
    flex: "1",
    display: "flex",
    position: "relative",
    overflow: "hidden",
    zIndex: 2,
  },
  sidebarSlot: {
    position: "relative",
    width: 0,
    flexShrink: 0,
    overflow: "hidden",
  },
  sidebarSlotAnimated: {
    transitionProperty: "width",
    transitionDuration: "0.3s",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  sidebarSlotOpen: {
    width: "var(--shell-sidebar-width)",
    overflow: "visible",
  },
  sidebarResizer: {
    position: "absolute",
    right: "-4px",
    top: 0,
    bottom: 0,
    width: "8px",
    cursor: "ew-resize",
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    "::after": {
      content: '""',
      width: "4px",
      height: "56px",
      borderRadius: "4px",
      backgroundColor: tokens.colorBrandStroke1,
      opacity: 0,
      transitionProperty: "opacity",
      transitionDuration: "0.15s",
    },
    ":hover::after": {
      opacity: 1,
      transitionDelay: "0.3s",
    },
  },
  sidebarResizing: {
    cursor: "ew-resize",
    "::after": {
      opacity: "1 !important",
    },
  },
  sidebarToggle: {
    position: "absolute",
    top: "16px",
    left: "5px",
    zIndex: 10,
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: "8px",
    padding: "3px",
    pointerEvents: "none",
  },
  sidebarToggleBtn: {
    borderRadius: "6px",
    border: "none",
    minWidth: "auto",
    height: "28px",
    width: "28px",
    padding: "0",
    pointerEvents: "auto",
  },
  sidebarSearchBtn: {
    position: "absolute",
    top: "19px",
    right: "8px",
    zIndex: 10,
    borderRadius: "6px",
    border: "none",
    minWidth: "auto",
    height: "28px",
    width: "28px",
    padding: "0",
  },
  sidebarNewGroupBtn: {
    position: "absolute",
    top: "19px",
    right: "64px",
    zIndex: 10,
    borderRadius: "6px",
    border: "none",
    minWidth: "auto",
    height: "28px",
    width: "28px",
    padding: "0",
  },
  sidebarSelectBtn: {
    position: "absolute",
    top: "19px",
    right: "36px",
    zIndex: 10,
    borderRadius: "6px",
    border: "none",
    minWidth: "auto",
    height: "28px",
    width: "28px",
    padding: "0",
  },
  floatingCard: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flex: "1",
    minWidth: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderTopLeftRadius: "8px",
    overflow: "hidden",
    boxShadow: "-1px 0 3px rgba(0,0,0,0.08)",
    marginTop: "var(--shell-card-gap)",
  },
  content: {
    flex: "1",
    overflow: "auto",
    position: "relative",
  },
  searchBarAnchor: {
    position: "sticky",
    top: 0,
    height: 0,
    zIndex: 50,
    overflow: "visible",
    pointerEvents: "none",
  },
  editorPane: {
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: "0.15s",
    transitionTimingFunction: "ease",
    height: "100%",
  },
  editorPaneHidden: {
    opacity: 0,
    position: "absolute",
    pointerEvents: "none",
    height: 0,
    overflow: "hidden",
  },
});

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [cmView, setCmView] = useState<import("@codemirror/view").EditorView | null>(null);
  const { settings, update: updateSetting, isLoaded: settingsLoaded } = useSettings();
  const isDarkMode = settings.themeMode === "dark";
  const locale = settings.locale;
  const state = useMarkdownState();
  const styles = useStyles();
  const tiptapRef = useRef<TiptapEditorHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [tiptapEditor, setTiptapEditor] = useState<import("@tiptap/react").Editor | null>(null);
  const startupModeApplied = useRef(false);

  // 노트 디렉토리 초기화 (settings 로드 → 경로 설정 → 노트 로딩)
  const [notesDirReady, setNotesDirReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [currentNotesDir, setCurrentNotesDir] = useState("");

  useEffect(() => {
    if (!settingsLoaded) return;
    (async () => {
      if (settings.notesDirectory) {
        setNotesDir(settings.notesDirectory);
      } else {
        resetNotesDir();
      }
      const dir = await getNotesDir();
      setCurrentNotesDir(dir);
      setNotesDirReady(true);
    })();
  }, [settingsLoaded, settings.notesDirectory]);

  // 노트 로더
  const { docs, setDocs, activeIndex, setActiveIndex, groups, setGroups, isLoading } = useNotesLoader(
    locale,
    settings.notesSortOrder,
    notesDirReady,
    reloadKey,
  );

  // Refs for values read (but not triggering) in effects
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // 그룹 관리
  const noteGroups = useNoteGroups(groups, setGroups, docs, activeIndex);

  // Select 모드 & 그룹 생성 후 rename 트리거
  const [selectMode, setSelectMode] = useState(false);
  const [pendingRenameGroupId, setPendingRenameGroupId] = useState<string | null>(null);

  // 초기 로드 완료 시 에디터에 첫 문서 로드
  useEffect(() => {
    if (!settingsLoaded || startupModeApplied.current) return;
    startupModeApplied.current = true;
    state.setEditing(settings.startupMode === "edit");
  }, [settings.startupMode, settingsLoaded, state.setEditing]);

  const initialLoaded = useRef(false);
  useEffect(() => {
    if (!isLoading && docs.length > 0 && !initialLoaded.current) {
      initialLoaded.current = true;
      const doc = docs[activeIndex];
      if (doc) {
        tiptapRef.current?.setContent(doc.content);
        state.setMarkdownRaw(doc.content);
        state.setFilePath(doc.filePath);
        state.setIsDirty(false);
      }
      // 콘텐츠 로드 완료 후 창 표시 (새 창 생성 시 visible:false로 시작)
      requestAnimationFrame(() => {
        getCurrentWindow().show().catch(() => {});
      });
    }
  }, [isLoading, docs, activeIndex]);

  const fs = useFileSystem(
    state,
    tiptapRef,
    docs,
    setDocs,
    activeIndex,
    setActiveIndex,
    locale,
    settings.notesSortOrder,
    groups,
    noteGroups.cleanupDeletedNote,
  );

  // 자동 저장
  useAutoSave(
    state,
    tiptapRef,
    docs,
    setDocs,
    activeIndex,
    setActiveIndex,
    locale,
    settings.notesSortOrder,
  );

  // URL 쿼리 파라미터로 전달된 노트 열기 (새 창에서 열기)
  const fileParamHandled = useRef(false);
  useEffect(() => {
    if (fileParamHandled.current || isLoading || docs.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const noteId = params.get("noteId");
    if (noteId) {
      fileParamHandled.current = true;
      const existing = docs.findIndex((d) => d.id === noteId);
      if (existing >= 0) {
        fs.switchDocument(existing);
      }
    }
  }, [isLoading, docs, fs.switchDocument]);

  // 창 간 동기화 (Tauri 이벤트)
  useWindowSync(setDocs, activeIndex, tiptapRef, setActiveIndex, setGroups);

  // 파일 시스템 감시 (클라우드 동기화 등 외부 변경 감지)
  useFileWatcher(
    docs, setDocs, groups, setGroups,
    activeIndex, setActiveIndex, tiptapRef,
    locale, settings.notesSortOrder,
    notesDirReady && !isLoading,
  );

  // OS Mica 효과
  const [micaSupported, setMicaSupported] = useState(true);
  useEffect(() => {
    getCurrentWindow()
      .setEffects({ effects: [Effect.Mica] })
      .catch(() => setMicaSupported(false));
  }, []);

  const syncEditorRef = useCallback(() => {
    if (tiptapRef.current) {
      const editor = tiptapRef.current.getEditor();
      state.editorRef.current = editor ?? null;
      if (editor && editor !== tiptapEditor) {
        setTiptapEditor(editor);
      }
    }
  }, [tiptapEditor, state.editorRef]);

  useEffect(syncEditorRef, [syncEditorRef]);

  useEffect(() => {
    if (!settingsLoaded || docs.length < 2) return;

    const activeId = docs[activeIndexRef.current]?.id ?? null;
    const sortedDocs = sortNotes(docs, settings.notesSortOrder);
    const changed = sortedDocs.some((doc, index) => doc.id !== docs[index]?.id);
    if (!changed) return;

    setDocs(sortedDocs);
    const nextActiveIndex = activeId
      ? Math.max(sortedDocs.findIndex((doc) => doc.id === activeId), 0)
      : 0;
    setActiveIndex(nextActiveIndex);
    void saveManifest(sortedDocs, activeId, groupsRef.current).catch(() => {});
  }, [
    docs,
    settings.notesSortOrder,
    settingsLoaded,
    setActiveIndex,
    setDocs,
  ]);

  // isDirty → docs 동기화
  useEffect(() => {
    setDocs((prev) => {
      if (activeIndex < 0 || activeIndex >= prev.length) return prev;
      const current = prev[activeIndex];
      if (current.isDirty === state.isDirty) return prev;
      const updated = [...prev];
      updated[activeIndex] = { ...current, isDirty: state.isDirty };
      return updated;
    });
  }, [state.isDirty, activeIndex]);

  const activeDoc = docs[activeIndex];

  const handleToggleTheme = useCallback(() => {
    updateSetting("themeMode", isDarkMode ? "light" : "dark");
  }, [isDarkMode, updateSetting]);

  const handleExportMd = useCallback(() => {
    const name = activeDoc?.fileName ?? "untitled";
    const md = tiptapRef.current?.getMarkdown() ?? state.markdown;
    exportAsMarkdown(md, name);
  }, [activeDoc?.fileName, state.markdown]);

  const handleExportPdf = useCallback(() => {
    const el = document.querySelector(".ProseMirror") as HTMLElement | null;
    if (el) exportAsPdf(el, activeDoc?.fileName ?? "untitled");
  }, [activeDoc?.fileName]);

  const handleExportRtf = useCallback(() => {
    const name = activeDoc?.fileName ?? "untitled";
    const html = tiptapEditor?.getHTML() ?? "";
    exportAsRtf(html, name);
  }, [activeDoc?.fileName, tiptapEditor]);

  const handleDeleteNotes = useCallback((indices: number[]) => {
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) fs.deleteNote(idx);
  }, [fs.deleteNote]);

  // 노트 저장 위치 변경
  const handleChangeNotesDir = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;

    const newDir = selected as string;
    const oldDir = await getNotesDir();

    // 같은 디렉토리 선택 시 무시
    const normalize = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    if (normalize(newDir) === normalize(oldDir)) return;

    const ok = await confirm(t("settings.notesDirectory.confirmMove", locale));
    if (!ok) return;

    let strategy: "merge" | "overwrite" = "overwrite";
    const destHasManifest = await hasManifest(newDir);
    if (destHasManifest) {
      const merge = await ask(t("settings.notesDirectory.mergePrompt", locale), {
        kind: "info",
        okLabel: locale === "ko" ? "병합" : "Merge",
        cancelLabel: locale === "ko" ? "덮어쓰기" : "Overwrite",
      });
      strategy = merge ? "merge" : "overwrite";
    }

    setMigrationInProgress(true);
    const result = await migrateNotesDir(oldDir, newDir, strategy);
    setMigrationInProgress(false);

    if (!result.success) {
      await message(t("settings.notesDirectory.migrationFailed", locale), { kind: "error" });
      return;
    }

    updateSetting("notesDirectory", newDir);
    setNotesDir(newDir);
    setCurrentNotesDir(newDir);
    setReloadKey((k) => k + 1);
  }, [locale, updateSetting]);

  const handleResetNotesDir = useCallback(async () => {
    if (!settings.notesDirectory) return;

    const ok = await confirm(t("settings.notesDirectory.confirmMove", locale));
    if (!ok) return;

    const oldDir = await getNotesDir();

    // Compute default directory
    resetNotesDir();
    const defaultDir = await getNotesDir();

    setMigrationInProgress(true);
    const result = await migrateNotesDir(oldDir, defaultDir, "overwrite");
    setMigrationInProgress(false);

    if (!result.success) {
      // Restore the custom dir on failure
      setNotesDir(oldDir);
      await message(t("settings.notesDirectory.migrationFailed", locale), { kind: "error" });
      return;
    }

    updateSetting("notesDirectory", "");
    setCurrentNotesDir(defaultDir);
    setReloadKey((k) => k + 1);
  }, [locale, settings.notesDirectory, updateSetting]);

  // 에디터 모드 전환 시 스크롤 위치 보존
  const handleSwitchEditorMode = useCallback(() => {
    const el = contentRef.current;
    const scrollRatio = el && el.scrollHeight > el.clientHeight
      ? el.scrollTop / (el.scrollHeight - el.clientHeight)
      : 0;

    state.switchEditorMode();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = scrollRatio * (el.scrollHeight - el.clientHeight);
        }
      });
    });
  }, [state.switchEditorMode]);

  // 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "e") { e.preventDefault(); state.toggleEditing(); }
      if (e.ctrlKey && e.key === "/" && state.isEditing) { e.preventDefault(); handleSwitchEditorMode(); }
      if (e.ctrlKey && e.key === "o") { e.preventDefault(); fs.importFile(); }
      if (e.ctrlKey && !e.shiftKey && e.key === "s") { e.preventDefault(); fs.saveFile(); }
      if (e.ctrlKey && e.shiftKey && e.key === "S") { e.preventDefault(); fs.saveFileAs(); }
      if (e.ctrlKey && !e.shiftKey && e.key === "n") { e.preventDefault(); fs.newNote(); }
      if (e.ctrlKey && e.shiftKey && e.key === "N") { e.preventDefault(); openNewWindow(); }
      if (e.ctrlKey && e.key === "f") { e.preventDefault(); setDocSearchOpen((o) => !o); }
      if (e.key === "Escape" && docSearchOpen) { e.preventDefault(); setDocSearchOpen(false); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.toggleEditing, handleSwitchEditorMode, state.isEditing, fs.importFile, fs.saveFile, fs.saveFileAs, fs.newNote, docSearchOpen]);

  // 마우스 클릭 후 버튼류 요소 자동 blur → Esc/Space 시 포커스 링 방지
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  useEffect(() => {
    const handleMouseUp = () => {
      if (settingsOpenRef.current) return;
      requestAnimationFrame(() => {
        const el = document.activeElement as HTMLElement | null;
        if (
          el && el !== document.body &&
          el.tagName !== "INPUT" &&
          el.tagName !== "TEXTAREA" &&
          !el.isContentEditable &&
          !el.closest(".ProseMirror") &&
          !el.closest(".cm-content")
        ) {
          el.blur();
        }
      });
    };
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  // 전역 우클릭 방지 (텍스트 필드·에디터 제외)
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const isTextField =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest(".ProseMirror") !== null ||
        target.closest(".cm-content") !== null ||
        target.closest("[data-sidebar-body]") !== null;
      if (!isTextField) {
        e.preventDefault();
      }
    };
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // 설정 모달 열릴 때 body 배경색 설정 (blur 가장자리 흰색 방지)
  useEffect(() => {
    if (settingsOpen) {
      document.body.style.transition = "none";
      document.body.style.background = isDarkMode ? "#1a1a1a" : "#f3f3f3";
    } else {
      document.body.style.transition = "background 0.2s ease";
      const timer = setTimeout(() => {
        document.body.style.background = "transparent";
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [settingsOpen, isDarkMode]);

  // 검색 닫힐 때 하이라이트 정리
  useEffect(() => {
    if (!docSearchOpen) {
      if (tiptapEditor) {
        const { tr } = tiptapEditor.state;
        tr.setMeta(searchPluginKey, { query: "", activeIndex: 0, matches: [] } satisfies SearchPluginState);
        tiptapEditor.view.dispatch(tr);
      }
      if (cmView) {
        cmView.dispatch({ effects: setCmSearch.of({ query: "", activeIndex: 0 }) });
      }
    }
  }, [docSearchOpen, tiptapEditor, cmView]);

  // 창 닫기 — 자동 저장이므로 별도 확인 없이 닫기 허용

  const handleTiptapDirty = useCallback(
    (dirty: boolean) => {
      state.setTiptapDirty(dirty);
      if (dirty) state.setIsDirty(true);
    },
    [state.setTiptapDirty, state.setIsDirty],
  );

  const handleCodemirrorChange = useCallback(
    (value: string) => state.updateMarkdown(value),
    [state.updateMarkdown],
  );

  const showCodeMirror = state.isEditing && state.editorMode === "markdown";

  return (
    <FluentProvider
      theme={isDarkMode ? webDarkTheme : webLightTheme}
      style={{ background: "transparent" }}
      data-theme={isDarkMode ? "dark" : "light"}
    >
      <div
        className={mergeClasses(styles.root, settingsOpen && styles.rootBlurred)}
        style={{ "--editor-font-family": `var(--editor-font-family-${settings.fontFamily})` } as React.CSSProperties}
      >
        <div
          className={mergeClasses(
            styles.micaOverlay,
            (isDarkMode || !micaSupported) && styles.micaOverlayActive,
          )}
          style={{
            background: isDarkMode
              ? micaSupported
                ? "rgba(0, 0, 0, 0.75)"
                : "#2a2a28"
              : micaSupported
                ? "transparent"
                : "#f0ece4",
          }}
        />

        <TitleBar
          isDark={isDarkMode}
          isEditing={state.isEditing}
          locale={locale}
          editor={tiptapEditor}
          paragraphSpacing={settings.paragraphSpacing}
          onToggleEditing={state.toggleEditing}
          onNewNote={fs.newNote}
          onImportFile={fs.importFile}
          onToggleTheme={handleToggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
          onUpdateParagraphSpacing={(v) => updateSetting("paragraphSpacing", v)}
          onExportMd={handleExportMd}
          onExportPdf={handleExportPdf}
          onExportRtf={handleExportRtf}
        />

        <div className={styles.body}>
          <div className={styles.sidebarToggle}>
            <Button
              appearance="subtle"
              icon={sidebarOpen ? <PanelLeftFilled /> : <PanelLeftRegular />}
              className={styles.sidebarToggleBtn}
              onClick={() => {
                setSidebarOpen((o) => {
                  if (o) { setSidebarSearchOpen(false); setSidebarSearchQuery(""); }
                  return !o;
                });
              }}
            />
          </div>

          <div
            className={mergeClasses(
              styles.sidebarSlot,
              !sidebarResizing && styles.sidebarSlotAnimated,
              sidebarOpen && styles.sidebarSlotOpen,
            )}
            style={sidebarOpen ? { "--shell-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties : undefined}
          >
            {sidebarOpen && (
              <>
                <Tooltip content={locale === "ko" ? "선택" : "Select"} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
                  <Button
                    appearance="subtle"
                    icon={<CheckboxCheckedRegular />}
                    className={styles.sidebarSelectBtn}
                    onClick={() => setSelectMode((o) => !o)}
                    style={selectMode ? { backgroundColor: "var(--ui-active-bg)" } : undefined}
                  />
                </Tooltip>
                <Tooltip content={locale === "ko" ? "새 그룹" : "New group"} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
                  <Button
                    appearance="subtle"
                    icon={<span style={{ display: "flex", marginTop: "-1px" }}><FolderAddRegular /></span>}
                    className={styles.sidebarNewGroupBtn}
                    onClick={() => {
                      const defaultName = locale === "ko" ? "새 그룹" : "New group";
                      const newId = noteGroups.createGroup(defaultName);
                      setPendingRenameGroupId(newId);
                    }}
                  />
                </Tooltip>
                <Tooltip content={locale === "ko" ? "검색" : "Search"} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
                  <Button
                    appearance="subtle"
                    icon={<SearchRegular />}
                    className={styles.sidebarSearchBtn}
                    onClick={() => setSidebarSearchOpen((o) => !o)}
                  />
                </Tooltip>
              </>
            )}
            <Sidebar
              docs={docs}
              activeIndex={activeIndex}
              onSwitchDocument={fs.switchDocument}
              onNewNote={fs.newNote}
              onDeleteNote={fs.deleteNote}

              onDuplicateNote={fs.duplicateNote}
              onExportNote={fs.exportNote}
              onRenameNote={fs.renameNote}
              onImportFile={fs.importFile}
              notesSortOrder={settings.notesSortOrder}
              locale={locale}
              onOpenSettings={() => setSettingsOpen(true)}
              sidebarSearchOpen={sidebarSearchOpen}
              sidebarSearchQuery={sidebarSearchQuery}
              onSidebarSearchQueryChange={setSidebarSearchQuery}
              onSidebarSearchClose={() => { setSidebarSearchOpen(false); setSidebarSearchQuery(""); }}
              groups={groups}
              groupLayout={settings.groupLayout}
              onCreateGroup={noteGroups.createGroup}
              onRenameGroup={noteGroups.renameGroup}
              onDeleteGroup={noteGroups.deleteGroup}
              onUngroupGroup={noteGroups.ungroupGroup}
              onAddNoteToGroup={noteGroups.addNoteToGroup}
              onRemoveNoteFromGroup={noteGroups.removeNoteFromGroup}
              onMoveNotesToGroup={noteGroups.moveNotesToGroup}
              onToggleGroupCollapsed={noteGroups.toggleGroupCollapsed}
              onDeleteNotes={handleDeleteNotes}
              selectMode={selectMode}
              onSelectModeChange={setSelectMode}
              pendingRenameGroupId={pendingRenameGroupId}
              onPendingRenameGroupIdClear={() => setPendingRenameGroupId(null)}
            />
            <div
              className={mergeClasses(
                styles.sidebarResizer,
                sidebarResizing && styles.sidebarResizing,
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                setSidebarResizing(true);
                document.body.style.cursor = "ew-resize";
                const startX = e.clientX;
                const startW = sidebarWidth;
                const onMove = (ev: MouseEvent) => {
                  const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
                  setSidebarWidth(w);
                };
                const onUp = () => {
                  setSidebarResizing(false);
                  document.body.style.cursor = "";
                  document.removeEventListener("mousemove", onMove);
                  document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
              }}
            />
          </div>

          <div className={styles.floatingCard}>
            <EditorToolbar
              editorMode={state.editorMode}
              onSwitchMode={handleSwitchEditorMode}
              editor={tiptapEditor}
              sidebarOpen={sidebarOpen}
              visible={state.isEditing}
              locale={locale}
            />

            <div ref={contentRef} className={styles.content}>
              {docSearchOpen && (
                <div className={styles.searchBarAnchor}>
                  <SearchBar
                    editor={tiptapEditor}
                    cmView={cmView}
                    isCmMode={showCodeMirror}
                    onClose={() => setDocSearchOpen(false)}
                    locale={locale}
                  />
                </div>
              )}
              <div className={showCodeMirror ? styles.editorPaneHidden : styles.editorPane}>
                <TiptapEditor
                  ref={tiptapRef}
                  initialMarkdown={activeDoc?.content ?? ""}
                  editable={state.isEditing && state.editorMode === "richtext"}
                  isDarkMode={isDarkMode}
                  locale={locale}
                  paragraphSpacing={settings.paragraphSpacing}
                  wordWrap={settings.wordWrap}
                  keepFormatOnPaste={settings.keepFormatOnPaste}
                  spellcheck={settings.spellcheck}
                  onDirtyChange={handleTiptapDirty}
                  onReady={syncEditorRef}
                />
              </div>

              {showCodeMirror && (
                <div className={styles.editorPane}>
                  <MarkdownEditor
                    value={state.markdown}
                    onChange={handleCodemirrorChange}
                    isDarkMode={isDarkMode}
                    wordWrap={settings.wordWrap}
                    onViewReady={setCmView}
                  />
                </div>
              )}
            </div>

            <StatusBar
              markdown={state.markdown}
              isEditing={state.isEditing}
              editorMode={state.editorMode}
              editor={tiptapEditor}
              locale={locale}
            />
          </div>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSetting}
        currentNotesDir={currentNotesDir}
        onChangeNotesDir={handleChangeNotesDir}
        onResetNotesDir={handleResetNotesDir}
      />
      <div id="portal-root" />
    </FluentProvider>
  );
}

export default App;
