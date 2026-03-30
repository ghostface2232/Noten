<p>
  <img src="public/Aa_icon_1024.png" alt="Aa Editor" width="128" height="128" />
</p>

# Aa Editor
<p>
  A minimal, Mica-styled Markdown editor for Windows built with Tauri + React.
</p>

## Features
- **Dual editor** - Rich text (WYSIWYG) and Markdown side by side, switchable with `Ctrl+/`
- **Slash commands** - Type `/` to insert headings, lists, code blocks, images, and more
- **Note management** - Sidebar with grouping, multi-select, drag reorder, search, and context menus
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

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development
```bash
npm install
npm run tauri dev
```

### Build
```bash
npm run tauri build
```
The installer will be generated in `src-tauri/target/release/bundle/`.

## Keyboard Shortcuts
| Action | Shortcut |
|---|---|
| New file | `Ctrl+N` |
| New window | `Ctrl+Shift+N` |
| Save | `Ctrl+S` |
| Save as | `Ctrl+Shift+S` |
| Import file | `Ctrl+O` |
| Toggle edit mode | `Ctrl+E` |
| Switch editor | `Ctrl+/` |
| Find in document | `Ctrl+F` |

## License
MIT


`2026 Mingwan Bae`
