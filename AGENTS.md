# Noten

Windows-native Markdown editor built with Tauri v2, React, and TypeScript.

## Core Architecture

- Markdown string is the serialization format and single source of truth on disk.
- Editing uses a single persistent Tiptap v3 instance with `@tiptap/markdown`. The user always edits WYSIWYM.
- `Tiptap editable: true` whenever a document is ready; the editor remains readonly until the first document loads.

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
- Note manifest (file list, groups, active note) is stored as `manifest.json` in the notes directory (file-based). localStorage is used only as a one-time migration fallback.
- Manifest includes `imageAssetMigrationV1CompletedAt` to track one-time image asset migration completion per notes directory.
- Sidebar open/close state and width are stored in localStorage.
- Notes created by the app are stored under the app data `notes` directory.
- `appDataDir()` may not include a trailing separator; always check before joining paths.
- The app is Tauri-only. Do not add browser fallbacks unless explicitly requested.

## External vs Internal Documents

- Internal documents live in the app's `notes` directory and are auto-saved (1s debounce).
- Auto-save uses `activeDocRef` (sync ref) to track the active document, not React state's `activeIndex`, to prevent wrong-doc writes after rapid switching.
- `notifyActiveDoc(id, filePath)` must be called in every code path that switches the active document (switchDocument, newNote, importFiles, duplicateNote, restoreNote). `deleteNote` does not call it directly because it relies on the subsequent active-index change to flow through normal state.
- `cancelDocSave(docId)` cancels pending autosave timers for a specific doc. Called in deleteNote to prevent orphan writes.
- `hasPendingChangesRef` (sync ref) tracks whether `scheduleAutoSave` was called, used by `flushAutoSave` to skip saving view-only documents.
- `onCloseRequested` handler in App.tsx awaits `flushAutoSave` before window close.
- Empty notes (no content, no customName) are auto-deleted when leaving via `pruneEmptyCurrentDoc`. Applied in switchDocument, newNote, importFiles, duplicateNote, and restoreNote.
- `Ctrl+O` imports selected files into the app notes directory and creates managed internal notes (new note IDs and note files).
- Imported notes are treated the same as other internal notes (auto-save enabled, normal delete/duplicate/restore flow).
- Rename updates the note title metadata (and sets `customName`), not the underlying `.md` file path.
- `customName` flag on a document means the user manually renamed it; auto-title derivation is permanently disabled for that document.

## Current Settings Model

- Theme, note sort order, paste formatting, spellcheck, wrap mode, font family, group layout, paragraph spacing, and notes directory are user settings.
- Note sort order supports six options: `updated-desc`, `updated-asc`, `created-desc`, `created-asc`, `title-asc`, `title-desc` (default: `updated-desc`).
- Old values `recent-first`/`recent-last` are auto-migrated on load.

## Images

- Markdown image sources use note-local relative asset paths: `.assets/<noteId>/<hash>.<ext>`.
- Legacy base64 images are supported for compatibility (`allowBase64: true`) and are migrated on startup once per notes directory.
- Startup migration converts `data:image/...` sources in markdown to asset files and marks completion via `imageAssetMigrationV1CompletedAt`.
- On insert/replace/drop/paste, images are written to note-local assets and inserted with relative `.assets/...` sources.
- The Image extension keeps a custom NodeView (`createImageNodeView`) for resize handles, drag reorder, context menu, and asset-source rendering.
- Asset-path images are rendered by reading file bytes and resolving to displayable data URLs in the NodeView.
- When `width`/`height` are set, `renderMarkdown` outputs `<img>` HTML tags to preserve dimensions through markdown round-trips.
- On insert (pick, drop, paste), images are capped to 560px width with aspect ratio preserved. Clamping uses `clampImageDimensions` from `imageUtils.ts`.
- Image height is always `auto` (CSS) — only width is set as px to prevent aspect ratio distortion on narrow viewports.
- Images in the editor show `move` cursor and can be dragged to reorder via `ImageReorder.ts`.
- Image drag reorder: `ImageView.ts` detects a 6px threshold on `pointerdown`, then delegates to `startReorder()` which creates a ghost preview, drop indicator, and handles the transaction in a single undo step.
- Ctrl+C on a selected image copies the image blob to clipboard (not HTML), for both base64 and asset-path sources.

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

