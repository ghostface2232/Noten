import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
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
import { exportAsMarkdown, exportAsPdf } from "./utils/exportHandlers";
import { clearManagedNotesData, hasExistingNotenData, migrateNotesDir } from "./utils/migrateNotesDir";
import { colorHex } from "./utils/noteColors";
import { clampMenuToViewport } from "./utils/clampMenuPosition";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { createReconcileState } from "./utils/reconcileFolder";
import { useWindowSync } from "./hooks/useWindowSync";
import { useChromeVisibility } from "./hooks/useChromeVisibility";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDragDrop } from "./hooks/useDragDrop";
import { useUpdater } from "./hooks/useUpdater";
import { open as openDialog, confirm, message } from "@tauri-apps/plugin-dialog";
import { useStyles } from "./App.styles";
import "./App.css";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;
// Enough logical width for the wrapped toolbar and sidebar toggle.
const EDITOR_MIN_WIDTH = 600;
const WINDOW_MIN_HEIGHT = 620;
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

type NotesDirConflictChoice = "replace-with-current" | "use-selected-only" | "merge" | null;

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
  // Track the live width during a drag without going through React state, so
  // mousemove doesn't re-render the whole tree (the sidebar slot's CSS var is
  // mutated imperatively below). State is updated once on mouseup.
  const sidebarWidthRef = useRef(sidebarWidth);
  const sidebarSlotRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  // Drive the --shell-sidebar-width CSS variable imperatively. Using
  // useLayoutEffect so the value is on the DOM element before the browser
  // paints (avoids one-frame fallback to the :root default on mount and on
  // sidebarOpen toggles). The mousemove handler writes to the same element
  // directly during drag.
  useLayoutEffect(() => {
    sidebarSlotRef.current?.style.setProperty("--shell-sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);
  useEffect(() => { try { localStorage.setItem("sidebar-open", String(sidebarOpen)); } catch {} }, [sidebarOpen]);
  useEffect(() => { try { localStorage.setItem("sidebar-width", String(sidebarWidth)); } catch {} }, [sidebarWidth]);
  // Keep the native window minimum aligned with the current sidebar width.
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

        const DURATION = 280;
        const startTime = performance.now();
        let lastW = fromW;
        const tick = () => {
          if (cancelled) return;
          const elapsed = performance.now() - startTime;
          const t = Math.min(1, elapsed / DURATION);
          const e = 1 - Math.pow(1 - t, 3);
          const w = fromW + (toW - fromW) * e;
          const x = fromX + (toX - fromX) * e;
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
      } catch {}
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
  const updater = useUpdater();
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);
  const isDarkMode = settings.themeMode === "system"
    ? systemPrefersDark
    : settings.themeMode === "dark";
  const locale = settings.locale;
  const state = useMarkdownState();
  const isDirtyRef = useRef(state.isDirty);
  isDirtyRef.current = state.isDirty;
  const styles = useStyles();
  const sidebarStyles = useSidebarStyles();
  const tiptapRef = useRef<TiptapEditorHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const startupUpdateCheckStartedRef = useRef(false);
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

  useEffect(() => {
    if (startupUpdateCheckStartedRef.current) return;
    startupUpdateCheckStartedRef.current = true;
    void updater.checkForUpdate();
  }, [updater.checkForUpdate]);

  const [notesDirReady, setNotesDirReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [currentNotesDir, setCurrentNotesDir] = useState("");

  useEffect(() => {
    if (!settingsLoaded) return;
    (async () => {
      if (settings.notesDirectory) {
        setNotesDir(settings.notesDirectory, reconcileStateRef.current);
      } else {
        resetNotesDir(reconcileStateRef.current);
      }
      const dir = await getNotesDir();
      setCurrentNotesDir(dir);
      setNotesDirReady(true);
    })();
  }, [settingsLoaded, settings.notesDirectory]);

  const reconcileStateRef = useRef(createReconcileState());

  const { docs, setDocs, activeIndex, setActiveIndex, groups, setGroups, trashedNotes, setTrashedNotes, isLoading } = useNotesLoader(
    locale,
    settings.notesSortOrder,
    notesDirReady,
    reloadKey,
    reconcileStateRef.current,
  );

  // Refs used by async handlers without retriggering effects.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const wikiDocIndexSignature = useMemo(
    () => docs.map((doc) => `${doc.id}\u0000${doc.fileName}`).join("\u0001"),
    [docs],
  );
  const lastWikiRefreshSignatureRef = useRef<string | null>(null);

  const noteGroups = useNoteGroups(groups, setGroups, docs, activeIndex);

  const [selectMode, setSelectMode] = useState(false);
  const [pendingRenameGroupId, setPendingRenameGroupId] = useState<string | null>(null);

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

  useFileWatcher(
    docs, setDocs, groups, setGroups,
    activeIndex, docs[activeIndex]?.id ?? null, setActiveIndex, tiptapRef,
    locale,
    notesDirReady && !isLoading,
    reconcileStateRef.current,
    handleActiveDocChanged,
  );

  // Keep Tauri's theme light so DWM Mica stays enabled.
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

  // Wiki-link decorations depend on the live docs list and callbacks.
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
      const targetGroup = groups.find((g) => g.noteIds.includes(docs[idx].id));
      if (targetGroup?.collapsed) {
        noteGroups.toggleGroupCollapsed(targetGroup.id);
      }
      void fs.switchDocument(idx);
    };
    storage.createNoteWithTitle = (title: string) => fs.createNoteWithTitle(title);
    const refreshSignature = `${wikiDocIndexSignature}\u0002${locale}`;
    if (lastWikiRefreshSignatureRef.current !== refreshSignature) {
      lastWikiRefreshSignatureRef.current = refreshSignature;
      refreshWikiLinkDecorations(tiptapEditor);
    }
  }, [tiptapEditor, docs, locale, groups, noteGroups.toggleGroupCollapsed, fs.switchDocument, fs.createNoteWithTitle, wikiDocIndexSignature]);

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

  const handleDeleteNotes = useCallback((indices: number[]) => {
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) fs.deleteNote(idx);
  }, [fs.deleteNote]);

  const getSidebarDocumentContent = useCallback((index: number) => {
    const doc = docs[index];
    if (!doc) return "";
    return index === activeIndex ? state.getCachedMarkdown() : doc.content;
  }, [activeIndex, docs, state]);

  // Stable handlers preserve memoized editor chrome.
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);

  const handleUpdateParagraphSpacing = useCallback((v: ParagraphSpacing) => {
    void updateSetting("paragraphSpacing", v);
  }, [updateSetting]);

  const persistNotesDirectorySetting = useCallback(async (value: string) => {
    let saved = await updateSetting("notesDirectory", value);
    if (!saved) saved = await updateSetting("notesDirectory", value);
    return saved;
  }, [updateSetting]);

  // Unwind a failed notes-dir migration: restore the loader's in-memory dir,
  // roll the persisted setting back, and release the autosave guard. Each
  // failure path (try/catch throw, !result.success) repeated this triple.
  const revertNotesDirChange = useCallback(async (oldDir: string, previousNotesDirectory: string) => {
    setNotesDir(oldDir, reconcileStateRef.current);
    await persistNotesDirectorySetting(previousNotesDirectory);
    setMigrationInProgress(false);
  }, [persistNotesDirectorySetting]);

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

  const handleChangeNotesDir = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;

    const newDir = selected as string;
    const oldDir = await getNotesDir();

    const normalize = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    if (normalize(newDir) === normalize(oldDir)) return;

    const destHasData = await hasExistingNotenData(newDir);
    let action: "move" | "replace-with-current" | "use-selected-only" | "merge" = "move";

    if (destHasData) {
      const choice = await requestNotesDirConflictChoice(newDir);
      if (choice === null) return;
      action = choice;
    } else {
      const ok = await confirm(t("settings.notesDirectory.confirmMove", locale));
      if (!ok) return;
    }

    // Flush before moving paths; later saves are blocked by migrationInProgress.
    await flushAutoSaveRef.current?.().catch(() => {});
    await saveManifest(
      docsRef.current,
      docsRef.current[activeIndexRef.current]?.id ?? null,
      groupsRef.current,
    ).catch(() => {});

    setMigrationInProgress(true);
    const previousNotesDirectory = settings.notesDirectory;
    if (!(await persistNotesDirectorySetting(newDir))) {
      setMigrationInProgress(false);
      await message(t("settings.notesDirectory.settingsFailed", locale), { kind: "error" });
      return;
    }

    let result;
    try {
      result = action === "use-selected-only"
        ? await clearManagedNotesData(oldDir, newDir)
        : await migrateNotesDir(oldDir, newDir, action === "merge" ? "merge" : "overwrite");
    } catch (err) {
      await revertNotesDirChange(oldDir, previousNotesDirectory);
      throw err;
    }

    if (!result.success) {
      await revertNotesDirChange(oldDir, previousNotesDirectory);
      await message(t("settings.notesDirectory.migrationFailed", locale), { kind: "error" });
      return;
    }

    setNotesDir(newDir, reconcileStateRef.current);
    setCurrentNotesDir(newDir);
    setReloadKey((k) => k + 1);
    // Reload owns releasing migrationInProgress.
  }, [locale, persistNotesDirectorySetting, requestNotesDirConflictChoice, revertNotesDirChange, settings.notesDirectory]);

  const handleResetNotesDir = useCallback(async () => {
    if (!settings.notesDirectory) return;

    const ok = await confirm(t("settings.notesDirectory.confirmMove", locale));
    if (!ok) return;

    const oldDir = await getNotesDir();

    // Flush before moving paths.
    await flushAutoSaveRef.current?.().catch(() => {});
    await saveManifest(
      docsRef.current,
      docsRef.current[activeIndexRef.current]?.id ?? null,
      groupsRef.current,
    ).catch(() => {});

    setMigrationInProgress(true);
    const previousNotesDirectory = settings.notesDirectory;
    if (!(await persistNotesDirectorySetting(""))) {
      setMigrationInProgress(false);
      await message(t("settings.notesDirectory.settingsFailed", locale), { kind: "error" });
      return;
    }

    resetNotesDir(reconcileStateRef.current);
    const defaultDir = await getNotesDir();

    let result;
    try {
      result = await migrateNotesDir(oldDir, defaultDir, "overwrite");
    } catch (err) {
      await revertNotesDirChange(oldDir, previousNotesDirectory);
      throw err;
    }

    if (!result.success) {
      await revertNotesDirChange(oldDir, previousNotesDirectory);
      await message(t("settings.notesDirectory.migrationFailed", locale), { kind: "error" });
      return;
    }

    setCurrentNotesDir(defaultDir);
    setReloadKey((k) => k + 1);
    // Reload owns releasing migrationInProgress.
  }, [locale, persistNotesDirectorySetting, revertNotesDirChange, settings.notesDirectory]);

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


  useEffect(() => {
    if (!docSearchOpen && tiptapEditor) {
      const { tr } = tiptapEditor.state;
      tr.setMeta(searchPluginKey, { query: "", activeIndex: 0, matches: [] } satisfies SearchPluginState);
      tiptapEditor.view.dispatch(tr);
    }
  }, [docSearchOpen, tiptapEditor]);

  useEffect(() => {
    setDocSearchOpen(false);
    setDocSearchReplace(false);
    setDocGoToLineOpen(false);
  }, [activeDoc?.id]);

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
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        state.setIsDirty(true);
      }
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
            ref={sidebarSlotRef}
            className={mergeClasses(
              styles.sidebarSlot,
              !sidebarResizing && styles.sidebarSlotAnimated,
              sidebarOpen && styles.sidebarSlotOpen,
            )}
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
              onSetNotesPinned={fs.setNotesPinned}
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
              updateAvailable={updater.state.status === "available" || updater.state.status === "downloading" || updater.state.status === "ready"}
              isDarkMode={isDarkMode}
              colorFilter={settings.colorFilter}
              onClearColorFilter={() => { void updateSetting("colorFilter", null); }}
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
                const startW = sidebarWidthRef.current;
                const slotEl = sidebarSlotRef.current;
                const onMove = (ev: MouseEvent) => {
                  const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
                  sidebarWidthRef.current = w;
                  // Imperative CSS-variable write — no React re-render path, so
                  // the sidebar follows the cursor at native refresh rate while
                  // the heavy effects (localStorage save, Tauri setMinSize +
                  // auto-expand) stay off until mouseup.
                  slotEl?.style.setProperty("--shell-sidebar-width", `${w}px`);
                };
                const onUp = () => {
                  setSidebarResizing(false);
                  setSidebarWidth(sidebarWidthRef.current);
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
          <div
            style={{
              fontSize: "12px",
              color: tokens.colorNeutralForeground3,
              marginTop: "10px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              userSelect: "none",
            }}
          >
            {notesDirConflict?.path}
          </div>
          <div style={{ display: "grid", gap: "8px", marginTop: "22px" }}>
            <Tooltip
              content={t("settings.notesDirectory.replaceWithCurrentHelp", locale)}
              relationship="description"
              positioning="above"
              appearance={isDarkMode ? "inverted" : undefined}
            >
              <Button
                size="medium"
                appearance="subtle"
                onClick={() => resolveNotesDirConflictChoice("replace-with-current")}
                style={{ justifyContent: "flex-start", color: tokens.colorPaletteRedForeground1 }}
              >
                {t("dialog.replaceWithCurrent", locale)}
              </Button>
            </Tooltip>
            <Tooltip
              content={t("settings.notesDirectory.useSelectedOnlyHelp", locale)}
              relationship="description"
              positioning="above"
              appearance={isDarkMode ? "inverted" : undefined}
            >
              <Button
                size="medium"
                appearance="subtle"
                onClick={() => resolveNotesDirConflictChoice("use-selected-only")}
                style={{ justifyContent: "flex-start", color: tokens.colorPaletteRedForeground1 }}
              >
                {t("dialog.useSelectedOnly", locale)}
              </Button>
            </Tooltip>
            <Tooltip
              content={t("settings.notesDirectory.mergeHelp", locale)}
              relationship="description"
              positioning="above"
              appearance={isDarkMode ? "inverted" : undefined}
            >
              <Button
                size="medium"
                appearance="subtle"
                className={styles.notesDirMergeButton}
                onClick={() => resolveNotesDirConflictChoice("merge")}
              >
                {t("dialog.merge", locale)}
              </Button>
            </Tooltip>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "6px" }}>
              <Button
                size="medium"
                appearance="subtle"
                onClick={() => resolveNotesDirConflictChoice(null)}
              >
                {t("trash.cancel", locale)}
              </Button>
            </div>
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
        updaterState={updater.state}
        onCheckForUpdate={updater.checkForUpdate}
        onInstallUpdate={updater.installUpdate}
        onRestartApp={updater.restartApp}
      />
      <div id="portal-root" />
    </FluentProvider>
  );
}

export default App;
