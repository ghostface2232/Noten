# Noten

Windows-native Markdown note app built with Tauri v2, React, and TypeScript.

## Core Architecture

- Markdown string is the serialization format and single source of truth on disk.
- Editing uses a single persistent Tiptap v3 instance with `@tiptap/markdown`. The user always edits WYSIWYM.
- The editor is `editable: true` whenever a document is ready, and stays readonly until the first document loads.

## Editor Chrome Visibility

- Toolbar and status bar visibility is driven by scroll position, not editor mode.
- At the top of the document, editor chrome is visible by default.
- Scrolling down past a short threshold hides editor chrome.
- Scrolling up or clicking inside the editor shows editor chrome again.

## Editor Synchronization

- Markdown is cached in `useMarkdownState.markdownRef` via `getCachedMarkdown` / `primeMarkdown`.
- Tiptap's `onUpdate` marks the cache stale; `scheduleAutoSave`'s `createSnapshot` refreshes it via `editor.getMarkdown()` + `primeMarkdown()`.
- `primeMarkdown(md)` is called whenever content is loaded imperatively (initial load, switchDocument, newNote, handleActiveDocChanged, etc.).
- `TiptapEditorHandle.setContent(md)` loads content with `emitUpdate: false` to avoid feedback loops; callers also call `primeMarkdown(md)` to keep the cache in sync (handled centrally by `resetDocState`).

## Persistence

- App settings are stored in `AppData/Roaming/com.noten.app/settings.json` via Tauri fs plugin.
- Shared note state is decomposed into note bodies (`<noteId>.md`), per-note metadata (`.meta/<noteId>.json`), and shared groups (`.groups.json`). Legacy `manifest.json` is migrated to `manifest.legacy.json`.
- Note metadata fields:
  - title / customName, created / updated timestamps, trash state.
  - group membership — has its own `groupUpdatedAt` clock so group moves resolve independently of body last-write-wins.
  - shared `pinned` state.
  - shared `color` label — one of a fixed 7-color palette in `src/utils/noteColors.ts`. Syncs like `pinned` (independent metadata that propagates even while the body is locally dirty) and does not bump `updatedAt`.
- Active note and group collapsed state are per-machine UI state, not shared sync state.
- Local cache includes `imageAssetMigrationV1CompletedAt` to track one-time image asset migration completion per notes directory.
- Sidebar open/close state and width are stored in localStorage.
- Notes created by the app are stored under the app data `notes` directory.
- `appDataDir()` may not include a trailing separator; always check before joining paths.
- The app is Tauri-only. Do not add browser fallbacks unless explicitly requested.

## Capability Surface

Noten's privacy posture is "your notes never leave the disk," and it should stay verifiable through the Tauri capability allowlist in `src-tauri/capabilities/default.json`:

- File access uses the broad `fs:read-all` / `fs:write-all` commands but is constrained by `fs:scope` to `$APPDATA`, `$APPLOCALDATA`, and `$HOME`. Do not widen this scope without a concrete need.
- There is no HTTP-client plugin. The only outbound network is `tauri-plugin-updater` (checks GitHub releases) and `opener` (hands links to the system browser; it does not transmit note content). Do not add `http:` or other network permissions just to make a feature easier — a local-first note app should not phone home.

## External vs Internal Documents

- Internal documents live in the app's `notes` directory and are auto-saved (1s debounce).
- Shared notes directories such as OneDrive/Dropbox are supported by file-based sync; metadata/group writes are merged so different PCs do not rely on one monolithic manifest.
- Remote body conflicts are last-write-wins with previous remote body backups under `.conflicts/`. `.conflicts/` travels with the notes directory on a folder change/migration; a `merge` migration also backs up an about-to-be-overwritten destination body there before applying last-write-wins.
- `reconcileFolder` does not delete a `.meta/<noteId>.json` the instant its body file is missing — on a mid-sync cloud folder the sidecar can arrive before its body:
  - An orphan meta is deleted only after a per-id grace (observed bodyless on a prior non-bulk reconcile pass).
  - The whole sweep is skipped when many metas are bodyless at once (bulk guard — likely mid-sync).
