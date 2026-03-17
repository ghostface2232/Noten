import { useState } from "react";
import {
  Dialog,
  DialogSurface,
  Label,
  Radio,
  RadioGroup,
  Slider,
  Switch,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { t } from "../i18n";
import type {
  Locale,
  NotesSortOrder,
  ParagraphSpacing,
  Settings,
  StartupMode,
  ThemeMode,
  WordWrap,
} from "../hooks/useSettings";

const NAV_WIDTH = "160px";

const useStyles = makeStyles({
  surface: {
    maxWidth: "620px",
    width: "100%",
    borderRadius: "12px",
    overflow: "hidden",
    padding: "0 !important",
  },
  layout: {
    display: "flex",
    minHeight: "380px",
    padding: "4px",
    paddingLeft: 0,
  },
  nav: {
    width: NAV_WIDTH,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    padding: "16px 8px",
    gap: "2px",
  },
  navTitle: {
    fontSize: "14px",
    fontWeight: 600,
    padding: "0 8px",
    marginBottom: "12px",
    color: tokens.colorNeutralForeground1,
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 400,
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    cursor: "pointer",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground3,
    fontFamily: "inherit",
    ":hover": {
      backgroundColor: "var(--settings-nav-hover)",
      color: tokens.colorNeutralForeground1,
    },
  },
  navItemActive: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 500,
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    cursor: "pointer",
    color: tokens.colorNeutralForeground1,
    fontFamily: "inherit",
    ":hover": {
      backgroundColor: "var(--settings-nav-hover)",
    },
  },
  content: {
    flex: 1,
    borderRadius: "8px",
    padding: "24px",
    overflow: "auto",
  },
  section: {
    display: "flex",
    flexDirection: "column",
  },
  settingItem: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "14px",
    paddingBottom: "14px",
  },
  settingItemFirst: {
    borderTop: "none",
    paddingTop: 0,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
  },
  label: {
    fontSize: "13px",
    fontWeight: 500,
    flexShrink: 0,
  },
  sublabel: {
    fontSize: "12px",
    color: tokens.colorNeutralForeground3,
  },
  sliderRow: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  sliderHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  shortcutGrid: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "10px 20px",
    fontSize: "13px",
  },
  shortcutKey: {
    fontFamily: "var(--editor-font-family-mono)",
    fontSize: "12px",
    color: tokens.colorNeutralForeground2,
    textAlign: "right",
  },
});

type TabId = "system" | "formatting" | "shortcuts";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onUpdate: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

function settingItemClass(
  styles: ReturnType<typeof useStyles>,
  isFirst = false,
) {
  return mergeClasses(styles.settingItem, isFirst && styles.settingItemFirst);
}

