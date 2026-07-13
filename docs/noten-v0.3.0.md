# Noten v0.3.0 구현 가이드 — 아웃라인 패널 + 포커스 모드

v0.2.9(main, Tiptap 3.27.3) 소스를 직접 확인하고 작성한 가이드입니다. 파일 경로와 행 번호, 기존 패턴 참조는 모두 v0.2.9 태그 기준입니다.

## 전체 구조 요약

### 이번 릴리즈의 정체성

v0.2.3-v0.2.9 일곱 릴리즈 동안 데이터 안전성에 집중한 뒤 처음 나오는 기능 릴리즈입니다. 두 기능 모두 데이터 계층(useFileSystem, decomposedState, sync)을 전혀 건드리지 않는 순수 에디터·UI 작업이며, 하나의 사용 시나리오(긴 노트)의 양면을 채웁니다.

- 아웃라인 패널: 긴 노트에서의 탐색 (헤딩 목차, 클릭 점프, 키보드 순회)
- 포커스 모드: 긴 노트에서의 몰입 (현재 문단 외 흐림 + 타이프라이터 스크롤, 독립 토글 2개)
- 동승: P2-5 첫 실행 로케일 감지 (navigator.language 기반 seed)



### 건드리는 파일

```
신규
  src/components/OutlinePanel.tsx          아웃라인 패널 컴포넌트
  src/extensions/FocusMode.ts              포커스 흐림 데코레이션 플러그인
  src/extensions/TypewriterScroll.ts       타이프라이터 스크롤 플러그인
  + 각 파일의 .test.ts(x)

수정
  src/hooks/useSettings.ts                 설정 3종 + 로케일 seed
  src/hooks/useKeyboardShortcuts.ts        단축키 3개 (Ctrl+Shift+O, F8, F9)
  src/components/TiptapEditor.tsx          확장 등록 (extensions 배열, 779행 부근)
  src/components/EditorToolbar.tsx         아웃라인 토글 버튼
  src/App.tsx                              패널 배치, 포커스 모드 시 chrome 처리
  src/components/SettingsModal.tsx         설정 UI + 단축키 목록 갱신
  src/i18n.ts                              신규 문자열 (ko/en 필수 쌍)
  src/hooks/useChromeVisibility.ts         (선택) 점프 락 노출
  AGENTS.md                                신규 개념·불변성 문서화
```



### 재사용하는 기존 인프라


| 기존 자산                      | 위치                                                  | 이번에 쓰는 곳               |
| -------------------------- | --------------------------------------------------- | ---------------------- |
| rAF 코얼레싱 stats 패턴          | StatusBar.tsx 49-92행 useEditorStats                 | 아웃라인 헤딩 재계산            |
| chrome 300ms 락             | useChromeVisibility.ts chromeLockUntilRef           | 아웃라인 점프 시 chrome 숨김 억제 |
| 증분 플러그인 선례                 | WikiLink.ts 306행 tr.mapping, 403행 appendTransaction | 포커스 플러그인의 상수 비용 설계 기준  |
| 모션 상수 + reduced-motion 가드  | src/styles/interactions.ts (v0.2.9 토글 스위치에서 확립)     | 패널 슬라이드·흐림 전환          |
| makeStyles + Fluent tokens | 전 컴포넌트 공통                                           | 신규 컴포넌트 스타일            |
| Settings 파싱 검증 패턴          | useSettings.ts 83행 (화이트리스트 검증)                      | 신규 설정 3종               |
| editorTopOffset            | useChromeVisibility.ts 24행                          | 점프 시 헤딩 상단 오프셋         |




### 단축키 배정 (충돌 확인 완료)

- Ctrl+Shift+O — 아웃라인 패널 토글. 미사용 확인.
- F8 — 포커스 흐림 토글. F5/F7/F12는 차단 목록에 있으나 F8은 비어 있음. Typora 관례와 일치.
- F9 — 타이프라이터 토글. 비어 있음. Typora 관례와 일치.
- Ctrl+P는 useKeyboardShortcuts.ts 91행에서 예약 차단 중(향후 퀵 스위처용)이므로 사용 금지.

---

## Step 1: 설정·i18n·단축키 뼈대