- Auto-save uses `activeDocRef` (sync ref) to track the active document, not React state's `activeIndex`, to prevent wrong-doc writes after rapid switching.
- `notifyActiveDoc(id, filePath)` must be called in every code path that switches the active document (switchDocument, newNote, importFiles, duplicateNote, restoreNote). `deleteNote` does not call it directly because it relies on the subsequent active-index change to flow through normal state.
- `cancelDocSave(docId)` cancels pending autosave timers for a specific doc. Called in deleteNote to prevent orphan writes.
- `hasPendingChangesRef` (sync ref) tracks whether `scheduleAutoSave` was called, used by `flushAutoSave` to skip saving view-only documents.
- `onCloseRequested` handler in App.tsx awaits `flushAutoSave` before window close.
- Empty notes (no content, no customName) are auto-deleted when leaving via `pruneEmptyCurrentDoc`. Applied in switchDocument, newNote, importFiles, duplicateNote, and restoreNote. Pruning removes both the `.md` body and its `.meta/<noteId>.json` sidecar so no orphan metadata is left behind.
- `Ctrl+O` imports selected files into the app notes directory and creates managed internal notes (new note IDs and note files).
- Imported notes are treated the same as other internal notes (auto-save enabled, normal delete/duplicate/restore flow).
- Rename updates the note title metadata (and sets `customName`), not the underlying `.md` file path.
- `customName` flag on a document means the user manually renamed it; auto-title derivation is permanently disabled for that document.
- Pinned notes sort before unpinned notes, with the active sort order preserved within each partition. In groups, pinned notes stay at the top of that group; ungrouped pinned notes stay at the top of the ungrouped list.

## Current Settings Model

- Theme, locale, note sort order, paste formatting, spellcheck, wrap mode, font family, group layout, paragraph spacing, notes directory, and the active sidebar color filter (`colorFilter`) are user settings.
- Note sort order supports six options: `updated-desc`, `updated-asc`, `created-desc`, `created-asc`, `title-asc`, `title-desc` (default: `updated-desc`).
- Old values `recent-first`/`recent-last` are auto-migrated on load.

## Images

- Markdown image sources use note-local relative asset paths: `.assets/<noteId>/<hash>.<ext>`.
- Legacy base64 images are supported for compatibility (`allowBase64: true`) and are migrated on startup once per notes directory.
- Startup migration converts `data:image/...` sources in markdown to asset files and marks completion via `imageAssetMigrationV1CompletedAt`.
- On insert/replace/drop/paste, images are written to note-local assets and inserted with relative `.assets/...` sources.
- The Image extension keeps a custom NodeView (`createImageNodeView`) for resize handles, drag reorder, context menu, and asset-source rendering.
- Image NodeViews share one per-editor `transaction` subscription (`registerImageSelectionSync` in `ImageView.ts`) that re-syncs selection outlines only when the node-selected position or readonly flag changes. Do not re-add a per-NodeView `editor.on("transaction")` listener — that made selection bookkeeping O(images) on every keystroke.
- Asset-path images are rendered by reading file bytes and resolving to displayable data URLs in the NodeView.
- When `width`/`height` are set, `renderMarkdown` outputs `<img>` HTML tags to preserve dimensions through markdown round-trips.
- On insert (pick, drop, paste), images are capped to 560px width with aspect ratio preserved. Clamping uses `clampImageDimensions` from `imageUtils.ts`.
- Image height is always `auto` (CSS) — only width is set as px to prevent aspect ratio distortion on narrow viewports.
- Images in the editor show `move` cursor and can be dragged to reorder via `ImageReorder.ts`.
- Image drag reorder: `ImageView.ts` detects a 6px threshold on `pointerdown`, then delegates to `startReorder()` which creates a ghost preview, drop indicator, and handles the transaction in a single undo step.
- Ctrl+C on a selected image copies the image blob to clipboard (not HTML), for both base64 and asset-path sources.

## Tables and Mermaid

- Tables use Tiptap v3 table extensions with `lastColumnResizable: false` so dragging an inner column redistributes width instead of growing the table past the editor width.
- Table insertion uses the toolbar grid picker; row/column/header/delete commands live in `TableBubbleMenu`.
- Empty table cells may serialize through `&nbsp;`; `stripTableCellNbsp` normalizes table-row markdown before load/save.
- Mermaid diagrams are `mermaid` code blocks rendered by the custom `MermaidCodeBlock` NodeView. Keep its source/preview toggle and SVG/PNG export controls inside the NodeView.
- Mermaid SVG/PNG export uses `src/extensions/mermaidExport.ts` and context-menu helpers from `contextMenuRegistry`; user-visible Mermaid labels must go through `src/i18n.ts`.
- Exported SVGs round-trip their source: `mermaidExport.ts` embeds the original Mermaid source via `embedMermaidSourceInSvg` (from `src/extensions/mermaidSourceMetadata.ts`), and `ImageDrop.ts` restores a marked SVG back into an editable Mermaid block via `extractMermaidSourceFromSvg`.

