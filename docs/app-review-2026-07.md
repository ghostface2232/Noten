# Noten 앱 종합 리뷰 (2026-07-07)

코드 / 기능 / 경험 세 관점에서 앱 전반을 리뷰하고, 발견된 이슈를 **독립 교차검증**한 뒤 확정된 것만 우선순위로 정리했다.

## 방법론

- **1차 리뷰(4개 영역 병렬):** ① 프론트엔드 코어 데이터 계층(App/hooks/persistence utils), ② Rust·Tauri 백엔드 + 보안(src-tauri/bootstrapper/maintenance-helper/CI), ③ 에디터 계층(TipTap 확장·컴포넌트), ④ UX·기능.
- **2차 교차검증:** 1차와 별개의 검증 리뷰어가 각 발견 사항을 반박(refute) 관점에서 인용 위치 코드를 재확인 → `확정 / 반박 / 심각도 조정` 판정.
- **기준선:** `npm run check` (typecheck + lint + test 600건) 전부 통과 상태에서 진행.
- **결과:** 후보 43건 중 **42건 확정**, 1건 반박(원래 U12), 2건 심각도 하향(U7·U8).

> 표기: `심각도` 는 데이터 손실 위험 · 재현 가능성 · 영향 범위를 종합한 값. 파일:행은 리뷰 시점(main `dfa7877`) 기준.

---

## P0 — 데이터 손실 (최우선)

사용자 조작 없이도 조용히, 영구적으로 데이터가 손상/유실될 수 있는 항목.

### P0-1. 노트 복제 후 원본 삭제 시 복제본 이미지가 영구 파손 · `high`
`src/hooks/useFileSystem.ts:894-927 (duplicateNote)`
`duplicateNote`은 마크다운을 그대로 복사하면서 `.assets/<원본noteId>/<hash>.png` 참조까지 복사하지만, **에셋 디렉터리를 복사하거나 경로를 새 noteId로 재작성하지 않는다.** 이후 원본을 영구 삭제(`removeNoteAssetDir(원본id)`, `:1257,:1277`)하거나 **휴지통 14일 자동 정리**(`useNotesLoader.ts:239-244`)가 돌면 `.assets/<원본id>/`가 통째로 삭제된다.
- **재현:** 이미지 있는 노트 복제 → 원본 영구삭제(또는 방치 후 자동 정리) → 복제본 이미지 전부 깨짐. 아무 경고 없음.
- 코드베이스 자신도 이 위험 클래스를 `migrateImageAssets.ts:36-40` 주석에 명시해 두었는데 복제 경로가 그대로 재도입함.
- **수정 방향:** 복제 시 에셋 디렉터리 복사 + 마크다운 내 `.assets/<원본id>/` → `.assets/<새id>/` 재작성.

### P0-2. 파일 워처가 편집 중 키 입력을 덮어씀 · `medium`
`src/hooks/useFileWatcher.ts:273, :296-315`
`doc.isDirty` 검사(273행)는 `await`(readTextFile·해시·getFileTimestamps) **이전에 캡처한 스냅샷**으로 이뤄지고, 실제 반영하는 `setDocs` updater(297-315)는 `prev[idx].isDirty`를 **재확인하지 않고** content 덮어쓰기 + `isDirty:false`를 강제한다. 대비되게 `useWindowSync.ts:155`는 updater 안에서 `if (prev[idx].isDirty) return prev`로 올바르게 방어한다.
- **재현:** 원격 편집이 활성 노트 파일에 도착 → OneDrive 하이드레이션으로 `readTextFile`가 수 초 지연 → 그 사이 사용자가 타이핑 → 스냅샷 검사는 이미 통과했으므로 디스크 본문으로 교체, 그동안 친 키 입력이 조용히 사라지고 다음 자동저장이 되돌린 본문을 기록.
- **수정 방향:** updater 내부에서 `prev[idx].isDirty` 재확인(useWindowSync와 동일 패턴).

### P0-3. 이미지 에셋 마이그레이션이 본문을 비원자적으로 재작성 · `medium`
`src/utils/migrateImageAssets.ts:159`
첫 실행 시 base64 이미지를 에셋 파일로 변환하며 본문을 `writeTextFile`(bare)로 쓴다. 다른 모든 본문 쓰기는 fail-closed `atomicWriteText`인데 이 파일은 ESLint durable-writer 허용목록(`eslint.config.js:63-68`) 밖이라 게이트를 빠져나갔다.
- **재현:** 최초 실행 마이그레이션 중 크래시/AV 잠금/전원 손실 → 노트 본문 truncate. 백업도 없음.
- 완화: 에셋 파일은 본문 재작성 전에 기록되므로 이미지 바이트는 대체로 살아남고, 유실되는 건 노트 텍스트다.
- **수정 방향:** `atomicWriteText(..., { failClosed: true })` 사용 + 이 파일을 durable-writer 허용목록에 추가.

