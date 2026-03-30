import { Button, makeStyles, tokens } from "@fluentui/react-components";
import {
  Dismiss20Regular,
  Square20Regular,
  Subtract20Regular,
} from "@fluentui/react-icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
    position: "relative",
    top: "2px",
    zIndex: 1,
  },
  dragRegion: {
    flex: 1,
    height: "100%",
  },
  documentTitle: {
    position: "absolute",
    left: "50%",
    top: "calc(50% + 2px)",
    transform: "translate(-50%, -50%)",
    fontSize: "12px",
    fontWeight: 400,
    color: tokens.colorNeutralForeground1,
    opacity: 0.5,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "300px",
    pointerEvents: "none" as const,
    zIndex: 2,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    position: "relative",
    top: "2px",
    marginRight: "4px",
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
    position: "relative",
    top: "2px",
    marginLeft: "auto",
    zIndex: 3,
  },
  controlBtn: {
    minWidth: "46px",
    height: "40px",
    borderRadius: "0",
    border: "none",
  },
  closeBtn: {
    minWidth: "46px",
    height: "40px",
    borderRadius: "0",
    border: "none",
    ":hover": {
      backgroundColor: "#c42b1c",
      color: "#ffffff",
    },
  },
});

interface TitleBarProps {
  isDark: boolean;
  isEditing: boolean;
  locale: Locale;
  editor: Editor | null;
  paragraphSpacing: ParagraphSpacing;
  documentTitle?: string;
  onToggleEditing: () => void;
  onNewNote: () => void;
  onImportFile: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onUpdateParagraphSpacing: (v: ParagraphSpacing) => void;
  onExportMd: () => void;
  onExportPdf: () => void;
  onExportRtf: () => void;
}

export function TitleBar({
  isDark,
  isEditing,
  locale,
  editor,
  paragraphSpacing,
  documentTitle,
  onToggleEditing,
  onNewNote,
  onImportFile,
  onToggleTheme,
  onOpenSettings,
  onUpdateParagraphSpacing,
  onExportMd,
  onExportPdf,
  onExportRtf,
}: TitleBarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

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
          onExportRtf={onExportRtf}
        />
      </div>

      <div className={styles.dragRegion} data-tauri-drag-region />

      {documentTitle && (
        <div className={styles.documentTitle} data-tauri-drag-region>
          {documentTitle}
        </div>
      )}

      <div className={styles.actions}>
        <div className={styles.segmentGroup}>
          <Button
            appearance="transparent"
            className={!isEditing ? styles.segmentActive : styles.segment}
            onClick={() => isEditing && onToggleEditing()}
            size="small"
          >
            {i("mode.read")}
          </Button>
          <Button
            appearance="transparent"
            className={isEditing ? styles.segmentActive : styles.segment}
            onClick={() => !isEditing && onToggleEditing()}
            size="small"
          >
            {i("mode.edit")}
          </Button>
        </div>
      </div>

      <div className={styles.windowControls}>
        <Button
          appearance="subtle"
          icon={<Subtract20Regular />}
          className={styles.controlBtn}
          onClick={() => { appWindow.minimize().catch(() => {}); }}
        />
        <Button
          appearance="subtle"
          icon={<Square20Regular />}
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
