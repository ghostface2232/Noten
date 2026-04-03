import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export type Locale = "en" | "ko";
export type ThemeMode = "light" | "dark";
export type NotesSortOrder = "updated-desc" | "updated-asc" | "created-desc" | "created-asc";
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
  const valid: NotesSortOrder[] = ["updated-desc", "updated-asc", "created-desc", "created-asc"];
  return valid.includes(order as NotesSortOrder) ? (order as NotesSortOrder) : DEFAULTS.notesSortOrder;
}

function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULTS;

  try {
    const parsed = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
    return {
      locale: parsed.locale === "en" ? "en" : DEFAULTS.locale,
      themeMode: parsed.themeMode === "dark" ? "dark" : DEFAULTS.themeMode,
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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const fileSettings = await loadSettingsFromFile();
      if (fileSettings) {
        if (!cancelled && !didUserUpdateRef.current) {
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

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    didUserUpdateRef.current = true;

    setSettingsRaw((prev) => {
      const next = { ...prev, [key]: value };
      void persistSettings(next).catch(() => {
        console.warn("Failed to persist settings update:", key);
      });
      return next;
    });
  }, []);

  return useMemo(() => ({ settings, update, isLoaded }), [settings, update, isLoaded]);
}
