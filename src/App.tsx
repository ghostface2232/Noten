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
import { useFileSystem, type OpenDocument } from "./hooks/useFileSystem";
import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "./components/TiptapEditor";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { MarkdownEditor } from "./components/MarkdownEditor";
import { EditorToolbar } from "./components/EditorToolbar";
import { StatusBar } from "./components/StatusBar";
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
  },
  sidebarToggleBtn: {
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
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const state = useMarkdownState();
  const styles = useStyles();
  const tiptapRef = useRef<TiptapEditorHandle>(null);
  const [tiptapEditor, setTiptapEditor] = useState<import("@tiptap/react").Editor | null>(null);

  // 열린 문서 목록 — Untitled 하나로 시작
  const [openDocuments, setOpenDocuments] = useState<OpenDocument[]>([
    { filePath: "", fileName: "Untitled", isDirty: false },
  ]);
  const [activeDocIndex, setActiveDocIndex] = useState(0);

  const fs = useFileSystem(
    state,
    tiptapRef,
    openDocuments,
    setOpenDocuments,
    activeDocIndex,
    setActiveDocIndex,
  );

  // OS Mica 효과
  const [micaSupported, setMicaSupported] = useState(true);
  useEffect(() => {
    getCurrentWindow()
      .setEffects({ effects: [Effect.Mica] })
      .catch(() => setMicaSupported(false));
  }, []);

  // TiptapEditor ref → editorRef 연결 (editor 변경 시만)
  const syncEditorRef = useCallback(() => {
    if (tiptapRef.current) {
      const editor = tiptapRef.current.getEditor();
      state.editorRef.current = editor ?? null;
      if (editor && editor !== tiptapEditor) {
        setTiptapEditor(editor);
      }
    }
  }, [tiptapEditor, state.editorRef]);

  // TiptapEditor가 마운트된 후 1회 + editor 변경 시
  useEffect(syncEditorRef, [syncEditorRef]);

  // isDirty → openDocuments 동기화
  useEffect(() => {
    setOpenDocuments((docs) => {
      if (activeDocIndex < 0 || activeDocIndex >= docs.length) return docs;
      const current = docs[activeDocIndex];
      if (current.isDirty === state.isDirty) return docs;
      const updated = [...docs];
      updated[activeDocIndex] = { ...current, isDirty: state.isDirty };
      return updated;
    });
  }, [state.isDirty, activeDocIndex]);

  // 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "e") { e.preventDefault(); state.toggleEditing(); }
      if (e.ctrlKey && e.key === "/" && state.isEditing) { e.preventDefault(); state.switchEditorMode(); }
      if (e.ctrlKey && e.key === "o") { e.preventDefault(); fs.openFile(); }
      if (e.ctrlKey && !e.shiftKey && e.key === "s") { e.preventDefault(); fs.saveFile(); }
      if (e.ctrlKey && e.shiftKey && e.key === "S") { e.preventDefault(); fs.saveFileAs(); }
      if (e.ctrlKey && e.key === "n") { e.preventDefault(); fs.newFile(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.toggleEditing, state.switchEditorMode, state.isEditing, fs.openFile, fs.saveFile, fs.saveFileAs, fs.newFile]);

  // 창 닫기 시 isDirty 확인
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (state.isDirty) {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const shouldClose = await confirm(
          "저장되지 않은 변경사항이 있습니다. 정말 닫으시겠습니까?",
          { title: "Markdown Studio", kind: "warning", okLabel: "닫기", cancelLabel: "취소" },
        );
        if (!shouldClose) event.preventDefault();
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [state.isDirty]);

  const handleTiptapDirty = useCallback(
    (dirty: boolean) => state.setTiptapDirty(dirty),
    [state.setTiptapDirty],
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
      <div className={styles.root}>
        <div
          className={mergeClasses(
            styles.micaOverlay,
            (isDarkMode || !micaSupported) && styles.micaOverlayActive,
          )}
          style={{
            background: isDarkMode
              ? micaSupported
                ? "rgba(0, 0, 0, 0.75)"  // Mica 위 반투명 다크 오버레이
                : "#2a2a28"               // Mica 미지원 fallback
              : micaSupported
                ? "transparent"
                : "#f0ece4",              // 라이트 fallback
          }}
        />

        <TitleBar
          filePath={state.filePath}
          isDirty={state.isDirty}
          isEditing={state.isEditing}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode((d) => !d)}
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
              openDocuments={openDocuments}
              activeDocIndex={activeDocIndex}
              onSwitchDocument={fs.switchDocument}
            />
          </div>

          <div className={styles.floatingCard}>
            <EditorToolbar
              editorMode={state.editorMode}
              onSwitchMode={state.switchEditorMode}
              editor={tiptapEditor}
              sidebarOpen={sidebarOpen}
              visible={state.isEditing}
            />

            <div className={styles.content}>
              <div className={showCodeMirror ? styles.editorPaneHidden : styles.editorPane}>
                <TiptapEditor
                  ref={tiptapRef}
                  initialMarkdown={state.markdown}
                  editable={state.isEditing && state.editorMode === "richtext"}
                  isDarkMode={isDarkMode}
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
                  />
                </div>
              )}
            </div>

            <StatusBar
              markdown={state.markdown}
              isEditing={state.isEditing}
              editorMode={state.editorMode}
            />
          </div>
        </div>
      </div>
    </FluentProvider>
  );
}

export default App;
