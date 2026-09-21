# HANDOFF — 에디터 성능 작업 (2026-09-21 기준)

다음 세션이 이 문서만 읽고 바로 이어갈 수 있게 정리했습니다.

- 측정 결과, 원인, 계획의 전체 내용: [docs/2026-09-21-editor-performance.md](docs/2026-09-21-editor-performance.md)
- 벤치 사용법: [bench/README.md](bench/README.md)

## 1. 현재 상태

- **머지 완료**: `claude/perf-bench`가 PR [#51](https://github.com/ghostface2232/Noten/pull/51)로 `main`에 머지됐습니다(머지 커밋 `a7b1741`, 2026-09-21). 기준이던 `0a73537` 위에 아래 커밋이 모두 올라가 있으므로, 다음 작업은 `main`에서 새 `claude/` 브랜치를 끊어 시작하면 됩니다.
- **커밋**(머지된 순서):

| 커밋 | 내용 |
|---|---|
| `075e63c` | 상태바 줄·글자·단어 수를 노드별 캐시로 합산 (`src/utils/documentLines.ts`) |
| `29c1995` | 목록·표 토크나이저에 원래 멈추는 줄까지만 입력 전달, 로딩 O(n²) 제거 (`src/extensions/boundedBlockTokenizers.ts`, `fastMarkdownLexer.ts`의 `use` 래핑) |
| `50ace1f` | 바뀐 코드블럭만 다시 하이라이트 (`src/extensions/incrementalLowlight.ts`, `MermaidCodeBlock.ts`) |
| `3dbf6df` | `bench/` 도구, 분석 문서, AGENTS.md 안내 |
| `b5552d3` | 무작위 하이라이트 테스트 타임아웃 30초 (병렬 실행 시 5초 초과) |
| `35f9d13` | 이 핸드오프 문서 추가 |
| `124e751` | `bench/corpus.mjs`와 AGENTS.md에서 깨진 주석 복구 (아래 리뷰 항목) |

- **검증**: 머지된 `main`에서 `npm run check`(타입·린트·테스트)를 다시 돌려 통과를 확인했습니다. 테스트 66파일 1,201개입니다.
- **리뷰**:
  - 수정 3건 모두 독립 리뷰 에이전트로 적대적 리뷰를 받았고, 지적 사항을 반영한 뒤 재리뷰에서 결함이 나오지 않았습니다.
  - PR #51에서 Codex 자동 리뷰가 P1 1건을 지적했습니다. `bench/corpus.mjs`의 캐시 경로 주석이 한 줄 깨져 문서화된 첫 단계인 `node bench/corpus.mjs`가 `SyntaxError`로 죽는 문제였고, `124e751`로 고친 뒤 머지했습니다.
- **작업 절차 메모**: 검증 → 수정 + 회귀 테스트 → 커밋·배치마다 리뷰 에이전트 → 커밋 분리 → `claude/` 브랜치로 push(main 금지). 사용자 보고는 한국어, 코드·커밋·주석은 영어입니다.

## 2. 벤치 사용법 요약

```bash
node bench/corpus.mjs                    # 자료 다운로드 + 생성 (이미 캐시에 있음)
node bench/run.mjs --build               # 격리 앱(com.noten.bench) release 빌드. target이 이미 있으면 불필요
node bench/run.mjs --build-web <이름>     # 작업 트리의 프론트엔드를 web-<이름>, web-<이름>-nomin으로 빌드
node bench/run.mjs --sizes 100k,1m --loads 3 --web web-<이름> --tag <태그>
node bench/compare.mjs base-100k,base-1m <태그>   # 기존 코드와 전후 비교 표
node bench/report.mjs                    # 가장 최근 결과 표
```

- **옵션**:

| 옵션 | 용도 |
|---|---|
| `--docs a,b` | 문서 종류 지정 |
| `--profile` | V8 CPU 프로파일. `--web ...-nomin`과 함께 써야 함수 이름이 보입니다 |
| `--trace` | 메인 스레드 self time 트레이스 |
| `--micro` | 앱 안에서 `getMarkdown`/`parse` 시간 직접 측정 |
| `--css "<규칙>"` | CSS 주입 실험 |
| `--trace-categories` | 트레이스 카테고리 지정 |

- **환경 변수**: `BENCH_TIMEOUT_MS`는 큰 문서에서 settle 대기 시간을 늘립니다(기본 300초). `NOTEN_BENCH_CACHE`는 캐시 위치를 바꾸고, `BENCH_DEBUG`는 settle 대기 중 상태를 찍습니다.
- **캐시**: `%LOCALAPPDATA%\noten-bench`(약 1.8GB)에 docs, raw, target, web-*, results가 있습니다. 앱 데이터는 `%APPDATA%\com.noten.bench`입니다.
- **결과 태그**(`results/*-<tag>.json`):

| 태그 | 내용 |
|---|---|
| `base-100k`, `base-1m` | 기존 코드 |
| `fix1` | 토크나이저 수정만 |
| `fix123` | 수정 3건, 리뷰 반영 전 |
| `final`, `final-10m` | 최종 커밋 기준 |
| `expA/B/C`, `expC-10m` | `content-visibility` 실험 |
| `micro` | 앱 안 직렬화·파싱 직접 측정 |
| `fix123-prof` | 프로파일과 트레이스 |

## 3. 핵심 수치 (최종 코드, 1MB)

- **로딩**: 소설 0.54초(기존 9.0초), 짧은 문단 0.81초(55.6초), 헤딩 1.08초(33.5초), 코드 2.6초(15.7초).
- **남은 문제 1 — 엔진 비용**:

| 1MB 문서 | 입력 p50 | 한글 IME p50 |
|---|---|---|
| 목록 | 76ms | 966ms |
| 표 | 126ms | 1,364ms |
| 혼합 | 74ms | 872ms |
| 코드 | 205ms | 2,102ms |

  원인은 Chromium의 문서 전체 커밋·페인트·선택 동기화·IME(TSF) 연동입니다.
- **남은 문제 2 — 이미지 노트(627장)**: 힙 2.1~2.8GB, 전체 표시 24~41초입니다. 그중 `bytesToDataUrl` base64 변환이 15초입니다. 첫 텍스트 표시도 가끔 16~24초로 밀립니다(이미지 처리가 첫 페인트보다 먼저 끝나는 경우).
- **남은 문제 3 — 자동저장 멈춤**: 1MB에서 80~130ms, 10MB에서 0.9~1.3초이며 원인은 `getMarkdown()` 직렬화입니다.

## 4. 다음 작업 (우선순위 순)

### 4.1 컨테이너 블록 `content-visibility` — 가장 효과 큼, 변경 작음

- **실험 C에 쓴 규칙**(`--css`로 주입해 측정):
  ```css
  .ProseMirror > :not(p, h1, h2, h3, h4, h5, h6) { content-visibility: auto; contain-intrinsic-size: auto 3em; }
  ```
- **측정 효과(1MB)**:
  - 목록: IME 1,013→5ms, 입력 80→4ms
  - 표: IME 1,383→18ms
  - 코드: IME 2,133→25ms
  - 로딩 약 2배, 표 스크롤 p95 147→19ms
  - 100KB 회귀 없음
- **주의 1**: 모든 블록에 걸면 블록 수만 개인 문서에서 내부 IntersectionObserver 비용으로 역효과가 납니다. 실험 B에서 paragraphs-1m 스크롤 p95가 20→108ms가 됐습니다.
- **주의 2**: mixed-10m에서는 컨테이너만 걸어도 스크롤 p95가 172→270ms로 나빠졌습니다. 블록 수가 많을 때 어떻게 할지 결정이 필요합니다.
- **넣을 위치**: `src/styles/tiptap-editor.css`. 적용 전 선택자를 실제 최상위 DOM과 대조해야 합니다(표는 `div.tableWrapper`, 코드블럭은 NodeView `div`, 이미지는 문단 안인지 확인).
- **머지 전 확인 목록**:
  - 개요 점프, Ctrl+G, 찾기 다음·바꾸기 스크롤 위치
  - 화면 밖 블록으로 방향키 이동, 전체 선택 복사
  - 이미지·블록 드래그 앤 드롭, 표 열 크기 조절, 머메이드 미리보기
  - 포커스 모드 흐림, PDF 내보내기, 스크롤바 안정성
  - 가능한 항목은 bench에 시나리오로 추가합니다.

### 4.2 이미지 로딩 재설계

- **대상 파일**: `src/extensions/ImageView.ts`, `src/utils/imageAssetUtils.ts`(`resolveRenderableImageSource`, LRU 캐시), `src/utils/imageUtils.ts`(`bytesToDataUrl`).
- **a. Blob URL**: data URL 대신 `URL.createObjectURL`을 씁니다. 캐시는 경로별 참조 수를 세고, 쓰는 NodeView가 없고 캐시에서 밀려난 URL만 `revokeObjectURL`합니다. 노트 폴더 변경·리셋·롤백 시 캐시를 비우는 규칙은 유지합니다(AGENTS.md Images 절).
- **b. 지연 로딩**: 편집기별 IntersectionObserver 하나(rootMargin 1~2화면)로, 보일 때만 소스를 해석합니다. `img.decoding = "async"`도 추가합니다.
- **c. PDF 내보내기 보정**: `src/utils/exportHandlers.ts`는 `exportRoot.innerHTML`을 headless Edge로 넘깁니다. Blob URL과 미로딩 이미지는 거기서 보이지 않으므로, 복제본의 이미지를 내보내기 시점에 data URL로 바꿔 넣어야 합니다.
- **검증**:
  - images-100k/1m 벤치: 힙, `allDecodedAt`, 첫 텍스트 시간
  - Ctrl+C 이미지 복사, 교체·드래그 재정렬·크기 조절
  - 폴더 전환 후 누수 없음, PDF에 모든 이미지 포함
- **보류안**: Tauri asset 프로토콜 + 네이티브 lazy 로딩. CSP는 이미 `asset:`을 허용하지만, capability 범위를 넓혀야 해 개인정보 원칙 검토가 필요합니다.

### 4.3 파서 예외 방어 — 정확성 버그

- **재현 입력**: `"> quote\na. alpha\n> quote\na. alpha"`. marked의 blockquote 토크나이저가 `Cannot read properties of undefined (reading 'raw')`를 던집니다. 기존 코드에서도 똑같이 발생합니다.
- **흐름**: `TiptapEditor.tsx`의 `openDocument`는 파싱이 실패하면 `setContent`로 넘어가는데, 그것도 예외를 던집니다.
- **결과**:
  - `useFileSystem.ts`의 `resetDocState` 뒤 `notifyActiveDoc`와 `setActiveIndex`가 실행되지 않아, 노트를 클릭해도 반응이 없습니다.
  - `documentContext`는 새 노트를 가리키는데 화면은 이전 노트여서, 붙여넣은 이미지가 다른 노트의 폴더로 들어갈 수 있습니다.
- **방향**:
  - `openDocument`가 절대 예외로 끝나지 않게 합니다.
  - 실패하면 원문을 편집 불가 상태로 보여주고 안내를 띄웁니다. 저장이 원문을 바꾸면 안 됩니다.
  - 전환 상태를 일관되게 유지하고, 회귀 테스트를 추가하고, 상류(Tiptap)에 보고합니다.

### 4.4 증분 마크다운 직렬화

- **방식**: 최상위 블록별 결과를 (노드, 직전 형제) 키로 캐시하고 이어 붙입니다.
  - Document는 `renderChildren(content, "\n\n")`로 블록을 잇습니다.
  - 최상위에서 결과에 영향을 주는 문맥은 paragraph의 `previousNode`(빈 문단 뒤 빈 문단 → `&nbsp;`)뿐입니다.
  - `node_modules/@tiptap/markdown/dist/index.js`의 `renderNodeToMarkdown`, `renderNodesWithMarkBoundaries` 부근을 보면 됩니다.
- **적용 지점**: `readEditorMarkdown`(`TiptapEditor.tsx`). 자동저장 `createSnapshot`과 노트 전환 `storeCurrentDocumentSession`이 모두 이 경로를 씁니다.
- **검증**: 코퍼스 전체와 무작위 편집에서 `editor.getMarkdown()`과 바이트 단위로 같은지 퍼징합니다.

### 4.5 그다음

- **코드블럭 NodeView 경량화**(`MermaidCodeBlock.ts`의 `MermaidCodeBlockView`): 모든 코드블럭이 버튼 3개와 SVG를 `innerHTML`로 만듭니다. code-1m DOM이 133만 개입니다. 복사 버튼은 템플릿 `cloneNode`나 지연 생성으로 만들고, 토글·내보내기 버튼은 머메이드일 때만 만듭니다.
- **표 셀 CSS**: `td`/`th`의 `position: relative`(`tiptap-editor.css` 약 380행)를 `:has(.column-resize-handle)`와 `.selectedCell`로 한정합니다. 4.1을 적용한 뒤에도 스크롤 `HitTest`가 남는지 먼저 측정합니다.
- **거대 단일 문단 인라인 렉싱 비선형**(100KB 14ms → 1MB 595ms): 원인 미확인입니다. WikiLink 인라인 `start`의 `indexOf("[[")` 등이 후보입니다.
- **구조적 한계라 보류**: 문단 수만 개 문서(키당 50~80ms), 1MB 단일 문단(입력 200ms, Enter 1초), 로딩 시 tabster 비용 100~330ms.

## 5. 이번 세션에서 배운 함정

- **`PluginKey` 이름은 인스턴스마다 `name$`, `name$1`… 로 붙습니다.** 원본 lowlight 플러그인은 `/^lowlight\$\d*$/`로 찾아야 하고, 우리 플러그인은 `incrementalLowlight`라는 다른 이름을 씁니다.
- **ProseMirror는 삭제 후 재삽입된 노드 객체를 재사용합니다**(드래그, undo). 노드 동일성만으로 "변경 없음"을 판단하면 안 되고, 매핑으로 제자리인지 확인해야 합니다(`keptInPlace`).
- **벤치 관련**:
  - 앱이 부팅하는 중에 `Page.reload`하면 에디터가 뜨지 않습니다. 부팅이 끝난 뒤 reload합니다(`run.mjs`에 반영됨).
  - `--profile` 모드는 타이핑 프로파일 수집이 1초 디바운스보다 오래 걸려, 자동저장이 두 프로파일 창 사이에 떨어집니다. 직렬화 비용은 `--micro`로 잽니다.
  - IME 지연은 `imeSetComposition`이 처리를 기다리지 않기 때문에, 느린 문서에서는 이벤트가 쌓인 대기 시간이 포함됩니다. 10MB에서 p50 2분이 나온 이유입니다.
  - `--loads 2`면 `stats`의 p50이 두 값 중 큰 쪽입니다. 비교용으로는 3회 이상 측정합니다.
  - 벤치 실행 중에 vitest나 빌드를 같이 돌리면 측정이 흔들립니다.
- **도구 관련**:
  - 셸에서 `npm run check | tail`을 쓰면 실패 코드가 가려집니다(이번에 push가 먼저 됨). `set -o pipefail`을 쓰거나 결과를 확인한 뒤 push합니다.
  - Python heredoc으로 TS의 정규식이나 `\n`을 치환하면 이스케이프가 깨지기 쉽습니다. Edit 도구를 씁니다.
  - **같은 함정이 실제로 터졌습니다.** `%LOCALAPPDATA%\noten-bench`를 쓰려던 편집이 `\n`을 진짜 줄바꿈으로 바꿔, `bench/corpus.mjs`에서 주석 밖으로 나온 맨 텍스트가 `SyntaxError`를 냈습니다(AGENTS.md도 같은 자리에서 끊겼습니다). `npm run check`는 `bench/`를 보지 않으므로 잡히지 않았고, PR 리뷰에서야 드러났습니다. 경로나 정규식이 들어간 편집 뒤에는 `node --check bench/*.mjs`로 확인합니다.
  - 저장소가 OneDrive 폴더 안에 있어 대용량 캐시는 저장소 밖(`%LOCALAPPDATA%`)에 둡니다.
