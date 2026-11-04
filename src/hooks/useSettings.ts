import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { mkdir, readTextFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n";
import { atomicWriteText } from "../utils/atomicWrite";
import { logNotenError } from "../utils/crashLog";
import { tauriFileSystem } from "../utils/fs";
import { NotenError } from "../utils/notenError";
import { isNoteColorId, type NoteColorId } from "../utils/noteColors";

export type Locale = "en" | "ko";
export type ThemeMode = "light" | "dark" | "system";
export type NotesSortOrder = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "title-asc" | "title-desc";
export type WordWrap = "word" | "char";
export type ParagraphSpacing = 0 | 10 | 20 | 30 | 40 | 50;
export type GroupLayout = "groups-first" | "mixed";
export type FontFamily = "sans" | "serif";

export interface Settings {
  locale: Locale;
  themeMode: ThemeMode;
  notesSortOrder: NotesSortOrder;
  wordWrap: WordWrap;
  paragraphSpacing: ParagraphSpacing;
  keepFormatOnPaste: boolean;
  pinEditorToolbar: boolean;
  spellcheck: boolean;
  groupLayout: GroupLayout;
  fontFamily: FontFamily;
  notesDirectory: string;
  /** Active sidebar color filter — only notes of this color are shown. */
  colorFilter: NoteColorId | null;
  /** When false, an active colorFilter is cleared on app start. */
  persistColorFilterAcrossRestarts: boolean;
  /** Outline panel open state — persisted like the sidebar's open state. */
  outlinePanelOpen: boolean;
  /** Focus mode: dim everything except the current block. */
  focusModeEnabled: boolean;
  /**
   * Outline state captured when focus mode was entered. Persisted (not kept
   * in memory) so leaving focus mode restores the panel even when the app
   * was restarted while focus mode was on.
   */
  outlineOpenBeforeFocus: boolean;
  /** Check at the first launch after each Windows logon and install unattended. */
  autoUpdate: boolean;
}

const DEFAULTS: Settings = {
  locale: "ko",
  themeMode: "light",
  notesSortOrder: "updated-desc",
  wordWrap: "word",
  paragraphSpacing: 30,
  keepFormatOnPaste: true,
  pinEditorToolbar: false,
  spellcheck: false,
  groupLayout: "groups-first",
  fontFamily: "sans",
  notesDirectory: "",
  colorFilter: null,
  persistColorFilterAcrossRestarts: false,
  outlinePanelOpen: false,
  focusModeEnabled: false,
  outlineOpenBeforeFocus: false,
  autoUpdate: true,
};

// First-run locale seed: with no settings file on disk yet, follow the OS/
// browser language. Never applied to an existing file — a file whose locale
// field is missing or corrupt still falls back to DEFAULTS.locale ("ko") in
// parseSettings, exactly as before.
function detectFirstRunLocale(): Locale {
  const lang = typeof navigator !== "undefined" ? navigator.language ?? "" : "";
  return lang.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function firstRunDefaults(): Settings {
  return { ...DEFAULTS, locale: detectFirstRunLocale() };
}

let settingsPathPromise: Promise<string> | null = null;
let settingsDirPromise: Promise<string> | null = null;

async function ensureSettingsDir(): Promise<string> {
  if (!settingsDirPromise) {
    settingsDirPromise = appDataDir().then(async (dir) => {
      await mkdir(dir, { recursive: true }).catch(() => {});
      return dir;
    });
  }
  return settingsDirPromise;
}

async function getSettingsPath(): Promise<string> {
  if (!settingsPathPromise) {
    settingsPathPromise = ensureSettingsDir().then((dir) => {
      const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
      return `${dir}${sep}settings.json`;
    });
  }
  return settingsPathPromise;
}

function migrateSortOrder(order: string): NotesSortOrder {
  if (order === "recent-first") return "updated-desc";
  if (order === "recent-last") return "updated-asc";
  const valid: NotesSortOrder[] = ["updated-desc", "updated-asc", "created-desc", "created-asc", "title-asc", "title-desc"];
  return valid.includes(order as NotesSortOrder) ? (order as NotesSortOrder) : DEFAULTS.notesSortOrder;
}

function parseSettings(raw: string): Settings {
  const parsed = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
  return {
    locale: parsed.locale === "en" ? "en" : DEFAULTS.locale,
    themeMode: parsed.themeMode === "dark" || parsed.themeMode === "system"
      ? parsed.themeMode
      : DEFAULTS.themeMode,
    notesSortOrder: migrateSortOrder(String(parsed.notesSortOrder ?? DEFAULTS.notesSortOrder)),
    wordWrap: parsed.wordWrap === "char" ? "char" : DEFAULTS.wordWrap,
    paragraphSpacing: [0, 10, 20, 30, 40, 50].includes(parsed.paragraphSpacing as number)
      ? (parsed.paragraphSpacing as ParagraphSpacing)
      : DEFAULTS.paragraphSpacing,
    keepFormatOnPaste: typeof parsed.keepFormatOnPaste === "boolean" ? parsed.keepFormatOnPaste : DEFAULTS.keepFormatOnPaste,
    pinEditorToolbar: typeof parsed.pinEditorToolbar === "boolean" ? parsed.pinEditorToolbar : DEFAULTS.pinEditorToolbar,
    spellcheck: typeof parsed.spellcheck === "boolean" ? parsed.spellcheck : DEFAULTS.spellcheck,
    groupLayout: parsed.groupLayout === "mixed" ? "mixed" : DEFAULTS.groupLayout,
    fontFamily: parsed.fontFamily === "serif" ? "serif" : DEFAULTS.fontFamily,
    notesDirectory: typeof parsed.notesDirectory === "string" ? parsed.notesDirectory : DEFAULTS.notesDirectory,
    colorFilter: isNoteColorId(parsed.colorFilter) ? parsed.colorFilter : DEFAULTS.colorFilter,
    persistColorFilterAcrossRestarts: typeof parsed.persistColorFilterAcrossRestarts === "boolean"
      ? parsed.persistColorFilterAcrossRestarts
      : DEFAULTS.persistColorFilterAcrossRestarts,
    outlinePanelOpen: typeof parsed.outlinePanelOpen === "boolean" ? parsed.outlinePanelOpen : DEFAULTS.outlinePanelOpen,
    focusModeEnabled: typeof parsed.focusModeEnabled === "boolean" ? parsed.focusModeEnabled : DEFAULTS.focusModeEnabled,
    outlineOpenBeforeFocus: typeof parsed.outlineOpenBeforeFocus === "boolean"
      ? parsed.outlineOpenBeforeFocus
      : DEFAULTS.outlineOpenBeforeFocus,
    autoUpdate: typeof parsed.autoUpdate === "boolean" ? parsed.autoUpdate : DEFAULTS.autoUpdate,
  };
}

async function persistSettings(settings: Settings) {
  await ensureSettingsDir();
  const path = await getSettingsPath();
  // Fail closed: a torn file reads as unreadable, and its notes folder is the only
  // record of where the user's library is. Callers treat a rejection as retryable.
  await atomicWriteText(tauriFileSystem, path, JSON.stringify(settings, null, 2), { failClosed: true });
}

// Re-read settings.json, apply a single key change on top of whatever is on
// disk now, then atomically write. This narrows the multi-window clobber
// window: if another window updated a different key between our reads, that
// change survives. Returns the new on-disk state so callers can adopt it.
async function readMergeWriteSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<Settings> {
  const attempt = async () => {
    const existing = await loadSettingsFromFile();
    const onDisk = existing === null ? firstRunDefaults() : existing;
    const merged = { ...onDisk, [key]: value };
    await persistSettings(merged);
    return merged;
  };
  try {
    return await attempt();
  } catch {
    // Two windows writing at once share a temp file, and the write is fail-closed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return attempt();
  }
}

// Windows' "file not found" and "path not found". `exists` cannot answer this: it
// says false when it cannot tell, and first-run defaults would then be written over
// a file nobody read.
const MISSING_FILE_ERROR = /\(os error [23]\)/;

async function loadSettingsFromFile(): Promise<Settings | null> {
  const path = await getSettingsPath();
  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch (err) {
    if (MISSING_FILE_ERROR.test(String(err))) return null;
    throw err;
  }
  return parseSettings(raw);
}

// An antivirus or sync client holding the file is usually gone in a moment.
const READ_RETRY_DELAYS_MS = [200, 800];

async function loadSettingsRetrying(): Promise<Settings | null> {
  for (const delay of READ_RETRY_DELAYS_MS) {
    try {
      return await loadSettingsFromFile();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return loadSettingsFromFile();
}

/**
 * Asks what to do about a file that stays unreadable: true starts on defaults. Esc
 * and the X both answer as the second button, so that has to be the one that changes
 * nothing. Null if it could not ask.
 */
async function askToStartOnDefaults(): Promise<boolean | null> {
  const locale = detectFirstRunLocale();
  try {
    // A window stays hidden until its note has loaded, which is waiting on this.
    await getCurrentWindow().show().catch(() => {});
    return await ask(t("settings.unreadable", locale), {
      title: t("settings.unreadableTitle", locale),
      kind: "warning",
      okLabel: t("settings.unreadableDefaults", locale),
      cancelLabel: t("settings.unreadableRetry", locale),
    });
  } catch {
    return null;
  }
}

async function setAsideUnreadableSettings(): Promise<boolean> {
  try {
    const path = await getSettingsPath();
    await tauriFileSystem.rename(path, path.replace(/\.json$/, `.unreadable-${Date.now()}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the saved setting still allows an automatic install. Settings changes
 * reach no other window or process, so the window waiting to install cannot
 * learn of an opt-out made elsewhere from its own state. An unreadable file
 * cannot show that the user still wants this.
 */
export async function readAutoUpdateAllowed(): Promise<boolean> {
  try {
    return (await loadSettingsFromFile())?.autoUpdate === true;
  } catch {
    return false;
  }
}

export function useSettings() {
  const [settings, setSettingsRaw] = useState<Settings>(DEFAULTS);
  const [isLoaded, setIsLoaded] = useState(false);
  const didUserUpdateRef = useRef(false);
  const settingsRef = useRef<Settings>(DEFAULTS);
  // Serialize writes from this window so two fast clicks can't lose each
  // other's changes before reaching disk.
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Loading on defaults is not neutral: it points the app at the default notes
      // folder, where recovery and a folder change act on the wrong library, and a
      // user with their own folder sees every note gone. So nothing proceeds until
      // this is settled. Only the user's choice replaces the file, and it is kept.
      let fileSettings: Settings | null = null;
      let mayWriteDefaults = true;
      for (;;) {
        try {
          fileSettings = await loadSettingsRetrying();
          break;
        } catch (err) {
          void logNotenError(new NotenError(
            "SETTINGS_READ_FAILED",
            "recoverable",
            err instanceof Error ? err.message : String(err),
            { cause: err },
          ));
          if (cancelled) return;
          const startOnDefaults = await askToStartOnDefaults();
          if (startOnDefaults === false) continue;
          mayWriteDefaults = startOnDefaults === true && await setAsideUnreadableSettings();
          break;
        }
      }
      if (fileSettings) {
        const shouldResetFilter =
          fileSettings.colorFilter != null && !fileSettings.persistColorFilterAcrossRestarts;
        const effective = shouldResetFilter
          ? { ...fileSettings, colorFilter: null }
          : fileSettings;
        if (!cancelled && !didUserUpdateRef.current) {
          settingsRef.current = effective;
          setSettingsRaw(effective);
        }
        if (shouldResetFilter) {
          try { await persistSettings(effective); } catch { /* best-effort */ }
        }
        if (!cancelled) setIsLoaded(true);
        return;
      }

      // No settings file: first run. Seed the locale from the system language
      // before persisting, so upgrade users (file already on disk) are never
      // touched by this path.
      const seeded = firstRunDefaults();
      if (!cancelled && !didUserUpdateRef.current) {
        settingsRef.current = seeded;
        setSettingsRaw(seeded);
      }
      if (mayWriteDefaults) {
        try {
          await persistSettings(seeded);
        } catch {
          if (import.meta.env.DEV) {
            console.warn("Failed to persist default settings:", seeded);
          }
        }
      }
      if (!cancelled) setIsLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async <K extends keyof Settings>(key: K, value: Settings[K]): Promise<boolean> => {
    didUserUpdateRef.current = true;
    const job = writeChainRef.current
      .catch(() => undefined)
      .then(() => readMergeWriteSetting(key, value));
    writeChainRef.current = job;
    try {
      const merged = await job;
      settingsRef.current = merged;
      setSettingsRaw(merged);
      return true;
    } catch (err) {
      void logNotenError(new NotenError(
        "SETTINGS_WRITE_FAILED",
        "fatal",
        err instanceof Error ? err.message : String(err),
        { context: { key }, cause: err },
      ));
      return false;
    }
  }, []);

  // Adopt a value another window already persisted (e.g. notesDirectory after
  // a migration broadcast) without a redundant disk write. Marks the user-
  // update flag so a still-running startup load cannot clobber it.
  const applyExternal = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]): void => {
    didUserUpdateRef.current = true;
    const next = { ...settingsRef.current, [key]: value };
    settingsRef.current = next;
    setSettingsRaw(next);
  }, []);

  return useMemo(() => ({ settings, update, applyExternal, isLoaded }), [settings, update, applyExternal, isLoaded]);
}