## Editor Decorations

- In-editor find (`SearchHighlight.ts`): `findSearchMatches` is the single match finder shared by `SearchBar` and the plugin. The full match list backs the counter, next/prev, and replace-all, but only `SEARCH_DECORATION_CAP` (2000) decorations are drawn — `selectMatchesToDecorate` picks those nearest the visible range, fed by a scroll-driven plugin `view` (falling back to a window around the active match). Keep the count truthful and the drawn set bounded; do not decorate every match.
- Wiki-link "missing link" decorations (`WikiLink.ts`): a target note's existence changes only via the forced refresh meta (`refreshWikiLinkDecorations`, dispatched from `App.tsx` when the docs/title set or locale changes), so a plain edit remaps the existing `DecorationSet` and recomputes only the changed range — it does not rebuild the whole set per keystroke. `findDocByTitle` is O(1) via a title map cached per `docs` array reference.

## Context Menus

- All context menus use shared helpers from `src/utils/contextMenuRegistry.ts` (`createMenuShell`, `createMenuItem`, `createMenuSeparator`).
- Only one context menu can be open at a time (singleton registry).
- All menus are clamped to the viewport via `clampMenuToViewport()`, accounting for the 25px status bar at the bottom.
- Image context menu: save, copy, replace, delete.
- Text context menu: cut, copy, paste, paste plain text, select all, emoji. All context menu items have Fluent UI icons.
- Tiptap uses `TextContextMenuContext` as the shared text context menu interface.

## Tiptap Markdown Rules

Use the official `@tiptap/markdown` API only:

- Serialize with `editor.getMarkdown()`
- Load markdown with `editor.commands.setContent(value, { contentType: "markdown" })`
- Initialize with `contentType: "markdown"`

Do not use old community-package APIs such as `editor.storage.markdown.getMarkdown()`.

- Copying selected text uses a `clipboardTextSerializer` (`sliceToPlainText` in `src/utils/clipboardText.ts`) that joins block boundaries with a single `\n` (and hard breaks with `\n`) so pasted plain text matches the on-screen line count. Only `text/plain` is overridden; `text/html` is left to ProseMirror, so rich targets (e.g. Notion) keep formatting and in-app paste still round-trips via `data-pm-slice`.

- The `Markdown` extension is configured with a custom marked instance: `Markdown.configure({ marked: createFastMarked() })` from `src/extensions/fastMarkdownLexer.ts`.
  - Why: stock marked's inline lexer is O(n²) on a single large block (no blank lines) dense with code spans, links, HTML, or escapes — a multi-million-char note on one line froze the app for minutes. `FastLexer` builds marked's inline mask in one linear pass; its output is byte-identical, so do not revert to the bare `Markdown` extension.
  - Guard: `fastMarkdownLexer.test.ts` fuzzes token-tree equivalence against stock marked and fails if a marked upgrade reshapes `Lexer.inlineTokens`. When that happens, re-transcribe only the main tokenization loop from the new version.

## UI Conventions

