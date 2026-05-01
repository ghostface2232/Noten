import { appDataDir } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { writeJsonAtomic } from "./atomicJson";
import { joinPath } from "./storagePaths";

export interface UiState {
  activeNoteId: string | null;
  lastOpenedNoteId: string | null;
  groupCollapsed: Record<string, boolean>;
}

const DEFAULT_UI_STATE: UiState = {
  activeNoteId: null,
  lastOpenedNoteId: null,
  groupCollapsed: {},
};

async function getUiStatePath(): Promise<string> {
  return joinPath(await appDataDir(), "ui-state.json");
}

export async function readUiState(): Promise<UiState> {
  try {
    const raw = await readTextFile(await getUiStatePath());
    const parsed = JSON.parse(raw) as Partial<UiState>;
    return {
      activeNoteId: parsed.activeNoteId ?? null,
      lastOpenedNoteId: parsed.lastOpenedNoteId ?? parsed.activeNoteId ?? null,
      groupCollapsed: parsed.groupCollapsed ?? {},
    };
  } catch {
    return DEFAULT_UI_STATE;
  }
}

export async function writeUiState(state: UiState): Promise<void> {
  await writeJsonAtomic(await getUiStatePath(), state);
}

export async function updateUiState(updater: (state: UiState) => UiState): Promise<UiState> {
  const next = updater(await readUiState());
  await writeUiState(next);
  return next;
}
