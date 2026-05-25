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
