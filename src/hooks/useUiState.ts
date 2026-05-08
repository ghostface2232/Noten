import { useCallback, useEffect, useRef, useState } from "react";
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

async function loadUiState(): Promise<UiState> {
  if (cache) return cache;
  try {
    const path = await getUiStatePath();
    const raw = await readTextFile(path);
    cache = parse(raw);
  } catch {
    cache = DEFAULTS;
  }
  return cache;
}

async function persistUiState(next: UiState): Promise<void> {
  cache = next;
  try {
    const path = await getUiStatePath();
    await writeTextFile(path, JSON.stringify(next, null, 2));
  } catch { /* best-effort */ }
}

/** Synchronously read the cached UI state (after useUiState has hydrated). */
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

export function useUiState() {
  const [state, setState] = useState<UiState>(DEFAULTS);
  const [isLoaded, setIsLoaded] = useState(false);
  const persistRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await loadUiState();
      if (!cancelled) {
        setState(loaded);
        setIsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const schedulePersist = useCallback((next: UiState) => {
    cache = next;
    if (persistRef.current) clearTimeout(persistRef.current);
    persistRef.current = setTimeout(() => {
      void persistUiState(next).catch(() => {});
    }, 150);
  }, []);

  const setActiveNoteId = useCallback((id: string | null) => {
    setState((prev) => {
      if (prev.activeNoteId === id) return prev;
      const next: UiState = {
        ...prev,
        activeNoteId: id,
        lastOpenedNoteId: id ?? prev.lastOpenedNoteId,
      };
      schedulePersist(next);
      return next;
    });
  }, [schedulePersist]);

  const setGroupCollapsed = useCallback((groupId: string, collapsed: boolean) => {
    setState((prev) => {
      if (prev.groupCollapsed[groupId] === collapsed) return prev;
      const next: UiState = {
        ...prev,
        groupCollapsed: { ...prev.groupCollapsed, [groupId]: collapsed },
      };
      schedulePersist(next);
      return next;
    });
  }, [schedulePersist]);

  return { uiState: state, isLoaded, setActiveNoteId, setGroupCollapsed };
}
