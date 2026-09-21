# HANDOFF — 에디터 성능 작업 (2026-09-21, 2차)

다음 세션이 이 문서만 읽고 바로 이어갈 수 있게 정리했습니다.

- 측정·원인·결과 전체: [docs/2026-09-21-editor-performance.md](docs/2026-09-21-editor-performance.md). 2차 작업은 §7입니다.
- 벤치 사용법: [bench/README.md](bench/README.md)

## 1. 현재 상태

- **브랜치**: `claude/perf-phase2`
  - `claude/perf-bench`(1차: 로딩 O(n²), 코드블럭 하이라이트, 상태바) 위에 쌓았습니다.
  - `origin`에 push했고, PR은 아직 없습니다.
- **2차 커밋**:

| 커밋 | 내용 |
|---|---|
| `cb15b10`, `cd5b7b8` | 벤치 정확성 검사: `--nav`, `--geometry`, `--visual` + `pngdiff.mjs`, `--eval`/`--eval-after`, `--doc-file`, 이미지 타임라인, GC 후 힙 |
| `5574838` | 인용문 끝의 `a.`/`iv.` 목록 때문에 노트가 열리지 않던 marked 예외 수정 (`fastMarkdownLexer.ts`의 `list` override) |
| `c1472e5` | 목록·코드블럭·표를 화면 밖에서 생략. 크기를 추정하지 않음 (`OffscreenBlocks.ts` + CSS) |
| `ab8d773` | 바뀐 블록만 다시 렌더링하는 `getMarkdown` (`IncrementalMarkdown.ts`) |
| `00da126` | 이미지를 전용 스킴 `noten-asset`으로 로드 (Rust `note_asset_response`, base64·IPC 제거) |
| `c137ed9` + 후속 | 유휴 시간에 직렬화 캐시 채우기 (첫 자동저장 멈춤 제거) |
| (최신) | 인라인 `start` 재스캔 제거 (`firstIndexOf`; 1MB 한 문단 로딩 1.36 → 0.85초) |

- **검증**: `npm run check` 통과(68파일 1,222개), Rust `cargo test --lib` 4개 통과.
- **작업 절차**:
  - 검증 → 수정 + 회귀 테스트 → 커밋·배치마다 리뷰 에이전트 → 커밋 분리 → `claude/` 브랜치로 push(main 금지).
  - 사용자 보고는 한국어, 코드·커밋·주석은 영어입니다.

## 2. 핵심 결과 (1MB, 기존 → 현재)

| 문서 | 한글 IME p50 | 입력 p50 | 비고 |
|---|---|---|---|
| lists | 966 → 6ms | 76 → 5ms | |
| code | 2,102 → 29ms | 205 → 20ms | |
| tables | 1,364 → 18ms | 126 → 19ms | 스크롤 p95 167 → 19ms |
| mixed | 872 → 85ms | 74 → 23ms | |
| images (627장) | | | 전체 표시 24.5~39.5초 → 2.7~2.9초, 첫 로딩 멈춤과 2GB 임시 가비지 없음 |
| 자동저장 | | | 두 번째부터 94~134 → 0ms. 노트를 연 뒤 첫 호출은 전체 직렬화 1회 |

## 3. 꼭 알아야 할 설계 불변식

- **화면 밖 생략 (`OffscreenBlocks.ts`, AGENTS.md "Off-screen Blocks")**
  - 높이를 추정하지 않습니다. 블록 높이를 바꾸는 새 레이아웃 입력(설정, 폰트 등)을 추가하면 `editor.storage.offscreenBlocks.remeasure()`를 불러야 합니다.
  - CSS 선택자와 `SKIPPABLE_BLOCK`은 같아야 합니다.
  - 레이아웃에 영향을 주는 변경은 `node bench/run.mjs --geometry`로 이전 빌드와 높이를 비교하고, `--nav`로 점프 도착 위치를 확인합니다.
- **이미지 (AGENTS.md "Images", "Capability Surface")**
  - `<img src>`는 `convertFileSrc(path, "noten-asset")`입니다.
  - Rust `note_asset_response`가 blocking 워커에서 `.assets` 안의 이미지 확장자 파일만 서빙합니다. 실제 경로 기준이고 `$HOME`·`$APPDATA`·`$APPLOCALDATA` 아래만 허용합니다.
  - Tauri 기본 asset 프로토콜은 쓰지 않습니다. UI 스레드에서 동기로 읽고, 다이얼로그가 범위를 넓히기 때문입니다.
  - 저장 방식(노트 폴더의 `.assets/<id>/<hash>`)은 그대로입니다. 이미지를 LocalAppData로 옮기는 안은 동기화·백업·호환성 때문에 권하지 않았습니다(사용자와 논의함).
