import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFocusOutlineSync } from "./useFocusOutlineSync";
import type { Settings } from "./useSettings";

type Params = Parameters<typeof useFocusOutlineSync>[0];

const updateSetting = vi.fn<
  (key: keyof Settings, value: Settings[keyof Settings]) => Promise<boolean>
>(async () => true);

beforeEach(() => {
  updateSetting.mockClear();
});

function mount(initial: Partial<Params> = {}) {
  const base: Params = {
    settingsLoaded: true,
    focusModeEnabled: false,
    outlinePanelOpen: false,
    outlineOpenBeforeFocus: false,
    updateSetting: updateSetting as Params["updateSetting"],
    ...initial,
  };
  const rendered = renderHook((props: Params) => useFocusOutlineSync(props), {
    initialProps: base,
  });
  return {
    ...rendered,
    /** Re-render with the given fields changed, keeping the rest. */
    set(next: Partial<Params>) {
      Object.assign(base, next);
      rendered.rerender({ ...base });
    },
  };
}

describe("useFocusOutlineSync — entering focus mode", () => {
  it("remembers an open outline (persisted) and closes it", () => {
    const h = mount({ outlinePanelOpen: true });
    h.set({ focusModeEnabled: true });
    expect(updateSetting).toHaveBeenCalledWith("outlineOpenBeforeFocus", true);
    expect(updateSetting).toHaveBeenCalledWith("outlinePanelOpen", false);
  });

  it("writes nothing when the outline was already closed", () => {
    const h = mount({ outlinePanelOpen: false });
    h.set({ focusModeEnabled: true });
    expect(updateSetting).not.toHaveBeenCalled();
  });
});

describe("useFocusOutlineSync — leaving focus mode", () => {
  it("restores the outline and clears the persisted pre-focus state", () => {
    const h = mount({ focusModeEnabled: true, outlineOpenBeforeFocus: true });
    h.set({ focusModeEnabled: false });
    expect(updateSetting).toHaveBeenCalledWith("outlinePanelOpen", true);
    expect(updateSetting).toHaveBeenCalledWith("outlineOpenBeforeFocus", false);
  });

  it("writes nothing when the outline was closed before focus", () => {
    const h = mount({ focusModeEnabled: true, outlineOpenBeforeFocus: false });
    h.set({ focusModeEnabled: false });
    expect(updateSetting).not.toHaveBeenCalled();
  });
});

describe("useFocusOutlineSync — restart while focus mode is on", () => {
  // The regression this hook exists for: outline open → enter focus → app
  // restart → leave focus. The pre-focus state now lives in settings, and
  // the async settings load must not read as an "entering focus" transition
  // that clobbers it.
  it("adopts the loaded focus state without clobbering the persisted pre-focus state, then restores on exit", () => {
    const h = mount({ settingsLoaded: false });
    // settings.json arrives: focus was on, outline was open before focus.
    h.set({ settingsLoaded: true, focusModeEnabled: true, outlineOpenBeforeFocus: true });
    expect(updateSetting).not.toHaveBeenCalled();

    h.set({ focusModeEnabled: false });
    expect(updateSetting).toHaveBeenCalledWith("outlinePanelOpen", true);
    expect(updateSetting).toHaveBeenCalledWith("outlineOpenBeforeFocus", false);
  });

  it("does nothing while settings are still loading", () => {
    const h = mount({ settingsLoaded: false });
    h.set({ focusModeEnabled: true, outlinePanelOpen: true });
    expect(updateSetting).not.toHaveBeenCalled();
  });
});

describe("useFocusOutlineSync — non-transitions", () => {
  it("ignores outlinePanelOpen changing on its own (no focus transition)", () => {
    const h = mount({ outlinePanelOpen: false });
    h.set({ outlinePanelOpen: true });
    h.set({ outlinePanelOpen: false });
    expect(updateSetting).not.toHaveBeenCalled();
  });
});

describe("useFocusOutlineSync — outline toggle handler", () => {
  it("toggles the outline when focus mode is off", () => {
    const h = mount({ outlinePanelOpen: false });
    act(() => h.result.current());
    expect(updateSetting).toHaveBeenCalledWith("outlinePanelOpen", true);
  });

  it("is a no-op while focus mode is on — Ctrl+Shift+O must not reopen the outline mid-focus", () => {
    const h = mount({ focusModeEnabled: true });
    updateSetting.mockClear();
    act(() => h.result.current());
    expect(updateSetting).not.toHaveBeenCalled();
  });
});
