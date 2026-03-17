# Markdown Studio

Windows-native Markdown editor built with Tauri v2, React, and TypeScript.

## Core Architecture

- Markdown string is the single source of truth.
- Read mode and Rich Text edit mode share one persistent Tiptap instance.
- Mode switching between read and Rich Text must not replace the editor DOM.
- Markdown source editing uses CodeMirror and is mounted only while `editorMode === "markdown"`.

## Editing Modes

- Read: `Tiptap editable: false`
- Edit / Rich Text: `Tiptap editable: true`
- Edit / Markdown: CodeMirror 6 with `@codemirror/lang-markdown`

## Persistence

- App settings are stored in `AppData/Roaming/<identifier>/settings.json` via Tauri fs plugin.
- UI state such as open-note manifest is stored in `localStorage`.
- Notes created by the app are stored under the app data `notes` directory.
- `appDataDir()` may not include a trailing separator; always check before joining paths.
- The app is Tauri-only. Do not add browser fallbacks unless explicitly requested.

## External vs Internal Documents

- Internal documents live in the app's `notes` directory and are auto-saved.
- External documents are files opened via Ctrl+O from outside the notes directory.
- External documents are NOT auto-saved; the user must press Ctrl+S to write back to disk.
- Rename on external documents renames the actual file on disk.
- Delete on internal documents removes the file; external documents show "Close" instead (removes from sidebar only).
- Sidebar icon: `DocumentRegular` for internal, `Folder16Regular` for external.
- External documents show a `●` dot when dirty; internal documents show no dirty indicator.

## Current Settings Model

- Theme, startup mode, note sort order, paste formatting, spellcheck, wrap mode, and paragraph spacing are user settings.
- Note sort order supports four options: `updated-desc`, `updated-asc`, `created-desc`, `created-asc` (default: `updated-desc`).
- Old values `recent-first`/`recent-last` are auto-migrated on load.
- Startup mode is configurable between read and edit.

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

## Tiptap v3 Import Rules

- Import menus from `@tiptap/react/menus`
- Import `Markdown` from `@tiptap/markdown`
- Use Tiptap v3 package paths, not v2 examples

## Code Style

- Components: PascalCase file names
- Hooks: camelCase file names
- Shared styles: `src/styles/`
- Keep comments short and only where they add real value
