import { useState, useEffect, useCallback, useRef } from "react";
import {
  FluentProvider,
  webLightTheme,
  webDarkTheme,
  mergeClasses,
  Button,
  Tooltip,
  Dialog,
  DialogSurface,
  tokens,
} from "@fluentui/react-components";
import {
  FolderAddRegular,
  CheckboxCheckedRegular,
  FilterRegular,
  PanelLeftFilled,
  PanelLeftRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { getCurrentWindow, Effect, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { useMarkdownState } from "./hooks/useMarkdownState";
import { getCurrentMarkdown, useFileSystem } from "./hooks/useFileSystem";
import { saveManifest, sortNotes, useNotesLoader, getNotesDir, setNotesDir, resetNotesDir, setMigrationInProgress } from "./hooks/useNotesLoader";
import { useAutoSave } from "./hooks/useAutoSave";
import { useNoteGroups } from "./hooks/useNoteGroups";
import { useSettings, type ParagraphSpacing } from "./hooks/useSettings";

import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "./components/TiptapEditor";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ColorSwatchRow } from "./components/NoteColorPicker";
import { useStyles as useSidebarStyles } from "./components/Sidebar.styles";
import { EditorToolbar } from "./components/EditorToolbar";
import { StatusBar } from "./components/StatusBar";
import { SettingsModal } from "./components/SettingsModal";
import { SearchBar } from "./components/SearchBar";
import { GoToLineBar } from "./components/GoToLineBar";
import { searchPluginKey, type SearchPluginState } from "./extensions/SearchHighlight";
import { refreshWikiLinkDecorations } from "./extensions/WikiLink";
import { t } from "./i18n";
import { exportAsMarkdown, exportAsPdf, exportAsRtf } from "./utils/exportHandlers";
import { clearManagedNotesData, hasExistingNotenData, migrateNotesDir } from "./utils/migrateNotesDir";
import { colorHex } from "./utils/noteColors";
import { clampMenuToViewport } from "./utils/clampMenuPosition";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { useWindowSync } from "./hooks/useWindowSync";
import { useChromeVisibility } from "./hooks/useChromeVisibility";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDragDrop } from "./hooks/useDragDrop";
import { open as openDialog, confirm, message } from "@tauri-apps/plugin-dialog";
import { useStyles } from "./App.styles";
import "./App.css";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;
// Minimum logical width the editor area needs so the toolbar (two-row mode)
// shows every icon with comfortable breathing room. Tools strip now measures
// ~487px; with the 46px sidebar-toggle overlay (when the sidebar is closed)
// plus grid padding this leaves >50px margin on either side.
const EDITOR_MIN_WIDTH = 600;
const WINDOW_MIN_HEIGHT = 620;
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

type NotesDirConflictChoice = "merge" | "overwrite" | null;

interface NotesDirConflictDialogState {
  path: string;
  resolve: (choice: NotesDirConflictChoice) => void;
}

