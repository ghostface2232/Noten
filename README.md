<p>
  <img src="public/Noten_icon.png" alt="Noten" width="128" height="128" />
</p>

# Noten

[![License](https://img.shields.io/github/license/ghostface2232/Noten?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ghostface2232/Noten?style=flat-square)](https://github.com/ghostface2232/Noten/releases)
![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)


A clean, fast and modern note-taking app for Windows, with Note and Markdown surfaces.
Powered by [Tiptap](https://tiptap.dev/) and [CodeMirror](https://codemirror.net/).


## Features
- **Note / Markdown surfaces** - An always-editable Note surface and an explicit Markdown source view switchable with `Ctrl+/`
- **Slash commands** - Type `/` to insert headings, lists, code blocks, images, and more
- **Image support** - Drag & drop, paste, resize with corner handles, and drag to reorder
- **Note management** - Sidebar with grouping, multi-select, drag reorder, full-text search, and context menus
- **Recently deleted** - Soft-delete with 14-day retention and restore
- **Multi-window** - Open notes in separate windows with real-time cross-window sync
- **Mica theme** - Native Windows 11 Mica material with dark/light mode
- **Export** - Save notes as Markdown, PDF, or Rich Text
- **Cloud sync** - Set a cloud folder (OneDrive, Google Drive, etc.) as your notes directory to sync across devices
- **Auto-update** - In-app update checking via GitHub Releases
- **i18n** - English and Korean

## Tech Stack

### Core
- [Tauri v2](https://v2.tauri.app/) - Rust backend, WebView frontend
- [React 19](https://react.dev/) - UI framework

### Editors
- [Tiptap](https://tiptap.dev/) - Rich text editor (Note surface)
- [CodeMirror](https://codemirror.net/) - Source editor (Markdown surface)

### Design
- [Fluent UI v9](https://react.fluentui.dev/) - Component library & design tokens
- [Pretendard JP](https://github.com/orioncactus/pretendard) - Primary typeface
- [Noto Serif](https://fonts.google.com/noto/specimen/Noto+Serif) - Serif typeface
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/) - Monospace typeface

## Keyboard Shortcuts

### Global
| Action | Shortcut |
|---|---|
| New document | `Ctrl+N` |
| New window | `Ctrl+Shift+N` |
| Open file | `Ctrl+O` |
| Save now | `Ctrl+S` |
| Switch Note / Markdown | `Ctrl+/` |
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
| Copy content | `Ctrl+Alt+C` |
| Delete | `Delete` |

## Development

- Use `npm run tauri:dev` for local app development. It prepares `maintenance-helper.exe` in Tauri resources and then starts `tauri dev`.
- Use `.\scripts\build-release.ps1` only when you want the full release output, including the final setup executable.

## License
MIT

© 2026 Mingwan Bae
