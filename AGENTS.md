# Noten

Windows-native Markdown note app built with Tauri v2, React, and TypeScript. The app is Tauri-only — do not add browser fallbacks unless explicitly requested.

This file holds what applies everywhere: the map below, the dev workflow, the quality gates, and the code style. The implementation invariants — the "do not do X, because Y" rules — live beside the code they govern, so working in a directory brings its rules with it. Update the file that owns a rule in the same change that invalidates it, and put a new rule where its code lives rather than here.

## Where the rules live

| Path | What its `AGENTS.md` covers |
| --- | --- |
| `src/hooks/` | The persistence system: the canonical store, hydration, the save/manifest chain, cross-window sync, note lifecycle, folder reconcile, conflict backup, the recovery journal. The largest and most failure-prone area; read it before touching anything that writes to the notes folder. |
| `src/extensions/` | The Tiptap editor layer: Markdown serialization and parsing, plugins and decorations, wiki/anchor links, images, tables, Mermaid, off-screen block skipping. |
| `src/components/` | The React UI layer: Fluent usage, editor chrome, sidebar targeting and shortcuts, context menus, per-keystroke re-render limits. |
| `src/utils/` | Utilities that carry their own rule (logical lines, export). Its persistence modules are governed by `src/hooks/AGENTS.md`. |
| `src-tauri/` | The native layer: the capability allowlist, the `noten-asset` scheme, PDF export through headless Edge. |

Two documents sit outside that split: `docs/architecture.md` is the high-level map (repository layout, runtime boundaries, persistence model, sync flow, native/release layers), and `README.md` holds user-visible behavior.

## Principles

These hold across every layer, and most of the rules in the nested files are one of them applied to a specific mechanism:

- **Never destroy what you have not read.** An empty or missing value in memory is not evidence about what is on disk. Every path that deletes, overwrites, or backs up must first establish what it would be destroying; where it cannot, it defers rather than guessing.
- **Fail closed per unit, not per library.** A file that cannot be read is quarantined on its own. Refusing to act on one note is correct; taking the whole library down with it is not.
- **A failure must be visible and recoverable.** An error the user cannot see is a silent loss. An operation that cannot complete keeps its intent for a retry instead of acknowledging work it did not do.
- **Per-keystroke work stays incremental.** No plugin, observer, or component may re-derive whole-document state on every transaction.

## Local Dev Workflow

- `npm run tauri:dev` for normal development; it runs `scripts/prepare-helper.ps1` to prepare `src-tauri/resources/maintenance-helper.exe`, then starts `tauri dev`. `scripts/prepare-helper.ps1 -Release` builds only a release-mode helper, without bundling.
- `npm run check` chains `typecheck` + `lint` + `test`; `.github/workflows/ci.yml` runs the same on every push and PR to `main`.
- `npm run test:smoke` runs just `src/smoke/` — the cross-module suite described under Quality Gates. It is a subset of `npm test`, useful as a fast first signal after touching the store, persistence, reconcile, or group-merge paths.
- `node scripts/gen-notes.mjs --out <dir> --count <n> [--groups <n>]` writes a synthetic notes directory for measuring startup, sidebar, and search behavior at library sizes real test folders never reach. Development aid only; it refuses to overwrite an existing library without `--force`.
- `bench/` measures editor performance in the real app (release Rust, production frontend, WebView2) through CDP: load, typing, Enter, Hangul IME, autosave, scroll, CPU profiles and traces, over a public-domain + synthetic corpus at 100 KiB–10 MiB. It builds its own binary with identifier `com.noten.bench` so it never touches the `com.noten.app` library, and keeps its cache in `%LOCALAPPDATA%\noten-bench`. See `bench/README.md`; findings and the plan built on them are in `docs/2026-09-21-editor-performance.md`. Compare before/after with `bench/compare.mjs` whenever a change touches parsing, plugins, NodeViews, or editor CSS.
- `scripts/build-release.ps1` is a **local smoke test only** — it does not sign and is not what ships. It also fails at the Tauri step without `TAURI_SIGNING_PRIVATE_KEY` in env, because `bundle.createUpdaterArtifacts` is on.
## Quality Gates

- **ESLint** (`eslint.config.js`) enforces two narrow project invariants on top of TypeScript:
  - Durable writers (`metadataIO.ts`, `groupsIO.ts`, `conflictFileDetector.ts`, `migrateImageAssets.ts`, `recoveryJournal.ts`) must call `atomicWriteText`, never `fs.writeTextFile` directly. Add new durable writers to the allowlist explicitly. Note bodies, `.groups.json` and recovery records pass `{ failClosed: true }`: relaxed mode's fallback is a direct non-atomic overwrite, and for those two a torn write loses data no later pass can reconstruct (`.groups.json` is the only index of every group and every tombstone, and `readGroupsFile` rejects the whole library on truncated JSON). Their callers already treat a rejection as retryable.
  - `FileStat.mtime` and `birthtime` cannot be bypassed via non-null assertion or `as` cast; the `Date | null` shape must be handled explicitly. Tests are exempt.
