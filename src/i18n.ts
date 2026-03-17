import type { Locale } from "./hooks/useSettings";

const dict = {
  /* ─── TitleBar ─── */
  "app.name": { en: "Markdown Studio", ko: "Markdown Studio" },
  "mode.read": { en: "Read", ko: "읽기" },
  "mode.edit": { en: "Edit", ko: "편집" },
  "theme.light": { en: "Light", ko: "라이트" },
  "theme.dark": { en: "Dark", ko: "다크" },

  /* ─── EditorToolbar ─── */
  "editor.richtext": { en: "Rich Text", ko: "서식 편집" },
  "editor.markdown": { en: "Markdown", ko: "마크다운" },
  "heading.body": { en: "Body", ko: "본문" },
  "heading.h1": { en: "Heading 1", ko: "제목 1" },
  "heading.h2": { en: "Heading 2", ko: "제목 2" },
  "heading.h3": { en: "Heading 3", ko: "제목 3" },
  "tool.bold": { en: "Bold (Ctrl+B)", ko: "굵게 (Ctrl+B)" },
  "tool.italic": { en: "Italic (Ctrl+I)", ko: "기울임 (Ctrl+I)" },
  "tool.underline": { en: "Underline (Ctrl+U)", ko: "밑줄 (Ctrl+U)" },
  "tool.strike": { en: "Strikethrough", ko: "취소선" },
  "tool.code": { en: "Inline code", ko: "인라인 코드" },
  "tool.bulletList": { en: "Bullet list", ko: "글머리 기호 목록" },
  "tool.orderedList": { en: "Numbered list", ko: "번호 목록" },
  "tool.taskList": { en: "Task list", ko: "할 일 목록" },
  "tool.blockquote": { en: "Blockquote", ko: "인용문" },
  "tool.hr": { en: "Horizontal rule", ko: "구분선" },
  "tool.codeBlock": { en: "Code block", ko: "코드 블록" },
  "tool.image": { en: "Insert image", ko: "이미지 삽입" },
  "tool.undo": { en: "Undo (Ctrl+Z)", ko: "실행취소 (Ctrl+Z)" },
  "tool.redo": { en: "Redo (Ctrl+Y)", ko: "다시실행 (Ctrl+Y)" },

  /* ─── Slash commands ─── */
  "slash.text": { en: "Text", ko: "텍스트" },
  "slash.text.desc": { en: "Plain body text", ko: "일반 본문 텍스트" },
  "slash.h1": { en: "Heading 1", ko: "제목 1" },
  "slash.h1.desc": { en: "Large heading", ko: "큰 제목" },
  "slash.h2": { en: "Heading 2", ko: "제목 2" },
  "slash.h2.desc": { en: "Medium heading", ko: "중간 제목" },
  "slash.h3": { en: "Heading 3", ko: "제목 3" },
  "slash.h3.desc": { en: "Small heading", ko: "작은 제목" },
  "slash.bulletList": { en: "Bullet list", ko: "글머리 기호 목록" },
  "slash.bulletList.desc": { en: "Unordered list", ko: "순서 없는 목록" },
  "slash.orderedList": { en: "Numbered list", ko: "번호 목록" },
  "slash.orderedList.desc": { en: "Ordered list", ko: "순서 있는 목록" },
  "slash.taskList": { en: "Task list", ko: "할 일 목록" },
  "slash.taskList.desc": { en: "List with checkboxes", ko: "체크박스가 있는 목록" },
  "slash.blockquote": { en: "Blockquote", ko: "인용문" },
  "slash.blockquote.desc": { en: "Quote block", ko: "인용 블록" },
  "slash.codeBlock": { en: "Code block", ko: "코드 블록" },
  "slash.codeBlock.desc": { en: "Syntax-highlighted code block", ko: "구문 강조 코드 블록" },
  "slash.hr": { en: "Horizontal rule", ko: "구분선" },
  "slash.hr.desc": { en: "Horizontal divider", ko: "수평 구분선" },
  "slash.image": { en: "Image", ko: "이미지" },
  "slash.image.desc": { en: "Insert local image", ko: "로컬 이미지 파일 삽입" },

  /* ─── Sidebar ─── */
  "sidebar.empty": {
    en: "Open a file with Ctrl+O or create a new document with Ctrl+N.",
    ko: "Ctrl+O로 파일을 열거나 Ctrl+N으로 새 문서를 만드세요.",
  },
  "sidebar.newNote": { en: "New document", ko: "새 문서" },
  "sidebar.settings": { en: "Settings", ko: "설정" },
  "sidebar.externalFile": { en: "External file", ko: "외부 파일" },

  /* ─── StatusBar ─── */
  "status.chars": { en: " chars", ko: " 자" },
  "status.lines": { en: " lines", ko: " 줄" },
  "status.cursorRow": { en: "Line ", ko: "" },
  "status.cursorRowSuffix": { en: "", ko: "행" },

  /* ─── Placeholder ─── */
  "placeholder": { en: "Start writing here...", ko: "여기에 글을 작성하세요..." },

  /* ─── Settings modal ─── */
  "settings.title": { en: "Settings", ko: "설정" },
  "settings.language": { en: "Language", ko: "언어" },
  "settings.theme": { en: "Theme", ko: "테마" },
  "settings.startupMode": { en: "Startup mode", ko: "시작 모드" },
  "settings.noteOrder": { en: "Note order", ko: "노트 정렬" },
  "settings.noteOrder.recentFirst": { en: "Newest first", ko: "최신순" },
  "settings.noteOrder.recentLast": { en: "Oldest first", ko: "오래된 순" },
  "settings.wordWrap": { en: "Word Wrap", ko: "줄바꿈" },
  "settings.wordWrap.word": { en: "Word", ko: "단어 단위" },
  "settings.wordWrap.char": { en: "Character", ko: "문자 단위" },
  "settings.paragraphSpacing": { en: "Paragraph Spacing", ko: "문단 간격" },
  "settings.keepFormat": { en: "Keep formatting on paste", ko: "붙여넣기 시 원문 서식 유지" },
  "settings.shortcuts": { en: "Keyboard Shortcuts", ko: "단축키 안내" },
  "settings.shortcut.toggleEdit": { en: "Toggle edit mode", ko: "편집 모드 전환" },
  "settings.shortcut.switchEditor": { en: "Switch editor", ko: "에디터 전환" },
  "settings.shortcut.open": { en: "Open file", ko: "파일 열기" },
  "settings.shortcut.save": { en: "Save", ko: "저장" },
  "settings.shortcut.saveAs": { en: "Save as", ko: "다른 이름으로 저장" },
  "settings.shortcut.newFile": { en: "New file", ko: "새 파일" },
  "settings.tab.system": { en: "System", ko: "시스템" },
  "settings.tab.formatting": { en: "Formatting", ko: "서식" },
  "settings.tab.shortcuts": { en: "Shortcuts", ko: "단축키" },
  "settings.spellcheck": { en: "Spelling & grammar indicators", ko: "맞춤법 및 문법 표시" },
} as const;

export type I18nKey = keyof typeof dict;

export function t(key: I18nKey, locale: Locale): string {
  return dict[key]?.[locale] ?? key;
}
