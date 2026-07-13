<p>
  <img src="public/Noten_icon.png" alt="Noten" width="128" height="128" />
</p>

# Noten

<p>
<img width="1994" height="1607" alt="스크린샷 2026-05-24 115950" src="https://github.com/user-attachments/assets/41f996bf-a74c-4416-a662-ed1ebf6daa0a" />
</p>

[![License](https://img.shields.io/github/license/ghostface2232/Noten?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ghostface2232/Noten?style=flat-square)](https://github.com/ghostface2232/Noten/releases)
![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)

A clean, fast and modern local-first Markdown note-taking app for Windows.
Powered by [Tiptap](https://tiptap.dev/), edited as WYSIWYM with Markdown as the on-disk format.

## Download

Download `noten-setup.exe` from [GitHub Releases](https://github.com/ghostface2232/Noten/releases) for a fresh installation.


## Features
- **WYSIWYM Markdown editor** - A persistent Tiptap surface that becomes editable when a document is ready, backed by Markdown on disk
- **Local-first autosave** - Notes stay on disk and save automatically; choose the app directory or a local/cloud-synced folder
- **Slash commands** - Type `/` to insert headings, lists, code blocks, images, tables, Mermaid diagrams, and more
- **Wiki links** - Type `[[` to link or create notes; links keep following notes when they are renamed
- **Tables** - Insert with a grid picker, resize columns in-place, and edit rows/columns from the table bubble toolbar
- **Mermaid diagrams** - Render Mermaid code blocks inline, collapse source, and export diagrams as SVG or PNG
- **Image support** - Drag & drop, paste, resize with corner handles, and drag to reorder
- **Note management** - Sidebar with grouping, pinned notes, color labels/filtering, multi-select, drag-and-drop group assignment, group reordering, full-text search, and context menus
- **Recently deleted** - Soft-delete with immediate undo, restore, and 14-day retention
- **File import** - Import Markdown and text files as managed Noten notes
- **Shared folder sync** - Use OneDrive, Dropbox, or another synced folder to share notes across PCs with metadata merge and conflict backups
- **Multi-window** - Open notes in separate windows with real-time cross-window sync
- **Customizable writing** - Light, dark, or system theme; font, wrapping, spacing, spellcheck, sorting, and optional pinned editor chrome
- **Mica theme** - Native Windows 11 Mica material
- **Export** - Save notes as Markdown or PDF; save Mermaid diagrams as SVG or PNG

## Tech Stack

### Core
- [Tauri v2](https://v2.tauri.app/) - Rust backend, WebView frontend
- [React 19](https://react.dev/) - UI framework
- [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vite.dev/) - Frontend language and build tooling

### Editor
- [Tiptap](https://tiptap.dev/) v3 with `@tiptap/markdown` - WYSIWYM editor over Markdown

### Design
- [Fluent UI v9](https://react.fluentui.dev/) - Component library & design tokens
- [Pretendard JP](https://github.com/orioncactus/pretendard) - Primary typeface
- [Noto Serif](https://fonts.google.com/noto/specimen/Noto+Serif) - Serif typeface
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) - Monospace typeface

## Keyboard Shortcuts

### Global
| Action | Shortcut |
|---|---|
| New note | `Ctrl+N` |
| New window | `Ctrl+Shift+N` |
| Import Markdown/text files | `Ctrl+O` |
| Show toolbar / status bar | `Click editor` / scroll up / top of document |
| Find in document | `Ctrl+F` |
| Find and replace | `Ctrl+H` |
| Go to line | `Ctrl+G` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Edit link | `Ctrl+K` |
| Strike-through | `Ctrl+Shift+X` |

### Sidebar (when sidebar is focused)
| Action | Shortcut |
|---|---|
| Rename | `Ctrl+R` / `F2` |
| Duplicate | `Ctrl+D` |
| Export | `Ctrl+E` |
| Pin / unpin | `Ctrl+Alt+P` |
| Copy content | `Ctrl+Alt+C` |
| Delete | `Delete` |

## Development

Development requires Windows, Node.js 24 (the CI version), and the stable Rust toolchain.

```powershell
npm ci
npm run tauri:dev
npm run check
```

`npm run tauri:dev` prepares `maintenance-helper.exe` in Tauri resources and then starts `tauri dev`. `npm run check` runs typecheck, lint, and tests.

Treat `.\scripts\build-release.ps1` as a local smoke test only. Real release installers are built and signed by GitHub Actions after a `v*` tag is pushed.

## Documentation

- [Source layout and architecture](docs/architecture.md)
- [`AGENTS.md`](AGENTS.md) - contributor invariants, data-safety rules, and release workflow

## License
MIT

© 2026 Mingwan Bae
