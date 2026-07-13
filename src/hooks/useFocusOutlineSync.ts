import { useCallback, useEffect, useRef } from "react";
import type { Settings } from "./useSettings";

interface FocusOutlineSyncParams {
  /**
   * False until settings.json has been read. Before that, `focusModeEnabled`
   * still holds the in-memory default, so a persisted `true` arriving from
   * disk would otherwise read as the user entering focus mode and clobber
   * the persisted pre-focus outline state.
   */
  settingsLoaded: boolean;
  focusModeEnabled: boolean;
  outlinePanelOpen: boolean;
  /** Persisted pre-focus outline state (see Settings.outlineOpenBeforeFocus). */
  outlineOpenBeforeFocus: boolean;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<boolean>;
}

/**
 * Keeps focus mode and the outline panel consistent.
 *
 * Focus mode wants a bare canvas: entering closes the outline panel (and
 * remembers whether it was open), leaving restores it. The remembered state
 * is persisted so the restore survives an app restart while focus mode is
 * on. Only real focus-mode transitions react — `outlinePanelOpen` changing
 * on its own must not re-trigger, and the async settings load is adopted
 * without being treated as a transition.
 *
 * Returns the outline toggle handler. While focus mode is on it is a no-op:
 * the outline is part of the chrome focus mode hides, so the Ctrl+Shift+O
 * shortcut must not reopen it mid-focus.
 */
export function useFocusOutlineSync({
  settingsLoaded,
  focusModeEnabled,
  outlinePanelOpen,
  outlineOpenBeforeFocus,
  updateSetting,
}: FocusOutlineSyncParams): () => void {
  // null until the first loaded value arrives from disk.
  const prevFocusModeRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (prevFocusModeRef.current === null) {
      prevFocusModeRef.current = focusModeEnabled;
      // The first loaded state must satisfy the invariant too: focus mode on
      // with the outline open can reach disk (an F8 press racing the settings
      // load, or state persisted by older builds that allowed the toggle
      // mid-focus). Close the panel and record that it was open — but only
      // when it IS open, so the normal restart-mid-focus state (outline
      // closed, outlineOpenBeforeFocus true) keeps its pending restore.
      if (focusModeEnabled && outlinePanelOpen) {
        if (!outlineOpenBeforeFocus) void updateSetting("outlineOpenBeforeFocus", true);
        void updateSetting("outlinePanelOpen", false);
      }
      return;
    }
    if (prevFocusModeRef.current === focusModeEnabled) return;
    prevFocusModeRef.current = focusModeEnabled;
    if (focusModeEnabled) {
      if (outlineOpenBeforeFocus !== outlinePanelOpen) {
        void updateSetting("outlineOpenBeforeFocus", outlinePanelOpen);
      }
      if (outlinePanelOpen) void updateSetting("outlinePanelOpen", false);
    } else if (outlineOpenBeforeFocus) {
      void updateSetting("outlineOpenBeforeFocus", false);
      void updateSetting("outlinePanelOpen", true);
    }
  }, [settingsLoaded, focusModeEnabled, outlinePanelOpen, outlineOpenBeforeFocus, updateSetting]);

  return useCallback(() => {
    if (focusModeEnabled) return;
    void updateSetting("outlinePanelOpen", !outlinePanelOpen);
  }, [focusModeEnabled, outlinePanelOpen, updateSetting]);
}