### P0-4. 그룹 삭제가 stale 저장에 취소되어 부활 · `medium`
`src/utils/decomposedState.ts:471-477`
tombstone 취소 가드 `if (currentIds.has(id)) pendingTombstones.delete(id)`는 드레인 중인 `saveManifest` 호출이 캡처한 `groups` 배열을 기준으로 하는데, "그룹이 실제 부활" 과 "이 저장의 스냅샷이 삭제 이전 것" 을 구분하지 못한다. `writeGroupsWithMerge`는 병합(`groupsIO.ts:116`)이므로 살아있는 상태로 병합된 그룹이 디스크에 남는다.
- **재현:** 저장 A 진행 중(느린 클라우드) → 그룹 G 포함 저장 B 큐잉 → 사용자가 G 삭제(tombstone + G 없는 저장 C 큐잉) → B 드레인 시 G가 B 스냅샷에 있어 tombstone 취소·G를 살아있는 채 기록 → C는 tombstone 없이 G만 빠진 상태로 병합 → `deletedAt` 이 어디에도 기록되지 않음 → 재시작 시 로컬 부활 + 다른 PC에 삭제 미전파.
- **수정 방향:** tombstone에 삭제 논리시계/버전을 부여해 stale 스냅샷이 취소하지 못하게 함.

### P0-5. reconcile가 stale 스냅샷으로 전체 교체 → 동시 생성/삭제 유실 · `medium`
`src/hooks/useFileWatcher.ts:166-242`
`runReconcile`은 `docsRef.current`를 캡처(179행) 후 클라우드 디렉터리에서 수 초간 `await`하고, 결과를 `setDocs(reconciledDocs)`로 **전체 교체**(205행)한 뒤 `saveManifest`로 영속화(242행)한다. 그 사이 로컬 변경은 병합이 아니라 덮어씌워진다.
- **재현 A(생성):** 60초 주기 reconcile 진행 중 Ctrl+N → 새 노트가 결과에서 누락되어 강제 전환, 직전 자동저장이 doc 존재 가드에 걸려 유실.
- **재현 B(삭제):** reconcile 중 삭제 → stale 스냅샷이 유령 행을 되살리고, 후행 `saveManifest`가 같은 id를 docs 루프와 trashed 루프에서 동시에 써 `${path}.tmp` 경합.
- **수정 방향:** 커밋 직전 `docsRef.current` 재확인 후 로컬 우세 변경을 병합, 또는 reconcile 중 로컬 뮤테이션에 대한 배리어.

---

## P1 — 보안 · 접근성 차단 · 기능 파손 (높음)

### P1-1. 릴리스 워크플로가 코드서명 키를 모든 스텝에 노출 · `high` (보안 최우선)
`.github/workflows/release.yml:14-16`
`CODE_SIGN_PFX` / `_PASSWORD`를 job-level `env`로 선언해 서드파티 액션(`tauri-action@v0`, `dtolnay/rust-toolchain@stable` — 브랜치 ref), `npm ci`(임의 postinstall), `cargo build`(build.rs/proc-macro)까지 **모든 스텝의 환경**에 존재한다. 정작 서명이 필요한 건 서명 스텝(:75-103)뿐이다(업데이터 키는 이미 step-level로 올바르게 처리 중, :47-50).
- **위협:** 액션/의존성 하나가 손상되면 Authenticode PFX + Tauri 업데이터 개인키를 탈취 → 모든 기존 설치가 자동 수락하는 악성 `noten-setup.exe`/`latest.json` 서명 가능(신뢰 루트 붕괴).
- **수정 방향:** PFX 시크릿을 서명 스텝 한정 step-level `env`로 이동.

### P1-2. GitHub Actions 전부 mutable ref (SHA 미고정) · `medium`
`.github/workflows/release.yml:20,23,29,46,106`, `ci.yml:17,20`
모든 액션이 `@v6`/`@stable`/`@v0` 등 이동 가능 태그·브랜치 참조. 공급망 공격 시 다음 릴리스 빌드가 write 권한 + (release는) 서명 시크릿과 함께 악성 코드를 실행. P1-1의 서드파티 leg가 이걸 통해 실현됨.
- **수정 방향:** 전체 full commit SHA 고정 + Dependabot으로 갱신.

