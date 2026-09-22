import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

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

  it("use-selected-only captures the conflict baselines before its setting commit", () => {
    // The commit's settings effect clears the baseline map; a capture after it
    // would hand the rollback an empty map.
    const text = read(APP);
    const body = text.match(/const handleChangeNotesDir[\s\S]*?\n  const handleResetNotesDir/)?.[0];
    expect(body, "handleChangeNotesDir not found").toBeDefined();
    const captureAt = body!.indexOf("snapshotKnownDiskContent()");
    const persistAt = body!.lastIndexOf("persistNotesDirectorySetting(newDir)");
    expect(captureAt).toBeGreaterThanOrEqual(0);
    expect(captureAt).toBeLessThan(persistAt);
    expect(body).toMatch(/revertNotesDirChange\([^)]*preservedBaselines\)/);
  });

  it("reset-notes-dir probes the default dir before any overwrite", () => {
    // An unconditional overwrite wiped a library left in the default folder by
    // an earlier migration's deferred or failed source clear, with no backup.
    const text = read(APP);
    const body = text.match(/const handleResetNotesDir[\s\S]*?\n  const \{/)?.[0];
    expect(body, "handleResetNotesDir not found").toBeDefined();
    const probeAt = body!.indexOf("hasExistingNotenData(defaultDir)");
    const drainAt = body!.indexOf("const manifestDrain = flushPersistence(");
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(drainAt);
    expect(body).not.toMatch(/migrateNotesDir\(oldDir, defaultDir, "overwrite"/);
  });

  it("both local migration paths enqueue the metadata barrier before raising the guard", () => {
    const text = read(APP);
    const change = text.match(/const handleChangeNotesDir[\s\S]*?\n  const handleResetNotesDir/)?.[0];
    const reset = text.match(/const handleResetNotesDir[\s\S]*?\n  const \{/)?.[0];
    expect(change, "handleChangeNotesDir not found").toBeDefined();
    expect(reset, "handleResetNotesDir not found").toBeDefined();

    for (const body of [change!, reset!]) {
      const enqueueAt = body.indexOf("const manifestDrain = flushPersistence(");
      const guardAt = body.indexOf("setMigrationInProgress(true)");
      const awaitAt = body.indexOf("const manifestSaved = await manifestDrain");
      expect(enqueueAt).toBeGreaterThanOrEqual(0);
      expect(guardAt).toBeGreaterThan(enqueueAt);
      expect(awaitAt).toBeGreaterThan(guardAt);
    }
  });
});

describe("contract: observed state commits through remote/reconcile adapters", () => {
  // Regression class: window-sync and watcher state must not be committed as
  // a local intent, and window-sync must express each event as one store
  // updater instead of nesting setActiveIndex inside a setDocs updater.
  const APP = resolve(SRC_ROOT, "App.tsx");
  const WINDOW_SYNC = resolve(SRC_ROOT, "hooks/useWindowSync.ts");
  const LOADER = resolve(SRC_ROOT, "hooks/useNotesLoader.ts");

  it("App wires useWindowSync to commitLibraryFromRemote and useFileWatcher to reconcile setters", () => {
    const text = read(APP);
    const sync = text.match(/useWindowSync\(\n([\s\S]*?)\n  \);/)?.[1];
    const watcher = text.match(/useFileWatcher\(\n([\s\S]*?)\n  \);/)?.[1];
    expect(sync, "useWindowSync call not found").toBeDefined();
    expect(watcher, "useFileWatcher call not found").toBeDefined();
    expect(sync).toContain("commitLibraryFromRemote");
    expect(sync).not.toMatch(/\bset(Docs|Groups|TrashedNotes|ActiveIndex)\b/);
    expect(watcher).toContain("setDocsFromReconcile");
    expect(watcher).toContain("setGroupsFromReconcile");
    expect(watcher).toContain("setActiveIndexFromReconcile");
    expect(watcher).not.toMatch(/\bset(Docs|Groups|ActiveIndex),/);
  });

  it("useWindowSync uses only the remote commit adapter and no React setters", () => {
    const text = read(WINDOW_SYNC);
    expect(text).not.toMatch(/\bset(Docs|Groups|TrashedNotes|ActiveIndex)\b/);
    expect(text).not.toContain("flushSync");
    expect(text).toContain("commitRemote((current) =>");
  });

  it("the store adapters no longer buffer nested active-index updates", () => {
    const text = read(LOADER);
    expect(text).not.toContain("nestedActiveUpdatesRef");
    expect(text).not.toContain("nested setDocs is not supported");
  });
});

describe("contract: hydration is generation-bound and pauses full persistence", () => {
  // Regression class: the loader effect used to gate its commits on strict
  // revision equality and re-run on locale/sort changes. A peer window's
  // commit mid-load then left the manifest-cache projection (empty bodies)
  // canonical, and a mid-load dep change tore the load down without restart.
  const LOADER = resolve(SRC_ROOT, "hooks/useNotesLoader.ts");

  it("hydration commits rebase through mergeHydratedLibrary, never commitIfCurrent", () => {
    const text = read(LOADER);
    const effect = text.match(/if \(!enabled \|\| initialized\.current\) return;[\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
    expect(effect, "load effect not found").toBeDefined();
    expect(effect).not.toContain("commitIfCurrent(");
    expect(effect).toContain("mergeHydratedLibrary(current, data, epoch");
    expect(effect).toMatch(/\}, \[enabled, reloadKey, commitLibraryForGeneration, commitWholeLibrary\]\);$/);
    expect(effect).toContain("if (!finished) initialized.current = false;");
  });

  it("flushPersistence and the persist job stay no-ops while hydrationInProgress", () => {
    const text = read(LOADER);
    const flush = text.match(/export async function flushPersistence[\s\S]*?\n\}/)?.[0];
    const persist = text.match(/async function persistLatestLibrarySnapshot[\s\S]*?\n\}/)?.[0];
    expect(flush).toBeDefined();
    expect(persist).toBeDefined();
    // Returns true, not undefined: the flush now reports whether everything
    // is durable, and a paused hydration is not an incomplete drain.
    expect(flush).toContain("if (hydrationInProgress) return true;");
    expect(persist).toContain("if (hydrationInProgress) return false;");
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
    // Anchor to the initializer expression alone (declaration up to its first
    // semicolon, which nothing inside the boolean chain contains). A wider
    // span covering switchDocument's head would let a future comment that
    // merely mentions getCurrentMarkdown satisfy the pin with the actual
    // editor read removed.
    const block = text.match(/const isPruneCandidate =[\s\S]*?;/);
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
    // readMeta may CLASSIFY a failure but never swallow one: a transiently
    // unreadable sidecar must not return null the way a missing one does, or
    // reconcile writes default metadata over it. A catch is allowed only when
    // it rethrows — readMeta distinguishes corrupt bytes (CorruptMetaError,
    // permanent) from an I/O failure (transient) for readAllMeta's quarantine.
    const catchBlocks = readMetaMatch![0].match(/catch\s*\([^)]*\)\s*\{[^{}]*\}/g) ?? [];
    const catchKeywords = readMetaMatch![0].match(/\bcatch\b/g) ?? [];
    // A nested or multi-block catch escapes the regex above, so require the
    // two counts to agree rather than silently checking fewer blocks.
    expect(catchBlocks.length).toBe(catchKeywords.length);
    for (const block of catchBlocks) expect(block).toMatch(/\bthrow\b/);
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

describe("contract: the close gate always has an escape", () => {
  // Regression: the undrained-save branch of onCloseRequested only ever called
  // preventDefault and showed an informational dialog. When the cause was not
  // fixable from the running app — a sidecar that stays unreadable, a notes
  // folder that is gone — the window could never be closed at all, and the app
  // could only be killed from Task Manager. The branch must keep offering a
  // confirm() the user can accept, not just a message().
  const APP = resolve(SRC_ROOT, "App.tsx");

  it("the unsaved-close branch reaches a confirm, not only a message", () => {
    const src = read(APP);
    const start = src.indexOf("onCloseRequested");
    expect(start).toBeGreaterThan(-1);
    // The handler body ends where the next top-level useEffect begins.
    const end = src.indexOf("useEffect(() => {", src.indexOf("}).then((fn)", start));
    const handler = src.slice(start, end > start ? end : undefined);

    expect(handler).toContain("close.unsavedBlocked");
    // The escape: a second attempt must offer to discard rather than refuse.
    expect(handler).toContain("close.unsavedDiscard");
    expect(handler).toMatch(/confirm\(\s*t\("close\.unsavedDiscard"/);
  });
});

describe("contract: fatal errors reach the user, not just crash.log", () => {
  // Regression: registerFatalHandler was defined in notenError.ts and never
  // called from anywhere, so every fatal NotenError went to crash.log and was
  // invisible in the running app. logNotenError already routes fatals through
  // notifyFatal, so the only missing piece was a registered handler.
  it("some non-test source registers a fatal handler", () => {
    const files = walk(SRC_ROOT).filter((f) => !f.endsWith("notenError.ts"));
    const registrars = files.filter((f) => /registerFatalHandler\s*\(/.test(read(f)));
    expect(registrars.length).toBeGreaterThan(0);
  });
});

describe("contract: unsaved edits get a last chance before the process ends", () => {
  // Tauri's quiet install ends the process from inside downloadAndInstall, so
  // the window never receives its close event and the drain that guards it
  // never runs — an unsaved edit simply went with the process. The hook must
  // await something before the installer, and App must supply it.
  it("useUpdater awaits a beforeInstall hook before downloadAndInstall", () => {
    const src = read(resolve(SRC_ROOT, "hooks/useUpdater.ts"));
    const beforeIdx = src.indexOf("beforeInstallRef?.current?.()");
    // The call, not the JSDoc above it that also names the method.
    const installIdx = src.indexOf("update.downloadAndInstall(");
    expect(beforeIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(beforeIdx).toBeLessThan(installIdx);
  });

  it("App supplies that hook and it journals, not just flushes", () => {
    const src = read(resolve(SRC_ROOT, "App.tsx"));
    const assignIdx = src.indexOf("beforeUpdateInstallRef.current =");
    expect(assignIdx).toBeGreaterThan(-1);
    const body = src.slice(assignIdx, assignIdx + 800);
    expect(body).toContain("flushAutoSave");
    // Flushing bodies alone is what failed before, twice over: if the folder
    // will not take the write the edit has to go somewhere this machine keeps,
    // and metadata-only writes (pin, colour, group, rename) are
    // fire-and-forget, so nothing else awaits them and the journal does not
    // cover them either.
    expect(body).toContain("flushManifestRef");
    expect(body).toContain("journalPendingEdits");
  });
});

describe("contract: recovery repoints the editor at what it restored", () => {
  // Applying a recovered body writes the file and commits the doc, but the
  // open note's editor still holds the PRE-recovery text. Its next keystroke
  // serializes that back over the restoration, so the recovery has to reload
  // the editor before anyone can type.
  it("the apply path reloads the editor for the active note", () => {
    const src = read(resolve(SRC_ROOT, "App.tsx"));
    const start = src.indexOf("recoverJournalledEdits(");
    expect(start).toBeGreaterThan(-1);
    const applyBody = src.slice(start, start + 3200);
    expect(applyBody).toContain("atomicWriteText");
    // The write runs under the per-doc lock and re-proves that the disk still
    // holds what the edit was made against: recovery decided from a read taken
    // several awaits earlier, and the editor is live by then.
    expect(applyBody).toContain("runExclusiveBodyWriteRef");
    expect(applyBody).toContain("markdownEqual(current, record.baseContent)");
    expect(applyBody).toContain("activeNoteId === record.docId");
    expect(applyBody).toContain("openDocument");
    expect(applyBody).toContain("primeMarkdown");
  });
});

describe("contract: customName only ever turns on", () => {
  // The three empty-note prunes (pruneEmptyCurrentDoc, newNote's willReplace,
  // restoreNote's pruneLeavingDoc) read customName as "the user named this"
  // and delete permanently, bypassing .trash and .conflicts. Because no user
  // action clears it, a copy of the title pair that has it off can never be
  // newer than one that has it on; keepManualTitle is that rule, and every
  // site that merges two copies must go through it.
  it("no code writes it off literally except the legacy trashed-note decomposition", () => {
    // Pins the premise against a new literal clear. A clear through a
    // variable is what the call-site test below guards against.
    const clears: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      for (const _hit of read(file).match(/customName\s*:\s*(false|undefined)\b/g) ?? []) clears.push(rel);
    }
    // Both write sidecars for notes already in the legacy trash.
    expect(clears.sort()).toEqual(["hooks/useNotesLoader.ts", "utils/migrateNotesDir.ts"]);
  });

  it.each([
    // mergeHydratedLibrary and the lifecycle mergeNoteMeta.
    ["hooks/useNotesLoader.ts", 2],
    // applyMetaChange.
    ["hooks/useFileWatcher.ts", 1],
    // persistDecomposedState, for live and trashed notes through one helper.
    ["utils/decomposedState.ts", 1],
    // mergeMetaForMigration.
    ["utils/migrateNotesDir.ts", 1],
  ])("%s merges title pairs through keepManualTitle", (file, sites) => {
    const calls = read(resolve(SRC_ROOT, file)).match(/\bkeepManualTitle\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(sites);
  });
});
