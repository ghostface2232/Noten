import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { clampMenuToViewport } from "../utils/clampMenuPosition";
import {
  NavigationRegular,
  DocumentAddRegular,
  ArrowDownloadRegular,
  ArrowExportUpRegular,
  ArrowUndoRegular,
  ArrowRedoRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
  TextParagraphRegular,
  SettingsRegular,
  DocumentRegular,
  DocumentPdfRegular,
  ChevronRightRegular,
  WindowNewRegular,
} from "@fluentui/react-icons";
import { t, type I18nKey } from "../i18n";
import type { Locale, ParagraphSpacing } from "../hooks/useSettings";
import type { Editor } from "@tiptap/react";
import { openNewWindow } from "../utils/newWindow";
import {
  MOTION_DURATION_BASE,
  MOTION_DURATION_FAST,
  MOTION_DURATION_MEDIUM,
  pressableButton,
} from "../styles/interactions";


const useStyles = makeStyles({
  menuBtn: {
    minWidth: "auto",
    height: "28px",
    width: "28px",
    padding: "0",
    borderRadius: "6px",
    border: "none",
    ...pressableButton,
  },
  overlay: {
    position: "fixed",
    inset: "0",
    zIndex: 9999,
  },
  menu: {
    position: "fixed",
    zIndex: 10000,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    padding: "4px",
    minWidth: "200px",
    animationName: {
      from: { opacity: 0, transform: "translateY(4px)", filter: "blur(4px)" },
      to: { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
    },
    animationDuration: MOTION_DURATION_BASE,
    animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
    animationFillMode: "backwards",
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "4px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "12px",
    ...pressableButton,
  },
  menuItemWithSub: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    border: "none",
    borderRadius: "4px",
    fontSize: "13px",
    gap: "8px",
    minHeight: "32px",
    paddingLeft: "8px",
    paddingRight: "8px",
    ...pressableButton,
  },
  chevron: {
    marginLeft: "auto",
    flexShrink: 0,
  },
  shortcut: {
    marginLeft: "auto",
    paddingLeft: "24px",
    fontSize: "12px",
    opacity: 0.45,
    whiteSpace: "nowrap",
  },
  groupLabel: {
    fontSize: "11px",
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
    paddingLeft: "8px",
    paddingTop: "6px",
    paddingBottom: "2px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  groupLabelSpaced: {
    fontSize: "11px",
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
    paddingLeft: "8px",
    paddingTop: "14px",
    paddingBottom: "2px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  subMenu: {
    position: "fixed",
    zIndex: 10001,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    padding: "4px",
    minWidth: "180px",
    animationName: {
      from: { opacity: 0, transform: "translateY(3px)", filter: "blur(4px)" },
      to: { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
    },
    animationDuration: MOTION_DURATION_FAST,
    animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
    animationFillMode: "backwards",
  },
  subMenuParent: {
    position: "relative",
  },
  iconCrossfade: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    flexShrink: 0,
  },
  iconCrossfadeLayer: {
    position: "absolute",
    inset: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: 0,
    scale: 0.25,
    filter: "blur(4px)",
    transitionProperty: "opacity, scale, filter",
    transitionDuration: MOTION_DURATION_MEDIUM,
    transitionTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
  },
  iconCrossfadeLayerVisible: {
    opacity: 1,
    scale: 1,
    filter: "blur(0px)",
  },
});

interface AppMenuProps {
  locale: Locale;
  isDark: boolean;
  editor: Editor | null;
  paragraphSpacing: ParagraphSpacing;
  onNewNote: () => void;
  onImportFile: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onUpdateParagraphSpacing: (v: ParagraphSpacing) => void;
  onExportMd: () => void;
  onExportPdf: () => void;
}

const SPACING_OPTIONS: ParagraphSpacing[] = [0, 10, 20, 30, 40, 50];

