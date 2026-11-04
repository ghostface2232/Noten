import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Shared in-memory FS. Both @tauri-apps/plugin-fs and ../utils/fs are wired
// to read/write this single Map so reads after writes see the committed state
// the way the real disk would. A per-test writeGate lets us stall the first
// update's writeTextFile so we can interleave a second update in flight.
const refs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  // Optional gate: if set, every writeTextFile awaits it before committing.
  writeGate: null as Promise<void> | null,
  writeCalls: 0,
  readError: null as string | null,
  renameError: false,
  showWindow: (async () => {}) as () => Promise<void>,
  ask: (async () => false) as (...args: unknown[]) => Promise<boolean>,
  logged: (async () => {}) as (...args: unknown[]) => Promise<void>,
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/test-appdata"),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: refs.showWindow }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => refs.ask(...args),
}));

vi.mock("../utils/crashLog", () => ({
  logNotenError: (...args: unknown[]) => refs.logged(...args),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  // Says false when it cannot tell, as the real command does.
  exists: vi.fn(async (p: string) => refs.files.has(p) && !refs.readError),
  readTextFile: vi.fn(async (p: string) => {
    if (refs.readError) throw new Error(refs.readError);
    const v = refs.files.get(p);
    if (v === undefined) throw new Error(`failed to open file at path: ${p} with error: not found (os error 2)`);
    return v;
  }),
}));

// useSettings persists through atomicWriteText, which uses tauriFileSystem
// (writeTextFile + rename + remove). Route those through the same Map so
// `readTextFile(path)` after `writeTextFile(tmp)` + `rename(tmp, path)` sees
// the new content.
vi.mock("../utils/fs", () => ({
  tauriFileSystem: {
    writeTextFile: vi.fn(async (p: string, c: string) => {
      refs.writeCalls += 1;
      if (refs.writeGate) await refs.writeGate;
      refs.files.set(p, c);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (refs.renameError) throw new Error("locked");
      const v = refs.files.get(from);
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      refs.files.set(to, v);
      refs.files.delete(from);
    }),
    remove: vi.fn(async (p: string) => { refs.files.delete(p); }),
  },
}));

import { readAutoUpdateAllowed, useSettings } from "./useSettings";

const SETTINGS_PATH = "/test-appdata/settings.json";

// "Start with defaults" on the first dialog, then confirmed on the second.
function startOnDefaults() {
  return vi.fn(async (_message: unknown, options: unknown) => (options as { title: string }).title.includes("?"));
}