### P1-3. Tab 키 하이잭이 키보드 내비게이션을 전면 파괴 · `high`
`src/hooks/useKeyboardShortcuts.ts:70-74`
`[role="dialog"]` 밖의 모든 Tab을 `preventDefault()`하고 포커스를 에디터로 강제한다. 결과: (a) 키보드로 사이드바·툴바·타이틀바·상태바에 **영영 도달 불가**, (b) 찾기 바(`SearchBar`는 dialog 아닌 plain div)에서 Find→Replace 이동 Tab이 본문으로 포커스를 빼앗음. WCAG 2.1.1 차단.
- **수정 방향:** 포커스가 이미 본문/chrome에 있을 때로 한정하거나 별도 단축키(예: Ctrl+Shift+E)로 이동.

### P1-4. 커스텀 컨텍스트 메뉴에 키보드·ARIA·Escape 전무 · `high`
`src/utils/contextMenuRegistry.ts:24-101` (+ TextContextMenu/ImageView/MermaidCodeBlock 소비자)
raw `div`/`button`으로 `role="menu"/"menuitem"` 없음, 방향키 내비 없음, 포커스 배치 없음, **Escape 핸들러 전무**(전 저장소 grep 확인 — 닫힘은 오버레이 mousedown뿐). 사이드바 메뉴도 동일(`SidebarContextMenus.tsx:144-155`). 스크린리더 사용자는 의미 없는 버튼 뭉치를 만남.
- **수정 방향:** menu 롤/aria + 방향키 순회 + Escape 닫기 + 열릴 때 첫 항목 포커스.

### P1-5. 서브메뉴가 hover 전용 → "PDF로 내보내기" 키보드 도달 불가 · `high`
`src/components/SidebarContextMenus.tsx:294-335,443-504`, `src/components/AppMenu.tsx:224-239,253-275`
"그룹 이동", "내보내기→MD/PDF", "문단 간격" 서브메뉴가 `onMouseEnter`로만 열리고 부모 버튼에 `onClick`이 없다. P1-3와 겹쳐 PDF 내보내기로 가는 키보드 경로가 아예 없음. AppMenu 서브메뉴는 `rect.right+4`에 뷰포트 클램핑 없이 배치되어 우측 가장자리에서 잘림.
- **수정 방향:** 부모에 클릭/키보드 토글 추가 + 서브메뉴 쌍 뷰포트 클램핑.

### P1-6. 전체 바꾸기가 겹치는 매치에서 텍스트 손상 또는 예외 · `medium`
`src/components/SearchBar.tsx:213-224`
모든 치환을 한 트랜잭션에서 역순으로, **원본 좌표를 그대로** 적용(위치 매핑 없음)한다. 그러나 `findSearchMatches`는 의도적으로 겹치는 매치를 만든다(`SearchHighlight.ts:73-76`, `re.lastIndex = m.index + 1`). 역순은 비겹침에만 유효.
- **재현:** `"aaaa"`에서 `"aaa"`를 `""`로 → 두 번째 `insertText("",1,4)`가 크기 3 문서의 pos 4를 참조 → RangeError(클릭 핸들러에서 throw). 등길이 치환은 겹친 텍스트를 조용히 이중 소비.
- **수정 방향:** 각 치환 후 `tr.mapping`으로 후속 좌표 매핑, 또는 겹치지 않는 매치만 치환.

### P1-7. 마이그레이션 윈도우 크래시 시 다른 윈도우 영구 블록 · `medium`
`src/hooks/useMigrationSync.ts:182-263`
비마이그레이션 윈도우는 `notes-migration-started` 수신 후 모듈 전역 `migrationInProgress`를 올리는데(202행), 해제 경로가 `notes-migration-finished` 이벤트(또는 reload)뿐이고 **워치독/타임아웃이 없다**(5초 타임아웃은 마이그레이션 *송신* 측의 ack 대기용). 마이그레이션 윈도우가 복사 중 크래시하면 피어의 모든 저장이 조용히 no-op(`useAutoSave.ts:174,476`)되고, 사용자는 강제 종료로만 빠져나가며 세션 편집분을 잃는다.
- **수정 방향:** 피어 블록에 상한 타임아웃 + 하트비트/생존 확인 후 자동 해제.

