import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export type Locale = "en" | "ko";
export type ThemeMode = "light" | "dark";
export type StartupMode = "read" | "edit";
export type NotesSortOrder = "recent-first" | "recent-last";
export type WordWrap = "word" | "char";
export type ParagraphSpacing = 0 | 10 | 20 | 30 | 40 | 50;

export interface Settings {
  locale: Locale;
  themeMode: ThemeMode;
  startupMode: StartupMode;
  notesSortOrder: NotesSortOrder;
  wordWrap: WordWrap;
  paragraphSpacing: ParagraphSpacing;
  keepFormatOnPaste: boolean;
  spellcheck: boolean;
}

const DEFAULTS: Settings = {
  locale: "ko",
  themeMode: "light",
  startupMode: "read",
  notesSortOrder: "recent-first",
  wordWrap: "word",
  paragraphSpacing: 30,
  keepFormatOnPaste: true,
  spellcheck: false,
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
    settingsPathPromise = ensureSettingsDir().then((dir) => `${dir}settings.json`);
  }
  return settingsPathPromise;
}

function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULTS;

  try {
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

async function persistSettings(settings: Settings) {
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