beforeEach(() => {
  refs.files = new Map();
  refs.writeGate = null;
  refs.writeCalls = 0;
  refs.readError = null;
  refs.renameError = false;
  refs.showWindow = vi.fn(async () => {});
  refs.ask = startOnDefaults();
  refs.logged = vi.fn(async () => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

async function mountSettings() {
  const { result } = renderHook(() => useSettings());
  await waitFor(() => expect(result.current.isLoaded).toBe(true), { timeout: 1000 });
  return result;
}


describe("useSettings — update chain serializes back-to-back writes", () => {
  // The scenario the chain exists for: user rapidly toggles two different
  // settings keys. Each update() reads disk, merges its key, and writes.
  // Without the chain, the two reads happen against the same baseline (the
  // first write hasn't landed yet), each merge produces a set with only
  // their own key changed, and the second write clobbers the first key's
  // change on disk. The chain forces the second read to happen AFTER the
  // first write commits, so both keys survive.
  it("persists both keys to disk even when the second update fires before the first finishes", async () => {
    const result = await mountSettings();

    // Stall every writeTextFile behind a manual gate so we can fire two
    // updates concurrently and observe whether the second sees the first.
    let releaseWrites: () => void = () => {};
    refs.writeGate = new Promise<void>((r) => { releaseWrites = r; });

    let p1: Promise<boolean>;
    let p2: Promise<boolean>;
    act(() => {
      p1 = result.current.update("themeMode", "dark");
      p2 = result.current.update("fontFamily", "serif");
    });

    // Let the chain wire up. Neither write should have committed yet — both
    // are waiting on the gate.
    await new Promise<void>((r) => setTimeout(r, 0));

    releaseWrites();
    const [ok1, ok2] = await Promise.all([p1!, p2!]);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);

    const onDisk = JSON.parse(refs.files.get(SETTINGS_PATH)!);
    expect(onDisk.themeMode).toBe("dark");
    expect(onDisk.fontFamily).toBe("serif");
  });

});

/** Seed the on-disk settings file with DEFAULT-shaped JSON plus overrides. */
function seedSettingsFile(overrides: Record<string, unknown>) {
  refs.files.set(SETTINGS_PATH, JSON.stringify({ locale: "ko", ...overrides }));
}

describe("readAutoUpdateAllowed", () => {
  it("follows what is saved now, not what a window loaded", async () => {
    seedSettingsFile({ autoUpdate: true });
    expect(await readAutoUpdateAllowed()).toBe(true);

    seedSettingsFile({ autoUpdate: false });
    expect(await readAutoUpdateAllowed()).toBe(false);
  });

  it("does not allow it when the file is missing or corrupt", async () => {
    refs.files.delete(SETTINGS_PATH);
    expect(await readAutoUpdateAllowed()).toBe(false);

    refs.files.set(SETTINGS_PATH, "{ not json");
    expect(await readAutoUpdateAllowed()).toBe(false);
  });
});

describe("useSettings — a settings file that cannot be read", () => {
  const SAVED = JSON.stringify({ locale: "ko", notesDirectory: "D:/내 노트" });
  const mount = async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.isLoaded).toBe(true), { timeout: 4000 });
    return result;
  };
  const asideFiles = () => Array.from(refs.files.keys()).filter((p) => p.includes(".unreadable-"));

  it("does not load on defaults while the user has not chosen", async () => {
    refs.files.set(SETTINGS_PATH, "{ not json");
    let answer!: (yes: boolean) => void;
    refs.ask = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(refs.ask).toHaveBeenCalled(), { timeout: 4000 });
    expect(refs.showWindow).toHaveBeenCalled();
    expect(result.current.isLoaded).toBe(false);
    expect(refs.files.get(SETTINGS_PATH)).toBe("{ not json");

    await act(async () => { answer(false); });
    await waitFor(() => expect(refs.ask).toHaveBeenCalledTimes(2));
    expect(result.current.isLoaded).toBe(false);
    await act(async () => { answer(true); });
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
  });

  it("loads the file after a retry", async () => {
    refs.readError = "The process cannot access the file (os error 32)";
    refs.files.set(SETTINGS_PATH, SAVED);
    refs.ask = vi.fn(async () => {
      refs.readError = null;
      return true;
    });

    const result = await mount();

    expect(result.current.settings.notesDirectory).toBe("D:/내 노트");
    expect(refs.files.get(SETTINGS_PATH)).toBe(SAVED);
    expect(asideFiles()).toEqual([]);
  });

  it("reads the file again when the user backs out of defaults", async () => {
    refs.readError = "The process cannot access the file (os error 32)";
    refs.files.set(SETTINGS_PATH, SAVED);
    // Esc and the X answer false on both dialogs.
    refs.ask = vi.fn(async () => {
      if (vi.mocked(refs.ask).mock.calls.length === 2) refs.readError = null;
      return false;
    });

    const result = await mount();

    expect(refs.ask).toHaveBeenCalledTimes(2);
    expect(result.current.settings.notesDirectory).toBe("D:/내 노트");
    expect(asideFiles()).toEqual([]);
  });

  it("gets past a brief lock without asking", async () => {
    refs.readError = "The process cannot access the file (os error 32)";
    refs.files.set(SETTINGS_PATH, SAVED);
    setTimeout(() => { refs.readError = null; }, 100);

    const result = await mount();

    expect(refs.ask).not.toHaveBeenCalled();
    expect(result.current.settings.notesDirectory).toBe("D:/내 노트");
  });

  it("keeps the file aside when the user starts with defaults", async () => {
    refs.files.set(SETTINGS_PATH, "{ not json");

    const result = await mount();

    expect(result.current.settings.notesDirectory).not.toBe("D:/내 노트");
    expect(asideFiles().map((p) => refs.files.get(p))).toEqual(["{ not json"]);
    expect(JSON.parse(refs.files.get(SETTINGS_PATH)!).locale).toBeDefined();
  });

  it("does not write over a file it could not move aside", async () => {
    refs.files.set(SETTINGS_PATH, "{ not json");
    refs.renameError = true;

    await mount();

    expect(refs.files.get(SETTINGS_PATH)).toBe("{ not json");
  });

  it("does not write over the file when it could not ask", async () => {
    refs.files.set(SETTINGS_PATH, "{ not json");
    refs.ask = vi.fn(async () => { throw new Error("no dialog"); });

    await mount();

    expect(refs.files.get(SETTINGS_PATH)).toBe("{ not json");
    expect(asideFiles()).toEqual([]);
  });

  it("does not take a failed existence check for a first run", async () => {
    refs.readError = "Access is denied. (os error 5)";
    refs.files.set(SETTINGS_PATH, SAVED);
    refs.ask = vi.fn(async () => { throw new Error("no dialog"); });

    await mount();

    expect(refs.files.get(SETTINGS_PATH)).toBe(SAVED);
  });

  it("reports a setting it could not save, and writes nothing over the file", async () => {
    refs.files.set(SETTINGS_PATH, SAVED);
    const result = await mount();
    refs.files.set(SETTINGS_PATH, "{ not json");

    let saved: boolean | undefined;
    await act(async () => { saved = await result.current.update("autoUpdate", false); });

    expect(saved).toBe(false);
    expect(refs.files.get(SETTINGS_PATH)).toBe("{ not json");
    expect(refs.logged).toHaveBeenCalledWith(expect.objectContaining({ code: "SETTINGS_WRITE_FAILED", severity: "fatal" }));
  });
});

