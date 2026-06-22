import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared in-memory file store that both the plugin-fs surface (used for
// read/exists/remove) and tauriFileSystem (used by atomicWriteText) write to.
const store = vi.hoisted(() => new Map<string, string>());

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/appdata/"),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  exists: vi.fn(async (path: string) => store.has(path)),
  readTextFile: vi.fn(async (path: string) => {
    if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
    return store.get(path)!;
  }),
  remove: vi.fn(async (path: string) => { store.delete(path); }),
}));

vi.mock("./fs", () => ({
  tauriFileSystem: {
    writeTextFile: vi.fn(async (path: string, content: string) => { store.set(path, content); }),
    rename: vi.fn(async (from: string, to: string) => {
      store.set(to, store.get(from)!);
      store.delete(from);
    }),
    remove: vi.fn(async (path: string) => { store.delete(path); }),
  },
}));

vi.mock("./crashLog", () => ({ logNotenError: vi.fn(() => Promise.resolve()) }));

import {
  readMigrationJournal,
  writeMigrationJournal,
  clearMigrationJournal,
  type MigrationJournal,
} from "./migrationJournal";

const JOURNAL_PATH = "/appdata/migration-journal.json";

const sample: MigrationJournal = {
  migrationId: "m1",
  oldDir: "/old/notes",
  newDir: "/new/notes",
  cleanupMode: "merge",
  startedAt: 1234,
};

beforeEach(() => {
  store.clear();
});

describe("migrationJournal", () => {
  it("round-trips a written journal", async () => {
    await writeMigrationJournal(sample);
    expect(await readMigrationJournal()).toEqual(sample);
  });

  it("returns null when no journal exists", async () => {
    expect(await readMigrationJournal()).toBeNull();
  });

  it("clears the journal so a later read sees nothing", async () => {
    await writeMigrationJournal(sample);
    await clearMigrationJournal();
    expect(await readMigrationJournal()).toBeNull();
  });

  it("rejects a journal with an invalid cleanupMode", async () => {
    store.set(JOURNAL_PATH, JSON.stringify({ ...sample, cleanupMode: "wipe-everything" }));
    expect(await readMigrationJournal()).toBeNull();
  });

  it("rejects a journal missing required fields", async () => {
    store.set(JOURNAL_PATH, JSON.stringify({ migrationId: "m1" }));
    expect(await readMigrationJournal()).toBeNull();
  });

  it("rejects malformed JSON instead of throwing", async () => {
    store.set(JOURNAL_PATH, "{ not valid json");
    expect(await readMigrationJournal()).toBeNull();
  });

  it("defaults a missing startedAt to 0", async () => {
    const { startedAt: _omit, ...withoutStartedAt } = sample;
    store.set(JOURNAL_PATH, JSON.stringify(withoutStartedAt));
    const read = await readMigrationJournal();
    expect(read).toEqual({ ...sample, startedAt: 0 });
  });
});
