# Noten 버그·이슈 수정 목록 (2026-08-13)

프론트엔드(src/), 네이티브·설치기(src-tauri/, bootstrapper/, maintenance-helper/), 빌드·릴리스(.github/, scripts/)를 코드 레벨에서 검증한 결과입니다. 모든 항목은 실제 코드를 읽고 확인한 것만 포함하며, 심각도 순으로 정렬했습니다.

개선·기능 제안은 [2026-08-13-improvements.md](2026-08-13-improvements.md) 참조.

> **현황(2026-09-21 확인)**: 이 문서는 2026-08-13 시점의 스냅샷입니다. 이후 **B2**(CI가 Rust를 빌드·테스트하지 않음)는 `ci.yml`의 `rust` 잡이 `cargo test --workspace`를 돌리면서, **B3**(Replace All의 대소문자 무시)은 찾기 바의 대소문자 구분 토글과 치환 개수 안내가 들어가면서 해소됐습니다. 나머지 항목은 이 날짜 이후로 다시 검증하지 않았으므로, 착수 전에 해당 코드를 먼저 확인하십시오.

---

## 심각도: 높음

### B1. 로더 실패 폴백 노트는 저장 불가인데 창 닫기를 막지 않음 — 데이터 유실
- **위치**: `src/hooks/useNotesLoader.ts:749-761` (스텁 `{ id: "local", filePath: "" }`), `src/hooks/useAutoSave.ts:150-152, 174`, `src/App.tsx:1158-1170`
- **시나리오**: 실행 시 노트 폴더가 일시적으로 읽기 불가 → 빈 스텁 문서가 뜨고 사용자가 한 시간 타이핑. `filePath: ""`라서 `markActiveDocEdited`/`createSnapshot`이 모두 조기 반환 → `hasPendingChangesRef`가 계속 `false` → `hasUnsavedChanges()`가 `false` → 창 닫기가 경고 없이 통과. **입력 내용 전부 유실.**
- **수정 방향**: 스텁을 읽기 전용 + 오류 배너로 만들거나, `isDirty && !filePath`일 때 닫기 차단, 또는 첫 편집 시 실제 파일 경로를 지연 생성.

### B2. CI가 Rust 코드를 전혀 빌드/테스트하지 않음
- **위치**: `.github/workflows/ci.yml:20-35`
- **시나리오**: CI는 프론트 typecheck/lint/test만 수행. 컴파일 오류나 언인스톨러의 재귀 삭제 안전 로직(`maintenance-helper/src/uninstaller.rs:359-452`에 **실제 유닛 테스트가 있음**) 리그레션이 main에 그대로 머지됨. `v*` 태그를 푸시한 뒤에야 릴리스 빌드가 실패하거나, 더 나쁘게는 테스트가 잡았을 결함이 있는 언인스톨러가 배포됨. 저장소에서 가장 안전-임계적인 코드에 자동 게이트가 0개.
- **수정 방향**: `windows-latest`에서 `cargo test --workspace` + `cargo build`(+ clippy) 잡을 ci.yml에 추가.

### B3. Replace All이 대소문자 무시로 의도치 않은 텍스트를 치환 (데이터 변형)
- **위치**: `src/extensions/SearchHighlight.ts` (`"gi"` 하드코딩), `src/components/SearchBar.tsx` (토글 UI 없음)
- **시나리오**: "foo"를 치환하면 "Foo", "FOO"까지 전부 바뀜. 사용자가 알아채지 못한 채 본문이 변형되고, 실패 피드백도 없음.
- **수정 방향**: 대소문자 구분(Aa) 토글 추가 + Replace All 후 "N개 치환됨" 피드백.

## 심각도: 중간

### B4. 삭제 시 사이드카에 `trashedAt`을 먼저 기록하지 않음 — 크래시 시 노트가 어디에도 안 보이게 됨
- **위치**: `src/hooks/useFileSystem.ts:796-829` (본문만 `.trash`로 이동, meta는 fire-and-forget 매니페스트 큐 `:907`에 의존), 대조: `restoreNote`는 meta-first를 await(`:1175-1204`)
- **시나리오**: 삭제 직후 프로세스 강제 종료 → 디스크에는 본문이 `.trash/<id>.md`, meta는 `trashedAt: null`. 다음 실행에서 `reconcileFolder`(`src/utils/reconcileFolder.ts:370-377`)가 이 상태를 `continue`로 건너뜀 → 노트가 목록에도 휴지통에도 안 나타나고 **영구히 복구 경로 없음**.
- **수정 방향**: 본문 이동 전에 `writeMeta({ trashedAt, trashedFromPath })`를 await(restoreNote와 대칭), 또는 reconcile이 "live meta + trash 본문" 상태를 휴지통 노트로 복원.

