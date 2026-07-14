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
import { saveManifest, sortNotes, useNotesLoader, getNotesDir, getDefaultNotesDir, setNotesDir, resetNotesDir, setMigrationInProgress } from "./hooks/useNotesLoader";
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
import { OutlinePanel } from "./components/OutlinePanel";
import { StatusBar } from "./components/StatusBar";
import { clampOutlinePos, OUTLINE_PANEL_WIDTH } from "./utils/outline";
import { animateScrollTop } from "./utils/scrollAnimation";

// Outline jump scroll animation — short and snappy, and the chrome lock that
// suppresses toolbar reaction during the jump must outlast it.
const OUTLINE_JUMP_SCROLL_MS = 280;
// How long a transient editor notice (focus-mode toggle, broken anchor link)
// stays on screen.
const EDITOR_NOTICE_MS = 1100;
import { SettingsModal } from "./components/SettingsModal";
import { SearchBar } from "./components/SearchBar";
import { GoToLineBar } from "./components/GoToLineBar";
import { searchPluginKey, type SearchPluginState } from "./extensions/SearchHighlight";
import { refreshWikiLinkDecorations } from "./extensions/WikiLink";
import { t } from "./i18n";
import { exportAsMarkdown, exportAsPdf } from "./utils/exportHandlers";
import { clearManagedNotesData, clearMigratedSource, hasExistingNotenData, migrateNotesDir } from "./utils/migrateNotesDir";
import { writeMigrationJournal, type MigrationCleanupMode } from "./utils/migrationJournal";
import { recoverPendingMigration } from "./utils/migrationCleanup";
import { colorHex } from "./utils/noteColors";
import { clampMenuToViewport } from "./utils/clampMenuPosition";
import { clearRenderableImageSourceCache } from "./utils/imageAssetUtils";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { createReconcileState } from "./utils/reconcileFolder";
import { useWindowSync } from "./hooks/useWindowSync";
import { useMigrationSync, broadcastMigrationStarted, broadcastMigrationFinished } from "./hooks/useMigrationSync";
import { useChromeVisibility } from "./hooks/useChromeVisibility";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useFocusOutlineSync } from "./hooks/useFocusOutlineSync";
import { useDragDrop } from "./hooks/useDragDrop";
import { useUpdater } from "./hooks/useUpdater";
import { MOTION_FAST_MS } from "./styles/interactions";
import {
  getSystemPrefersDarkFromMatchMedia,
  queryWindowsSystemPrefersDark,
  SYSTEM_DARK_QUERY,
  SYSTEM_THEME_POLL_MS,
  themeToPrefersDark,
} from "./utils/systemTheme";
import { open as openDialog, confirm, message } from "@tauri-apps/plugin-dialog";
import { useStyles } from "./App.styles";
import "./App.css";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;
// Enough logical width for the wrapped toolbar and sidebar toggle.
const EDITOR_MIN_WIDTH = 600;
const WINDOW_MIN_HEIGHT = 620;
type FloatingEditorControl = "search" | "goto" | null;

type NotesDirConflictChoice = "replace-with-current" | "use-selected-only" | "merge" | null;