- **증분 직렬화 (`IncrementalMarkdown.ts`)**
  - 최상위 블록의 Markdown을 (노드, 이전 노드)로 캐시합니다.
  - `@tiptap/markdown`을 업그레이드하면 문서 렌더러가 `"\n\n"` join인지, 최상위 렌더러가 노드와 `previousNode` 말고는 읽지 않는지 다시 확인합니다. 테스트가 퍼즈로 고정합니다.

## 4. 리뷰 기록

- 모든 커밋은 독립 리뷰 에이전트의 적대적 리뷰를 거쳤고, 지적은 모두 반영했습니다.
- **화면 밖 생략**: 리뷰 2회에서 4건과 2건을 반영했습니다.
- **이미지**: 리뷰 3회.
  - 기본 asset 프로토콜이 UI 스레드에서 동기로 읽는 문제 → 전용 스킴으로 교체했습니다.
  - 등록 스킴 오리진이 로컬로 취급되는 문제 → 모든 응답에 sandbox CSP와 nosniff를 붙였습니다.
- **미반영 Low 1건**: `note_asset_response`는 `canonicalize` 뒤에 경로로 다시 엽니다(TOCTOU). `.assets`에 로컬 쓰기 권한이 있어야 공격할 수 있어 두었습니다.
- **참고**: 앱에는 탐색 가드(`on_navigation`)가 없습니다. 일반 http 링크가 창을 바꿀 수 있는지 따로 점검할 만합니다.

## 5. 남은 후보 (우선순위 순)

### 5.1 완료된 계획

- **유휴 시간 캐시 채우기**: `c137ed9`와 리뷰 반영 후속 커밋. 문서 §7.6.
- **인라인 `start` 재스캔 제거**: 문서 §7.5.

### 5.3 그 밖

1. **파싱 실패 방어**: `openDocument`가 예외로 끝나지 않게 하고 원문을 읽기 전용으로 보여 주는 것입니다. 알려진 재현 입력은 고쳤고, 파서 퍼즈 2,000건에서 예외가 없어 보류했습니다.
2. **코드블럭 NodeView 경량화**: code-1m 로딩 2.6초 중 약 160ms라 효과가 작습니다.
3. **구조적 한계라 보류**:
   - 문단 수만 개 문서: 키당 50~80ms.
   - 1MB 단일 문단: 입력 200ms, Enter 1초.
   - 편집기보다 넓은 표: 생략 중 6px 오차.

## 6. 이번 세션에서 배운 함정

- **Tiptap v3의 `onCreate`는 비동기(setTimeout)로 호출됩니다.** 에디터 API를 바꾸려면 `onBeforeCreate`에서 해야 합니다. 그렇지 않으면 초기 호출은 원본을 탑니다(`IncrementalMarkdown`에서 겪음).
- **`content-visibility: auto`는 크기를 추정합니다.** 기억된 크기(`contain-intrinsic-size: auto`)만 신뢰할 수 있고, 그것도 스크롤 컨테이너 자신의 스크롤바는 빠집니다.
- **`contain: layout`는 자식 margin이 부모 밖으로 겹쳐 나가는 것을 막습니다.** 목록 마지막 항목 margin 보정이 필요했습니다.
- **WebView2 Blob 저장소에는 한도가 있습니다.** 이미지 수백 MB를 Blob으로 들면 일부 `blob:` URL이 무효가 됩니다.
- **`window.__TAURI_INTERNALS__.invoke`는 writable이 아닙니다.** 벤치에서 IPC를 가로챌 수 없습니다.
- **Windows Python 텍스트 모드는 `\n`을 CRLF로 씁니다.** `newline='\n'`을 지정합니다. 또 heredoc 안의 `\\U` 같은 이스케이프가 깨지므로 raw 문자열 스크립트 파일이나 Edit 도구를 씁니다.
- **벤치의 첫 측정 로드는 이후보다 빠르게 나옵니다**(images-100k ready 370 vs 500ms). 전후 비교는 같은 조건을 교차해서 합니다.
- **`--loads 1`의 자동저장 수치는 GC 타이밍에 따라 크게 흔들립니다**(tables-1m 132~229ms). 두 빌드를 교차 측정해서 판단합니다.