### P1-8. WikiLink atomicity 플러그인이 키 입력마다 전체 문서 순회 · `medium`
`src/extensions/WikiLink.ts:332-408`
`appendTransaction`이 `docChanged || selectionSet` 트랜잭션마다 실행되며, 캐럿이 링크 밖(일반적 경우)이면 조기 종료가 안 되어 `doc.descendants` 전체 스캔을 수행한다. 키 입력당 스캔 3회(`handleTextInput`+:353+:387), 캐럿 이동당 1회. `fastMarkdownLexer`가 지원하려는 수백만 자 단일 블록 노트에서 타이핑 지연 유발 — AGENTS.md가 명시한 "키 입력당 증분 작업" 원칙에 정면 위배(데코레이션 플러그인은 올바르게 증분적임).
- **수정 방향:** 캐럿 주변 `$pos.marks()` 로컬 검사로 전체 순회 회피.

---

## P2 — 중간 (교정 권장)

| ID | 위치 | 요약 |
|---|---|---|
| P2-1 `medium` | `TextContextMenu.ts:89-91` | "일반 텍스트로 붙여넣기"가 `insertContent(text)`로 문자열을 HTML 파싱 → 리터럴 마크업이 서식화, 줄바꿈 붕괴. 올바른 헬퍼 `createPlainTextSlice`(TiptapEditor.tsx:89-112)가 이미 존재. |
| P2-2 `medium` | `TiptapEditor.tsx:135-139` | `stripTableCellNbsp`가 `\|...\|` 줄의 모든 `&nbsp;`를 인라인코드 인식 없이 삭제 → HTML 엔티티를 문서화한 표(`` \| `&nbsp;` \| ``)가 load/save마다 영구 손상. |
| P2-3 `medium` | `capabilities/default.json:28-38` | `fs:read/write-all`이 `$HOME/**`로 광범위 + `opener` → 렌더러 XSS 성립 시 임의 파일 read/write + 브라우저 URL 유출 채널(강한 CSP가 완화). 실제 관리 노트 루트로 좁히기 권장. |
| P2-4 `medium` | `SettingsModal.tsx:611-618` | 휴지통 개별 영구삭제에 확인/실행취소 없음("모두 비우기"는 확인 있음), "복원" 버튼 4px 옆. 파일명만 표시. |
| P2-5 `medium` | `useSettings.ts:34` | 기본 locale이 `"ko"` 하드코딩, `navigator.language` 감지 없음 → 비한국어 사용자 첫 실행이 한국어. |
| P2-6 `medium` | `exportHandlers.ts:189,:52` | PDF 실패 다이얼로그가 미번역 영어 + raw `${err}`를 본문으로 노출(앱 자체 i18n 규칙 위반). |
| P2-7 `medium` | `Sidebar.tsx:1310-1338` | 삭제/실행취소 토스트에 `role="status"`/`aria-live` 없음, 고정 6초, hover만 타이머 정지(키보드 포커스는 아님) → 스크린리더 사용자에 안내 없음. |
| P2-8 `medium` | `imageAssetUtils.ts:117,191-199` | 모듈 전역 `renderableSourceCache`가 evict/상한 없이 무한 증가(삭제·교체·디렉터리 전환 어느 것도 정리 안 함) → 이미지 많은 장기 세션에서 수백 MB 누수. |
| P2-9 `low→med` | `useWindowSync.ts:195-231,:248-260` | `doc-deleted`/`note-pinned-updated`가 `setDocs` updater 내부에서 부수효과(`setActiveIndex`/`openDocument`/`onActiveDocChanged`) 수행 → React가 updater 재실행 시 이중 발화 위험(같은 파일 `doc-updated`는 올바른 패턴 사용). |

---

## P3 — 낮음 (다듬기)