- Use Fluent UI v9 components for app chrome.
- Use only `@fluentui/react-icons`.
- The editor surface (`.ProseMirror`) should read shared colors from CSS variables in `src/styles/theme.css`.
- The editor content column (`.ProseMirror`) is capped at `--editor-max-width` (1400px) and centered, leaving gutters on wide windows; the surrounding area stays clickable/scrollable.
- Preserve the existing visual language; do not introduce unrelated icon sets or browser-style controls.
- All user-visible strings must go through the i18n system (`src/i18n.ts`). Do not hardcode locale checks inline.
- Toolbar and status bar share the same scroll-driven visibility behavior.
- Toolbar layout: Undo/Redo in column 1, formatting tools centered in column 2, Search and Go-to-line in column 3; when width < 740px the formatting tools wrap to row 2.
- Browser/WebView shortcuts that would interfere with app behavior are blocked. This includes reload, DevTools, print, source view, caret browsing, zoom, and browser back/forward. Ctrl+R is unblocked when sidebar has focus (used for rename). Ctrl+S is swallowed (no-op) since autosave persists continuously — there is no manual-save shortcut.
- The sidebar body slides between two panes: the root view (groups section + ungrouped notes section) and an "All Notes" drill-in — a flat list of every note (groups ignored, pinned first, current sort order). Clicking the "All Notes" entry atop the group list opens the drill-in; its header or `Escape` returns. Drag-to-group works only in the root view.
- A note's color label is set from the note context menu (or, in select mode, the bulk right-click menu) and tints the note's sidebar icon. The sidebar "filter" button opens a swatch popover; picking a color filters the sidebar to a flat list of only that color's notes (composes with search; reuses the search flat-list rendering path, so drag is inert while filtered). The filter persists across restarts.
- Sidebar shortcuts (Ctrl+D, Ctrl+R, F2, Ctrl+E, Ctrl+Alt+P, Ctrl+Alt+C, Delete) are active when last mousedown was inside the sidebar. Tracked via `data-sidebar-active` attribute on `document.documentElement`.
- Toggling/resizing the sidebar updates the OS window min-size and grows a too-narrow window to fit (`ensureWindowFitsSidebar` in `App.tsx`). This is skipped while the window is maximized or fullscreen — mutating window size there pops it back to windowed (and shifts position) on Windows — and the deferred min-size is re-applied when the window is later restored, detected via `onResized`.
- Editor shortcuts include `Ctrl+Shift+X` for strike-through, `Ctrl+G` for Go to Line, and `Ctrl+H` for Find and Replace. All are handled at the window level via `useKeyboardShortcuts`, not inside individual editor keymaps.
- Sidebar shortcut hints are displayed in context menus. Shortcut style is unified across all menus (opacity 0.45, 12px, 24px left padding).

## Local Dev Workflow

- `npm run tauri:dev` for normal development. It runs `scripts/prepare-helper.ps1` to prepare `src-tauri/resources/maintenance-helper.exe`, then starts `tauri dev`.
- `scripts/prepare-helper.ps1 -Release` builds only a release-mode helper, without bundling.
- `scripts/build-release.ps1` is a **local smoke test only** — does not sign and is not what ships. It also fails at the Tauri step without `TAURI_SIGNING_PRIVATE_KEY` in env, because `bundle.createUpdaterArtifacts` is on. Real releases go through CI.
- `npm run check` chains `typecheck` + `lint` + `test`; `.github/workflows/ci.yml` runs the same on every push and PR to `main`.

## Quality Gates

- **ESLint** (`npm run lint`, `eslint.config.js`) enforces two narrow project invariants on top of TypeScript:
  - Durable writers (`metadataIO.ts`, `groupsIO.ts`, `conflictFileDetector.ts`) must call `atomicWriteText`, never `fs.writeTextFile` directly. Add new durable writers to the allowlist explicitly.
  - `FileStat.mtime` and `birthtime` cannot be bypassed via non-null assertion or `as` cast; the `Date | null` shape must be handled explicitly. Tests are exempt.
- **Contract tests** (`src/utils/contracts.test.ts`) cover cross-file invariants ESLint cannot express cheaply — e.g., every external `setNotesDir` / `resetNotesDir` call site must pass the reconcile state. Keep them grep-based and add new ones for each regression class.
- **Fault injection** (`src/utils/fs.fault.test-utils.ts`, `wrapWithFaults`) lets FS-level tests reproduce OneDrive placeholders, AV rename locks, transient network errors, and `mtime: null` cases that the bare `InMemoryFileSystem` cannot.
- **Crash log**: fatal/recoverable errors flow through `NotenError` + `logNotenError` and are appended to `AppData/Roaming/com.noten.app/crash.log` (capped, with per-component truncation in `formatLine`). `initCrashLog()` also captures uncaught `error` / `unhandledrejection` events.

## Release Process

Releases are fully automated by `.github/workflows/release.yml`, triggered by pushing any `v*` tag. Do not build shippable installers locally.

To cut a release:

