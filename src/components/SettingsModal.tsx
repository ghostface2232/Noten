import { useState, useEffect, useMemo } from "react";
import {
  Button,
  Dialog,
  DialogSurface,
  Dropdown,
  Label,
  Option,
  ProgressBar,
  Radio,
  RadioGroup,
  Slider,
  Spinner,
  Switch,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  CheckmarkCircle20Regular,
  DocumentAdd20Regular,
  WindowNew20Regular,
  Save20Regular,
  ArrowDownload20Regular,
  Code20Regular,
  Search20Regular,
  TextNumberListLtr20Regular,
  TextStrikethrough20Regular,
  Rename20Regular,
  DocumentCopy20Regular,
  ArrowExportUp20Regular,
  CopySelect20Regular,
  Delete20Regular,
  Link20Regular,
} from "@fluentui/react-icons";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "../i18n";
import { useUpdater } from "../hooks/useUpdater";
import type {
  FontFamily,
  Locale,
  NotesSortOrder,
  ParagraphSpacing,
  Settings,
  ThemeMode,
  WordWrap,
} from "../hooks/useSettings";
import type { TrashedNote } from "../hooks/useNotesLoader";

const NAV_WIDTH = "160px";
const CONTROL_RADIUS = "6px";

const useStyles = makeStyles({
  surface: {
    maxWidth: "620px",
    width: "100%",
    borderRadius: "12px",
    overflow: "hidden",
    padding: "0 !important",
    userSelect: "none",
  },
  layout: {
    display: "flex",
    height: "470px",
    padding: "4px",
    paddingLeft: 0,
    position: "relative",
  },
  noiseOverlay: {
    position: "absolute",
    inset: "0",
    borderRadius: "8px",
    pointerEvents: "none",
    zIndex: 2,
    backgroundRepeat: "repeat",
    backgroundSize: "200px 200px",
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
    borderRadius: CONTROL_RADIUS,
    fontSize: "13px",
    fontWeight: 500,
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
    borderRadius: CONTROL_RADIUS,
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
  dropdown: {
    minWidth: "150px",
    fontSize: "13px",
    borderRadius: CONTROL_RADIUS,
    borderTopColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "transparent",
    borderLeftColor: "transparent",
    ":hover": {
      borderTopColor: "transparent",
      borderRightColor: "transparent",
      borderBottomColor: "transparent",
      borderLeftColor: "transparent",
    },
    ":active": {
      borderTopColor: "transparent",
      borderRightColor: "transparent",
      borderBottomColor: "transparent",
      borderLeftColor: "transparent",
    },
    ":focus-within": {
      borderTopColor: "transparent",
      borderRightColor: "transparent",
      borderBottomColor: "transparent",
      borderLeftColor: "transparent",
    },
    "::after": {
      display: "none",
    },
  },
});

type TabId = "general" | "display" | "shortcuts" | "trash" | "about";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onUpdate: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  currentNotesDir: string;
  onChangeNotesDir: () => void;
  onResetNotesDir: () => void;
  trashedNotes: TrashedNote[];
  onRestoreNote: (id: string) => Promise<void>;
  onPermanentlyDeleteNote: (id: string) => Promise<void>;
  onEmptyTrash: () => Promise<void>;
}

const SORT_ORDER_LABELS: Record<NotesSortOrder, Parameters<typeof t>[0]> = {
  "updated-desc": "settings.noteOrder.updatedDesc",
  "updated-asc": "settings.noteOrder.updatedAsc",
  "created-desc": "settings.noteOrder.createdDesc",
  "created-asc": "settings.noteOrder.createdAsc",
  "title-asc": "settings.noteOrder.titleAsc",
  "title-desc": "settings.noteOrder.titleDesc",
};

function sortOrderLabelKey(order: NotesSortOrder): Parameters<typeof t>[0] {
  return SORT_ORDER_LABELS[order];
}

