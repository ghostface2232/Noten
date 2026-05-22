import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
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

function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULTS;

  try {
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
    };
  } catch {
    return DEFAULTS;
  }
}

async function persistSettings(settings: Settings) {
  await ensureSettingsDir();
  const path = await getSettingsPath();
  await writeTextFile(path, JSON.stringify(settings, null, 2));
}

async function loadSettingsFromFile(): Promise<Settings | null> {
  try {
    const path = await getSettingsPath();
    const raw = await readTextFile(path);
    return parseSettings(raw);
  } catch {
    return null;
  }
}

export function useSettings() {
  const [settings, setSettingsRaw] = useState<Settings>(DEFAULTS);
  const [isLoaded, setIsLoaded] = useState(false);
  const didUserUpdateRef = useRef(false);
  const settingsRef = useRef<Settings>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const fileSettings = await loadSettingsFromFile();
      if (fileSettings) {
        if (!cancelled && !didUserUpdateRef.current) {
          settingsRef.current = fileSettings;
          setSettingsRaw(fileSettings);
        }
        if (!cancelled) setIsLoaded(true);
        return;
      }

      try {
        await persistSettings(DEFAULTS);
      } catch {
        console.warn("Failed to persist default settings:", DEFAULTS);
      }
      if (!cancelled) setIsLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async <K extends keyof Settings>(key: K, value: Settings[K]): Promise<boolean> => {
    didUserUpdateRef.current = true;
    const next = { ...settingsRef.current, [key]: value };
    settingsRef.current = next;
    setSettingsRaw(next);
    try {
      await persistSettings(next);
      return true;
    } catch {
      console.warn("Failed to persist settings update:", key);
      return false;
    }
  }, []);

  return useMemo(() => ({ settings, update, isLoaded }), [settings, update, isLoaded]);
}
