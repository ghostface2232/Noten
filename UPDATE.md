Noten은 Windows용 노트 앱. 기술 스택은 React 19, Tauri v2, Tiptap v3, CodeMirror.
이번 작업의 목적은 기존의 read mode / rich text edit mode / markdown mode처럼 보이던 경험을 더 단순하고 정직한 개념으로 재정리하는 것.

핵심 개념은 2개. `Note`와 `Markdown`.
1. `Note`는 앱의 기본 문서 표면이며, 기존 read mode와 rich text edit mode를 따로 보지 않고 하나의 기본 화면으로 취급해야 함.
2. `Markdown`은 필요할 때만 들어가는 별도 소스 편집 화면이어야 함.

확인된 핵심 파일은 `src/App.tsx`, `src/hooks/useMarkdownState.ts`, `src/components/TiptapEditor.tsx`. 
현재 `useMarkdownState`는 `isEditing + editorMode` 조합으로 사실상 세 상태를 표현함. viewing richtext, editing richtext, editing markdown임. 하지만 제품 개념상 이걸 세 개의 큰 모드처럼 다루지 않는 것이 목표임.

채택한 방향은 다음과 같음.
1. `Note`는 기본적으로 quiet state로 열림. 본문 클릭 한 번으로 editing state에 들어감. `Escape`를 누르면 다시 quiet state로 돌아감.
2. `Markdown`은 `Ctrl+/` 또는 버튼으로만 진입하는 보조 화면으로 유지함. locked state는 이번 범위에서 고려하지 않음.

구현할 때 중요한 해석은 다음과 같음. `Note`는 하나의 기본 surface이며, 그 안에 quiet와 editing 두 상태가 있음.
`Markdown`은 별도 surface임. 따라서 앞으로는 read mode라는 표현을 제품 용어에서 제거하고, rich text edit mode도 별도 모드처럼 다루지 않음.
사용자에게는 `Note | Markdown`만 보이게 하는 것이 목표임.

quiet state에서는 읽기 중심 경험을 유지해야 함. 툴바는 숨기고, caret은 보이지 않게 하며, 편집 affordance는 최소화함. 링크는 자연스럽게 열려야 함.
editing state에서는 caret, 툴바, 선택 및 포맷 편집, 이미지 선택 등 편집 affordance가 활성화되어야 함. `Markdown`은 명시적으로 들어가는 소스 편집 화면으로 남김.

이 작업의 본질은 새로운 편집기를 만드는 것이 아니라, 이미 코드 안에 존재하는 실제 구조를 더 단순한 제품 개념으로 정렬하는 것임.
다시 말해 Noten의 진짜 축은 read / edit가 아니라 `Note / Markdown`이며, read는 독립 모드가 아니라 Note의 quiet state로 재해석하는 것이 맞음.