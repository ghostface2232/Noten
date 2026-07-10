import { memo, useEffect, useState } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import {
  Dismiss20Regular,
  Square20Regular,
  SquareMultiple20Regular,
  Subtract20Regular,
} from "@fluentui/react-icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pressableButton } from "../styles/interactions";
import { t } from "../i18n";
import type { Locale, ParagraphSpacing } from "../hooks/useSettings";
import type { Editor } from "@tiptap/react";
import { AppMenu } from "./AppMenu";

const appWindow = getCurrentWindow();

const useStyles = makeStyles({
  titleBar: {
    display: "flex",
    alignItems: "center",
    height: "40px",
    paddingLeft: "8px",
    paddingRight: "0",
    backgroundColor: "transparent",
    userSelect: "none",
    position: "relative",
    zIndex: 2,
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
    zIndex: 1,
  },
  dragRegion: {
    flex: 1,
    height: "100%",
  },
  appTitle: {
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: '"Pretendard JP", system-ui, sans-serif',
    color: tokens.colorNeutralForeground1,
    opacity: 1,
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  documentTitle: {
    fontSize: "13px",
    fontWeight: 400,
    fontFamily: '"Pretendard JP", system-ui, sans-serif',
    color: tokens.colorNeutralForeground1,
    opacity: 0.55,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "200px",
  },
  actions: {
    position: "absolute",
    left: "50%",
    top: "calc(50% + 2px)",
    transform: "translate(-50%, -50%)",
    zIndex: 2,
  },
  segmentGroup: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    height: "30px",
    padding: "2px",
    borderRadius: "8px",
    backgroundColor: tokens.colorNeutralBackground3,
    boxShadow: `inset 0 0 0 1px ${tokens.colorNeutralStroke2}`,
  },
  segment: {
    position: "relative",
    border: "none",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    minWidth: "auto",
    paddingLeft: "12px",
    paddingRight: "12px",
    height: "26px",
    color: tokens.colorNeutralForeground2,
    cursor: "pointer",
    backgroundColor: "transparent",
  },
  segmentActive: {
    position: "relative",
    border: "none",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    minWidth: "auto",
    paddingLeft: "12px",
    paddingRight: "12px",
    height: "26px",
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  windowControls: {
    display: "flex",
    alignItems: "center",
    height: "100%",
    marginLeft: "auto",
    zIndex: 3,
  },
  controlBtn: {
    width: "46px",
    minWidth: "46px",
    height: "40px",
    borderRadius: "0",
    border: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0",
    padding: "0",
    lineHeight: 1,
    alignSelf: "stretch",
    ...pressableButton,
  },
  closeBtn: {
    width: "46px",
    minWidth: "46px",
    height: "40px",
    borderRadius: "0",
    border: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0",
    padding: "0",
    lineHeight: 1,
    alignSelf: "stretch",
    color: tokens.colorNeutralForeground1,
    backgroundColor: "transparent",
    ...pressableButton,
    ":hover": {
      backgroundColor: "#c42b1c !important",
      color: "#ffffff !important",
    },
    ":active": {
      backgroundColor: "#a42618 !important",
      color: "#ffffff !important",
      scale: 0.96,
    },
    ":focus-visible": {
      outline: "none",
      backgroundColor: "#c42b1c !important",
      color: "#ffffff !important",
    },
  },
});

interface TitleBarProps {
  isDark: boolean;
  locale: Locale;
  editor: Editor | null;
  paragraphSpacing: ParagraphSpacing;
  documentTitle?: string;
  onNewNote: () => void;
  onImportFile: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onUpdateParagraphSpacing: (v: ParagraphSpacing) => void;
  onExportMd: () => void;
  onExportPdf: () => void;
}

function TitleBarImpl({
  isDark,
  locale,
  editor,
  paragraphSpacing,
  documentTitle,
  onNewNote,
  onImportFile,
  onToggleTheme,
  onOpenSettings,
  onUpdateParagraphSpacing,
  onExportMd,
  onExportPdf,
}: TitleBarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;

    appWindow.isMaximized().then((v) => { if (active) setIsMaximized(v); }).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then((v) => { if (active) setIsMaximized(v); }).catch(() => {});
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => {});

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return (
    <div className={styles.titleBar} data-tauri-drag-region>
      <div className={styles.left} data-tauri-drag-region>
        <AppMenu
          locale={locale}
          isDark={isDark}
          editor={editor}
          paragraphSpacing={paragraphSpacing}
          onNewNote={onNewNote}
          onImportFile={onImportFile}
          onToggleTheme={onToggleTheme}
          onOpenSettings={onOpenSettings}
          onUpdateParagraphSpacing={onUpdateParagraphSpacing}
          onExportMd={onExportMd}
          onExportPdf={onExportPdf}
        />
        <div className={styles.appTitle} data-tauri-drag-region>
          {i("app.name")}
        </div>
        {documentTitle && (
          <div className={styles.documentTitle} data-tauri-drag-region>
            {documentTitle}
          </div>
        )}
      </div>

      <div className={styles.dragRegion} data-tauri-drag-region />

      <div className={styles.windowControls}>
        <Button
          appearance="subtle"
          icon={<Subtract20Regular />}
          className={styles.controlBtn}
          onClick={() => { appWindow.minimize().catch(() => {}); }}
        />
        <Button
          appearance="subtle"
          icon={isMaximized ? <SquareMultiple20Regular /> : <Square20Regular />}
          className={styles.controlBtn}
          onClick={() => { appWindow.toggleMaximize().catch(() => {}); }}
        />
        <Button
          appearance="subtle"
          icon={<Dismiss20Regular />}
          className={styles.closeBtn}
          onClick={() => { appWindow.close().catch(() => window.close()); }}
        />
      </div>
    </div>
  );
}

// Memoized so unrelated App state changes (e.g. a sidebar group toggle) don't
// re-render the title bar. All props are primitives or stable callbacks.
export const TitleBar = memo(TitleBarImpl);
