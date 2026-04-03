import { useState, useEffect, useCallback, useRef } from "react";
import {
  FluentProvider,
  webLightTheme,
  webDarkTheme,
  mergeClasses,
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
import { getCurrentMarkdown, useFileSystem } from "./hooks/useFileSystem";
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
import { GoToLineBar } from "./components/GoToLineBar";
import { searchPluginKey, type SearchPluginState } from "./extensions/SearchHighlight";
import { setCmSearch } from "./extensions/cmSearchHighlight";
import { t } from "./i18n";
import { exportAsMarkdown, exportAsPdf, exportAsRtf } from "./utils/exportHandlers";
import { migrateNotesDir, hasManifest } from "./utils/migrateNotesDir";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { useWindowSync } from "./hooks/useWindowSync";
import { useChromeVisibility } from "./hooks/useChromeVisibility";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDragDrop } from "./hooks/useDragDrop";
import { open as openDialog, confirm, ask, message } from "@tauri-apps/plugin-dialog";
import { useStyles } from "./App.styles";
import "./App.css";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;
function App() {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("sidebar-open") === "true"; } catch { return false; }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem("sidebar-width"); return v ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number(v))) : SIDEBAR_DEFAULT; } catch { return SIDEBAR_DEFAULT; }
  });
  useEffect(() => { try { localStorage.setItem("sidebar-open", String(sidebarOpen)); } catch {} }, [sidebarOpen]);
  useEffect(() => { try { localStorage.setItem("sidebar-width", String(sidebarWidth)); } catch {} }, [sidebarWidth]);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [docGoToLineOpen, setDocGoToLineOpen] = useState(false);
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
  const { docs, setDocs, activeIndex, setActiveIndex, groups, setGroups, trashedNotes, setTrashedNotes, isLoading } = useNotesLoader(
    locale,
    settings.notesSortOrder,
    notesDirReady,
    reloadKey,
  );

  // Refs for values read (but not triggering) in effects
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const activeDocIdRef = useRef<string | null>(docs[activeIndex]?.id ?? null);
  activeDocIdRef.current = docs[activeIndex]?.id ?? null;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // 그룹 관리
  const noteGroups = useNoteGroups(groups, setGroups, docs, activeIndex);

  // Select 모드 & 그룹 생성 후 rename 트리거
  const [selectMode, setSelectMode] = useState(false);
  const [pendingRenameGroupId, setPendingRenameGroupId] = useState<string | null>(null);

  const initialLoaded = useRef(false);
  useEffect(() => {
    if (reloadKey > 0) {
      initialLoaded.current = false;
    }
  }, [reloadKey]);

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

  const flushAutoSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const notifyActiveDocRef = useRef<((id: string, filePath: string) => void) | null>(null);
  const cancelDocSaveRef = useRef<((docId: string) => void) | null>(null);

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
    setGroups,
    noteGroups.getGroupForNote,
    trashedNotes,
    setTrashedNotes,
    flushAutoSaveRef,
    notifyActiveDocRef,
    cancelDocSaveRef,
  );

  // 자동 저장
  const { scheduleAutoSave, flushAutoSave, notifyActiveDoc, cancelDocSave } = useAutoSave(
    state,
    tiptapRef,
    docs,
    setDocs,
    activeIndex,
    setActiveIndex,
    locale,
    settings.notesSortOrder,
    groups,
  );
  flushAutoSaveRef.current = flushAutoSave;
  notifyActiveDocRef.current = notifyActiveDoc;
  cancelDocSaveRef.current = cancelDocSave;

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
  const handleActiveDocChanged = useCallback((doc: { filePath: string; content: string }) => {
    state.setMarkdownRaw(doc.content);
    state.setFilePath(doc.filePath);
    state.setIsDirty(false);
    state.setTiptapDirty(false);
  }, [state]);
  useWindowSync(setDocs, activeIndex, tiptapRef, setActiveIndex, setGroups, setTrashedNotes, handleActiveDocChanged);

  // 파일 시스템 감시 (클라우드 동기화 등 외부 변경 감지)
  useFileWatcher(
    docs, setDocs, groups, setGroups,
    activeIndex, setActiveIndex, tiptapRef,
    locale, settings.notesSortOrder,
    notesDirReady && !isLoading,
    handleActiveDocChanged,
  );

  // OS Mica 효과 — setTheme("dark")가 Mica를 죽이므로 항상 light 고정
  // 첫 페인트 후 실행하여 DWM 재구성이 초기 WebView2 렌더와 충돌하지 않도록 함
  const [micaSupported, setMicaSupported] = useState(true);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const win = getCurrentWindow();
      (async () => {
        try {
          await win.setTheme("light");
          await win.setEffects({ effects: [Effect.Mica] });
        } catch {
          setMicaSupported(false);
        }
      })();
    });
    return () => cancelAnimationFrame(raf);
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
    const sortedDocs = sortNotes(docs, settings.notesSortOrder, locale);
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
  const isNoteSurface = state.surface === "note";
  const docReady = !isLoading && !!activeDoc;
  const noteEditor = docReady ? tiptapEditor : null;
  const activeCmView = docReady ? cmView : null;
  const showCodeMirror = state.surface === "markdown";

  const handleToggleTheme = useCallback(() => {
    updateSetting("themeMode", isDarkMode ? "light" : "dark");
  }, [isDarkMode, updateSetting]);

  const handleExportMd = useCallback(() => {
    const name = activeDoc?.fileName ?? "untitled";
    const md = getCurrentMarkdown(state, tiptapRef);
    exportAsMarkdown(md, name, locale);
  }, [activeDoc?.fileName, locale, state]);

  const handleExportPdf = useCallback(() => {
    const el = document.querySelector(".ProseMirror") as HTMLElement | null;
    if (el) exportAsPdf(el, activeDoc?.fileName ?? "untitled", locale);
  }, [activeDoc?.fileName, locale]);

  const handleExportRtf = useCallback(() => {
    const name = activeDoc?.fileName ?? "untitled";
    const html = tiptapEditor?.getHTML() ?? "";
    exportAsRtf(html, name, locale);
  }, [activeDoc?.fileName, tiptapEditor, locale]);

  const handleDeleteNotes = useCallback((indices: number[]) => {
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) fs.deleteNote(idx);
  }, [fs.deleteNote]);

  const getSidebarDocumentContent = useCallback((index: number) => {
    const doc = docs[index];
    if (!doc) return "";
    return index === activeIndex ? getCurrentMarkdown(state, tiptapRef) : doc.content;
  }, [activeIndex, docs, state]);

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
        okLabel: t("dialog.merge", locale),
        cancelLabel: t("dialog.overwrite", locale),
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

  const handleSelectSurface = useCallback((nextSurface: "note" | "markdown") => {
    const el = contentRef.current;
    const scrollRatio = el && el.scrollHeight > el.clientHeight
      ? el.scrollTop / (el.scrollHeight - el.clientHeight)
      : 0;

    state.setSurface(nextSurface);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = scrollRatio * (el.scrollHeight - el.clientHeight);
        }
      });
    });
  }, [state.setSurface]);

  const handleToggleSurface = useCallback(() => {
    handleSelectSurface(state.surface === "note" ? "markdown" : "note");
  }, [handleSelectSurface, state.surface]);

  const {
    chromeVisible,
    toolbarHeight,
    editorTopOffset,
    handleShowEditorChrome,
    handleBarHeight,
  } = useChromeVisibility(contentRef, activeDoc?.id, state.surface);

  const handleNewNote = useCallback(async () => {
    await fs.newNote();
    state.setSurface("note");
  }, [fs.newNote, state.setSurface]);

  const handleToggleGoToLine = useCallback(() => {
    if (state.surface === "markdown") {
      setDocSearchOpen(false);
      setDocGoToLineOpen((o) => !o);
    }
  }, [state.surface]);

  useKeyboardShortcuts({
    activeCmView,
    noteEditor,
    tiptapRef,
    surface: state.surface,
    docSearchOpen,
    docGoToLineOpen,
    setDocSearchOpen,
    setDocGoToLineOpen,
    onToggleSurface: handleToggleSurface,
    onToggleGoToLine: handleToggleGoToLine,
    onNewNote: handleNewNote,
    onImportFile: fs.importFile,
    onSaveFile: fs.saveFile,
  });

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    if (state.surface !== "markdown" && docGoToLineOpen) {
      setDocGoToLineOpen(false);
    }
  }, [docGoToLineOpen, state.surface]);

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
      const isNativeTextField =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.closest("[data-sidebar-body]") !== null;
      if (!isNativeTextField) {
        e.preventDefault();
      }
    };
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);


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

  // 창 닫기 — pending autosave flush 후 닫기
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async () => {
      await flushAutoSaveRef.current?.();
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const handleTiptapDirty = useCallback(
    (dirty: boolean) => {
      state.setTiptapDirty(dirty);
      if (dirty) {
        state.setIsDirty(true);
        scheduleAutoSave();
      }
    },
    [state.setTiptapDirty, state.setIsDirty, scheduleAutoSave],
  );

  const handleCodemirrorChange = useCallback(
    (sourceDocId: string | null, value: string) => {
      if (!sourceDocId || sourceDocId !== activeDocIdRef.current) return;
      state.updateMarkdown(value);
      scheduleAutoSave();
    },
    [state.updateMarkdown, scheduleAutoSave],
  );

  const handleMarkdownViewReady = useCallback((sourceDocId: string | null, view: import("@codemirror/view").EditorView) => {
    if (!sourceDocId || sourceDocId !== activeDocIdRef.current) return;
    setCmView(view);
  }, []);

  useDragDrop({
    activeCmView,
    tiptapRef,
    surface: state.surface,
    docReady,
    importFiles: fs.importFiles,
    setIsDirty: state.setIsDirty,
    scheduleAutoSave,
  });

  const hideEditorChrome = !chromeVisible;
  const hideToolbar = hideEditorChrome;
  const hideStatusBar = hideEditorChrome;

  return (
    <FluentProvider
      theme={isDarkMode ? webDarkTheme : webLightTheme}
      style={{ background: "transparent" }}
      data-theme={isDarkMode ? "dark" : "light"}
    >
      <div
        className={styles.root}
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
          locale={locale}
          editor={showCodeMirror ? null : noteEditor}
          paragraphSpacing={settings.paragraphSpacing}
          documentTitle={activeDoc?.fileName}
          onNewNote={handleNewNote}
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
                <Tooltip content={t("sidebar.select", locale)} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
                  <Button
                    appearance="subtle"
                    icon={<CheckboxCheckedRegular />}
                    className={styles.sidebarSelectBtn}
                    onClick={() => setSelectMode((o) => !o)}
                    style={selectMode ? { backgroundColor: "var(--ui-active-bg)" } : undefined}
                  />
                </Tooltip>
                <Tooltip content={t("sidebar.newGroup", locale)} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
                  <Button
                    appearance="subtle"
                    icon={<span style={{ display: "flex", marginTop: "-1px" }}><FolderAddRegular /></span>}
                    className={styles.sidebarNewGroupBtn}
                    onClick={() => {
                      const defaultName = t("sidebar.newGroup", locale);
                      const newId = noteGroups.createGroup(defaultName);
                      setPendingRenameGroupId(newId);
                    }}
                  />
                </Tooltip>
                <Tooltip content={t("search.label", locale)} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
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
              getDocumentContent={getSidebarDocumentContent}
              onSwitchDocument={fs.switchDocument}
              onNewNote={handleNewNote}
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
            <div ref={contentRef} className={`${styles.content} editor-scroll-area`} style={toolbarHeight > 0 ? { "--scrollbar-offset": `${toolbarHeight}px` } as React.CSSProperties : undefined}>
              <div className={styles.toolbarAnchor}>
                <EditorToolbar
                  surface={state.surface}
                  onSelectSurface={handleSelectSurface}
                  editor={noteEditor}
                  cmView={activeCmView}
                  sidebarOpen={sidebarOpen}
                  hidden={hideToolbar}
                  locale={locale}
                  onBarHeight={handleBarHeight}
                />
              </div>
              {(docSearchOpen || docGoToLineOpen) && (
                <div
                  className={styles.searchBarAnchor}
                  style={!hideToolbar && toolbarHeight > 0 ? { top: `${toolbarHeight}px` } : undefined}
                >
                  {docSearchOpen ? (
                    <SearchBar
                      editor={noteEditor}
                      cmView={activeCmView}
                      isCmMode={showCodeMirror}
                      onClose={() => setDocSearchOpen(false)}
                      locale={locale}
                    />
                  ) : (
                    <GoToLineBar
                      cmView={activeCmView}
                      onClose={() => setDocGoToLineOpen(false)}
                      locale={locale}
                    />
                  )}
                </div>
              )}
              <div
                className={showCodeMirror ? styles.editorPaneHidden : styles.editorPane}
                style={editorTopOffset > 0 ? { "--editor-top-offset": `${editorTopOffset}px` } as React.CSSProperties : undefined}
              >
                <TiptapEditor
                  ref={tiptapRef}
                  initialMarkdown={activeDoc?.content ?? ""}
                  editable={isNoteSurface && docReady}
                  isDarkMode={isDarkMode}
                  locale={locale}
                  paragraphSpacing={settings.paragraphSpacing}
                  wordWrap={settings.wordWrap}
                  keepFormatOnPaste={settings.keepFormatOnPaste}
                  spellcheck={settings.spellcheck}
                  onDirtyChange={handleTiptapDirty}
                  onReady={syncEditorRef}
                  onChromeActivate={!showCodeMirror && docReady ? handleShowEditorChrome : undefined}
                  onGoToLine={handleToggleGoToLine}
                />
              </div>

              {showCodeMirror && (
                <div
                  className={styles.editorPane}
                  style={editorTopOffset > 0 ? { "--editor-top-offset": `${editorTopOffset}px` } as React.CSSProperties : undefined}
                >
                  <MarkdownEditor
                    key={activeDoc?.id ?? "markdown-editor"}
                    value={state.markdown}
                    onChange={(value) => handleCodemirrorChange(activeDoc?.id ?? null, value)}
                    editable={docReady}
                    isDarkMode={isDarkMode}
                    locale={locale}
                    wordWrap={settings.wordWrap}
                    onViewReady={(view) => handleMarkdownViewReady(activeDoc?.id ?? null, view)}
                    onChromeActivate={docReady ? handleShowEditorChrome : undefined}
                    onGoToLine={handleToggleGoToLine}
                  />
                </div>
              )}
            </div>

            <StatusBar
              markdown={state.markdown}
              surface={state.surface}
              editor={showCodeMirror ? null : noteEditor}
              cmView={showCodeMirror ? activeCmView : null}
              hidden={hideStatusBar}
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
        trashedNotes={trashedNotes}
        onRestoreNote={fs.restoreNote}
        onPermanentlyDeleteNote={fs.permanentlyDeleteNote}
        onEmptyTrash={fs.emptyTrash}
      />
      <div id="portal-root" />
    </FluentProvider>
  );
}

export default App;
