import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// Project-specific contract tests. These are NOT exhaustive — they enforce a
// handful of invariants from recent regressions that ESLint cannot easily
// express (cross-file call-shape rules, presence of named constants, etc.).
//
// Style: grep over source text. Cheap to add, cheap to maintain, low ceremony.
// If a check needs real AST analysis, prefer adding an ESLint rule instead.

const SRC_ROOT = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$|\.test-utils\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("contract: setNotesDir / resetNotesDir callers pass reconcile state", () => {
  // Regression: src/App.tsx:206-218 (commit f8f7b58). The settings-driven
  // effect was the only caller that omitted reconcileStateRef.current, which
  // silently disabled the 2-pass body-missing safeguard on cross-window dir
  // changes. The implementation lives in useNotesLoader.ts and is the only
  // file allowed to mention these names without the argument.
  const IMPL_FILE = "hooks/useNotesLoader.ts";
  const CALL_RE = /\b(?:setNotesDir|resetNotesDir)\s*\(/g;

  it("every external call site mentions reconcileState on the same line", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file.replace(/\\/g, "/").endsWith(IMPL_FILE)) continue;
      const lines = read(file).split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!CALL_RE.test(line)) {
          CALL_RE.lastIndex = 0;
          continue;
        }
        CALL_RE.lastIndex = 0;
        if (!/reconcileState/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("contract: crashLog line caps remain in place", () => {
  // Regression: src/utils/crashLog.ts (commit bc358f9). Without these caps a
  // single pathological entry (e.g., unhandled rejection with a huge reason)
  // can exceed the 250KB threshold in trimExistingForAppend and wipe all
  // prior history.
  const CRASH_LOG = resolve(SRC_ROOT, "utils/crashLog.ts");

  it("declares MAX_MESSAGE_CHARS, MAX_CONTEXT_CHARS, and MAX_STACK_CHARS", () => {
    const text = read(CRASH_LOG);
    expect(text).toMatch(/\bMAX_MESSAGE_CHARS\s*=/);
    expect(text).toMatch(/\bMAX_CONTEXT_CHARS\s*=/);
    expect(text).toMatch(/\bMAX_STACK_CHARS\s*=/);
  });

  it("applies each cap inside formatLine", () => {
    const text = read(CRASH_LOG);
    const fnMatch = text.match(/function formatLine[\s\S]*?\n\}/);
    expect(fnMatch, "formatLine not found").not.toBeNull();
    const body = fnMatch![0];
    expect(body).toMatch(/MAX_MESSAGE_CHARS/);
    expect(body).toMatch(/MAX_CONTEXT_CHARS/);
    expect(body).toMatch(/MAX_STACK_CHARS/);
  });
});

describe("contract: settings read failures are not default settings", () => {
  // Regression class: transient settings.json read/parse failures must not be
  // collapsed into DEFAULTS and then written back over the user's settings.
  const SETTINGS = resolve(SRC_ROOT, "hooks/useSettings.ts");

  it("only a missing settings file returns null from loadSettingsFromFile", () => {
    const text = read(SETTINGS);
    const fnMatch = text.match(/async function loadSettingsFromFile[\s\S]*?\n\}/);
    expect(fnMatch, "loadSettingsFromFile not found").not.toBeNull();
    const body = fnMatch![0];
    expect(body).toMatch(/exists\(path\)/);
    expect(body).toMatch(/return null/);
    expect(body).not.toMatch(/\bcatch\b/);
  });

  it("readMergeWriteSetting does not merge updates onto DEFAULTS after read failure", () => {
    const text = read(SETTINGS);
    const fnMatch = text.match(/async function readMergeWriteSetting[\s\S]*?\n\}/);
    expect(fnMatch, "readMergeWriteSetting not found").not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/\?\?\s*DEFAULTS/);
  });
});

