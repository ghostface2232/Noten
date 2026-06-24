import { invoke } from "@tauri-apps/api/core";
import type { Theme } from "@tauri-apps/api/window";

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
export const SYSTEM_THEME_POLL_MS = 2000;

export function themeToPrefersDark(theme: Theme | null | undefined): boolean | null {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return null;
}

export function getSystemPrefersDarkFromMatchMedia(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

export async function queryWindowsSystemPrefersDark(): Promise<boolean | null> {
  try {
    const theme = await invoke<Theme | null>("get_windows_app_theme");
    return themeToPrefersDark(theme);
  } catch {
    return null;
  }
}
