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
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/test-appdata"),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  exists: vi.fn(async (p: string) => refs.files.has(p)),
  readTextFile: vi.fn(async (p: string) => {
    const v = refs.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
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
      const v = refs.files.get(from);
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      refs.files.set(to, v);
      refs.files.delete(from);
    }),
    remove: vi.fn(async (p: string) => { refs.files.delete(p); }),
  },
}));

import { useSettings } from "./useSettings";

const SETTINGS_PATH = "/test-appdata/settings.json";

beforeEach(() => {
  refs.files = new Map();
  refs.writeGate = null;
  refs.writeCalls = 0;
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