export function SettingsModal({ open, onClose, settings, onUpdate }: SettingsModalProps) {
  const styles = useStyles();
  const locale = settings.locale;
  const isDarkMode = settings.themeMode === "dark";
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);
  const [tab, setTab] = useState<TabId>("system");

  const micaBg = isDarkMode ? "rgba(32, 32, 32, 0.80)" : "rgba(243, 243, 243, 0.75)";
  const panelBg = isDarkMode ? "rgba(45, 45, 45, 1)" : "rgba(255, 255, 255, 1)";
  const borderColor = isDarkMode ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.12)";

  const navItems: { id: TabId; labelKey: Parameters<typeof t>[0] }[] = [
    { id: "system", labelKey: "settings.tab.system" },
    { id: "formatting", labelKey: "settings.tab.formatting" },
    { id: "shortcuts", labelKey: "settings.tab.shortcuts" },
  ];

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface
        className={styles.surface}
        style={{
          background: micaBg,
          backdropFilter: "blur(40px)",
          WebkitBackdropFilter: "blur(40px)",
          border: `1px solid ${borderColor}`,
          boxShadow: isDarkMode
            ? "0 12px 48px rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.4)"
            : "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
        }}
        backdrop={{
          style: {
            backgroundColor: isDarkMode ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.3)",
          },
        }}
      >
        <div className={styles.layout}>
          <nav
            className={styles.nav}
            style={{
              "--settings-nav-hover": isDarkMode
                ? "rgba(255, 255, 255, 0.08)"
                : "rgba(0, 0, 0, 0.04)",
            } as React.CSSProperties}
          >
            <span className={styles.navTitle}>{i("settings.title")}</span>
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  className={active ? styles.navItemActive : styles.navItem}
                  style={active ? {
                    backgroundColor: isDarkMode
                      ? "rgba(255, 255, 255, 0.10)"
                      : "rgba(0, 0, 0, 0.06)",
                  } : undefined}
                  onClick={() => setTab(item.id)}
                >
                  {i(item.labelKey)}
                </button>
              );
            })}
          </nav>

          <div className={styles.content} style={{ backgroundColor: panelBg }}>
            {tab === "system" && (
              <div className={styles.section}>
                <div className={mergeClasses(styles.row, settingItemClass(styles, true))}>
                  <Label className={styles.label}>{i("settings.language")}</Label>
                  <RadioGroup
                    layout="horizontal"
                    value={settings.locale}
                    onChange={(_, data) => onUpdate("locale", data.value as Locale)}
                  >
                    <Radio value="en" label="English" />
                    <Radio value="ko" label="한국어" />
                  </RadioGroup>
                </div>

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
                  <Label className={styles.label}>{i("settings.theme")}</Label>
                  <RadioGroup
                    layout="horizontal"
                    value={settings.themeMode}
                    onChange={(_, data) => onUpdate("themeMode", data.value as ThemeMode)}
                  >
                    <Radio value="light" label={i("theme.light")} />
                    <Radio value="dark" label={i("theme.dark")} />
                  </RadioGroup>
                </div>

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
                  <Label className={styles.label}>{i("settings.startupMode")}</Label>
                  <RadioGroup
                    layout="horizontal"
                    value={settings.startupMode}
                    onChange={(_, data) => onUpdate("startupMode", data.value as StartupMode)}
                  >
                    <Radio value="read" label={i("mode.read")} />
                    <Radio value="edit" label={i("mode.edit")} />
                  </RadioGroup>
                </div>

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
                  <Label className={styles.label}>{i("settings.noteOrder")}</Label>
                  <RadioGroup
                    layout="horizontal"
                    value={settings.notesSortOrder}
                    onChange={(_, data) => onUpdate("notesSortOrder", data.value as NotesSortOrder)}
                  >
                    <Radio value="recent-first" label={i("settings.noteOrder.recentFirst")} />
                    <Radio value="recent-last" label={i("settings.noteOrder.recentLast")} />
                  </RadioGroup>
                </div>

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
                  <Label className={styles.label}>{i("settings.keepFormat")}</Label>
                  <Switch
                    checked={settings.keepFormatOnPaste}
                    onChange={(_, data) => onUpdate("keepFormatOnPaste", data.checked)}
                  />
                </div>

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
                  <Label className={styles.label}>{i("settings.spellcheck")}</Label>
                  <Switch
                    checked={settings.spellcheck}
                    onChange={(_, data) => onUpdate("spellcheck", data.checked)}
                  />
                </div>
              </div>
            )}

            {tab === "formatting" && (
              <div className={styles.section}>
                <div className={mergeClasses(styles.row, settingItemClass(styles, true))}>
                  <Label className={styles.label}>{i("settings.wordWrap")}</Label>
                  <RadioGroup
                    layout="horizontal"
                    value={settings.wordWrap}
                    onChange={(_, data) => onUpdate("wordWrap", data.value as WordWrap)}
                  >
                    <Radio value="word" label={i("settings.wordWrap.word")} />
                    <Radio value="char" label={i("settings.wordWrap.char")} />
                  </RadioGroup>
                </div>

                <div className={mergeClasses(styles.sliderRow, settingItemClass(styles))}>
                  <div className={styles.sliderHeader}>
                    <Label className={styles.label}>{i("settings.paragraphSpacing")}</Label>
                    <span className={styles.sublabel}>{settings.paragraphSpacing}%</span>
                  </div>
                  <Slider
                    min={0}
                    max={50}
                    step={10}
                    value={settings.paragraphSpacing}
                    onChange={(_, data) => onUpdate("paragraphSpacing", data.value as ParagraphSpacing)}
                  />
                </div>
              </div>
            )}

            {tab === "shortcuts" && (
              <div className={styles.shortcutGrid}>
                <span>{i("settings.shortcut.toggleEdit")}</span>
                <span className={styles.shortcutKey}>Ctrl+E</span>

                <span>{i("settings.shortcut.switchEditor")}</span>
                <span className={styles.shortcutKey}>Ctrl+/</span>

                <span>{i("settings.shortcut.open")}</span>
                <span className={styles.shortcutKey}>Ctrl+O</span>

                <span>{i("settings.shortcut.save")}</span>
                <span className={styles.shortcutKey}>Ctrl+S</span>

                <span>{i("settings.shortcut.saveAs")}</span>
                <span className={styles.shortcutKey}>Ctrl+Shift+S</span>

                <span>{i("settings.shortcut.newFile")}</span>
                <span className={styles.shortcutKey}>Ctrl+N</span>
              </div>
            )}
          </div>
        </div>
      </DialogSurface>
    </Dialog>
  );
}