## UI Conventions

- Use Fluent UI v9 components for app chrome.
- Use only `@fluentui/react-icons`.
- The editor surface (`.ProseMirror`) should read shared colors from CSS variables in `src/styles/theme.css`.
- Preserve the existing visual language; do not introduce unrelated icon sets or browser-style controls.
- All user-visible strings must go through the i18n system (`src/i18n.ts`). Do not hardcode locale checks inline.
- Toolbar and status bar share the same scroll-driven visibility behavior.
- Toolbar layout: Undo/Redo in column 1, formatting tools centered in column 2, Search and Go-to-line in column 3; when width < 740px the formatting tools wrap to row 2.
- Browser/WebView shortcuts that would interfere with app behavior are blocked. This includes reload, DevTools, print, source view, caret browsing, zoom, and browser back/forward. Ctrl+R is unblocked when sidebar has focus (used for rename).
- Sidebar shortcuts (Ctrl+D, Ctrl+R, F2, Ctrl+Alt+C, Delete) are active when last mousedown was inside the sidebar. Tracked via `data-sidebar-active` attribute on `document.documentElement`.
- Editor shortcuts include `Ctrl+Shift+X` for strike-through, `Ctrl+G` for Go to Line, and `Ctrl+H` for Find and Replace. All are handled at the window level via `useKeyboardShortcuts`, not inside individual editor keymaps.
- Sidebar shortcut hints are displayed in context menus. Shortcut style is unified across all menus (opacity 0.45, 12px, 24px left padding).

## Local Dev Workflow

- `npm run tauri:dev` for normal development. It runs `scripts/prepare-helper.ps1` to prepare `src-tauri/resources/maintenance-helper.exe`, then starts `tauri dev`.
- `scripts/prepare-helper.ps1 -Release` builds only a release-mode helper, without bundling.
- `scripts/build-release.ps1` is a **local smoke test only** — does not sign and is not what ships. It also fails at the Tauri step without `TAURI_SIGNING_PRIVATE_KEY` in env, because `bundle.createUpdaterArtifacts` is on. Real releases go through CI.

## Release Process

Releases are fully automated by `.github/workflows/release.yml`, triggered by pushing any `v*` tag. Do not build shippable installers locally.

To cut a release:

1. Bump the version everywhere it appears: `package.json`, `package-lock.json` (root + root package entry), `src-tauri/tauri.conf.json`, the four `Cargo.toml` (`src-tauri`, `bootstrapper`, `maintenance-helper`, `noten-splash-ui`), our entries in `Cargo.lock` + `src-tauri/Cargo.lock`, and the `v…` label in `SettingsModal.tsx`.
2. Rewrite the SettingsModal changelog block (Korean + English).
3. Commit, `git push origin main`, then `git tag -a vX.Y.Z <commit> -m …` and `git push origin vX.Y.Z`.

CI then builds the helper, runs `tauri-action@v0` (signs updater artifacts using `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` secrets and creates a **draft** release with the NSIS bundle, `.sig`, and `latest.json`), copies the NSIS into `bootstrapper/assets/nsis-payload.exe`, builds `noten-setup.exe`, Authenticode-signs it via `signtool` with `CODE_SIGN_PFX`/`_PASSWORD`, and uploads the signed bootstrapper to the same draft release.

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

## Code Style

- Components: PascalCase file names
- Hooks: camelCase file names
- Extensions: camelCase or PascalCase file names under `src/extensions/`
- Shared styles: `src/styles/`
- Shared utilities: `src/utils/`
- Keep comments short and only where they add real value