### B5. `doSave`가 절대 `docs` 배열을 커밋 — 방금 삭제한 노트가 부활할 수 있는 레이스
- **상태 (2026-08-14)**: 해결. `5963e54`가 React state/active-index 커밋을 함수형으로 바꿨고, 후속 수정에서 autosave persistence를 저장 대상 note sidecar만 갱신하도록 분리했다. 따라서 A 저장은 삭제된 B의 sidecar를 전혀 쓰지 않으며, A의 pin/color/group처럼 autosave가 소유하지 않는 필드도 disk 값을 보존한다. 동일 note의 cross-window lifecycle 전이는 별도 coordinator의 직렬화 대상으로 남는다.
- **위치**: `src/hooks/useAutoSave.ts:323-369` (`stateRef.current.docs` 기반 `latestSetDocs(sortedDocs)` + `saveManifest`)
- **시나리오**: 노트 A의 백그라운드 저장이 느리게 진행 중 사용자가 노트 B 삭제. doSave 후속 처리가 React 커밋 전의 stale `stateRef`를 읽으면 B가 포함된 배열을 다시 커밋 + 매니페스트에 live로 영속화 → 파일은 이미 `.trash`에 있는 유령 사이드바 행. 다음 reconcile까지 지속. (`deleteNotes`의 주석 `:748-752`가 같은 클래스의 버그를 벌크 삭제에서 이미 고쳤음을 보여줌 — doSave만 남음.)
- **수정 방향**: doSave 내부에서 함수형 `setDocs(prev => ...)` 사용.

### B6. 휴지통 비우기 실패가 영구 고아 파일을 만듦 — `.trash`는 reconcile 대상이 아님
- **위치**: `src/hooks/useFileSystem.ts:1310-1328` (`emptyTrash`: 개별 remove 실패 무시 후 무조건 `setTrashedNotes([])`), `:1290-1299` (`permanentlyDeleteNote` 동일), `src/utils/reconcileFolder.ts:357-379`
- **시나리오**: AV/OneDrive 잠금으로 `.trash` 본문 삭제 실패 → meta는 지워지고 UI 목록도 비워지는데 본문은 `.trash`에 영구 잔존. 14일 퍼지는 목록 기반이라 못 잡고, 폴더 마이그레이션 시 고아도 함께 복사됨.
- **수정 방향**: 삭제 성공한 항목만 목록에서 제거(실패분은 재시도용으로 유지), 또는 reconcile에 고아 trash 스윕 추가.

### B7. `print_to_pdf` 출력 경로가 `fs:scope` 허용 목록을 완전히 우회
- **위치**: `src-tauri/src/lib.rs:58-91`, 대조: `capabilities/default.json:32-39`
- **시나리오**: `output_path`를 검증 없이 Edge 프로세스에 전달 — Tauri fs 플러그인과 스코프 밖에서 임의 경로(확장자 검사도 없음)에 쓰기 가능. 현재는 저장 다이얼로그가 게이트라 실질 위험은 낮지만, 능력 허용 목록이 보장해야 할 불변식이 이 커맨드에서 성립하지 않음.
- **수정 방향**: 스폰 전에 절대 경로 + `.pdf` 확장자 + 허용 루트 하위인지 서버 측 검증.

### B8. 자동 저장마다 노트 본문 전체를 Tauri 이벤트 버스로 브로드캐스트
- **위치**: `src/hooks/useAutoSave.ts:371-372` (`emitDocUpdated(id, snapshot.content, ...)`), `src/hooks/useWindowSync.ts:61-65`
- **시나리오**: 수백만 자 노트(fastMarkdownLexer가 존재하는 이유인 그 케이스)에서 1초 디바운스마다 수 MB JSON 직렬화/IPC — **창이 하나뿐이어도 무조건 emit**(필터가 수신 측에만 있음).
- **수정 방향**: `docId` + 리비전만 emit하고 피어 창이 디스크에서 읽게 하거나(own-write 해시가 이미 워처를 억제함), 다른 창이 없으면 emit 생략.

