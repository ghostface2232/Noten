import { useState, useEffect, useCallback, useRef } from "react";
import {
  FluentProvider,
  webLightTheme,
  webDarkTheme,
  makeStyles,
  mergeClasses,
  tokens,
  Button,
} from "@fluentui/react-components";
import { PanelLeftRegular, PanelLeftFilled } from "@fluentui/react-icons";
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";
import { useMarkdownState } from "./hooks/useMarkdownState";
import { useFileSystem } from "./hooks/useFileSystem";
import { saveManifest, sortNotes, useNotesLoader } from "./hooks/useNotesLoader";
import { useAutoSave } from "./hooks/useAutoSave";
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
import "./App.css";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    color: tokens.colorNeutralForeground1,
    position: "relative",
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
    width: 0,
    flexShrink: 0,
    overflow: "hidden",
    transitionProperty: "width",
    transitionDuration: "0.3s",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  sidebarSlotOpen: {
    width: "var(--shell-sidebar-width)",
  },
  sidebarToggle: {
    position: "absolute",
    top: "12px",
    left: "8px",
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

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, update: updateSetting, isLoaded: settingsLoaded } = useSettings();
  const isDarkMode = settings.themeMode === "dark";
  const locale = settings.locale;
  const state = useMarkdownState();
  const styles = useStyles();
  const tiptapRef = useRef<TiptapEditorHandle>(null);
  const [tiptapEditor, setTiptapEditor] = useState<import("@tiptap/react").Editor | null>(null);
  const startupModeApplied = useRef(false);

  // 노트 로더
  const { docs, setDocs, activeIndex, setActiveIndex, isLoading } = useNotesLoader(
    locale,
    settings.notesSortOrder,
    settingsLoaded,
  );

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

    const activeId = docs[activeIndex]?.id ?? null;
    const sortedDocs = sortNotes(docs, settings.notesSortOrder);
    const changed = sortedDocs.some((doc, index) => doc.id !== docs[index]?.id);
    if (!changed) return;

    setDocs(sortedDocs);
    const nextActiveIndex = activeId
      ? Math.max(sortedDocs.findIndex((doc) => doc.id === activeId), 0)
      : 0;
    setActiveIndex(nextActiveIndex);
    void saveManifest(sortedDocs, activeId).catch(() => {});
  }, [
    activeIndex,
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

  // 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "e") { e.preventDefault(); state.toggleEditing(); }
      if (e.ctrlKey && e.key === "/" && state.isEditing) { e.preventDefault(); state.switchEditorMode(); }
      if (e.ctrlKey && e.key === "o") { e.preventDefault(); fs.openFile(); }
      if (e.ctrlKey && !e.shiftKey && e.key === "s") { e.preventDefault(); fs.saveFile(); }
      if (e.ctrlKey && e.shiftKey && e.key === "S") { e.preventDefault(); fs.saveFileAs(); }
      if (e.ctrlKey && e.key === "n") { e.preventDefault(); fs.newNote(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.toggleEditing, state.switchEditorMode, state.isEditing, fs.openFile, fs.saveFile, fs.saveFileAs, fs.newNote]);

  // 창 닫기 — 자동 저장이므로 별도 확인 없이 닫기 허용

  const handleTiptapDirty = useCallback(
    (dirty: boolean) => state.setTiptapDirty(dirty),
    [state.setTiptapDirty],
  );

  const handleCodemirrorChange = useCallback(
    (value: string) => state.updateMarkdown(value),
    [state.updateMarkdown],
  );

  const showCodeMirror = state.isEditing && state.editorMode === "markdown";
  const activeDoc = docs[activeIndex];

  return (
    <FluentProvider
      theme={isDarkMode ? webDarkTheme : webLightTheme}
      style={{ background: "transparent" }}
      data-theme={isDarkMode ? "dark" : "light"}
    >
      <div className={styles.root}>
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
          documentTitle={activeDoc?.fileName ?? null}
          isDirty={state.isDirty}
          isEditing={state.isEditing}
          locale={locale}
          onToggleEditing={state.toggleEditing}
        />

        <div className={styles.body}>
          <div className={styles.sidebarToggle}>
            <Button
              appearance="subtle"
              icon={sidebarOpen ? <PanelLeftFilled /> : <PanelLeftRegular />}
              className={styles.sidebarToggleBtn}
              onClick={() => setSidebarOpen((o) => !o)}
            />
          </div>

          <div className={mergeClasses(
            styles.sidebarSlot,
            sidebarOpen && styles.sidebarSlotOpen,
          )}>
            <Sidebar
              docs={docs}
              activeIndex={activeIndex}
              onSwitchDocument={fs.switchDocument}
              onNewNote={fs.newNote}
              locale={locale}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>

          <div className={styles.floatingCard}>
            <EditorToolbar
              editorMode={state.editorMode}
              onSwitchMode={state.switchEditorMode}
              editor={tiptapEditor}
              sidebarOpen={sidebarOpen}
              visible={state.isEditing}
              locale={locale}
            />

            <div className={styles.content}>
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
      />
    </FluentProvider>
  );
}

export default App;