1. Edit `package.json`'s `version`, then run `npm run sync-version`. The script (`scripts/sync-version.mjs`) propagates the new version to:
   - `package-lock.json` (root + root package entry)
   - `src-tauri/tauri.conf.json`
   - the four `Cargo.toml` (`src-tauri`, `bootstrapper`, `maintenance-helper`, `noten-splash-ui`)
   - our entries in `Cargo.lock` + `src-tauri/Cargo.lock`
   - the `v…` label in `SettingsModal.tsx`

   Add a new entry only if you introduce another hardcoded version site.
2. Rewrite the SettingsModal changelog block (Korean + English) — this is human-written copy and is intentionally not touched by the script.
3. Commit, `git push origin main`, then `git tag -a vX.Y.Z <commit> -m …` and `git push origin vX.Y.Z`.

CI then:

1. Builds the helper.
2. Runs `tauri-action@v0` — signs updater artifacts with `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` and creates a **draft** release holding the NSIS bundle, `.sig`, and `latest.json`.
3. Copies the NSIS into `bootstrapper/assets/nsis-payload.exe` and builds `noten-setup.exe`.
4. Authenticode-signs `noten-setup.exe` via `signtool` with `CODE_SIGN_PFX`/`_PASSWORD`.
5. Uploads the signed bootstrapper to the same draft release.

The draft must be reviewed and **manually published** on GitHub — only then does the in-app updater see it.

Required secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `CODE_SIGN_PFX`, `CODE_SIGN_PFX_PASSWORD`. The Tauri pubkey in `tauri.conf.json` must stay paired with the private key — rotating one without the other breaks updates for existing installs.

## Updater

- Uses `tauri-plugin-updater`, configured in `tauri.conf.json` under `plugins.updater`.
- Endpoint is `https://github.com/<org>/Noten/releases/latest/download/latest.json` — GitHub resolves `latest` to the most recent **published** release, so draft releases are invisible. Publishing the draft is what actually rolls out an update.
- `installMode: quiet` on Windows: download in background, install on next launch via `Update.installAndRestart()` from the SettingsModal "Check for updates" UI.
- Two installers exist on each release: `noten-setup.exe` (the bootstrapper, what fresh-install downloads should link to) and `Noten_X.Y.Z_x64-setup.exe` (the raw NSIS bundle, present only because `latest.json` points at it as the update payload).

## Tiptap v3 Import Rules

- Import menus from `@tiptap/react/menus`
- Import `Markdown` from `@tiptap/markdown`
- Use Tiptap v3 package paths, not v2 examples

## Shared Utilities

- `src/utils/imageUtils.ts` — `bytesToDataUrl`, `dataUrlToUint8Array`, `mimeFromExt`, `mimeToExt`, `mimeFromDataUrl`, `clampImageDimensions`
- `src/utils/imageAssetUtils.ts` — document image context, asset path helpers, asset write/read, renderable source resolution
- `src/utils/migrateImageAssets.ts` — one-time markdown migration from base64 image sources to `.assets/...` paths
- `src/utils/contextMenuRegistry.ts` — `closeContextMenu`, `createMenuShell`, `createMenuItem`, `createMenuSeparator`, `isDarkTheme`
- `src/utils/clampMenuPosition.ts` — `clampMenuToViewport`
- `src/utils/clipboardText.ts` — `sliceToPlainText` (clipboard `text/plain` serialization)
- `src/extensions/mermaidExport.ts` — self-contained SVG serialization and transparent-background PNG export for rendered Mermaid diagrams
- `src/extensions/mermaidSourceMetadata.ts` — `embedMermaidSourceInSvg` / `extractMermaidSourceFromSvg`, storing the Mermaid source in the SVG `<metadata>` under a private namespace so export/import round-trips losslessly

## Code Style

- Components: PascalCase file names
- Hooks: camelCase file names
- Extensions: camelCase or PascalCase file names under `src/extensions/`
- Shared styles: `src/styles/`
- Shared utilities: `src/utils/`
- Comments should explain non-obvious invariants, race/concurrency constraints, data-loss risks, or platform quirks.
- Do not add comments that restate nearby code, narrate ordinary control flow, or preserve temporary implementation history.
- Prefer short English comments in complete sentences. Avoid decorative section banners and numbered step comments unless they clarify a long algorithm.
- Keep JSDoc for exported APIs only when it documents behavior not already clear from the type signature.