interface NotesDirConflictDialogState {
  path: string;
  resolve: (choice: NotesDirConflictChoice) => void;
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("sidebar-open") === "true"; } catch { return false; }
  });
  const [sidebarTopActionsVisible, setSidebarTopActionsVisible] = useState(false);
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
  useEffect(() => {
    if (!sidebarOpen) {
      setSidebarTopActionsVisible(false);
      return;
    }
    setSidebarTopActionsVisible(false);
    const frame = requestAnimationFrame(() => setSidebarTopActionsVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [sidebarOpen]);
  const { settings, update: updateSetting, applyExternal: applySettingExternal, isLoaded: settingsLoaded } = useSettings();
  // Latest desired min window width (editor + open side panels), read by the
  // resize listener after the window is restored from a maximized state.
  const minWidthRef = useRef(EDITOR_MIN_WIDTH);
  // Tracks the in-flight sizing animation so a newer invocation cancels it.
  const sizingRunRef = useRef<{ cancelled: boolean } | null>(null);
  // Apply the window min-size for the current side-panel state (sidebar and
  // outline panel) and, if the window is narrower than that minimum, animate
  // it wider. No-op while maximized or fullscreen, where mutating size/min-size
  // would pop the window back to windowed mode (the panels reflow via CSS
  // inside the existing window).
  const ensureWindowFitsPanels = useCallback(async (minWidth: number) => {
    if (sizingRunRef.current) sizingRunRef.current.cancelled = true;
    const run = { cancelled: false };
    sizingRunRef.current = run;
    try {
      const win = getCurrentWindow();
      const [maximized, fullscreen] = await Promise.all([
        win.isMaximized().catch(() => false),
        win.isFullscreen().catch(() => false),
      ]);
      if (run.cancelled || maximized || fullscreen) return;
      await win.setMinSize(new LogicalSize(minWidth, WINDOW_MIN_HEIGHT));
      if (run.cancelled) return;
      const scale = await win.scaleFactor();
      const size = await win.innerSize();
      const currentLogicalW = size.width / scale;
      const currentLogicalH = size.height / scale;
      if (currentLogicalW >= minWidth - 1) return;

      const pos = await win.outerPosition();
      if (run.cancelled) return;
      const fromX = pos.x / scale;
      const fromW = currentLogicalW;
      const toW = minWidth;
      const toX = fromX;

      const DURATION = 280;
      const startTime = performance.now();
      let lastW = fromW;
      const tick = () => {
        if (run.cancelled) return;
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
  }, []);

  useEffect(() => {
    const effectiveSidebar = sidebarOpen ? sidebarWidth : 0;
    // The outline panel occupies a fixed-width slot beside the editor, so an
    // open panel eats into the editor's minimum just like the sidebar does.
    const effectiveOutline = settings.outlinePanelOpen ? OUTLINE_PANEL_WIDTH : 0;
    const minWidth = EDITOR_MIN_WIDTH + effectiveSidebar + effectiveOutline;
    minWidthRef.current = minWidth;
    void ensureWindowFitsPanels(minWidth);
    return () => { if (sizingRunRef.current) sizingRunRef.current.cancelled = true; };
  }, [sidebarOpen, sidebarWidth, settings.outlinePanelOpen, ensureWindowFitsPanels]);

  // When the window is restored from maximized (or fullscreen) we deferred the
  // min-size update, so re-apply it now and grow the restored window to fit
  // the open side panels. Detect the transition by watching resize events.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let prevMaximized = false;
    const win = getCurrentWindow();
    win.isMaximized().then((m) => { prevMaximized = m; }).catch(() => {});
    win
      .onResized(() => {
        void (async () => {
          const maximized = await win.isMaximized().catch(() => false);
          const wasMaximized = prevMaximized;
          prevMaximized = maximized;
          if (wasMaximized && !maximized) {
            void ensureWindowFitsPanels(minWidthRef.current);
          }
        })();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [ensureWindowFitsPanels]);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [docSearchReplace, setDocSearchReplace] = useState(false);
  const [docGoToLineOpen, setDocGoToLineOpen] = useState(false);
  const activeFloatingEditorControl: FloatingEditorControl = docSearchOpen ? "search" : docGoToLineOpen ? "goto" : null;
  const [renderedFloatingEditorControl, setRenderedFloatingEditorControl] = useState<FloatingEditorControl>(null);
  const [floatingEditorControlExiting, setFloatingEditorControlExiting] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [notesDirConflict, setNotesDirConflict] = useState<NotesDirConflictDialogState | null>(null);
  const updater = useUpdater();
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDarkFromMatchMedia);
  const isDarkMode = settings.themeMode === "system"
    ? systemPrefersDark
    : settings.themeMode === "dark";
  const locale = settings.locale;
  const state = useMarkdownState();
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
    if (settings.themeMode !== "system") return;

    const win = getCurrentWindow();
    let disposed = false;
    let themeUnlisten: (() => void) | undefined;
    let refreshInFlight = false;
    let refreshAgain = false;

    const applyPrefersDark = (prefersDark: boolean | null) => {
      if (disposed || prefersDark == null) return;
      setSystemPrefersDark((current) => (current === prefersDark ? current : prefersDark));
    };

    const refreshSystemTheme = () => {
      if (refreshInFlight) {
        refreshAgain = true;
        return;
      }
      refreshInFlight = true;
      void (async () => {
        try {
          const windowsPrefersDark = await queryWindowsSystemPrefersDark();
          applyPrefersDark(windowsPrefersDark ?? getSystemPrefersDarkFromMatchMedia());
        } finally {
          refreshInFlight = false;
          if (!disposed && refreshAgain) {
            refreshAgain = false;
            refreshSystemTheme();
          }
        }
      })();
    };

    refreshSystemTheme();
    win
      .onThemeChanged(({ payload }) => {
        applyPrefersDark(themeToPrefersDark(payload));
        refreshSystemTheme();
      })
      .then((fn) => {
        if (disposed) fn();
        else themeUnlisten = fn;
      })
      .catch(() => {});

    const onFocus = () => refreshSystemTheme();
    const onVisibilityChange = () => {
      if (!document.hidden) refreshSystemTheme();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    const poll = window.setInterval(refreshSystemTheme, SYSTEM_THEME_POLL_MS);
    let media: MediaQueryList | null = null;
    const syncMedia = () => applyPrefersDark(getSystemPrefersDarkFromMatchMedia());
    if (typeof window.matchMedia === "function") {
      media = window.matchMedia(SYSTEM_DARK_QUERY);
      media.addEventListener("change", syncMedia);
    }

    return () => {
      disposed = true;
      themeUnlisten?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(poll);
      media?.removeEventListener("change", syncMedia);
    };
  }, [settings.themeMode]);

  useEffect(() => {
    if (activeFloatingEditorControl) {
      setRenderedFloatingEditorControl(activeFloatingEditorControl);
      setFloatingEditorControlExiting(false);
      return;
    }

    if (!renderedFloatingEditorControl) {
      return;
    }

    setFloatingEditorControlExiting(true);
    const timeout = window.setTimeout(() => {
      setRenderedFloatingEditorControl(null);
      setFloatingEditorControlExiting(false);
    }, MOTION_FAST_MS);
    return () => window.clearTimeout(timeout);
  }, [activeFloatingEditorControl, renderedFloatingEditorControl]);

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
      clearRenderableImageSourceCache();
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

  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  // Fresh-locale ref for effects/handlers registered once (empty deps) that
  // still need to localize a late message — e.g. the close-blocked dialog.
  const localeRef = useRef(locale);
  localeRef.current = locale;
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
  const hasUnsavedChangesRef = useRef<(() => boolean) | null>(null);
  const flushManifestRef = useRef<(() => Promise<boolean>) | null>(null);
  const captureAndQueueSaveRef = useRef<(() => void) | null>(null);
  const awaitInFlightSavesRef = useRef<(() => Promise<void>) | null>(null);
  const flushDocSaveRef = useRef<((docId: string) => Promise<boolean>) | null>(null);
  const flushPendingSnapshotsRef = useRef<(() => Promise<void>) | null>(null);
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
    captureAndQueueSaveRef,
    flushDocSaveRef,
  );

  const { scheduleAutoSave, flushAutoSave, hasUnsavedChanges, captureAndQueueSave, awaitInFlightSaves, flushDocSave, flushPendingSnapshots, notifyActiveDoc, cancelDocSave } = useAutoSave(
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
  hasUnsavedChangesRef.current = hasUnsavedChanges;
  flushManifestRef.current = () => saveManifest(
    docsRef.current,
    docsRef.current[activeIndexRef.current]?.id ?? null,
    groupsRef.current,
  ).then(() => true).catch(() => false);
  captureAndQueueSaveRef.current = captureAndQueueSave;
  awaitInFlightSavesRef.current = awaitInFlightSaves;
  flushDocSaveRef.current = flushDocSave;
  flushPendingSnapshotsRef.current = flushPendingSnapshots;
  notifyActiveDocRef.current = notifyActiveDoc;
  cancelDocSaveRef.current = cancelDocSave;

  // Cross-window migration coordination: when another window migrates the
  // notes directory, flush+block our saves, then follow it to the new dir.
  useMigrationSync({
    flushAutoSaveRef,
    hasUnsavedChangesRef,
    flushManifestRef,
    awaitInFlightSavesRef,
    flushPendingSnapshotsRef,
    reconcileState: reconcileStateRef.current,
    setReloadKey,
    setCurrentNotesDir,
    applyExternalSettingsChange: applySettingExternal,
  });

  // Finish any migration whose old dir was retained for deferred cleanup (a
  // previous session quit before every window left the old dir). Runs once the
  // initial load settled, and only acts when this is the sole window.
  const migrationRecoveryDone = useRef(false);
  useEffect(() => {
    if (migrationRecoveryDone.current || isLoading) return;
    migrationRecoveryDone.current = true;
    void recoverPendingMigration();
  }, [isLoading]);

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
    storage.activeNoteId = docs[activeIndex]?.id ?? null;
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
  }, [tiptapEditor, docs, activeIndex, locale, groups, noteGroups.toggleGroupCollapsed, fs.switchDocument, fs.createNoteWithTitle, wikiDocIndexSignature]);

  // Most upstream mutations (autosave, rename, pin, color, etc.) already sort
  // via sortAndPersistDocs / doSave. But several setDocs sites outside the
  // hook layer DO NOT sort: useFileWatcher.applyMetaChange / runReconcile /
  // body-change setDocs, useWindowSync's doc-updated / note-color-updated.
  // Without this effect the sidebar visibly drifts out of order whenever
  // those paths fire (remote rename, remote color change, etc.).
  //
  // Cheap gate: hash only the fields the comparator looks at. Pure-content
  // edits (most autosave commits) keep the same signature and skip the
  // O(N log N) sort entirely; field changes that could move a row recompute.
  const lastSortSignatureRef = useRef<string>("");
  useEffect(() => {
    if (!settingsLoaded || docs.length < 2) return;

    let sig = `${settings.notesSortOrder}|${locale}|`;
    for (const d of docs) {
      sig += `${d.id}|${d.fileName}|${d.updatedAt}|${d.createdAt}|${d.pinned ? 1 : 0}`;
    }
    if (sig === lastSortSignatureRef.current) return;
    lastSortSignatureRef.current = sig;

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
    locale,
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
  const editorDirtySessionRef = useRef<{ docId: string | null; dirty: boolean }>({
    docId: null,
    dirty: false,
  });
  useEffect(() => {
    editorDirtySessionRef.current = { docId: activeDoc?.id ?? null, dirty: false };
  }, [activeDoc?.id]);
  useEffect(() => {
    if (!state.isDirty) {
      editorDirtySessionRef.current = { docId: activeDoc?.id ?? null, dirty: false };
    }
  }, [activeDoc?.id, state.isDirty]);

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

  // Undo toast for note deletion: no confirm dialog (deleting stays one
  // keypress), but every delete offers a one-click restore from .trash for a
  // few seconds. Rendered by the Sidebar just above its settings button.
  const [deleteUndoToast, setDeleteUndoToast] = useState<{ ids: string[]; key: number } | null>(null);
  const deleteUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showDeleteUndoToast = useCallback((deletedIds: string[]) => {
    if (deletedIds.length === 0) return;
    if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);
    setDeleteUndoToast({ ids: deletedIds, key: Date.now() });
    deleteUndoTimerRef.current = setTimeout(() => {
      deleteUndoTimerRef.current = null;
      setDeleteUndoToast(null);
    }, 6000);
  }, []);
  const dismissDeleteUndoToast = useCallback(() => {
    if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);
    deleteUndoTimerRef.current = null;
    setDeleteUndoToast(null);
  }, []);
  // Hovering the toast pauses auto-dismiss; leaving restarts the full window.
  const pauseDeleteUndoToast = useCallback(() => {
    if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);
    deleteUndoTimerRef.current = null;
  }, []);
  const resumeDeleteUndoToast = useCallback(() => {
    if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);
    deleteUndoTimerRef.current = setTimeout(() => {
      deleteUndoTimerRef.current = null;
      setDeleteUndoToast(null);
    }, 6000);
  }, []);
  useEffect(() => () => {
    if (deleteUndoTimerRef.current) clearTimeout(deleteUndoTimerRef.current);
  }, []);

  const handleUndoDelete = useCallback(async (ids: string[]) => {
    dismissDeleteUndoToast();
    // Sequential: each restore commits the doc list before the next runs, and
    // the last restored note ends up active.
    for (const id of ids) await fs.restoreNote(id);
  }, [dismissDeleteUndoToast, fs.restoreNote]);

  const handleDeleteNote = useCallback((index: number) => {
    void fs.deleteNote(index).then(showDeleteUndoToast);
  }, [fs.deleteNote, showDeleteUndoToast]);

  const handleDeleteNotes = useCallback((noteIds: string[]) => {
    void fs.deleteNotes(noteIds).then(showDeleteUndoToast);
  }, [fs.deleteNotes, showDeleteUndoToast]);

  const getSidebarDocumentContent = useCallback((index: number) => {
    const doc = docs[index];
    if (!doc) return "";
    return index === activeIndex ? state.getCachedMarkdown() : doc.content;
  }, [activeIndex, docs, state]);

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);

  const handleUpdateParagraphSpacing = useCallback((v: ParagraphSpacing) => {
    void updateSetting("paragraphSpacing", v);
  }, [updateSetting]);

  const persistNotesDirectorySetting = useCallback(async (value: string) => {
    let saved = await updateSetting("notesDirectory", value);
    if (!saved) saved = await updateSetting("notesDirectory", value);
    return saved;
  }, [updateSetting]);

  // Unwind the use-selected-only path when clearing the old dir fails after
  // the setting was already persisted: restore the loader's in-memory dir,
  // roll the persisted setting back, and release the autosave guard. The
  // copy-based paths no longer need this — they persist only after success.
  const revertNotesDirChange = useCallback(async (oldDir: string, previousNotesDirectory: string) => {
    clearRenderableImageSourceCache();
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
    await awaitInFlightSavesRef.current?.().catch(() => {});
    await flushPendingSnapshotsRef.current?.().catch(() => {});
    const manifestSaved = await saveManifest(
      docsRef.current,
      docsRef.current[activeIndexRef.current]?.id ?? null,
      groupsRef.current,
    ).then(() => true).catch(() => false);

    // Abort before any destructive step if anything could not be persisted —
    // the copy/clear below would otherwise drop it. hasUnsavedChanges covers
    // the autosave body queue; manifestSaved covers group/pin/color/order
    // metadata, which lives only in the manifest and is not reflected by the
    // body-queue flag.
    if (hasUnsavedChangesRef.current?.() || !manifestSaved) {
      await message(t("settings.notesDirectory.drainFailed", locale), { kind: "error" });
      return;
    }

    setMigrationInProgress(true);
    // Other windows flush and block their saves before any destructive step.
    const { migrationId, outcome } = await broadcastMigrationStarted();
    // Clear the old dir now only when every window confirmed it drained.
    // Otherwise migrate anyway but KEEP the old dir (deferred cleanup): a slow
    // or save-failed window's edits stay safe there and are merged in later,
    // so the user never sees a "close other windows and retry" dead end.
    const sourceRetained = outcome !== "all-drained";
    const cleanupMode: MigrationCleanupMode = action === "use-selected-only" ? "backup-only" : "merge";
    const abortMigration = async (messageKey: Parameters<typeof t>[0] | null) => {
      setMigrationInProgress(false);
      broadcastMigrationFinished(migrationId, false, "");
      if (messageKey) await message(t(messageKey, locale), { kind: "error" });
    };

    if (action !== "use-selected-only") {
      // Copy first, commit the setting only after the copy landed, clear the
      // source only after the commit. A crash at any point leaves either the
      // old dir authoritative or duplicate data — never a partial-only state.
      let result;
      try {
        result = await migrateNotesDir(oldDir, newDir, action === "merge" ? "merge" : "overwrite", { clearSource: false });
      } catch (err) {
        await abortMigration(null);
        throw err;
      }
      if (!result.success) {
        await abortMigration("settings.notesDirectory.migrationFailed");
        return;
      }
      if (!(await persistNotesDirectorySetting(newDir))) {
        // The copied data stays in newDir as a harmless duplicate; the old
        // dir remains authoritative.
        await abortMigration("settings.notesDirectory.settingsFailed");
        return;
      }
      if (sourceRetained) {
        await writeMigrationJournal({ migrationId, oldDir, newDir, cleanupMode, startedAt: Date.now() }).catch(() => {});
      } else {
        await clearMigratedSource(oldDir, newDir).catch(() => {});
      }
    } else {
      // No copy phase: the destination is adopted as-is, so the setting
      // commit comes first and the only destructive step (clearing the old
      // dir) follows it.
      const previousNotesDirectory = settings.notesDirectory;
      if (!(await persistNotesDirectorySetting(newDir))) {
        await abortMigration("settings.notesDirectory.settingsFailed");
        return;
      }
      if (sourceRetained) {
        // Keep the old dir as a backup; it is deleted (no merge) once every
        // window has left it. The user chose to discard the old notes.
        await writeMigrationJournal({ migrationId, oldDir, newDir, cleanupMode: "backup-only", startedAt: Date.now() }).catch(() => {});
      } else {
        const result = await clearManagedNotesData(oldDir, newDir);
        if (!result.success) {
          await revertNotesDirChange(oldDir, previousNotesDirectory);
          broadcastMigrationFinished(migrationId, false, "");
          await message(t("settings.notesDirectory.migrationFailed", locale), { kind: "error" });
          return;
        }
      }
    }

    clearRenderableImageSourceCache();
    setNotesDir(newDir, reconcileStateRef.current);
    setCurrentNotesDir(newDir);
    setReloadKey((k) => k + 1);
    broadcastMigrationFinished(migrationId, true, newDir, sourceRetained);
    // If we turned out to be the only window after all, finish the deferred
    // cleanup now instead of waiting for the next launch.
    if (sourceRetained) void recoverPendingMigration();
    // Reload owns releasing migrationInProgress.
  }, [locale, persistNotesDirectorySetting, requestNotesDirConflictChoice, revertNotesDirChange, settings.notesDirectory]);

  const handleResetNotesDir = useCallback(async () => {
    if (!settings.notesDirectory) return;

    const ok = await confirm(t("settings.notesDirectory.confirmMove", locale));
    if (!ok) return;

    const oldDir = await getNotesDir();

    // Flush before moving paths.
    await flushAutoSaveRef.current?.().catch(() => {});
    await awaitInFlightSavesRef.current?.().catch(() => {});
    await flushPendingSnapshotsRef.current?.().catch(() => {});
    const manifestSaved = await saveManifest(
      docsRef.current,
      docsRef.current[activeIndexRef.current]?.id ?? null,
      groupsRef.current,
    ).then(() => true).catch(() => false);

    // Abort before any destructive step if anything could not be persisted —
    // the copy/clear below would otherwise drop it. hasUnsavedChanges covers
    // the autosave body queue; manifestSaved covers group/pin/color/order
    // metadata, which lives only in the manifest and is not reflected by the
    // body-queue flag.
    if (hasUnsavedChangesRef.current?.() || !manifestSaved) {
      await message(t("settings.notesDirectory.drainFailed", locale), { kind: "error" });
      return;
    }

    setMigrationInProgress(true);
    // Other windows flush and block their saves before any destructive step.
    const { migrationId, outcome } = await broadcastMigrationStarted();
    const sourceRetained = outcome !== "all-drained";
    const abortMigration = async (messageKey: Parameters<typeof t>[0]) => {
      setMigrationInProgress(false);
      broadcastMigrationFinished(migrationId, false, "");
      await message(t(messageKey, locale), { kind: "error" });
    };

    // Resolve the default dir without mutating the loader cache — the cache
    // must keep pointing at the old dir until the copy lands and the setting
    // commits.
    const defaultDir = await getDefaultNotesDir();

    // Same crash-safe ordering as handleChangeNotesDir: copy → persist →
    // clear source (or defer the clear when not all windows drained).
    let result;
    try {
      result = await migrateNotesDir(oldDir, defaultDir, "overwrite", { clearSource: false });
    } catch (err) {
      setMigrationInProgress(false);
      broadcastMigrationFinished(migrationId, false, "");
      throw err;
    }
    if (!result.success) {
      await abortMigration("settings.notesDirectory.migrationFailed");
      return;
    }

    if (!(await persistNotesDirectorySetting(""))) {
      await abortMigration("settings.notesDirectory.settingsFailed");
      return;
    }

    clearRenderableImageSourceCache();
    resetNotesDir(reconcileStateRef.current);
    if (sourceRetained) {
      // Journal the resolved default dir so a later cleanup knows where to
      // merge the retained old-dir writes into.
      await writeMigrationJournal({ migrationId, oldDir, newDir: defaultDir, cleanupMode: "merge", startedAt: Date.now() }).catch(() => {});
    } else {
      await clearMigratedSource(oldDir, defaultDir).catch(() => {});
    }

    setCurrentNotesDir(defaultDir);
    setReloadKey((k) => k + 1);
    broadcastMigrationFinished(migrationId, true, "", sourceRetained);
    if (sourceRetained) void recoverPendingMigration();
    // Reload owns releasing migrationInProgress.
  }, [locale, persistNotesDirectorySetting, settings.notesDirectory]);

  const {
    chromeVisible,
    toolbarHeight,
    editorTopOffset,
    handleShowEditorChrome,
    lockEditorChrome,
    unlockEditorChrome,
    handleBarHeight,
  } = useChromeVisibility(contentRef, activeDoc?.id, settings.pinEditorToolbar);

  // v0.3.0 editor-mode toggles. Focus mode and the outline panel are coupled
  // (focus mode closes the outline and restores it on exit, the toggle is
  // inert mid-focus) — useFocusOutlineSync owns that coupling.
  const { outlinePanelOpen, focusModeEnabled } = settings;
  const handleToggleOutline = useFocusOutlineSync({
    settingsLoaded,
    focusModeEnabled,
    outlinePanelOpen,
    outlineOpenBeforeFocus: settings.outlineOpenBeforeFocus,
    updateSetting,
  });

  // Transient editor notice (focus-mode toggle, broken anchor link). The
  // aria-live region stays mounted (visibility travels via opacity) so screen
  // readers announce the text change without a DOM insertion.
  const [editorNoticeText, setEditorNoticeText] = useState("");
  const [editorNoticeVisible, setEditorNoticeVisible] = useState(false);
  const editorNoticeTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (editorNoticeTimerRef.current !== null) {
      window.clearTimeout(editorNoticeTimerRef.current);
    }
  }, []);

  const showEditorNotice = useCallback((text: string) => {
    setEditorNoticeText(text);
    setEditorNoticeVisible(true);
    if (editorNoticeTimerRef.current !== null) {
      window.clearTimeout(editorNoticeTimerRef.current);
    }
    editorNoticeTimerRef.current = window.setTimeout(() => {
      setEditorNoticeVisible(false);
      editorNoticeTimerRef.current = null;
    }, EDITOR_NOTICE_MS);
  }, []);

  const handleToggleFocusMode = useCallback(() => {
    const next = !focusModeEnabled;
    void updateSetting("focusModeEnabled", next);
    showEditorNotice(t(next ? "focus.modeOn" : "focus.modeOff", locale));
  }, [updateSetting, focusModeEnabled, locale, showEditorNotice]);

  const handleCloseOutline = useCallback(() => {
    void updateSetting("outlinePanelOpen", false);
  }, [updateSetting]);

  // Outline jump: place the clicked heading near the top of the scroll
  // container instead of wherever scrollIntoView happens to leave it.
  const outlineScrollCancelRef = useRef<(() => void) | null>(null);
  const handleOutlineJump = useCallback((pos: number) => {
    const editor = tiptapRef.current?.getEditor();
    const container = contentRef.current;
    if (!editor || !container) return;
    // Freeze the toolbar/status bar in their current state for the whole
    // animation (plus a margin for the trailing rAF-coalesced scroll
    // evaluation) — an outline jump must not flash the chrome in or out.
    lockEditorChrome(OUTLINE_JUMP_SCROLL_MS + 120);
    // A click can race the outline's rAF-coalesced recompute by a frame, so
    // the stored pos may be stale — clamp instead of throwing.
    const target = clampOutlinePos(pos + 1, editor.state.doc.content.size);
    editor.chain().setTextSelection(target).focus(null, { scrollIntoView: false }).run();
    const coords = editor.view.coordsAtPos(target);
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = Math.max(
      0,
      coords.top - containerTop + container.scrollTop - (editorTopOffset + 16),
    );
    outlineScrollCancelRef.current?.();
    outlineScrollCancelRef.current = animateScrollTop(container, targetTop, OUTLINE_JUMP_SCROLL_MS, {
      // The user took over mid-jump — drop the lock so scroll-driven chrome
      // behavior resumes immediately.
      onUserCancel: unlockEditorChrome,
    });
  }, [lockEditorChrome, unlockEditorChrome, editorTopOffset]);

  // Anchor-link ("#fragment") clicks share the outline jump path; a link whose
  // target heading no longer exists surfaces the transient notice instead.
  useEffect(() => {
    if (!tiptapEditor?.storage.anchorLink) return;
    tiptapEditor.storage.anchorLink.onJump = handleOutlineJump;
    tiptapEditor.storage.anchorLink.onMissing = () => {
      showEditorNotice(t("link.anchorMissing", locale));
    };
  }, [tiptapEditor, handleOutlineJump, showEditorNotice, locale]);

  useKeyboardShortcuts({
    tiptapRef,
    docSearchOpen,
    docGoToLineOpen,
    setDocSearchOpen,
    setDocSearchReplace,
    setDocGoToLineOpen,
    onNewNote: fs.newNote,
    onImportFile: fs.importFile,
    onToggleOutline: handleToggleOutline,
    onToggleFocusMode: handleToggleFocusMode,
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
    getCurrentWindow().onCloseRequested(async (event) => {
      // Four-step drain: (1) flushAutoSave commits the current doc's pending
      // edits, (2) awaitInFlightSaves waits for any background save queued by
      // switchDocument's fast path, (3) flushPendingSnapshots retries any
      // snapshot whose background save failed and is otherwise orphaned in
      // pendingSnapshotsRef — without step (3), a transient backup/write
      // failure for a previously-active doc would silently lose data — and
      // (4) flushManifest drains the per-window persist queue. Body autosave
      // tracking does NOT cover metadata-only writes (pin/color/group/rename
      // enqueue saveManifest fire-and-forget); when the body is clean, nothing
      // else awaits them, so a close right after a metadata change could quit
      // before they land. flushManifest enqueues a current full-state write at
      // the tail of the serialized chain, so awaiting it also drains every
      // earlier queued write.
      await flushAutoSaveRef.current?.();
      await awaitInFlightSavesRef.current?.();
      await flushPendingSnapshotsRef.current?.();
      const manifestOk = (await flushManifestRef.current?.()) ?? true;
      // If the drain could not persist everything (a backup/write error the
      // retry above also hit, or a manifest/groups write that kept failing),
      // keep the window open instead of silently dropping the edits.
      // onCloseRequested awaits this handler, so preventDefault still cancels
      // the close.
      if (hasUnsavedChangesRef.current?.() || !manifestOk) {
        event.preventDefault();
        await message(t("close.unsavedBlocked", localeRef.current), { kind: "error" });
      }
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    // Complementary autosave flush triggers. onCloseRequested is the primary
    // guarantee, but alt-tabbing away or minimizing mid-type can strand the
    // last debounce window unsaved until the window is closed. Flushing when
    // the window loses focus or the page is hidden closes that gap.
    // flushAutoSave is a cheap no-op when nothing is pending.
    const flush = () => { void flushAutoSaveRef.current?.(); };
    const onVisibility = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", onVisibility);

    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => { if (!focused) flush(); })
      .then((fn) => { unlisten = fn; });

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unlisten?.();
    };
  }, []);

  const handleTiptapDirty = useCallback(
    (dirty: boolean) => {
      if (!dirty) return;
      const ai = activeIndexRef.current;
      const active = docsRef.current[ai];
      if (
        active
        && (
          editorDirtySessionRef.current.docId !== active.id
          || !editorDirtySessionRef.current.dirty
        )
      ) {
        editorDirtySessionRef.current = { docId: active.id, dirty: true };
        state.setIsDirty(true);
        setDocs((prev) => {
          if (ai < 0 || ai >= prev.length) return prev;
          const current = prev[ai];
          if (current.isDirty) return prev;
          const next = prev.slice();
          next[ai] = { ...current, isDirty: true };
          return next;
        });
      }
      scheduleAutoSave();
    },
    [state, scheduleAutoSave, setDocs],
  );

  useDragDrop({
    tiptapRef,
    docReady,
    importFiles: fs.importFiles,
    setIsDirty: state.setIsDirty,
    scheduleAutoSave,
  });

  // Focus mode pins the chrome hidden regardless of scroll direction — a
  // toolbar that pops in and out contradicts the whole point of the mode.
  // Leaving it falls back to the usual pinEditorToolbar-driven behavior.
  const hideEditorChrome = focusModeEnabled || !chromeVisible;
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
              icon={
                <span className={styles.iconCrossfade} aria-hidden="true">
                  <span className={mergeClasses(styles.iconCrossfadeLayer, !sidebarOpen && styles.iconCrossfadeLayerVisible)}>
                    <PanelLeftRegular />
                  </span>
                  <span className={mergeClasses(styles.iconCrossfadeLayer, sidebarOpen && styles.iconCrossfadeLayerVisible)}>
                    <PanelLeftFilled />
                  </span>
                </span>
              }
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
                    className={mergeClasses(
                      styles.sidebarSelectBtn,
                      styles.sidebarTopActionBtn,
                      sidebarTopActionsVisible && styles.sidebarTopActionBtnVisible,
                    )}
                    onClick={() => setSelectMode((o) => !o)}
                    style={selectMode ? { backgroundColor: "var(--ui-active-bg)" } : undefined}
                  />
                </Tooltip>
                <Tooltip content={t("sidebar.filter", locale)} relationship="label" positioning="below" appearance={isDarkMode ? "inverted" : undefined}>
                  <Button
                    appearance="subtle"
                    icon={<span style={{ display: "flex", color: colorHex(settings.colorFilter) }}><FilterRegular /></span>}
                    className={mergeClasses(
                      styles.sidebarFilterBtn,
                      styles.sidebarTopActionBtn,
                      sidebarTopActionsVisible && styles.sidebarTopActionBtnVisible,
                    )}
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
                    className={mergeClasses(
                      styles.sidebarNewGroupBtn,
                      styles.sidebarTopActionBtn,
                      sidebarTopActionsVisible && styles.sidebarTopActionBtnVisible,
                    )}
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
                    className={mergeClasses(
                      styles.sidebarSearchBtn,
                      styles.sidebarTopActionBtn,
                      sidebarTopActionsVisible && styles.sidebarTopActionBtnVisible,
                    )}
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
              onDeleteNote={handleDeleteNote}

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
              deleteUndoToast={deleteUndoToast}
              onUndoDelete={handleUndoDelete}
              onDismissDeleteUndoToast={dismissDeleteUndoToast}
              onDeleteUndoToastHoverStart={pauseDeleteUndoToast}
              onDeleteUndoToastHoverEnd={resumeDeleteUndoToast}
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
            <div className={styles.editorRow}>
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
                  outlineOpen={settings.outlinePanelOpen}
                  onToggleOutline={handleToggleOutline}
                />
              </div>
              {renderedFloatingEditorControl && (
                <div
                  className={mergeClasses(
                    styles.searchBarAnchor,
                    floatingEditorControlExiting && styles.searchBarAnchorExiting,
                  )}
                  style={!hideToolbar && toolbarHeight > 0 ? { top: `${toolbarHeight}px` } : undefined}
                >
                  {renderedFloatingEditorControl === "search" ? (
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
                  focusMode={focusModeEnabled}
                  onDirtyChange={handleTiptapDirty}
                  onReady={syncEditorRef}
                  onChromeActivate={docReady ? handleShowEditorChrome : undefined}
                />
              </div>
            </div>

            <div
              className={mergeClasses(
                styles.outlineSlot,
                !settings.outlinePanelOpen && styles.outlineSlotClosed,
              )}
              aria-hidden={!settings.outlinePanelOpen}
            >
              <OutlinePanel
                editor={noteEditor}
                locale={locale}
                open={settings.outlinePanelOpen}
                docKey={activeDoc?.id ?? null}
                onClose={handleCloseOutline}
                onNavigate={handleOutlineJump}
              />
            </div>
            </div>

            <StatusBar
              editor={noteEditor}
              hidden={hideStatusBar}
              locale={locale}
            />

            <div
              className={mergeClasses(
                styles.editorNotice,
                editorNoticeVisible && styles.editorNoticeVisible,
              )}
              aria-live="polite"
            >
              {editorNoticeText}
            </div>
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
