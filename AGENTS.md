# Noten

Windows-native Markdown editor built with Tauri v2, React, and TypeScript.

## Core Architecture

- Markdown string is the single source of truth.
- Read mode and Rich Text edit mode share one persistent Tiptap instance.
- Mode switching between read and Rich Text must not replace the editor DOM.
- Markdown source editing uses CodeMirror and is mounted only while `editorMode === "markdown"`.

## Editing Modes

- Read: `Tiptap editable: false` (via ReadonlyGuard extension, not `editor.setEditable`)
- Edit / Rich Text: `Tiptap editable: true`
- Edit / Markdown: CodeMirror 6 with `@codemirror/lang-markdown`

## Editor Synchronization

- `flushCurrentEditor()` reads from whichever editor is currently active (Tiptap or CodeMirror) and syncs to state.
- It does not rely on dirty flags — always reads the current value directly, and only updates state if the value changed.
- `loadIntoTiptap(md)` loads content into Tiptap with `emitUpdate: false` to avoid feedback loops.
- Mode switching always calls `flushCurrentEditor()` before transitioning.

## Persistence

- App settings are stored in `AppData/Roaming/com.noten.app/settings.json` via Tauri fs plugin.
- Note manifest (file list, groups, active note) is stored as `manifest.json` in the notes directory (file-based). localStorage is used only as a one-time migration fallback.
- Sidebar open/close state and width are stored in localStorage.
- Notes created by the app are stored under the app data `notes` directory.
- `appDataDir()` may not include a trailing separator; always check before joining paths.
- The app is Tauri-only. Do not add browser fallbacks unless explicitly requested.

## External vs Internal Documents

- Internal documents live in the app's `notes` directory and are auto-saved (1s debounce).
- Auto-save uses `activeDocRef` (sync ref) to track the active document, not React state's `activeIndex`, to prevent wrong-doc writes after rapid switching.
- `notifyActiveDoc(id, filePath)` must be called in every code path that switches documents (switchDocument, newNote, deleteNote, importFiles, duplicateNote, restoreNote).
- `cancelDocSave(docId)` cancels pending autosave timers for a specific doc. Called in deleteNote to prevent orphan writes.
- `hasPendingChangesRef` (sync ref) tracks whether `scheduleAutoSave` was called, used by `flushAutoSave` to skip saving view-only documents.
- `onCloseRequested` handler in App.tsx awaits `flushAutoSave` before window close.
- Empty notes (no content, no customName) are auto-deleted when leaving via `pruneEmptyCurrentDoc`. Applied in switchDocument, newNote, importFiles, duplicateNote, and restoreNote.
- External documents are files opened via Ctrl+O from outside the notes directory.
- External documents are NOT auto-saved; the user must press Ctrl+S to write back to disk.
- Rename on external documents renames the actual file on disk.
- Delete on internal documents removes the file; external documents show "Close" instead (removes from sidebar only).
- Sidebar icon: `DocumentRegular` for internal, `FolderRegular` for external.
- External documents show a `●` dot when dirty; internal documents show no dirty indicator.
- `customName` flag on a document means the user manually renamed it; auto-title derivation is permanently disabled for that document.

## Current Settings Model

- Theme, startup mode, note sort order, paste formatting, spellcheck, wrap mode, font family, group layout, and paragraph spacing are user settings.
- Note sort order supports four options: `updated-desc`, `updated-asc`, `created-desc`, `created-asc` (default: `updated-desc`).
- Old values `recent-first`/`recent-last` are auto-migrated on load.
- Startup mode is configurable between read and edit.

## Images

- Images are stored as base64 data URLs in markdown.
- The Image extension uses `allowBase64: true` and a custom NodeView (`createImageNodeView`) for resize handles and context menu.
- When `width`/`height` are set, `renderMarkdown` outputs `<img>` HTML tags to preserve dimensions through markdown round-trips.
- On insert (pick, drop, paste), images are capped to 560px width with aspect ratio preserved. Clamping uses `clampImageDimensions` from `imageUtils.ts`.
- Image height is always `auto` (CSS) — only width is set as px to prevent aspect ratio distortion on narrow viewports.
- In Read mode, image selection, resize handles, outline, and drag are disabled. Cursor is `default`.
- In Edit mode, images show `move` cursor and can be dragged to reorder via `ImageReorder.ts`.
- Image drag reorder: `ImageView.ts` detects a 6px threshold on `pointerdown`, then delegates to `startReorder()` which creates a ghost preview, drop indicator, and handles the transaction in a single undo step.
- Ctrl+C on a selected image copies the image blob to clipboard (not HTML).

## Context Menus

- All context menus use shared helpers from `src/utils/contextMenuRegistry.ts` (`createMenuShell`, `createMenuItem`, `createMenuSeparator`).
- Only one context menu can be open at a time (singleton registry).
- All menus are clamped to the viewport via `clampMenuToViewport()`, accounting for the 25px status bar at the bottom.
- Image context menu: save, copy, replace, delete.
- Text context menu: cut, copy, paste, paste plain text, select all, emoji. Disabled items are grayed out in Read mode. All context menu items have Fluent UI icons.
- Both Tiptap and CodeMirror editors share the same context menu interface (`TextContextMenuContext`).

## Tiptap Markdown Rules

Use the official `@tiptap/markdown` API only:

- Serialize with `editor.getMarkdown()`
- Load markdown with `editor.commands.setContent(value, { contentType: "markdown" })`
- Initialize with `contentType: "markdown"`

Do not use old community-package APIs such as `editor.storage.markdown.getMarkdown()`.

## UI Conventions

- Use Fluent UI v9 components for app chrome.
- Use only `@fluentui/react-icons`.
- Editor surfaces (`.ProseMirror`, `.cm-editor`) should read shared colors from CSS variables in `src/styles/theme.css`.
- Preserve the existing visual language; do not introduce unrelated icon sets or browser-style controls.
- All user-visible strings must go through the i18n system (`src/i18n.ts`). Do not hardcode locale checks inline.
- Browser shortcuts (Ctrl+R, F5, F12, Ctrl+Shift+I) are blocked to prevent web-app behavior. Ctrl+R is unblocked when sidebar has focus (used for rename).
- Sidebar shortcuts (Ctrl+D, Ctrl+R, Ctrl+Shift+X, Ctrl+Alt+C, Delete) are active when last mousedown was inside the sidebar. Tracked via `data-sidebar-active` attribute on `document.documentElement`.
- Sidebar shortcut hints are displayed in context menus. Shortcut style is unified across all menus (opacity 0.45, 12px, 24px left padding).

## Tiptap v3 Import Rules

- Import menus from `@tiptap/react/menus`
- Import `Markdown` from `@tiptap/markdown`
- Use Tiptap v3 package paths, not v2 examples

## Shared Utilities

- `src/utils/imageUtils.ts` — `bytesToDataUrl`, `dataUrlToUint8Array`, `mimeFromExt`, `mimeToExt`, `mimeFromDataUrl`, `clampImageDimensions`
- `src/utils/contextMenuRegistry.ts` — `closeContextMenu`, `createMenuShell`, `createMenuItem`, `createMenuSeparator`, `isDarkTheme`
- `src/utils/clampMenuPosition.ts` — `clampMenuToViewport`

## Code Style

- Components: PascalCase file names
- Hooks: camelCase file names
- Extensions: camelCase or PascalCase file names under `src/extensions/`
- Shared styles: `src/styles/`
- Shared utilities: `src/utils/`
- Keep comments short and only where they add real value
