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

- App settings are stored in `AppData/settings.json`.
- UI state such as open-note manifest is stored in `localStorage`.
- Notes created by the app are stored under the app data `notes` directory.
- The app is Tauri-only. Do not add browser fallbacks unless explicitly requested.

## Current Settings Model

- Theme, startup mode, note sort order, paste formatting, spellcheck, wrap mode, and paragraph spacing are user settings.
- Default note order is `recent-first`.
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