| ID | 위치 | 요약 |
|---|---|---|
| P3-1 | `imageUtils.ts:10-16` | `dataUrlToUint8Array`가 base64 가정 → `data:image/svg+xml;utf8,...` 소스에서 `atob` throw/truncate, 이미지 저장/복사 조용히 실패(try/catch 없음). |
| P3-2 | `ImageReorder.ts:25-26` | 드래그 고스트가 `attrs.src`(상대 `.assets/` 경로) 사용 → 모든 에셋 이미지에서 미리보기 깨짐(해결된 `imgEl.src` 재사용 필요). |
| P3-3 | `ImageDrop.ts:198-207` | 다중 이미지 드롭이 각자 같은 pos에 삽입 → 완료 순서에 따라 문서 순서가 뒤집힘. |
| P3-4 | `ImageDrop.ts:171-180`, `ImageView.ts:131-139` | 클립보드 쓰기가 네이티브 MIME 사용 → WebView2는 `image/png`만 허용, JPEG/GIF/WebP 복사 조용히 실패(AGENTS.md 광고 기능과 모순). PNG 트랜스코드 필요. |
| P3-5 | `WikiLink.ts:154` 외 | 이름에 `[`/`]` 포함 시 rename이 back-link를 파싱 불가 마크다운으로 재작성 → 링크 plain text로 강등. 부차: rename 정규식(리터럴)과 `findDocByTitle`(NFC 정규화) 불일치로 유니코드 정규화로 해석되는 링크가 재작성에서 누락. |
| P3-6 | `groupsIO.ts:162-170` | `genOrderKeyBefore("...0")`이 `"0i"` 반환(`"0" < "0i"`) → 반복 최상단 드래그 후 정렬 오류. |
| P3-7 | `decomposedState.ts:536-539,:147-155` | `writeLocalCache`가 에러를 삼키고 항상 resolve → 실패해도 `lastWrittenLocalCache` 기록되어 이후 동일 페이로드 재시도 스킵, 다음 실행 시 stale 노트 목록 quick-paint. |
| P3-8 | `useFileSystem.ts:929-939(exportNote), :368-376(saveFileAs)` | write 에러에 catch·사용자 피드백 없음 → 읽기전용/잠긴 대상 내보내기 실패가 조용히 성공처럼 보임. |
| P3-9 | `bootstrapper/src/installer.rs:11-22` | NSIS 페이로드를 고정 `%TEMP%\Noten_silent_setup.exe`에 쓰고 실행 → TOCTOU(동일 사용자 한정, 권한 상승 없음). 랜덤 temp 이름 권장. |
| P3-10 | `src-tauri/src/lib.rs:31-33,60` | PDF 내보내기가 노트 HTML을 고정 `%TEMP%\noten_print_preview.html`에 씀 → 동시 내보내기 경합, 크래시 시 평문 잔류. |
| P3-11 | `maintenance-helper/src/uninstaller.rs:208-217` | 중첩 고정명 디렉터리에 reparse-point 재확인 없이 `remove_dir_all`(Rust ≥1.58.1 std가 완화, `rust-toolchain.toml` 미고정). |
| P3-12 | `TitleBar.tsx:223-228` | 최대화 버튼이 최대화 상태에서 Restore 글리프로 안 바뀜. |
| P3-13 | `GoToLineBar.tsx:157-159,174-178` | `jumpToLine`가 키 입력마다 실행 + 입력을 클램프값으로 스냅 → 60줄 문서에서 "150" 입력이 중간에 "60"이 되어 끝까지 못 침. |
| P3-14 | `Sidebar.tsx:78-100` | 오래된 노트 타임스탬프에 연도 없음 → 2년 전 노트와 올해 노트 구분 불가. |
| P3-15 | `i18n.ts:262` | `"trash.count": "{n} deleted notes"` → "1 deleted notes"(영어 복수형 깨짐). 하향(경미). |
| P3-16 | `Sidebar.tsx:641-651,:673-710` | sidebar 단축키가 마지막 mousedown 영역 기준 `activeIndex` 타깃 → 예상 밖 노트에 Delete 가능. 하향(입력 중 면역 + soft delete + 실행취소로 완화). |
| P3-17 | `i18n.ts:290-304` | dead i18n 키(`menu.cut/copy/selectAll/find/exit`, `dialog.overwrite`) 미사용. |
| P3-18 | `AppMenu.tsx:267-271` | 문단 간격 체크 상태가 fontWeight + 리터럴 `"✓"`만, `aria-checked`/menuitemradio 없음. |
| P3-19 | `useKeyboardShortcuts.ts:103-126` | Ctrl+F/G/H에 모달 열림 가드 없음 → Settings 뒤에서 찾기 바가 열려 포커스 다툼. |

> **반박됨(이슈 아님):** 원래 후보였던 `Sidebar.tsx:593-598 handleDoubleClick 죽은 코드` 주장은 오류. 이 함수는 Ctrl+R/F2 rename(`:695`)과 `onStartRename`(`:1383`)에서 실제 사용됨. 다만 "행 더블클릭 rename 미지원"은 아래 제안(F-3)으로 이어짐.

---

## 향후 추가 제안 (기능 · 디자인 · 경험)

가치 대비 노력 순. 대부분 이미 존재하는 인프라를 재사용한다.