### B9. 노트 내보내기(Ctrl+E) 실패가 무음 — unhandled rejection
- **위치**: `src/hooks/useFileSystem.ts:966-967` (try/catch 없는 `writeTextFile`), 호출 체인 `Sidebar.tsx:783` → `App.tsx:1412`도 미처리. 대조: `exportHandlers.ts:70-75`는 오류 다이얼로그 표시.
- **시나리오**: 읽기 전용 폴더/분리된 드라이브로 내보내기 → 다이얼로그는 닫히고 아무것도 안 써졌는데 피드백 없음 (crash.log에만 기록).
- **수정 방향**: exportHandlers와 동일한 `message(...)` 다이얼로그로 래핑. (`saveFileAs` `:393-401`도 동일 구멍이나 데드 코드로 보임 — 삭제 검토.)

### B10. 릴리스 빌드 재현성 없음 — `windows` 크레이트 범위 지정 + `stable` 툴체인
- **위치**: `bootstrapper/Cargo.toml:6`, `maintenance-helper/Cargo.toml:7`, `noten-splash-ui/Cargo.toml:6` (`windows = ">=0.59, <=0.62"`), `.github/workflows/release.yml:33-37`
- **시나리오**: `cargo update`나 Cargo.lock 재생성이 `windows` 크레이트를 밴드 내에서 조용히 올려 splash/언인스톨러 `unsafe` FFI 동작이 바뀌거나, 태그 시점의 새 stable rustc가 릴리스 빌드를 깨뜨림 — B2 때문에 사전 신호도 없음.
- **수정 방향**: `windows`를 단일 버전으로 고정(`=0.61`), 툴체인을 명시 버전으로 고정.

### B11. 언인스톨러가 문자열 검색으로 settings.json에서 노트 폴더를 추출한 뒤 재귀 삭제
- **위치**: `maintenance-helper/src/uninstaller.rs:118-121, 311-357` (`extract_json_string` — 진짜 JSON 파서 아님)
- **시나리오**: `"notesDirectory"` 부분 문자열이 실제 키보다 먼저 다른 값/키에 등장하면 잘못된 경로가 반환됨. 마커 검사 + `validate_delete_path` 가드 덕분에 대부분 fail-safe지만, 마커를 가진 잘못된 경로는 이론상 가능.
- **수정 방향**: `serde_json`으로 정식 파싱.

### B12. `$HOME/**` 전체에 대한 `fs:read-all`/`fs:write-all` — 심층 방어 취약
- **위치**: `src-tauri/capabilities/default.json:28-39`
- **시나리오**: 마크다운/mermaid/HTML 렌더 경로에서 의존성발 XSS가 하나라도 뚫리면 앱 데이터가 아니라 **사용자 프로필 전체** 읽기/쓰기 권한 획득. (AGENTS.md상 의도된 설계이나 가장 넓은 공격 표면.)
- **수정 방향**: 가능하면 기본 스코프를 앱 데이터 + 설정된 노트 폴더(동적 부여)로 축소. 최소한 의존성 범프 시 재검증 항목으로 명문화.

## 심각도: 낮음~중간

### B13. `createNoteWithTitle`이 `normalizeNoteTitle`을 안 씀 — AGENTS.md 불변식 위반
- **위치**: `src/hooks/useFileSystem.ts:649-651` (trim 없는 NFC+lowercase), 정본: `src/utils/noteText.ts:16-18`
- **시나리오**: `"Foo "` 제목 노트가 있을 때 `[[Foo]]` 생성 경로가 중복 제목 노트를 만들어 즉시 링크 모호성 발생.
- **수정 방향**: 양쪽 모두 `normalizeNoteTitle`로 비교.

### B14. `importFiles`가 제목을 정확 일치로만 중복 검사 (+ trim 안 함)
- **위치**: `src/hooks/useFileSystem.ts:411, 434-442`
- **시나리오**: 기존 "Foo"가 있는데 `foo.md` 임포트 → 대소문자 변형 중복 제목 → 위키링크 모호성 + 이후 rename 시 백링크 재작성이 건너뜀(`linkRewriteSkipped`).
- **수정 방향**: 충돌 집합 키를 `normalizeNoteTitle(fileName)`으로.

## 심각도: 낮음

