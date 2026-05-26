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

A clean, fast and modern Markdown note-taking app for Windows.
Powered by [Tiptap](https://tiptap.dev/), edited as WYSIWYM with Markdown as the on-disk format.


## Features
- **WYSIWYM Markdown editor** - A single always-editable Tiptap surface backed by Markdown on disk
- **Slash commands** - Type `/` to insert headings, lists, code blocks, images, tables, Mermaid diagrams, and more
- **Tables** - Insert with a grid picker, resize columns in-place, and edit rows/columns from the table bubble toolbar
- **Mermaid diagrams** - Render Mermaid code blocks inline, collapse source, and export diagrams as SVG or PNG
- **Image support** - Drag & drop, paste, resize with corner handles, and drag to reorder
- **Note management** - Sidebar with grouping, pinned notes, color labels/filtering, multi-select, drag reorder, full-text search, and context menus
- **Recently deleted** - Soft-delete with 14-day retention and restore
- **Shared folder sync** - Use OneDrive, Dropbox, or another synced folder to share notes across PCs with metadata merge and conflict backups
- **Multi-window** - Open notes in separate windows with real-time cross-window sync
- **Mica theme** - Native Windows 11 Mica material with dark/light mode
- **Export** - Save notes as Markdown or PDF; save Mermaid diagrams as SVG or PNG

## Tech Stack

### Core
- [Tauri v2](https://v2.tauri.app/) - Rust backend, WebView frontend
- [React 19](https://react.dev/) - UI framework

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
| Open file | `Ctrl+O` |
| Save now | `Ctrl+S` |
| Show toolbar / status bar | `Click editor` / scroll up / top of document |
| Find in document | `Ctrl+F` |
| Find and replace | `Ctrl+H` |
| Go to line | `Ctrl+G` |
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

- Use `npm run tauri:dev` for local app development. It prepares `maintenance-helper.exe` in Tauri resources and then starts `tauri dev`.
- Use `npm run check` before shipping changes. It runs typecheck, lint, and tests.
- Treat `.\scripts\build-release.ps1` as a local smoke test only. Real release installers are built and signed by GitHub Actions after a `v*` tag is pushed.

## License
MIT

© 2026 Mingwan Bae