const NOISE_SVG = `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

function settingItemClass(
  styles: ReturnType<typeof useStyles>,
  isFirst = false,
) {
  return mergeClasses(styles.settingItem, isFirst && styles.settingItemFirst);
}

export function SettingsModal({ open, onClose, settings, onUpdate, currentNotesDir, onChangeNotesDir, onResetNotesDir, trashedNotes, onRestoreNote, onPermanentlyDeleteNote, onEmptyTrash }: SettingsModalProps) {
  const styles = useStyles();
  const locale = settings.locale;
  const isDarkMode = settings.themeMode === "dark";
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);
  const [tab, setTab] = useState<TabId>("general");
  const [appVersion, setAppVersion] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { state: updaterState, checkForUpdate, installUpdate, restartApp } = useUpdater();
  const subtleBtnStyle: React.CSSProperties = { fontSize: "13px", fontWeight: 500, borderRadius: CONTROL_RADIUS, backgroundColor: isDarkMode ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" };

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const themeStyles = useMemo(() => {
    const dark = isDarkMode;
    return {
      micaBg: dark ? "rgba(44, 44, 44, 0.92)" : "rgba(243, 243, 243, 0.90)",
      panelBg: dark ? "rgba(56, 56, 56, 0.70)" : "rgba(255, 255, 255, 0.70)",
      borderColor: dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)",
      noiseOpacity: dark ? 0.035 : 0.025,
      backdropBg: dark ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.32)",
      navHover: dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.04)",
      navActiveBg: dark ? "rgba(255, 255, 255, 0.10)" : "rgba(0, 0, 0, 0.06)",
      surfaceShadow: dark
        ? "0 12px 48px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.3)"
        : "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
      dropdownBg: dark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.08)",
    };
  }, [isDarkMode]);

  const navItems: { id: TabId; labelKey: Parameters<typeof t>[0] }[] = [
    { id: "general", labelKey: "settings.tab.general" },
    { id: "display", labelKey: "settings.tab.display" },
    { id: "shortcuts", labelKey: "settings.tab.shortcuts" },
    { id: "trash", labelKey: "settings.tab.trash" },
    { id: "about", labelKey: "settings.tab.about" },
  ];

  return (
    <>
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface
        className={styles.surface}
        style={{
          background: themeStyles.micaBg,
          backdropFilter: "saturate(120%) blur(60px)",
          WebkitBackdropFilter: "saturate(120%) blur(60px)",
          border: `1px solid ${themeStyles.borderColor}`,
          boxShadow: themeStyles.surfaceShadow,
          willChange: "transform, opacity",
        }}
        backdrop={{
          style: {
            backgroundColor: themeStyles.backdropBg,
          },
        }}
      >
        <div className={styles.layout}>
          <div
            className={styles.noiseOverlay}
            style={{ backgroundImage: NOISE_SVG, opacity: themeStyles.noiseOpacity }}
          />
          <nav
            className={styles.nav}
            style={{
              "--settings-nav-hover": themeStyles.navHover,
            } as React.CSSProperties}
          >
            <span className={styles.navTitle}>{i("settings.title")}</span>
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  className={active ? styles.navItemActive : styles.navItem}
                  style={active ? { backgroundColor: themeStyles.navActiveBg } : undefined}
                  onClick={() => setTab(item.id)}
                >
                  {i(item.labelKey)}
                </button>
              );
            })}
          </nav>

          <div className={styles.content} style={{ backgroundColor: themeStyles.panelBg }}>
            {tab === "general" && (
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
                  <Label className={styles.label}>{i("settings.noteOrder")}</Label>
                  <Dropdown
                    className={styles.dropdown}
                    style={{ backgroundColor: themeStyles.dropdownBg }}
                    value={i(sortOrderLabelKey(settings.notesSortOrder))}
                    selectedOptions={[settings.notesSortOrder]}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) onUpdate("notesSortOrder", data.optionValue as NotesSortOrder);
                    }}
                    appearance="outline"
                  >
                    <Option value="updated-desc">{i("settings.noteOrder.updatedDesc")}</Option>
                    <Option value="updated-asc">{i("settings.noteOrder.updatedAsc")}</Option>
                    <Option value="created-desc">{i("settings.noteOrder.createdDesc")}</Option>
                    <Option value="created-asc">{i("settings.noteOrder.createdAsc")}</Option>
                    <Option value="title-asc">{i("settings.noteOrder.titleAsc")}</Option>
                    <Option value="title-desc">{i("settings.noteOrder.titleDesc")}</Option>
                  </Dropdown>
                </div>

                <div className={settingItemClass(styles)}>
                  <div className={styles.row}>
                    <Label className={styles.label}>{i("settings.notesDirectory")}</Label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      <Button size="medium" appearance="subtle" onClick={onChangeNotesDir} style={{ ...subtleBtnStyle, minWidth: 0 }}>
                        {i("settings.notesDirectory.change")}
                      </Button>
                      {settings.notesDirectory && (
                        <Button size="medium" appearance="subtle" onClick={onResetNotesDir} style={{ ...subtleBtnStyle, minWidth: 0 }}>
                          {i("settings.notesDirectory.reset")}
                        </Button>
                      )}
                    </div>
                  </div>
                  <Tooltip
                    content={(
                      <span style={{ userSelect: "none", WebkitUserSelect: "none", pointerEvents: "none" }}>
                        {currentNotesDir}
                      </span>
                    )}
                    relationship="description"
                    positioning="above"
                  >
                    <div style={{
                      fontSize: "13px",
                      color: tokens.colorNeutralForeground3,
                      marginTop: "10px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {currentNotesDir}
                    </div>
                  </Tooltip>
                  <div style={{ fontSize: "12px", color: tokens.colorNeutralForeground3, marginTop: "4px", lineHeight: "1.5" }}>
                    {i("settings.notesDirectory.description")}
                  </div>
                </div>
              </div>
            )}

            {tab === "display" && (
              <div className={styles.section}>
                <div className={mergeClasses(styles.row, settingItemClass(styles, true))}>
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
                  <Label className={styles.label}>{i("settings.fontFamily")}</Label>
                  <RadioGroup
                    layout="horizontal"
                    value={settings.fontFamily}
                    onChange={(_, data) => onUpdate("fontFamily", data.value as FontFamily)}
                  >
                    <Radio value="sans" label={i("settings.fontFamily.sans")} />
                    <Radio value="serif" label={i("settings.fontFamily.serif")} />
                  </RadioGroup>
                </div>

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
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

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
                  <Label className={styles.label}>{i("settings.keepFormat")}</Label>
                  <Switch
                    checked={settings.keepFormatOnPaste}
                    onChange={(_, data) => onUpdate("keepFormatOnPaste", data.checked)}
                  />
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

                <div className={mergeClasses(styles.row, settingItemClass(styles))}>
                  <Label className={styles.label}>{i("settings.spellcheck")}</Label>
                  <Switch
                    checked={settings.spellcheck}
                    onChange={(_, data) => onUpdate("spellcheck", data.checked)}
                  />
                </div>
              </div>
            )}

            {tab === "shortcuts" && (
              <div className={styles.section}>
                {([
                  ["settings.shortcut.newFile", "Ctrl+N", DocumentAdd20Regular],
                  ["settings.shortcut.newWindow", "Ctrl+Shift+N", WindowNew20Regular],
                  ["settings.shortcut.save", "Ctrl+S", Save20Regular],
                  ["settings.shortcut.import", "Ctrl+O", ArrowDownload20Regular],
                  ["settings.shortcut.switchSurface", "Ctrl+/", Code20Regular],
                  ["settings.shortcut.showChrome", "Click / Scroll", Code20Regular],
                  ["settings.shortcut.find", "Ctrl+F", Search20Regular],
                  ["settings.shortcut.gotoLine", "Ctrl+G", TextNumberListLtr20Regular],
                  ["settings.shortcut.link", "Ctrl+K", Link20Regular],
                  ["settings.shortcut.strike", "Ctrl+Shift+X", TextStrikethrough20Regular],
                  ["settings.shortcut.rename", "Ctrl+R / F2", Rename20Regular],
                  ["settings.shortcut.duplicate", "Ctrl+D", DocumentCopy20Regular],
                  ["settings.shortcut.export", "Ctrl+E", ArrowExportUp20Regular],
                  ["settings.shortcut.copyContent", "Ctrl+Alt+C", CopySelect20Regular],
                  ["settings.shortcut.delete", "Delete", Delete20Regular],
                ] as [Parameters<typeof t>[0], string, React.ComponentType][]).map(([labelKey, key, Icon], idx) => (
                  <div key={key} className={mergeClasses(styles.row, settingItemClass(styles, idx === 0))}>
                    <Label className={styles.label} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Icon />{i(labelKey)}
                    </Label>
                    <span className={styles.shortcutKey}>{key}</span>
                  </div>
                ))}
              </div>
            )}

            {tab === "trash" && (
              <div className={styles.section}>
                <div className={mergeClasses(styles.row, settingItemClass(styles, true))}>
                  <Label className={styles.label}>
                    {i("trash.count").replace("{n}", String(trashedNotes.length))}
                  </Label>
                  {trashedNotes.length > 0 && (
                    <Button
                      size="medium"
                      appearance="subtle"
                      onClick={() => setConfirmOpen(true)}
                      style={{ ...subtleBtnStyle, color: tokens.colorPaletteRedForeground1 }}
                    >
                      {i("trash.emptyAll")}
                    </Button>
                  )}
                </div>
                {trashedNotes.length === 0 ? (
                  <div style={{ fontSize: "13px", color: tokens.colorNeutralForeground3, padding: "20px 0", textAlign: "center" }}>
                    {i("trash.empty")}
                  </div>
                ) : (
                  trashedNotes.map((note) => {
                    const daysLeft = Math.max(0, 14 - Math.floor((Date.now() - note.trashedAt) / 86400000));
                    return (
                      <div key={note.id} className={settingItemClass(styles)}>
                        <div className={styles.row}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {note.fileName}
                            </div>
                            <div style={{ fontSize: "12px", color: tokens.colorNeutralForeground3, marginTop: "2px" }}>
                              {i("trash.daysLeft").replace("{n}", String(daysLeft))}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
                            <Button
                              size="medium"
                              appearance="subtle"
                              onClick={() => onRestoreNote(note.id)}
                              style={subtleBtnStyle}
                            >
                              {i("trash.restore")}
                            </Button>
                            <Button
                              size="medium"
                              appearance="subtle"
                              onClick={() => onPermanentlyDeleteNote(note.id)}
                              style={{ ...subtleBtnStyle, color: tokens.colorPaletteRedForeground1 }}
                            >
                              {i("trash.deletePermanently")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {tab === "about" && (
              <div className={styles.section} style={{ justifyContent: "space-between", height: "100%" }}>
                <div>
                  {/* App info */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "18px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <img
                        src="/Noten_icon.png"
                        alt="Noten"
                        style={{ width: "40px", height: "40px", borderRadius: "8px" }}
                      />
                      <div>
                        <div style={{ fontSize: "16px", color: tokens.colorNeutralForeground1 }}>{i("app.name")}</div>
                        <div style={{ fontSize: "12px", color: tokens.colorNeutralForeground3 }}>v{appVersion}</div>
                      </div>
                    </div>
                    {(updaterState.status === "idle" ||
                      updaterState.status === "error" ||
                      updaterState.status === "upToDate" ||
                      updaterState.status === "checking") && (
                      <Button
                        size="medium"
                        appearance="subtle"
                        onClick={checkForUpdate}
                        disabled={updaterState.status === "checking"}
                        style={subtleBtnStyle}
                      >
                        {updaterState.status === "checking" ? i("about.checkingShort") : i("about.checkUpdate")}
                      </Button>
                    )}
                  </div>

                  {/* Version notes */}
                  <div className={settingItemClass(styles)} style={{ paddingTop: "18px" }}>
                    <div style={{ fontSize: "12px", fontWeight: 500, color: tokens.colorNeutralForeground2, marginBottom: "6px" }}>v0.1.4</div>
                    <div style={{ fontSize: "12px", color: tokens.colorNeutralForeground3, lineHeight: "1.6" }}>
                      {locale === "ko" ? (
                        <>
                          · Note surface를 상시 편집 구조로 정리<br />
                          · Note / Markdown 모두 동일한 상단 chrome 표시 규칙 적용<br />
                          · 초기 로딩 중 문서 준비 전 입력 유실 방지<br />
                          · Markdown과 호환되지 않는 TextAlign 확장 제거<br />
                          · 하단 스크롤 구간의 상태바 떨림 현상 완화
                        </>
                      ) : (
                        <>
                          · Simplified the Note surface to stay always editable<br />
                          · Unified top chrome visibility behavior across Note and Markdown<br />
                          · Prevented input loss before the first document is ready<br />
                          · Removed the markdown-incompatible TextAlign extension<br />
                          · Reduced status bar jitter near the bottom scroll boundary
                        </>
                      )}
                    </div>
                  </div>

                  {/* Update section */}
                  <div className={settingItemClass(styles)} style={{ paddingTop: "18px" }}>
                    {updaterState.status === "checking" && (
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Spinner size="tiny" />
                        <span style={{ fontSize: "13px", color: tokens.colorNeutralForeground3 }}>
                          {i("about.checking")}
                        </span>
                      </div>
                    )}

                    {updaterState.status === "upToDate" && (
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <CheckmarkCircle20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
                        <span style={{ fontSize: "13px", color: tokens.colorNeutralForeground2 }}>
                          {i("about.upToDate")}
                        </span>
                      </div>
                    )}

                    {updaterState.status === "available" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <span style={{ fontSize: "13px", fontWeight: 500 }}>
                          {i("about.available")}: v{updaterState.version}
                        </span>
                        {updaterState.body && (
                          <div style={{ fontSize: "12px", color: tokens.colorNeutralForeground3, whiteSpace: "pre-wrap", maxHeight: "120px", overflow: "auto" }}>
                            {updaterState.body}
                          </div>
                        )}
                        <Button appearance="primary" size="medium" onClick={installUpdate} style={{ borderRadius: "6px" }}>
                          {i("about.install")}
                        </Button>
                      </div>
                    )}

                    {updaterState.status === "downloading" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <span style={{ fontSize: "13px", color: tokens.colorNeutralForeground3 }}>
                          {i("about.downloading")} {updaterState.progress}%
                        </span>
                        <ProgressBar value={updaterState.progress / 100} />
                      </div>
                    )}

                    {updaterState.status === "ready" && (
                      <Button appearance="primary" size="medium" onClick={restartApp} style={{ borderRadius: "6px" }}>
                        {i("about.restart")}
                      </Button>
                    )}

                    {updaterState.status === "error" && (
                      <span style={{ fontSize: "12px", color: tokens.colorPaletteRedForeground1 }}>
                        {i("about.error")}
                      </span>
                    )}
                  </div>
                </div>

                {/* Copyright */}
                <div style={{ fontSize: "12px", color: tokens.colorNeutralForeground3, marginBottom: "-4px" }}>
                  {i("about.copyright")}
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogSurface>
    </Dialog>

    {/* Empty All confirm dialog — must be outside settings Dialog to avoid event interference */}
    <Dialog open={confirmOpen} onOpenChange={(_, data) => { if (!data.open) setConfirmOpen(false); }}>
      <DialogSurface
        style={{
          maxWidth: "340px",
          padding: "24px 20px 16px",
          borderRadius: "12px",
          background: themeStyles.micaBg,
          backdropFilter: "saturate(120%) blur(60px)",
          WebkitBackdropFilter: "saturate(120%) blur(60px)",
          border: `1px solid ${themeStyles.borderColor}`,
          boxShadow: themeStyles.surfaceShadow,
        }}
      >
        <div style={{ fontSize: "14px", color: tokens.colorNeutralForeground1, lineHeight: "1.5", textAlign: "center", userSelect: "none" }}>
          {i("trash.emptyAllConfirm")}
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "20px" }}>
          <Button
            size="medium"
            appearance="subtle"
            onClick={() => setConfirmOpen(false)}
            style={subtleBtnStyle}
          >
            {i("trash.cancel")}
          </Button>
          <Button
            size="medium"
            appearance="subtle"
            onClick={async () => {
              setConfirmOpen(false);
              await onEmptyTrash();
            }}
            style={{ ...subtleBtnStyle, color: tokens.colorPaletteRedForeground1 }}
          >
            {i("trash.confirmDelete")}
          </Button>
        </div>
      </DialogSurface>
    </Dialog>
    </>
  );
}