### B15. `renameNote`가 이름 바뀐 노트 자신의 `[[Old]]` 자기 참조는 재작성하지 않음 — `useFileSystem.ts:1005-1007`. 허브 노트의 자기 링크가 깨진 링크로 렌더됨.
### B16. `onCloseRequested`/`onFocusChanged` 리스너 등록에 disposed 가드 없음 — `App.tsx:1142-1173, 1185-1194`. StrictMode에서 닫기 드레인/오류 다이얼로그 2회 실행(개발 빌드). 이웃 이펙트(`:197-220`)의 가드 패턴 복제로 해결.
### B17. `useWindowSync`가 `setDocs` 업데이터 안에서 사이드 이펙트 수행 — `useWindowSync.ts:209-244, 288-300`. 업데이터 순수성 위반; StrictMode/동시 렌더링에서 `openDocument` 중복 호출.
### B18. `markdownRef` 캐시에 stale 마킹이 없음 (AGENTS.md는 있다고 기술) — `useMarkdownState.ts:12-31`. 편집 후 1초 디바운스 내 Ctrl+Alt+C 복사 시 키 입력 전 본문이 클립보드로. 복사 시 `isDirty`면 즉석 재직렬화하거나 문서대로 stale 플래그 구현.
### B19. 부트스트래퍼가 고정 임시 파일명(`%TEMP%\Noten_silent_setup.exe`)에 페이로드 기록 — `bootstrapper/src/installer.rs:11-16`. TOCTOU + 동시 실행 충돌. `lib.rs:48-56`의 pid+nanos 패턴 재사용.
### B20. `LOCALAPPDATA`/`APPDATA` 환경 변수 `.expect()` — `bootstrapper/src/constants.rs:9`, `maintenance-helper/src/constants.rs:11,17`. 콘솔 없는 서브시스템이라 무음 크래시. splash 실패 경로로 라우팅.
### B21. 매 실행마다 헬퍼 복사 + `reg.exe` 2회 스폰 — `src-tauri/src/lib.rs:259-296`. 존재/버전 체크로 가드.
### B22. 릴리스 워크플로우: 같은 드래프트 태그에 두 액션이 업로드, 자산 완결성 검증 없음 — `release.yml:50-64, 107-113`. 자산 목록 검증 스텝 추가.
### B23. 서명 안 된 부트스트래퍼가 게이트 없이 업로드됨 — `release.yml:66-73`. 시크릿 누락 시 무서명 `noten-setup.exe`가 드래프트에 올라가고 사람 검토에만 의존. 태그 빌드에서 `HAS_SIGNING_CERT != 'true'`면 잡 실패 처리.
### B24. PDF 내보내기 임시 HTML에 노트 평문 전체 — 정리(cleanup)가 수동이라 미래의 early-return이 평문을 `%TEMP%`에 남길 수 있음 — `src-tauri/src/lib.rs:60-150`. Drop 가드로 래핑.
### B25. `changedRangeForTransactions`가 트랜잭션 간 범위를 매핑 없이 병합 — `WikiLink.ts:609-626`. 멀티 트랜잭션 배치에서 stale 데코레이션(외관상 문제, 자기 치유됨).

---

## 테스트 격차 (수정과 함께 추가 권장)

- `useAutoSave.test.ts`: B5(doSave vs deleteNotes 인터리빙), B4(meta 순서 크래시 윈도우) 테스트 부재
- `useNotesLoader.test.ts`: B1 폴백 스텁의 저장 동작 검증이 스텁 생성 확인에서 멈춤
- `useWindowSync.test.ts`: StrictMode 시맨틱 미적용이라 B17이 CI에 비가시
- Rust 워크스페이스 테스트 전체가 CI 미실행 (B2)

## 검증 결과 문제없음 (기록용)

- 노트 ID 경로 순회 방어(`isValidNoteId`): 견고
- 언인스톨러 삭제 안전장치(canonicalize, 보호 경로, 마커): 견고 — 단 CI 미실행(B2)
- CSP(`tauri.conf.json:28`): 적절히 엄격
- 자동 저장 직렬화 체인, 원격 삭제 톰스톤, reconcile 드리프트 재시도, 마이그레이션 드레인/하트비트, own-write 경로 정규화, 고아 meta 유예: 모두 AGENTS.md 불변식과 일치함을 확인 (깨뜨리기 시도 실패)
- GitHub Actions 커밋 SHA 고정, 서명 시크릿 스텝 스코프, `sync-version.mjs` 검증: 양호
