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

describe("contract: notes directory setting commits after copy, before source clear", () => {
  // Regression class: persisting notesDirectory before the copy phase means a
  // crash mid-copy boots the next launch into an empty/partial directory.
  // Migration must run copy → persist setting → clear source, so a crash at
  // any point leaves either the old dir authoritative or duplicate data.
  const APP = resolve(SRC_ROOT, "App.tsx");

  it("change-notes-dir copies, then persists, then clears the source", () => {
    const text = read(APP);
    const fnMatch = text.match(/const handleChangeNotesDir[\s\S]*?\n  const handleResetNotesDir/);
    expect(fnMatch, "handleChangeNotesDir not found").not.toBeNull();
    const body = fnMatch![0];
    const migrateAt = body.indexOf("migrateNotesDir(oldDir, newDir");
    const persistAt = body.indexOf("persistNotesDirectorySetting(newDir)");
    const clearSourceAt = body.indexOf("clearMigratedSource(oldDir, newDir)");
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeGreaterThanOrEqual(0);
    expect(clearSourceAt).toBeGreaterThanOrEqual(0);
    expect(migrateAt).toBeLessThan(persistAt);
    expect(persistAt).toBeLessThan(clearSourceAt);
    // The copy phase must not clear the source itself.
    expect(body.slice(migrateAt, persistAt)).toContain("clearSource: false");
  });

  it("change-notes-dir use-selected-only persists before clearing the old dir", () => {
    const text = read(APP);
    const fnMatch = text.match(/const handleChangeNotesDir[\s\S]*?\n  const handleResetNotesDir/);
    expect(fnMatch, "handleChangeNotesDir not found").not.toBeNull();
    const body = fnMatch![0];
    // This branch has no copy phase; its only destructive step (clearing the
    // old dir) must follow its own setting commit — the last persist call.
    const persistAt = body.lastIndexOf("persistNotesDirectorySetting(newDir)");
    const clearAt = body.indexOf("clearManagedNotesData(oldDir, newDir)");
    expect(persistAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeLessThan(clearAt);
  });

  it("reset-notes-dir copies, then persists, then clears the source", () => {
    const text = read(APP);
    const fnMatch = text.match(/const handleResetNotesDir[\s\S]*?\n  const \{/);
    expect(fnMatch, "handleResetNotesDir not found").not.toBeNull();
    const body = fnMatch![0];
    const migrateAt = body.indexOf("migrateNotesDir(oldDir, defaultDir");
    const persistAt = body.indexOf("persistNotesDirectorySetting(\"\")");
    const clearSourceAt = body.indexOf("clearMigratedSource(oldDir, defaultDir)");
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeGreaterThanOrEqual(0);
    expect(clearSourceAt).toBeGreaterThanOrEqual(0);
    expect(migrateAt).toBeLessThan(persistAt);
    expect(persistAt).toBeLessThan(clearSourceAt);
    expect(body.slice(migrateAt, persistAt)).toContain("clearSource: false");
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

  it("background save tail clears pending snapshots only after doSave succeeds", () => {
    // flushAutoSave / captureAndQueueSave / scheduleAutoSave's timer all funnel
    // through startBackgroundSave. The contract is that clearPendingSnapshotIfCurrent
    // runs ONLY inside the .then(saved => ...) success branch — clearing eagerly
    // would let a write failure silently drop the retry trigger.
    const text = read(AUTOSAVE);
    const helperMatch = text.match(/const startBackgroundSave = useCallback[\s\S]*?\n  \}, \[[^\]]*\]\);/);
    expect(helperMatch, "startBackgroundSave helper not found").not.toBeNull();
    const body = helperMatch![0];
    const saveAt = body.indexOf("doSave(snapshot)");
    const clearAt = body.indexOf("clearPendingSnapshotIfCurrent(snapshot)");
    expect(saveAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(saveAt);
    // The clear must be reachable only via `if (saved)`, not unconditionally.
    expect(body).toMatch(/if\s*\(saved\)\s*clearPendingSnapshotIfCurrent/);
  });

  it("doSave runs backupIfRemoteWroteFirst before the body write in the same body", () => {
    // Commit 4003532 introduced the pre-save .conflicts/ backup as the only
    // recovery surface for "remote wrote first" overwrites in cloud-sync
    // setups. If a refactor accidentally reorders these two calls, autosave
    // overwrites a possibly-newer remote body without a backup and the user
    // has no way to recover. Cheap, refactor-only contract guard.
    //
    // Strip line comments before searching so a `// await backupIfRemote...`
    // doesn't satisfy this contract; the call must actually run.
    const text = read(AUTOSAVE);
    const fnMatch = text.match(/const doSave = useCallback[\s\S]*?\n  \}, \[\]\);/);
    expect(fnMatch, "doSave function body not found").not.toBeNull();
    const body = fnMatch![0].replace(/^\s*\/\/.*$/gm, "");
    const backupMatch = body.match(/await\s+backupIfRemoteWroteFirst\(/);
    const writeMatch = body.match(/await\s+atomicWriteText\(/);
    expect(backupMatch, "live `await backupIfRemoteWroteFirst(` call not found in doSave").not.toBeNull();
    expect(writeMatch, "live `await atomicWriteText(` body write not found in doSave").not.toBeNull();
    expect(backupMatch!.index!).toBeLessThan(writeMatch!.index!);
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

describe("contract: App-level sort effect reacts to docs identity", () => {
  // Regression class: useFileWatcher.applyMetaChange / runReconcile and
  // useWindowSync's doc-updated / note-color-updated listeners all setDocs
  // *without* sorting. App.tsx's sort effect is the only place that catches
  // those out-of-band updates; if it stops depending on `docs`, sidebar order
  // visibly drifts on remote rename / remote color / remote body updates.
  const APP_FILE = resolve(SRC_ROOT, "App.tsx");

  it("the sort effect's dependency array still includes docs", () => {
    const text = read(APP_FILE);
    // Find every useEffect deps array and verify the one wrapping a sortNotes
    // call includes `docs`. Cheap grep, but pinned enough to catch the
    // "removed docs from deps to skip per-autosave sort" regression.
    const sortBlock = text.match(/useEffect\(\(\) => \{[\s\S]*?sortNotes\([\s\S]*?\}, \[([\s\S]*?)\]\);/);
    expect(sortBlock, "sortNotes-driven useEffect not found in App.tsx").not.toBeNull();
    const deps = sortBlock![1].split(",").map((s) => s.trim());
    expect(deps).toContain("docs");
  });
});

describe("contract: switchDocument's prune detector consults the live editor", () => {
  // Regression class: the fast (fire-and-forget) switch path races
  // pruneEmptyCurrentDoc when isPruneCandidate is computed only from the
  // (potentially stale) docs[].content. A doc that the user just typed into
  // after autosave would look empty in liveDocs and get its file deleted while
  // a background save was still writing to it. The detector MUST read live
  // markdown from the editor so an empty-on-disk-but-typed-in-memory doc is
  // routed through the slow (await-flush) path.
  const FS_FILE = resolve(SRC_ROOT, "hooks/useFileSystem.ts");

  it("isPruneCandidate definition references getCurrentMarkdown(tiptapRef)", () => {
    const text = read(FS_FILE);
    const block = text.match(/const switchDocument[\s\S]*?const isPruneCandidate[\s\S]*?\n\n/);
    expect(block, "switchDocument's isPruneCandidate definition not found").not.toBeNull();
    expect(block![0]).toMatch(/getCurrentMarkdown\(tiptapRef\)/);
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
