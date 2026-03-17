import { Button, Tooltip, makeStyles, tokens } from "@fluentui/react-components";
import {
  ArrowImportRegular,
  DocumentAddRegular,
  DocumentRegular,
  SettingsRegular,
} from "@fluentui/react-icons";
import { t } from "../i18n";
import type { NoteDoc } from "../hooks/useNotesLoader";
import type { Locale } from "../hooks/useSettings";

const SIDE_PADDING = "8px";

const useStyles = makeStyles({
  sidebar: {
    display: "flex",
    flexDirection: "column",
    width: "var(--shell-sidebar-width)",
    height: "100%",
    backgroundColor: "transparent",
    flexShrink: 0,
  },
  body: {
    flex: 1,
    overflow: "auto",
    paddingTop: "54px",
    paddingLeft: SIDE_PADDING,
    paddingRight: SIDE_PADDING,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  docItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
  },
  docItemActive: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    backgroundColor: "var(--ui-active-bg)",
    fontWeight: 500,
  },
  newDocItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    fontWeight: 500,
  },
  docName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    textAlign: "left",
  },
  badge: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
  },
  dirty: {
    fontSize: "10px",
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  empty: {
    fontSize: "13px",
    color: tokens.colorNeutralForeground3,
    lineHeight: "1.6",
    paddingTop: "10px",
    paddingLeft: "8px",
    paddingRight: "8px",
  },
  footer: {
    flexShrink: 0,
    paddingLeft: SIDE_PADDING,
    paddingRight: SIDE_PADDING,
    paddingBottom: "12px",
  },
  settingsBtn: {
    width: "100%",
    justifyContent: "flex-start",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "36px",
    paddingLeft: "8px",
    paddingRight: "8px",
  },
});

interface SidebarProps {
  docs: NoteDoc[];
  activeIndex: number;
  onSwitchDocument: (index: number) => void;
  onNewNote: () => void;
  locale: Locale;
  onOpenSettings: () => void;
}

export function Sidebar({
  docs,
  activeIndex,
  onSwitchDocument,
  onNewNote,
  locale,
  onOpenSettings,
}: SidebarProps) {
  const styles = useStyles();
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);

  return (
    <div className={styles.sidebar}>
      <div className={styles.body}>
        <Button
          appearance="subtle"
          icon={<DocumentAddRegular />}
          className={styles.newDocItem}
          onClick={onNewNote}
          size="small"
        >
          {i("sidebar.newNote")}
        </Button>

        {docs.length === 0 ? (
          <span className={styles.empty}>{i("sidebar.empty")}</span>
        ) : (
          docs.map((doc, index) => (
            <Button
              key={doc.id}
              appearance="subtle"
              icon={<DocumentRegular />}
              className={index === activeIndex ? styles.docItemActive : styles.docItem}
              onClick={() => onSwitchDocument(index)}
              size="small"
            >
              <span className={styles.docName}>{doc.fileName}</span>
              {doc.isDirty && <span className={styles.dirty}>*</span>}
              {doc.isExternal && (
                <Tooltip content={i("sidebar.externalFile")} relationship="label">
                  <span className={styles.badge}>
                    <ArrowImportRegular fontSize={14} />
                  </span>
                </Tooltip>
              )}
            </Button>
          ))
        )}
      </div>

      <div className={styles.footer}>
        <Button
          appearance="subtle"
          icon={<SettingsRegular />}
          className={styles.settingsBtn}
          size="small"
          onClick={onOpenSettings}
        >
          {i("sidebar.settings")}
        </Button>
      </div>
    </div>
  );
}
