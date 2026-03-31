<p>
  <img src="public/Noten_icon.png" alt="Noten" width="128" height="128" />
</p>

# Noten

[![License](https://img.shields.io/github/license/ghostface2232/Noten?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ghostface2232/Noten?style=flat-square)](https://github.com/ghostface2232/Noten/releases)
![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)

<p>
  A markdown and rich text editor inspired by Apple Notes and Notion — clean, fast, and built for Windows.
</p>

## Features
- **Dual editor** - Rich text (WYSIWYG) and Markdown side by side, switchable with `Ctrl+/`
- **Slash commands** - Type `/` to insert headings, lists, code blocks, images, and more
- **Image support** - Drag & drop, paste, resize with corner handles, and drag to reorder
- **Note management** - Sidebar with grouping, multi-select, drag reorder, search, and context menus
- **Recently deleted** - Soft-delete with 14-day retention and restore
- **Multi-window** - Open notes in separate windows with real-time cross-window sync
- **Mica theme** - Native Windows 11 Mica material with dark/light mode
- **Export** - Save notes as Markdown, PDF, or Rich Text
- **Cloud sync** - Set a cloud folder (OneDrive, Google Drive, etc.) as your notes directory to sync across devices
- **Auto-update** - In-app update checking via GitHub Releases
- **i18n** - English and Korean

## Tech Stack
- [Tauri v2](https://v2.tauri.app/) - Rust backend, WebView frontend
- [React 19](https://react.dev/) - UI framework
- [Fluent UI v9](https://react.fluentui.dev/) - Component library
- [Tiptap](https://tiptap.dev/) - Rich text editor
- [CodeMirror](https://codemirror.net/) - Markdown editor

## Keyboard Shortcuts

### Global
| Action | Shortcut |
|---|---|
| New document | `Ctrl+N` |
| New window | `Ctrl+Shift+N` |
| Open file | `Ctrl+O` |
| Save now | `Ctrl+S` |
| Toggle edit mode | `Ctrl+E` |
| Switch editor | `Ctrl+/` |
| Find in document | `Ctrl+F` |

### Sidebar (when sidebar is focused)
| Action | Shortcut |
|---|---|
| Rename | `Ctrl+R` |
| Duplicate | `Ctrl+D` |
| Export | `Ctrl+Shift+X` |
| Copy content | `Ctrl+Alt+C` |
| Delete | `Delete` |

## License
MIT

2026 Mingwan Bae