describe("contract: notes directory setting is durable before migration", () => {
  // Regression class: moving note files and then failing to save notesDirectory
  // splits this session from the next launch. The setting must be persisted
  // before destructive directory migration begins.
  const APP = resolve(SRC_ROOT, "App.tsx");

  it("change-notes-dir persists notesDirectory before moving managed data", () => {
    const text = read(APP);
    const fnMatch = text.match(/const handleChangeNotesDir[\s\S]*?\n  const handleResetNotesDir/);
    expect(fnMatch, "handleChangeNotesDir not found").not.toBeNull();
    const body = fnMatch![0];
    const persistAt = body.indexOf("persistNotesDirectorySetting(newDir)");
    const migrateAt = body.indexOf("migrateNotesDir(oldDir, newDir");
    const clearAt = body.indexOf("clearManagedNotesData(oldDir, newDir)");
    expect(persistAt).toBeGreaterThanOrEqual(0);
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeLessThan(migrateAt);
    expect(persistAt).toBeLessThan(clearAt);
  });

  it("reset-notes-dir persists the default setting before overwriting data", () => {
    const text = read(APP);
    const fnMatch = text.match(/const handleResetNotesDir[\s\S]*?\n  const \{/);
    expect(fnMatch, "handleResetNotesDir not found").not.toBeNull();
    const body = fnMatch![0];
    const persistAt = body.indexOf("persistNotesDirectorySetting(\"\")");
    const migrateAt = body.indexOf("migrateNotesDir(oldDir, defaultDir");
    expect(persistAt).toBeGreaterThanOrEqual(0);
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeLessThan(migrateAt);
  });
});

describe("contract: autosave failures remain flushable", () => {
  // Regression class: failed debounced saves must not clear all pending state
  // before the write result is known. Otherwise a later flush can observe a
  // dirty document but have no pending retry to perform.
  const AUTOSAVE = resolve(SRC_ROOT, "hooks/useAutoSave.ts");

  it("flush retries when the document is dirty even if pending flags were lost", () => {
    const text = read(AUTOSAVE);
    expect(text).toMatch(/!hasPendingChangesRef\.current && !stateRef\.current\.state\.isDirty/);
  });

  it("timer callbacks clear pending snapshots only after doSave succeeds", () => {
    const text = read(AUTOSAVE);
    const timerMatch = text.match(/const timer = setTimeout[\s\S]*?\n    \}, DEBOUNCE_MS\);/);
    expect(timerMatch, "autosave timer callback not found").not.toBeNull();
    const body = timerMatch![0];
    const saveAt = body.indexOf("doSave(pending)");
    const clearAt = body.indexOf("clearPendingSnapshotIfCurrent(pending)");
    expect(saveAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(saveAt);
  });
});

describe("contract: migration does not treat transient I/O as empty state", () => {
  // Regression class: directory migration must fail closed when reads or stats
  // are unavailable. Empty-dir and Date.now() fallbacks can pick the wrong
  // last-write-wins side or delete/copy the wrong managed tree.
  const MIGRATION = resolve(SRC_ROOT, "utils/migrateNotesDir.ts");

  it("migration code does not downgrade exists failures to false", () => {
    const text = read(MIGRATION);
    expect(text).not.toMatch(/exists\([^)]*\)\.catch\(\(\) => false\)/);
  });

  it("overwrite copy does not turn an unreadable source root into an empty copy", () => {
    const text = read(MIGRATION);
    const fnMatch = text.match(/async function copySharedTreeForOverwrite[\s\S]*?\n\}/);
    expect(fnMatch, "copySharedTreeForOverwrite not found").not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/entries\s*=\s*\[\]/);
  });

  it("migration mtimes come from stat mtime, not getFileTimestamps Date.now fallback", () => {
    const text = read(MIGRATION);
    expect(text).not.toMatch(/getFileTimestamps/);
    expect(text).toMatch(/Missing mtime for file/);
  });

  it("destination probing fails closed when the root directory is unreadable", () => {
    const text = read(MIGRATION);
    const fnMatch = text.match(/export async function hasExistingNotenData[\s\S]*?\n\}/);
    expect(fnMatch, "hasExistingNotenData not found").not.toBeNull();
    expect(fnMatch![0]).toMatch(/catch\s*\{\s*return true;\s*\}/);
  });
});

describe("contract: shared metadata reads fail closed", () => {
  // Regression class: transiently unreadable .meta/.groups files must not look
  // like absent state. Otherwise later merge/reconcile writes can propagate
  // default metadata, empty groups, or lost group membership.
  const METADATA = resolve(SRC_ROOT, "utils/metadataIO.ts");
  const GROUPS = resolve(SRC_ROOT, "utils/groupsIO.ts");

  it("metadata readers distinguish missing files from unreadable files", () => {
    const text = read(METADATA);
    const readMetaMatch = text.match(/export async function readMeta[\s\S]*?\n\}/);
    const listMetaMatch = text.match(/export async function listMetaFiles[\s\S]*?\n\}/);
    expect(readMetaMatch, "readMeta not found").not.toBeNull();
    expect(listMetaMatch, "listMetaFiles not found").not.toBeNull();
    expect(readMetaMatch![0]).toMatch(/fs\.exists\(path\)/);
    expect(readMetaMatch![0]).not.toMatch(/\bcatch\b/);
    expect(listMetaMatch![0]).toMatch(/fs\.exists\(dir\)/);
    expect(listMetaMatch![0]).not.toMatch(/\bcatch\b/);
  });

  it("groups reader does not collapse read or parse failures into an empty groups file", () => {
    const text = read(GROUPS);
    const fnMatch = text.match(/export async function readGroupsFile[\s\S]*?\n\}/);
    expect(fnMatch, "readGroupsFile not found").not.toBeNull();
    const body = fnMatch![0];
    expect(body).toMatch(/fs\.exists\(path\)/);
    expect(body).not.toMatch(/\bcatch\b/);
    expect(body.indexOf("fs.exists(path)")).toBeLessThan(body.indexOf("fs.readTextFile(path)"));
  });
});
