import { appDataDir } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export interface UiState {
  activeNoteId: string | null;
  lastOpenedNoteId: string | null;
  groupCollapsed: Record<string, boolean>;
}

const DEFAULTS: UiState = {
  activeNoteId: null,
  lastOpenedNoteId: null,
  groupCollapsed: {},
};

let uiStatePathPromise: Promise<string> | null = null;

async function getUiStatePath(): Promise<string> {
  if (!uiStatePathPromise) {
    uiStatePathPromise = (async () => {
      const base = await appDataDir();
      await mkdir(base, { recursive: true }).catch(() => {});
      const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
      return `${base}${sep}ui-state.json`;
    })();
  }
  return uiStatePathPromise;
}

function parse(raw: string | null): UiState {
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<UiState>;
    return {
      activeNoteId: typeof parsed.activeNoteId === "string" ? parsed.activeNoteId : null,
      lastOpenedNoteId: typeof parsed.lastOpenedNoteId === "string" ? parsed.lastOpenedNoteId : null,
      groupCollapsed:
        parsed.groupCollapsed && typeof parsed.groupCollapsed === "object"
          ? Object.fromEntries(
              Object.entries(parsed.groupCollapsed).filter(
                ([, v]) => typeof v === "boolean",
              ),
            ) as Record<string, boolean>
          : {},
    };
  } catch {
    return DEFAULTS;
  }
}

let cache: UiState | null = null;
let loadPromise: Promise<UiState> | null = null;

/**
 * Read `ui-state.json` into the module cache. Idempotent and deduped: the
 * first caller triggers the file read, concurrent callers share its promise.
 * Must be awaited before any `getUiStateCached()` read whose result must be
 * accurate on a cold start — notably the notes loader, which builds group
 * collapsed state and the active note from it. Without this the cache is
 * empty at first load and every group renders expanded.
 */
export async function loadUiState(): Promise<UiState> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const path = await getUiStatePath();
      const raw = await readTextFile(path);
      cache = parse(raw);
    } catch {
      cache = DEFAULTS;
    }
    return cache;
  })();
  return loadPromise;
}

async function persistUiState(next: UiState): Promise<void> {
  cache = next;
  try {
    const path = await getUiStatePath();
    await writeTextFile(path, JSON.stringify(next, null, 2));
  } catch { /* best-effort */ }
}

/** Synchronously read the cached UI state. Returns DEFAULTS until
 *  `loadUiState()` has populated the cache — callers needing accuracy on a
 *  cold start must await `loadUiState()` first. */
export function getUiStateCached(): UiState {
  return cache ?? DEFAULTS;
}

export async function setActiveNoteIdPersisted(id: string | null): Promise<void> {
  const cur = await loadUiState();
  if (cur.activeNoteId === id) return;
  await persistUiState({ ...cur, activeNoteId: id, lastOpenedNoteId: id ?? cur.lastOpenedNoteId });
}

export async function setGroupCollapsedPersisted(groupId: string, collapsed: boolean): Promise<void> {
  const cur = await loadUiState();
  if (cur.groupCollapsed[groupId] === collapsed) return;
  const next = { ...cur.groupCollapsed, [groupId]: collapsed };
  await persistUiState({ ...cur, groupCollapsed: next });
}

export async function pruneUiGroupCollapsed(validGroupIds: Set<string>): Promise<void> {
  const cur = await loadUiState();
  let changed = false;
  const next: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(cur.groupCollapsed)) {
    if (validGroupIds.has(id)) next[id] = v;
    else changed = true;
  }
  if (changed) await persistUiState({ ...cur, groupCollapsed: next });
}