function getSystemPrefersDark() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("sidebar-open") === "true"; } catch { return false; }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem("sidebar-width"); return v ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number(v))) : SIDEBAR_DEFAULT; } catch { return SIDEBAR_DEFAULT; }
  });
  useEffect(() => { try { localStorage.setItem("sidebar-open", String(sidebarOpen)); } catch {} }, [sidebarOpen]);
  useEffect(() => { try { localStorage.setItem("sidebar-width", String(sidebarWidth)); } catch {} }, [sidebarWidth]);
  // Keep the OS-level window minimum wide enough to fit the toolbar alongside
  // the current sidebar. When the sidebar is opened or dragged wider past the
  // current window's capacity, we grow the window rightward (anchoring the
  // left edge) in a short animation that matches the sidebar's CSS transition
  // so the two motions read as one.
  useEffect(() => {
    const effectiveSidebar = sidebarOpen ? sidebarWidth : 0;
    const minWidth = EDITOR_MIN_WIDTH + effectiveSidebar;
    let cancelled = false;
    (async () => {
      try {
        const win = getCurrentWindow();
        await win.setMinSize(new LogicalSize(minWidth, WINDOW_MIN_HEIGHT));
        if (cancelled) return;
        const scale = await win.scaleFactor();
        const size = await win.innerSize();
        const currentLogicalW = size.width / scale;
        const currentLogicalH = size.height / scale;
        if (currentLogicalW >= minWidth - 1) return;

        const pos = await win.outerPosition();
        if (cancelled) return;
        const fromX = pos.x / scale;
        const fromW = currentLogicalW;
        const toW = minWidth;
        const toX = fromX;

        // Animate to match the sidebar's ~300ms CSS transition.
        const DURATION = 280;
        const startTime = performance.now();
        let lastW = fromW;
        const tick = () => {
          if (cancelled) return;
          const elapsed = performance.now() - startTime;
          const t = Math.min(1, elapsed / DURATION);
          // easeOutCubic — fast start, gentle finish, matches the sidebar curve
          const e = 1 - Math.pow(1 - t, 3);
          const w = fromW + (toW - fromW) * e;
          const x = fromX + (toX - fromX) * e;
          // Skip sub-physical-pixel frames to avoid IPC flooding near the tail.
          if (t >= 1 || Math.abs(w - lastW) * scale >= 1) {
            lastW = w;
            void Promise.all([
              win.setPosition(new LogicalPosition(x, pos.y / scale)),
              win.setSize(new LogicalSize(w, currentLogicalH)),
            ]).catch(() => {});
          }
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch { /* no-op */ }
    })();
    return () => { cancelled = true; };
  }, [sidebarOpen, sidebarWidth]);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [docSearchReplace, setDocSearchReplace] = useState(false);
  const [docGoToLineOpen, setDocGoToLineOpen] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [notesDirConflict, setNotesDirConflict] = useState<NotesDirConflictDialogState | null>(null);
  const { settings, update: updateSetting, isLoaded: settingsLoaded } = useSettings();
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);
  const isDarkMode = settings.themeMode === "system"
    ? systemPrefersDark
    : settings.themeMode === "dark";
  const locale = settings.locale;
  const state = useMarkdownState();
  const styles = useStyles();
  const sidebarStyles = useSidebarStyles();
  const tiptapRef = useRef<TiptapEditorHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [tiptapEditor, setTiptapEditor] = useState<import("@tiptap/react").Editor | null>(null);

  const requestNotesDirConflictChoice = useCallback((path: string) => (
    new Promise<NotesDirConflictChoice>((resolve) => {
      setNotesDirConflict({ path, resolve });
    })
  ), []);

  const resolveNotesDirConflictChoice = useCallback((choice: NotesDirConflictChoice) => {
    setNotesDirConflict((prev) => {
      prev?.resolve(choice);
      return null;
    });
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const sync = () => setSystemPrefersDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

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
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // 그룹 관리
  const noteGroups = useNoteGroups(groups, setGroups, docs, activeIndex);

  // Select 모드 & 그룹 생성 후 rename 트리거
  const [selectMode, setSelectMode] = useState(false);
  const [pendingRenameGroupId, setPendingRenameGroupId] = useState<string | null>(null);

  // Color-filter popover (anchored under the sidebar filter button)
  const [filterPopoverPos, setFilterPopoverPos] = useState<{ x: number; y: number } | null>(null);

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
        tiptapRef.current?.openDocument?.({
          noteId: doc.id,
          filePath: doc.filePath,
          markdown: doc.content,
          reason: "init",
        });
        state.primeMarkdown(doc.content);
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
    state.primeMarkdown(doc.content);
    state.setFilePath(doc.filePath);
    state.setIsDirty(false);
  }, [state]);
  useWindowSync(
    setDocs,
    activeIndex,
    docs[activeIndex]?.id ?? null,
    tiptapRef,
    setActiveIndex,
    setGroups,
    setTrashedNotes,
    handleActiveDocChanged,
    settings.notesSortOrder,
    locale,
  );

  // 파일 시스템 감시 (클라우드 동기화 등 외부 변경 감지)
  useFileWatcher(
    docs, setDocs, groups, setGroups,
    activeIndex, docs[activeIndex]?.id ?? null, setActiveIndex, tiptapRef,
    locale,
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
      if (editor && editor !== tiptapEditor) {
        setTiptapEditor(editor);
      }
    }
  }, [tiptapEditor]);

  useEffect(syncEditorRef, [syncEditorRef]);

  // Keep the wiki-link extension's storage in sync with the live docs list
  // and the app callbacks. The decoration plugin rebuilds when we nudge it
  // here so missing/existing state reflects newly added or removed notes.
  useEffect(() => {
    if (!tiptapEditor?.storage.wikiLink) return;
    const storage = tiptapEditor.storage.wikiLink;
    storage.docs = docs;
    storage.locale = locale;
    storage.navigateToTitle = (title: string) => {
      const needle = title.normalize("NFC").trim().toLowerCase();
      if (!needle) return;
      const idx = docs.findIndex(
        (doc) => doc.fileName.normalize("NFC").toLowerCase() === needle,
      );
      if (idx < 0) return;
      // Reveal the target note's group in the sidebar so the user can see
      // where they just landed. Collapsed groups would otherwise hide the
      // active row entirely.
      const targetGroup = groups.find((g) => g.noteIds.includes(docs[idx].id));
      if (targetGroup?.collapsed) {
        noteGroups.toggleGroupCollapsed(targetGroup.id);
      }
      void fs.switchDocument(idx);
    };
    storage.createNoteWithTitle = (title: string) => fs.createNoteWithTitle(title);
    refreshWikiLinkDecorations(tiptapEditor);
  }, [tiptapEditor, docs, locale, groups, noteGroups.toggleGroupCollapsed, fs.switchDocument, fs.createNoteWithTitle]);

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
  const docReady = !isLoading && !!activeDoc;
  const noteEditor = docReady ? tiptapEditor : null;

  const handleToggleTheme = useCallback(() => {
    updateSetting("themeMode", isDarkMode ? "light" : "dark");
  }, [isDarkMode, updateSetting]);

  const handleExportMd = useCallback(() => {
    const name = activeDoc?.fileName ?? "untitled";
    const md = getCurrentMarkdown(tiptapRef);
    exportAsMarkdown(md, name, locale);
  }, [activeDoc?.fileName, locale]);

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
    return index === activeIndex ? state.getCachedMarkdown() : doc.content;
  }, [activeIndex, docs, state]);

  // Stable handlers passed to the memoized TitleBar / EditorToolbar. Inline
  // arrows would be new references each render and defeat their `memo`, so an
  // unrelated state change (e.g. a sidebar group toggle) would still re-render
  // the whole editor chrome — the cause of the perceived toggle delay.
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);

  const handleUpdateParagraphSpacing = useCallback((v: ParagraphSpacing) => {
    void updateSetting("paragraphSpacing", v);
  }, [updateSetting]);

  const handleOpenSearch = useCallback(() => {
    setDocGoToLineOpen(false);
    setDocSearchReplace(false);
    setDocSearchOpen(true);
  }, []);

  const handleOpenGoToLine = useCallback(() => {
    setDocSearchOpen(false);
    setDocSearchReplace(false);
    setDocGoToLineOpen(true);
  }, []);

  // 노트 저장 위치 변경
  const handleChangeNotesDir = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;

    const newDir = selected as string;
    const oldDir = await getNotesDir();

    // 같은 디렉토리 선택 시 무시
    const normalize = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    if (normalize(newDir) === normalize(oldDir)) return;

    const destHasData = await hasExistingNotenData(newDir);
    let action: "move" | "merge" | "overwrite-current" = "move";

    if (destHasData) {
      const choice = await requestNotesDirConflictChoice(newDir);
      if (choice === null) return;
      action = choice === "merge" ? "merge" : "overwrite-current";
    } else {
      const ok = await confirm(t("settings.notesDirectory.confirmMove", locale));
      if (!ok) return;
    }

    // Flush any in-flight autosave to the OLD directory FIRST so the user's
    // most recent edits are included in the migration. The autosave's gating
    // on `migrationInProgress` (set immediately after) then prevents new
    // writes to the old path while migrate runs and the subsequent reload
    // re-binds doc paths.
    await flushAutoSaveRef.current?.().catch(() => {});
    await saveManifest(
      docsRef.current,
      docsRef.current[activeIndexRef.current]?.id ?? null,
      groupsRef.current,
    ).catch(() => {});

    setMigrationInProgress(true);
    let result;
    try {
      result = action === "overwrite-current"
        ? await clearManagedNotesData(oldDir, newDir)
        : await migrateNotesDir(oldDir, newDir, action === "merge" ? "merge" : "overwrite");
    } catch (err) {
      setMigrationInProgress(false);
      throw err;
    }

    if (!result.success) {
      setMigrationInProgress(false);
      await message(t("settings.notesDirectory.migrationFailed", locale), { kind: "error" });
      return;
    }

    let settingsSaved = await updateSetting("notesDirectory", newDir);
    if (!settingsSaved) settingsSaved = await updateSetting("notesDirectory", newDir); // retry once for transient failures
    if (!settingsSaved) {
      // Migration already succeeded — the data now lives in `newDir`. A failed
      // settings write is NOT fatal: returning here would strand
      // `migrationInProgress` at `true` for the whole session. Fall through to
      // the same reload sequence as the success path.
      await message(t("settings.notesDirectory.settingsFailed", locale), { kind: "error" });
    }
    setNotesDir(newDir);
    setCurrentNotesDir(newDir);
    setReloadKey((k) => k + 1);
    // Don't release `migrationInProgress` here — the reload-triggered
    // useNotesLoader effect re-acquires it at the top and releases it in
    // its own finally. Releasing here would briefly open a window during
    // which the about-to-run effect's awaits could be preempted by an
    // autosave for an already-stale `snapshot.filePath`.
  }, [locale, requestNotesDirConflictChoice, updateSetting]);

  const handleResetNotesDir = useCallback(async () => {
    if (!settings.notesDirectory) return;

    const ok = await confirm(t("settings.notesDirectory.confirmMove", locale));
    if (!ok) return;

    const oldDir = await getNotesDir();

    // Flush before any path manipulation so pending edits land in OLD dir.
    await flushAutoSaveRef.current?.().catch(() => {});
    await saveManifest(
      docsRef.current,
      docsRef.current[activeIndexRef.current]?.id ?? null,
      groupsRef.current,
    ).catch(() => {});

    // Compute default directory
    resetNotesDir();
    const defaultDir = await getNotesDir();

    setMigrationInProgress(true);
    let result;
    try {
      result = await migrateNotesDir(oldDir, defaultDir, "overwrite");
    } catch (err) {
      setMigrationInProgress(false);
      // Restore the custom dir so the user isn't stranded
      setNotesDir(oldDir);
      throw err;
    }

    if (!result.success) {
      setMigrationInProgress(false);
      // Restore the custom dir on failure
      setNotesDir(oldDir);
      await message(t("settings.notesDirectory.migrationFailed", locale), { kind: "error" });
      return;
    }

    let settingsSaved = await updateSetting("notesDirectory", "");
    if (!settingsSaved) settingsSaved = await updateSetting("notesDirectory", ""); // retry once for transient failures
    if (!settingsSaved) {
      // Migration already succeeded — data now lives in the default folder.
      // Don't return: that would strand `migrationInProgress` at `true`.
      await message(t("settings.notesDirectory.settingsFailed", locale), { kind: "error" });
    }
    setCurrentNotesDir(defaultDir);
    setReloadKey((k) => k + 1);
    // Same as handleChangeNotesDir — release is owned by the reload effect.
  }, [locale, settings.notesDirectory, updateSetting]);

  const {
    chromeVisible,
    toolbarHeight,
    editorTopOffset,
    handleShowEditorChrome,
    handleBarHeight,
  } = useChromeVisibility(contentRef, activeDoc?.id);

  useKeyboardShortcuts({
    tiptapRef,
    docSearchOpen,
    docGoToLineOpen,
    setDocSearchOpen,
    setDocSearchReplace,
    setDocGoToLineOpen,
    onNewNote: fs.newNote,
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
          !el.closest(".ProseMirror")
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
    if (!docSearchOpen && tiptapEditor) {
      const { tr } = tiptapEditor.state;
      tr.setMeta(searchPluginKey, { query: "", activeIndex: 0, matches: [] } satisfies SearchPluginState);
      tiptapEditor.view.dispatch(tr);
    }
  }, [docSearchOpen, tiptapEditor]);

  // 문서 전환 시 검색/바꾸기/행이동 바 닫기
  useEffect(() => {
    setDocSearchOpen(false);
    setDocSearchReplace(false);
    setDocGoToLineOpen(false);
  }, [activeDoc?.id]);

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
      if (!dirty) return;
      state.setIsDirty(true);
      scheduleAutoSave();
    },
    [state, scheduleAutoSave],
  );

  useDragDrop({
    tiptapRef,
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
          editor={noteEditor}
          paragraphSpacing={settings.paragraphSpacing}
          documentTitle={activeDoc?.fileName}
          onNewNote={fs.newNote}
          onImportFile={fs.importFile}
          onToggleTheme={handleToggleTheme}
          onOpenSettings={handleOpenSettings}
          onUpdateParagraphSpacing={handleUpdateParagraphSpacing}
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
                <Tooltip content={t("sidebar.filter", locale)} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
                  <Button
                    appearance="subtle"
                    icon={<span style={{ display: "flex", color: colorHex(settings.colorFilter) }}><FilterRegular /></span>}
                    className={styles.sidebarFilterBtn}
                    onClick={(e) => {
                      if (filterPopoverPos) { setFilterPopoverPos(null); return; }
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setFilterPopoverPos({ x: rect.left, y: rect.bottom + 4 });
                    }}
                    style={settings.colorFilter ? { backgroundColor: "var(--ui-active-bg)" } : undefined}
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
                {filterPopoverPos && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 999 }}
                      onClick={() => setFilterPopoverPos(null)}
                      onContextMenu={(e) => { e.preventDefault(); setFilterPopoverPos(null); }}
                    />
                    <div
                      className={sidebarStyles.filterPopover}
                      style={{ left: filterPopoverPos.x, top: filterPopoverPos.y }}
                      ref={(el) => { if (el) clampMenuToViewport(el); }}
                    >
                      <Button
                        appearance="subtle"
                        size="small"
                        className={sidebarStyles.contextMenuItem}
                        onClick={() => { void updateSetting("colorFilter", null); setFilterPopoverPos(null); }}
                      >
                        {t("sidebar.filterAll", locale)}
                      </Button>
                      <ColorSwatchRow
                        value={settings.colorFilter}
                        includeNone={false}
                        locale={locale}
                        onSelect={(c) => { void updateSetting("colorFilter", c); setFilterPopoverPos(null); }}
                      />
                    </div>
                  </>
                )}
              </>
            )}
            <Sidebar
              docs={docs}
              activeIndex={activeIndex}
              getDocumentContent={getSidebarDocumentContent}
              onSwitchDocument={fs.switchDocument}
              onNewNote={fs.newNote}
              onDeleteNote={fs.deleteNote}

              onDuplicateNote={fs.duplicateNote}
              onExportNote={fs.exportNote}
              onRenameNote={fs.renameNote}
              onToggleNotePinned={fs.toggleNotePinned}
              onSetNoteColor={fs.setNoteColor}
              onSetNotesColor={fs.setNotesColor}
              onImportFile={fs.importFile}
              notesSortOrder={settings.notesSortOrder}
              locale={locale}
              onOpenSettings={handleOpenSettings}
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
              onRemoveNotesFromGroups={noteGroups.removeNotesFromGroups}
              onMoveNotesToGroup={noteGroups.moveNotesToGroup}
              onToggleGroupCollapsed={noteGroups.toggleGroupCollapsed}
              onReorderGroups={noteGroups.reorderGroups}
              onDeleteNotes={handleDeleteNotes}
              selectMode={selectMode}
              onSelectModeChange={setSelectMode}
              pendingRenameGroupId={pendingRenameGroupId}
              onPendingRenameGroupIdClear={() => setPendingRenameGroupId(null)}
              colorFilter={settings.colorFilter}
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
                  editor={noteEditor}
                  sidebarOpen={sidebarOpen}
                  hidden={hideToolbar}
                  locale={locale}
                  onBarHeight={handleBarHeight}
                  onOpenSearch={handleOpenSearch}
                  onOpenGoToLine={handleOpenGoToLine}
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
                      onClose={() => { setDocSearchOpen(false); setDocSearchReplace(false); }}
                      replaceOpen={docSearchReplace}
                      onToggleReplace={setDocSearchReplace}
                      locale={locale}
                    />
                  ) : (
                    <GoToLineBar
                      editor={noteEditor}
                      onClose={() => setDocGoToLineOpen(false)}
                      locale={locale}
                    />
                  )}
                </div>
              )}
              <div
                className={styles.editorPane}
                style={editorTopOffset > 0 ? { "--editor-top-offset": `${editorTopOffset}px` } as React.CSSProperties : undefined}
              >
                <TiptapEditor
                  ref={tiptapRef}
                  initialMarkdown={activeDoc?.content ?? ""}
                  editable={docReady}
                  isDarkMode={isDarkMode}
                  locale={locale}
                  paragraphSpacing={settings.paragraphSpacing}
                  wordWrap={settings.wordWrap}
                  keepFormatOnPaste={settings.keepFormatOnPaste}
                  spellcheck={settings.spellcheck}
                  onDirtyChange={handleTiptapDirty}
                  onReady={syncEditorRef}
                  onChromeActivate={docReady ? handleShowEditorChrome : undefined}
                />
              </div>
            </div>

            <StatusBar
              editor={noteEditor}
              hidden={hideStatusBar}
              locale={locale}
            />
          </div>
        </div>
      </div>

      <Dialog
        open={notesDirConflict !== null}
        onOpenChange={(_, data) => {
          if (!data.open) resolveNotesDirConflictChoice(null);
        }}
      >
        <DialogSurface
          style={{
            maxWidth: "420px",
            padding: "24px 22px 18px",
            borderRadius: "12px",
            background: isDarkMode ? "rgba(32,32,32,0.92)" : "rgba(255,255,255,0.92)",
            backdropFilter: "saturate(120%) blur(60px)",
            WebkitBackdropFilter: "saturate(120%) blur(60px)",
            border: `1px solid ${isDarkMode ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)"}`,
            boxShadow: isDarkMode ? "0 24px 64px rgba(0,0,0,0.48)" : "0 24px 64px rgba(0,0,0,0.18)",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 600, color: tokens.colorNeutralForeground1, userSelect: "none" }}>
            {t("settings.notesDirectory.conflictTitle", locale)}
          </div>
          <div style={{ fontSize: "13px", color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginTop: "10px", userSelect: "none" }}>
            {t("settings.notesDirectory.conflictBody", locale)}
          </div>
          <div
            style={{
              fontSize: "12px",
              color: tokens.colorNeutralForeground3,
              marginTop: "12px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              userSelect: "none",
            }}
          >
            {notesDirConflict?.path}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "22px" }}>
            <Button
              size="medium"
              appearance="subtle"
              onClick={() => resolveNotesDirConflictChoice(null)}
            >
              {t("trash.cancel", locale)}
            </Button>
            <Button
              size="medium"
              appearance="subtle"
              onClick={() => resolveNotesDirConflictChoice("merge")}
            >
              {t("dialog.merge", locale)}
            </Button>
            <Button
              size="medium"
              appearance="subtle"
              onClick={() => resolveNotesDirConflictChoice("overwrite")}
              style={{ color: tokens.colorPaletteRedForeground1 }}
            >
              {t("dialog.overwrite", locale)}
            </Button>
          </div>
        </DialogSurface>
      </Dialog>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        isDarkMode={isDarkMode}
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