describe("useSettings — autoUpdate", () => {
  it("is on for a settings file that predates it", async () => {
    seedSettingsFile({});
    const result = await mountSettings();
    expect(result.current.settings.autoUpdate).toBe(true);
  });

  it("keeps a user's choice to turn it off", async () => {
    seedSettingsFile({ autoUpdate: false });
    const result = await mountSettings();
    expect(result.current.settings.autoUpdate).toBe(false);
  });

  it("falls back to on when the field holds non-boolean garbage", async () => {
    seedSettingsFile({ autoUpdate: "no" });
    const result = await mountSettings();
    expect(result.current.settings.autoUpdate).toBe(true);
  });
});

describe("useSettings — v0.3.0 boolean fields (outlinePanelOpen, focusModeEnabled, outlineOpenBeforeFocus)", () => {
  it("loads persisted true values", async () => {
    seedSettingsFile({
      outlinePanelOpen: true,
      focusModeEnabled: true,
      outlineOpenBeforeFocus: true,
    });
    const result = await mountSettings();
    expect(result.current.settings.outlinePanelOpen).toBe(true);
    expect(result.current.settings.focusModeEnabled).toBe(true);
    expect(result.current.settings.outlineOpenBeforeFocus).toBe(true);
  });

  it("defaults all to false when the fields are missing (upgrade from v0.2.x)", async () => {
    seedSettingsFile({});
    const result = await mountSettings();
    expect(result.current.settings.outlinePanelOpen).toBe(false);
    expect(result.current.settings.focusModeEnabled).toBe(false);
    expect(result.current.settings.outlineOpenBeforeFocus).toBe(false);
  });

  it("falls back to false when the fields hold non-boolean garbage", async () => {
    seedSettingsFile({
      outlinePanelOpen: "yes",
      focusModeEnabled: 1,
      outlineOpenBeforeFocus: "open",
    });
    const result = await mountSettings();
    expect(result.current.settings.outlinePanelOpen).toBe(false);
    expect(result.current.settings.focusModeEnabled).toBe(false);
    expect(result.current.settings.outlineOpenBeforeFocus).toBe(false);
  });
});

describe("useSettings — first-run locale seed (navigator.language)", () => {
  let languageSpy: ReturnType<typeof vi.spyOn> | null = null;

  function mockLanguage(lang: string) {
    languageSpy = vi.spyOn(window.navigator, "language", "get").mockReturnValue(lang);
  }

  afterEach(() => {
    languageSpy?.mockRestore();
    languageSpy = null;
  });

  it("seeds locale ko when no settings file exists and the system language is ko-*", async () => {
    mockLanguage("ko-KR");
    const result = await mountSettings();
    expect(result.current.settings.locale).toBe("ko");
    const onDisk = JSON.parse(refs.files.get(SETTINGS_PATH)!);
    expect(onDisk.locale).toBe("ko");
  });

  it("seeds locale en when no settings file exists and the system language is not ko", async () => {
    mockLanguage("en-US");
    const result = await mountSettings();
    expect(result.current.settings.locale).toBe("en");
    const onDisk = JSON.parse(refs.files.get(SETTINGS_PATH)!);
    expect(onDisk.locale).toBe("en");
  });

  it("never touches an existing settings file (upgrade user keeps ko even on an en system)", async () => {
    mockLanguage("en-US");
    seedSettingsFile({ locale: "ko" });
    const before = refs.files.get(SETTINGS_PATH);
    const result = await mountSettings();
    expect(result.current.settings.locale).toBe("ko");
    // Load path must not rewrite the file at all.
    expect(refs.writeCalls).toBe(0);
    expect(refs.files.get(SETTINGS_PATH)).toBe(before);
  });

  it("falls back to ko (not the system language) when the file exists but its locale field is missing", async () => {
    mockLanguage("en-US");
    refs.files.set(SETTINGS_PATH, JSON.stringify({ themeMode: "dark" }));
    const result = await mountSettings();
    expect(result.current.settings.locale).toBe("ko");
  });
});