1. **빠른 승리 묶음 (반나절):** OS 로케일로 첫 실행 언어 seed(P2-5), Tab 하이잭을 포커스가 이미 chrome/본문일 때로 한정(P1-3), 아이콘 버튼 `aria-label` 일괄 추가(P1-4/U4). 투자 대비 효과 큼.
2. **첫 실행 환영 노트:** 온보딩이 전무하다. 최초 실행 시 사용자 로케일로 슬래시 커맨드·`[[위키링크]]`·표·mermaid·스크롤 시 chrome 숨김을 시연하는 실제 노트 생성(`newNote` + 마크다운 상수). README에만 있고 UI에선 드러나지 않는 기능을 자기문서화.
3. **사이드바 Shift/Ctrl+클릭 다중 선택:** select 모드·벌크 액션(`onDeleteNotes`/`onSetNotesColor`/`onMoveNotesToGroup`)과 `selectedNoteIds: Set` 상태가 이미 존재. 파일 매니저 표준 상호작용.
4. **"[[Title]] 링크 복사" 컨텍스트 메뉴:** `WikiLink`가 이미 제목을 해석. 메뉴 항목 1개 + `clipboard.writeText`로 교차 노트 워크플로 저렴화.
5. **휴지통 미리보기 + 확인 + 삭제일:** `stripMarkdownContent`(존재)로 1-2줄 스니펫 + 삭제일 표시, 개별 영구삭제에 기존 Empty-All 확인 다이얼로그 재사용(P2-4 해소).
6. **검색 옵션(대소문자/단어 단위) + "N / M" live region:** `findSearchMatches`가 단일 공유 finder라 플래그 추가가 한 경로. 비교 대상 에디터의 기본 기능.
7. **툴바 고정 옵션:** chrome 자동 숨김이 발견성 낮음. `useChromeVisibility`가 결정을 중앙집중하므로 불리언 하나로 "툴바 항상 표시" 토글.
8. **상태바 단어 수 + 읽기 시간:** `useEditorStats`가 이미 `doc.textContent` 순회. `Intl.Segmenter`(한국어 처리)로 단어 분절 추가, 클릭 시 문자↔단어 토글.
9. **빠른 전환기(Ctrl+P):** 랭킹 검색(`filteredDocs`) + `lastOpenedNoteId` + `switchDocument` 모두 존재. Ctrl+P는 이미 단축키 차단기에 잡혀 있어 키바인딩 비어 있음 — 키보드 사용자에게 사이드바 대안 제공.
10. **그룹 색상 + 오래된 타임스탬프 연도 표시:** 노트는 7색, 그룹은 무색 — `ColorSwatchRow` 재사용 가능. P3-14도 함께.

---

## 잘 되어 있는 점 (유지 권장)

- **Fail-closed 본문 쓰기 규율:** `atomicWriteText` 2-모드 설계 + ESLint 강제 + doc별 쓰기 직렬화 + 락 내부 리비전 재확인(`useAutoSave.ts:231-259`). truncation/tmp 클로버 방어가 이례적으로 완성도 높음.
- **에코 억제:** `ownWriteTracker`가 Windows 경로 별칭(`\\?\`, UNC, 대소문자, 구분자) 정규화 + 시간 grace + consume-once 해시로 동일 원격 쓰기를 삼키지 않음.
- **보수적 파괴 연산 게이팅:** orphan-meta 삭제에 이중 조건(이전 non-bulk 패스 + 90초 나이 + bulk 가드), 미확인 mtime/읽기 실패 시 행동 거부·패자 백업 우선, noteId path-safe 검증.
- **크래시 순서 마이그레이션:** copy → 설정 영속화 → 소스 정리 + 크로스윈도우 드레인 + AppData 저널(P1-7 liveness 갭 하나만 예외).
- **강한 보안 자세:** 프로덕션 CSP `script-src 'self'`(no inline/eval), `object-src/frame-src 'none'`; HTTP 클라이언트 플러그인 없음(외부 표면 = updater + opener); `resolveRenderableImageSource`가 원격/file URL 거부(추적 픽셀 방지); mermaid `securityLevel:"strict"`; 언인스톨러 다중 경로 방어(마커 요구·보호경로 denylist·빈 디렉터리만 삭제).
- **fastMarkdownLexer 견고:** 설치된 marked 17.0.4 대비 전사 정확성 확인 + 결정론적 퍼즈 테스트 가드.

---

*리뷰 방식: 4영역 병렬 1차 리뷰 → 독립 교차검증(반박 관점) → 확정 42건. 기준선 `npm run check` 전부 통과.*
