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

### 5.1 유휴 시간에 직렬화 캐시 채우기 (계획 확정, 미구현)

- **목표**: 노트를 연 뒤 첫 `getMarkdown`의 전체 렌더(1MB 약 120ms 긴 작업)를 없앱니다. 첫 자동저장과 노트를 떠날 때(`storeCurrentDocumentSession`) 모두 이 비용을 냅니다.
- **방법**
  - `createIncrementalSerializer`가 `warm(deadline)`을 함께 반환합니다. 블록을 앞에서부터 돌며 캐시 미스만 렌더링하고, `deadline.timeRemaining()`이 1ms 아래로 떨어지면 커서를 저장한 채 멈춥니다.
  - `IncrementalMarkdown`에 플러그인 view를 추가합니다. 문서가 바뀌면 300ms 디바운스(자동저장 디바운스 1초보다 짧게)한 뒤 `requestIdleCallback`으로 `warm`을 반복합니다. 새 변경이 오면 취소하고 처음부터 다시 돕니다.
  - 캐시 키가 (노드, 이전 노드)라서, 도중에 문서가 바뀌어도 이미 채운 결과는 유효합니다. 틀린 결과가 생길 수 없습니다.
- **비용**: 이미 캐시된 블록을 한 번 도는 비용은 WeakMap 조회뿐입니다(1MB, 블록 수천~4만 개에서 수 ms). 모두 유휴 시간에만 실행됩니다.
- **한계**: 블록 하나가 거대하면(1MB 한 문단) 쪼갤 수 없어 유휴 시간에 긴 작업 1회가 남습니다. 이는 지금 자동저장이 내는 비용을 옮기는 것일 뿐입니다.
- **검증**
  - 벤치 1MB 목록·표·혼합: 첫 자동저장 최장 작업 110~140ms → 0, 로딩 뒤 유휴 구간 긴 작업 수(`--eval-after`로 longtask 기록).
  - 입력·IME 지연이 그대로인지 확인합니다(유휴 콜백이 입력과 겹치지 않는지).
  - 단위 테스트: `warm` 뒤 `getMarkdown`이 렌더러를 호출하지 않을 것, 도중 편집 후에도 결과가 기존 직렬화와 같을 것.

### 5.2 인라인 `start` 콜백의 O(n²) (계획 확정, 미구현)

- **측정**: 800KB 한 문단 렉싱이 515ms입니다. Underline을 빼면 61ms입니다.
- **원인**: Underline의 `start`(`indexOf("++")`)입니다. WikiLink의 `start`(`indexOf("[[")`)도 같은 구조라, `[[`가 없는 긴 문단에서 똑같이 느려집니다.
- **이유**: marked는 텍스트 토큰마다 "문단의 남은 전체"를 넘겨 `start`를 부르고, 없는 문자열을 매번 끝까지 찾습니다.
- **방법**
  - `FastLexer.inlineTokens`는 우리가 옮겨 적은 루프라서 현재 위치(`cutSrc`는 항상 문단의 접미사)를 압니다.
  - "고정 문자열의 첫 위치"라고 의미가 보장된 `start`에 한해, 찾은 절대 위치를 기억합니다. 커서가 그 위치를 지나야 다시 찾습니다(못 찾았으면 그 뒤로도 없음). 이렇게 하면 문단당 O(n)입니다.
  - 의미 보장은 추측하지 않고 우리가 만든 함수로 합니다. `createFastMarked`의 `use` 래퍼가 Underline과 WikiLink의 `start`를 `firstIndexOf("++")`·`firstIndexOf("[[")`로 바꾸고, 그 함수를 WeakSet에 등록합니다. FastLexer는 WeakSet에 있는 함수만 기억 대상으로 삼고, 나머지는 기존대로 매번 호출합니다.
- **정확성**: 접미사 성질과 첫 위치 의미만으로 결과가 같다는 것이 증명됩니다.
  - 기존 FastLexer 퍼즈(stock marked와 토큰 트리 비교)에 `++`, `[[` 조각을 섞어 확인합니다.
  - "Tiptap Underline의 `start`가 `indexOf("++")`와 같다"는 전제는 무작위 문자열 비교 테스트로 고정해서, Tiptap이 바꾸면 실패하게 합니다.
- **효과**: 한 줄·한 문단짜리 대형 붙여넣기(로그, 긴 원문)에서만 드러납니다(100KB 39 → 16ms, 800KB 515 → 약 60ms). 일반 노트에는 영향이 없습니다.

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