- **Contract tests** (`src/utils/contracts.test.ts`) cover cross-file invariants ESLint cannot express cheaply — e.g. every external `setNotesDir` / `resetNotesDir` call site must pass the reconcile state. Keep them grep-based and add one for each new regression class.
- **Smoke tests** (`src/smoke/`) are the only suite that runs the real modules together: two windows over one in-memory folder, driving the real `libraryStore`, `persistDecomposedState`/`loadDecomposedState`, `reconcileFolder`, and `mergeDiskGroups`. They exist for the stale-snapshot class — a commit computed from a snapshot that went stale across an await, erasing a concurrent change — which every per-module suite misses because each module is individually correct. The Tauri-bound layers (the metadata mutation clocks in `useNotesLoader`, `useWindowSync`'s event channel, React projections) cannot be imported outside Tauri and are deliberately NOT modelled, so these tests assert membership, group metadata, and note existence — never title/pin/colour LWW. `windowHarness.test-utils.ts` reimplements thin adapters that MIRROR named production hooks: when you change one of those hooks, re-check the adapter whose doc comment names it, and give each window its own `FileSystem` facade — `readAllMeta` caches by FileSystem identity, and sharing one object would hand the tests fresher sidecars than a real second window ever sees.
- **Fault injection** (`src/utils/fs.fault.test-utils.ts`, `wrapWithFaults`) reproduces OneDrive placeholders, AV rename locks, transient network errors, and `mtime: null` cases that the bare `InMemoryFileSystem` cannot.
- **Crash log**: fatal/recoverable errors flow through `NotenError` + `logNotenError` into `AppData/Roaming/com.noten.app/crash.log` (capped, per-component truncation in `formatLine`). `initCrashLog()` also captures uncaught `error` / `unhandledrejection` events. `logNotenError` also routes fatals through `notifyFatal`, and App.tsx must keep a handler registered (`registerFatalHandler`) so they surface in the running app — throttled per code, since a failing autosave retries every second. crash.log alone is not a user-visible surface: a read-only notes folder looked exactly like a healthy app until the close gate refused to quit.
## Release and Updater

Releases are fully automated by `.github/workflows/release.yml`, triggered by pushing any `v*` tag. Do not build shippable installers locally.

To cut a release:

1. Edit `package.json`'s `version`, then run `npm run sync-version`. The script propagates it to `package-lock.json`, `src-tauri/tauri.conf.json`, the four `Cargo.toml` files, and our entries in both `Cargo.lock` files. The `v…` label in `SettingsModal.tsx` reads `getVersion()` at runtime and needs no sync — add a new entry to the script only if you introduce another hardcoded version site.
2. Rewrite `changelog.json` at the repository root (Korean + English arrays, same line count). This is human-written copy and is intentionally not touched by the script. `SettingsModal` bundles it as the running build's highlights, and the release workflow copies it into the updater manifest's `notes`, so the About tab shows the *new* version's highlights at check time, before the update is installed. The workflow validates the file before injecting it and fails the release rather than shipping notes the app would reject: it applies every rule `parseChangelogNotes` applies (both `ko` and `en`, case-sensitive; 1-20 non-empty lines each; at most 300 characters per line) plus one the app does not — the two locales must have the same number of lines. Notes that do not parse as this shape (older releases, hand-written text) fall back to rendering the raw body.
3. Commit, push `main`, then `git tag -a vX.Y.Z <commit> -m …` and push the tag.

CI builds the helper, runs the commit-SHA-pinned `tauri-apps/tauri-action` v1 to produce signed updater artifacts, rewrites `latest.json`'s `notes` from `changelog.json`, then builds and Authenticode-signs the bootstrapper. The result is a **draft** release that must be reviewed and **manually published** — only then does the in-app updater see it, because the endpoint (`.../releases/latest/download/latest.json`) resolves `latest` to the most recent *published* release.

- Production publishing requires `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `CODE_SIGN_PFX`, and `CODE_SIGN_PFX_PASSWORD`. The Authenticode step is conditional when the PFX is absent, but an unsigned bootstrapper must not be published as a production release.
- The Tauri pubkey in `tauri.conf.json` must stay paired with the private key — rotating one without the other breaks updates for existing installs.
- Two installers exist per release: `noten-setup.exe` (the bootstrapper, what fresh-install downloads should link to) and `Noten_X.Y.Z_x64-setup.exe` (the raw NSIS bundle, present only because `latest.json` points at it as the update payload).
- The app performs one background update check after startup; SettingsModal can also check manually. On Windows with `installMode: quiet`, `useUpdater` calls `update.downloadAndInstall()`, then exposes a restart action calling `relaunch()`.
## Code Style

- PascalCase file names for components; camelCase for hooks; either under `src/extensions/`. Shared styles in `src/styles/`, shared utilities in `src/utils/`, tests colocated with the module they cover.
- Comments should explain non-obvious invariants, race/concurrency constraints, data-loss risks, or platform quirks. Do not add comments that restate nearby code, narrate ordinary control flow, or preserve temporary implementation history.
- Prefer short English comments in complete sentences. Avoid decorative section banners and numbered step comments unless they clarify a long algorithm. Keep JSDoc for exported APIs only when it documents behavior the type signature does not already make clear.
- A few shared utilities exist specifically to keep a rule in one place — prefer them over reimplementing:
  - `src/utils/concurrency.ts` — `mapWithConcurrency`, the bounded fan-out for startup body reads (an unbounded `Promise.all` over every note stampedes the IPC bridge and cloud-folder placeholder hydration).
  - `src/utils/docsSignature.ts` — `sortSignature`, the allocation-free change detector gating App.tsx's re-sort effect.
  - `src/utils/noteId.ts` — note id validation before use as a filesystem path segment.
  - `src/utils/migrationJournal.ts` / `migrationCleanup.ts` — crash-safe deferred cleanup of a migrated notes directory.