export function AppMenu({
  locale,
  isDark,
  editor,
  paragraphSpacing,
  onNewNote,
  onImportFile,
  onToggleTheme,
  onOpenSettings,
  onUpdateParagraphSpacing,
  onExportMd,
  onExportPdf,
}: AppMenuProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [subMenu, setSubMenu] = useState<"export" | "spacing" | null>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });

  const i = (key: I18nKey) => t(key, locale);

  const openMenu = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
    setOpen(true);
    setSubMenu(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setSubMenu(null);
  }, []);

  const act = useCallback((fn: () => void) => {
    close();
    fn();
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  const showSubMenu = useCallback((type: "export" | "spacing", e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSubPos({ x: rect.right + 4, y: rect.top });
    setSubMenu(type);
  }, []);

  return (
    <>
      <Button
        ref={btnRef}
        appearance="subtle"
        icon={<NavigationRegular />}
        className={styles.menuBtn}
        onClick={openMenu}
      />

      {open && createPortal(
        <>
          <div className={styles.overlay} onClick={close} />
          <div ref={(el) => { (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = el; if (el) clampMenuToViewport(el); }} className={styles.menu} style={{ left: menuPos.x, top: menuPos.y }}>
            <div className={styles.groupLabel}>{i("menu.file")}</div>
            <Button appearance="subtle" icon={<DocumentAddRegular />} className={styles.menuItem} onClick={() => act(onNewNote)} size="small">
              <span>{i("menu.newDoc")}</span><span className={styles.shortcut}>Ctrl+N</span>
            </Button>
            <Button appearance="subtle" icon={<ArrowDownloadRegular />} className={styles.menuItem} onClick={() => act(onImportFile)} size="small">
              <span>{i("menu.import")}</span><span className={styles.shortcut}>Ctrl+O</span>
            </Button>
            <Button appearance="subtle" icon={<WindowNewRegular />} className={styles.menuItem} onClick={() => act(() => openNewWindow())} size="small">
              <span>{i("menu.newWindow")}</span><span className={styles.shortcut}>Ctrl+Shift+N</span>
            </Button>

            <div className={styles.subMenuParent} onMouseEnter={(e) => showSubMenu("export", e)} onMouseLeave={() => { if (subMenu === "export") setSubMenu(null); }}>
              <Button appearance="subtle" icon={<ArrowExportUpRegular />} className={styles.menuItemWithSub} size="small">
                {i("menu.export")}
                <ChevronRightRegular className={styles.chevron} />
              </Button>
              {subMenu === "export" && (
                <div ref={subMenuRef} className={styles.subMenu} style={{ left: subPos.x - menuPos.x, top: subPos.y - menuPos.y }}>
                  <Button appearance="subtle" icon={<DocumentRegular />} className={styles.menuItem} onClick={() => act(onExportMd)} size="small">
                    {i("menu.exportMd")}
                  </Button>
                  <Button appearance="subtle" icon={<DocumentPdfRegular />} className={styles.menuItem} onClick={() => act(onExportPdf)} size="small">
                    {i("menu.exportPdf")}
                  </Button>
                </div>
              )}
            </div>

            <div className={styles.groupLabelSpaced}>{i("menu.edit")}</div>
            <Button appearance="subtle" icon={<ArrowUndoRegular />} className={styles.menuItem} onClick={() => act(() => editor?.commands.undo())} size="small" disabled={!editor?.can().undo()}>
              <span>{i("menu.undo")}</span><span className={styles.shortcut}>Ctrl+Z</span>
            </Button>
            <Button appearance="subtle" icon={<ArrowRedoRegular />} className={styles.menuItem} onClick={() => act(() => editor?.commands.redo())} size="small" disabled={!editor?.can().redo()}>
              <span>{i("menu.redo")}</span><span className={styles.shortcut}>Ctrl+Y</span>
            </Button>
            <div className={styles.groupLabelSpaced}>{i("menu.view")}</div>
            <Button
              appearance="subtle"
              icon={
                <span className={styles.iconCrossfade} aria-hidden="true">
                  <span className={mergeClasses(styles.iconCrossfadeLayer, !isDark && styles.iconCrossfadeLayerVisible)}>
                    <WeatherMoonRegular />
                  </span>
                  <span className={mergeClasses(styles.iconCrossfadeLayer, isDark && styles.iconCrossfadeLayerVisible)}>
                    <WeatherSunnyRegular />
                  </span>
                </span>
              }
              className={styles.menuItem}
              onClick={() => act(onToggleTheme)}
              size="small"
            >
              {isDark ? i("menu.lightMode") : i("menu.darkMode")}
            </Button>

            <div className={styles.subMenuParent} onMouseEnter={(e) => showSubMenu("spacing", e)} onMouseLeave={() => { if (subMenu === "spacing") setSubMenu(null); }}>
              <Button appearance="subtle" icon={<TextParagraphRegular />} className={styles.menuItemWithSub} size="small">
                {i("menu.paragraphSpacing")}
                <ChevronRightRegular className={styles.chevron} />
              </Button>
              {subMenu === "spacing" && (
                <div ref={subMenuRef} className={styles.subMenu} style={{ left: subPos.x - menuPos.x, top: subPos.y - menuPos.y }}>
                  {SPACING_OPTIONS.map((v) => (
                    <Button
                      key={v}
                      appearance="subtle"
                      className={styles.menuItem}
                      onClick={() => act(() => onUpdateParagraphSpacing(v))}
                      size="small"
                      style={v === paragraphSpacing ? { fontWeight: 700 } : undefined}
                    >
                      {v === 0 ? i("menu.spacingNone") : `${v}%`}
                      {v === paragraphSpacing ? " ✓" : ""}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <Button appearance="subtle" icon={<SettingsRegular />} className={styles.menuItem} onClick={() => act(onOpenSettings)} size="small">
              {i("menu.settings")}
            </Button>
          </div>
        </>,
        document.getElementById("portal-root") ?? document.body,
      )}
    </>
  );
}
