import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile } from "@tauri-apps/plugin-fs";
import { atomicWriteText } from "../utils/atomicWrite";
import { tauriFileSystem } from "../utils/fs";
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
  spellcheck: boolean;
  groupLayout: GroupLayout;
  fontFamily: FontFamily;
  notesDirectory: string;
  /** Active sidebar color filter — only notes of this color are shown. */
  colorFilter: NoteColorId | null;
  /** When false, an active colorFilter is cleared on app start. */
  persistColorFilterAcrossRestarts: boolean;
}

const DEFAULTS: Settings = {
  locale: "ko",
  themeMode: "light",
  notesSortOrder: "updated-desc",
  wordWrap: "word",
  paragraphSpacing: 30,
  keepFormatOnPaste: true,
  spellcheck: false,
  groupLayout: "groups-first",
  fontFamily: "sans",
  notesDirectory: "",
  colorFilter: null,
  persistColorFilterAcrossRestarts: false,
};

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
    spellcheck: typeof parsed.spellcheck === "boolean" ? parsed.spellcheck : DEFAULTS.spellcheck,
    groupLayout: parsed.groupLayout === "mixed" ? "mixed" : DEFAULTS.groupLayout,
    fontFamily: parsed.fontFamily === "serif" ? "serif" : DEFAULTS.fontFamily,
    notesDirectory: typeof parsed.notesDirectory === "string" ? parsed.notesDirectory : DEFAULTS.notesDirectory,
    colorFilter: isNoteColorId(parsed.colorFilter) ? parsed.colorFilter : DEFAULTS.colorFilter,
    persistColorFilterAcrossRestarts: typeof parsed.persistColorFilterAcrossRestarts === "boolean"
      ? parsed.persistColorFilterAcrossRestarts
      : DEFAULTS.persistColorFilterAcrossRestarts,
  };
}

async function persistSettings(settings: Settings) {
  await ensureSettingsDir();
  const path = await getSettingsPath();
  await atomicWriteText(tauriFileSystem, path, JSON.stringify(settings, null, 2));
}

// Re-read settings.json, apply a single key change on top of whatever is on
// disk now, then atomically write. This narrows the multi-window clobber
// window: if another window updated a different key between our reads, that
// change survives. Returns the new on-disk state so callers can adopt it.
async function readMergeWriteSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<Settings> {
  const existing = await loadSettingsFromFile();
  const onDisk = existing === null ? DEFAULTS : existing;
  const merged = { ...onDisk, [key]: value };
  await persistSettings(merged);
  return merged;
}

async function loadSettingsFromFile(): Promise<Settings | null> {
  const path = await getSettingsPath();
  if (!(await exists(path))) return null;
  const raw = await readTextFile(path);
  return parseSettings(raw);
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
      let fileSettings: Settings | null = null;
      try {
        fileSettings = await loadSettingsFromFile();
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn("Failed to load settings:", err);
        }
        if (!cancelled) setIsLoaded(true);
        return;
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

      try {
        await persistSettings(DEFAULTS);
      } catch {
        if (import.meta.env.DEV) {
          console.warn("Failed to persist default settings:", DEFAULTS);
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
    } catch {
      if (import.meta.env.DEV) {
        console.warn("Failed to persist settings update:", key);
      }
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