세 기능이 공유하는 기반을 한 번에 깝니다. UI 없이 상태와 배선만 먼저 만들어, 이후 Step들이 각자 독립적으로 붙을 수 있게 합니다.

---

## Step 2: 아웃라인 패널

### 설계 결정

- 데이터: editor.state.doc에서 heading 노드만 순회해 텍스트·레벨·pos 추출. 헤딩은 문서당 수십 개 수준이라 순회 자체는 저렴하지만, 재계산 시점은 StatusBar의 useEditorStats처럼 transaction 이벤트 + rAF 코얼레싱으로 프레임당 1회로 묶습니다. docChanged가 아닌 selection-only 트랜잭션은 목차 재계산 없이 현재 헤딩 하이라이트만 갱신합니다.
- 점프: scrollIntoView는 헤딩을 뷰포트 하단에 걸치게 놓는 경우가 많으므로, coordsAtPos로 대상 y를 구해 헤딩이 상단(editorTopOffset + 여유 16px 부근)에 오도록 스크롤 컨테이너의 scrollTop을 직접 보정합니다.
- chrome 충돌: 점프로 인한 프로그래매틱 아래 방향 스크롤이 useChromeVisibility의 숨김 판정을 타지 않도록, 점프 직전에 handleShowEditorChrome을 호출해 기존 300ms 락을 재사용합니다.
- 현재 위치: 캐럿 기준(selection $head 이전 마지막 헤딩)만 1차 범위. 뷰포트 스크롤 추적은 비용 대비 가치가 낮아 이번 릴리즈에서 제외.
- 배치: 에디터 우측 패널. 사이드바(좌)와 대칭. 열림 상태는 Step 1의 outlinePanelOpen 설정.

---

## Step 3: 포커스 흐림 (FocusMode 플러그인)

### 설계 결정

- 핵심 원칙: selection당 비용이 문서 크기와 무관하게 상수여야 합니다. 현재 블록 하나에만 node decoration을 붙이고, 나머지 블록의 흐림은 전부 CSS 셀렉터가 처리합니다. 모든 블록에 dimmed 데코레이션을 다시 계산하는 방식은 v0.2.9에서 WikiLink로부터 제거한 전체 순회 패턴의 재도입이므로 금지합니다.
- 흐림 단위: 최상위 블록(문단, 헤딩, 코드 블록, 표, Mermaid 각각 통째). 문장 단위는 한국어 문장 경계 문제로 범위 제외.
- chrome: 포커스 모드 진입 시 툴바·상태바를 숨김 고정합니다. 스크롤 방향에 따라 나타났다 사라지는 것은 몰입 모드와 모순이며, 우연이 아닌 의도로 명시합니다. 해제 시 원래 pinEditorToolbar 설정 기준으로 복귀합니다.
- 아웃라인과의 상호작용: 포커스 모드 진입 시 아웃라인 패널을 자동으로 닫고, 해제 시 진입 전 열림 상태로 복원합니다. 아웃라인 점프 후의 active 블록 이동은 selection 기반이라 자동으로 따라옵니다.

---

## Step 4: 타이프라이터 스크롤

### 설계 결정

- 포커스 흐림과 독립 토글입니다. 흐림만 원하는 사용자와 스크롤 고정만 원하는 사용자가 다릅니다(iA Writer, Typora 모두 분리 토글).
- 보정은 문서 변경이 있는 트랜잭션 직후에만 수행합니다. 클릭·방향키 등 selection-only 이동에서까지 화면이 끌려가면 멀미를 유발합니다. 타이핑할 때만 캐럿이 중앙을 유지하는 것이 표준 동작입니다.
- 문서 끝에서 캐럿을 중앙에 두려면 에디터 하단에 뷰포트 절반만큼의 여백이 필요합니다. 이게 없으면 마지막 문단에서 기능이 조용히 죽습니다.
- 보정 스크롤은 프로그래매틱이지만 useChromeVisibility 핸들러를 타게 됩니다. 포커스 모드와 함께 켠 경우는 chrome이 이미 숨김 고정이라 무관하고, 타이프라이터 단독일 때는 아래 방향 보정이 chrome을 숨기는데 이는 타이핑 몰입 중이므로 수용 가능한 동작으로 확정합니다(별도 억제 없음).

---

## Step 5: 통합 점검·문서화·릴리즈 준비

