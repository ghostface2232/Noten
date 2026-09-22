# Noten 검토 미처리 항목 (2026-09-22)

영속성 계층 외부 리뷰에 대응한 [PR #60](https://github.com/ghostface2232/Noten/pull/60) 이후, 다섯 개의 독립 검토(영역 분담 2 + 전체 2 + 앱 전수 1)에서 나온 지적 중 **그 PR 범위 밖이라 처리하지 않은 것들**입니다. PR에서 다룬 항목(투영 노트 삭제, 사이드카 격리, 복구 저널 등)은 여기 없습니다.

모든 항목은 실제 코드를 읽어 확인했고, 재현한 것은 그렇게 표시했습니다. 심각도 순입니다.

> **착수 전 확인**: 이 문서는 2026-09-22 시점의 스냅샷입니다. 해당 코드를 먼저 읽고 여전히 유효한지 확인하십시오.

---

## 심각도: 높음 (영구 손실)

### R1. `doc-renamed`가 `customName`을 싣지 않아 두 번째 창이 이름 붙인 노트를 영구 삭제
- **위치**: `src/hooks/useWindowSync.ts:34-40` (`DocRenamedPayload`), `:328-339` (수신부). 소비자는 `src/hooks/useFileSystem.ts`의 세 prune 지점 — `pruneEmptyCurrentDoc`, `newNote`의 `willReplace`, `restoreNote`의 `pruneLeavingDoc`.
- **확인**: 페이로드에 `customName` 필드가 없고, 수신부는 `{ ...docs[idx], filePath, fileName }`만 커밋합니다. `renameNote`는 로컬에서 `customName: true`를 세우지만 그 사실이 이벤트로 건너가지 않습니다.
- **시나리오**: 창 A에서 빈 자동 제목 노트를 F2로 "장보기"라고 이름 붙입니다. A는 `doc-renamed`를 즉시 emit하고 사이드카 쓰기는 큐에 넣습니다. 창 B는 `fileName`만 갱신하고 `customName`은 거짓으로 둡니다. A의 사이드카가 도착하고 B의 `.meta` 워처가 뜨기 전에(`WATCH_DELAY_MS` 1500 ms, 클라우드 폴더에서는 훨씬 김) 사용자가 B에서 다른 노트를 클릭하면, `pruneEmptyCurrentDoc`이 빈 본문 + 거짓 `customName` + 알려진 baseline + `docs.length > 1`을 보고 `.md`와 사이드카를 지웁니다. **휴지통도 `.conflicts`도 거치지 않으며 모든 동기화 기기에서 사라집니다.** Ctrl+N(`willReplace`)도 같은 삭제에 도달합니다.
- **수정 방향**: 페이로드에 `customName`을 추가하고 수신부에서 커밋. 더 근본적으로는, 세 prune과 `willReplace`가 읽는 모든 필드는 그 필드를 바꿀 수 있는 모든 이벤트에 실려야 한다는 규칙을 contract 테스트로 고정.

- **처리 (브랜치 `c/review-findings-backlog`)**: `6123dc6`이 페이로드와 수신부에 `customName`을 실었습니다. 이후 검토에서 같은 필드가 하이드레이션 병합(`mergeHydratedLibrary`)과 `.meta` 워처(`applyMetaChange`)로도 들어오며, 둘 다 rename보다 오래된 사이드카를 읽으면 같은 삭제에 도달한다는 점이 드러났습니다. `customName`은 살아 있는 노트에서 켜지기만 하므로(사용자 동작으로 끄는 경로가 없음) 읽은 값이 꺼져 있고 메모리가 켜져 있으면 그 읽기가 오래된 것입니다. `31e46a9`이 이 규칙을 `keepManualTitle`(`src/utils/documentTitle.ts`) 하나에 담아 두 지점에 적용했고, 이어진 검토에서 같은 퇴행이 쓰기 쪽에도 세 곳 남아 있음이 드러났습니다. 휴지통, 삭제, 복원 경로의 `mergeNoteMeta`, 이름 변경을 보지 못한 창이 메모리의 쌍을 그대로 쓰는 `persistDecomposedState`, 그리고 폴더 병합 마이그레이션입니다. `5104d23`이 이 셋도 같은 헬퍼로 모았고, contract 테스트는 모든 병합 지점과 전제(문자 그대로 끄는 곳은 레거시 휴지통 분해 두 곳뿐)를 고정합니다.

### R2. `renameNote`가 이스케이프하지 않은 제목을 치환 문자열로 넘겨 역링크 노트 본문을 손상
- **위치**: `src/hooks/useFileSystem.ts:1342` (`const replacement = \`[[${trimmed}]]\``), 사용처 `:1386` (`base.replace(rewritePattern, replacement)`). 패턴 쪽은 `escapeRegexForRename`(`:50-52`)으로 이스케이프되지만 치환 문자열은 아닙니다.
- **확인**: 실제 코드 그대로 재현했습니다.
  - 새 제목 `Budget $' 2026` → `See [[Budget  for details.\nA long tail of the note follows here. 2026]] for details.…` (노트의 나머지 전체가 링크 안으로 끼어듭니다)
  - 새 제목 `Rock $$ Roll` → 모든 `[[Budget]]`이 `[[Rock $ Roll]]`이 되어 어느 노트로도 해석되지 않습니다
  - 새 제목 `Q1 $& Q2` → `[[Q1 [[Budget]] Q2]]`
- **시나리오**: 손상된 본문은 `rewriteNoteFile` → `atomicWriteText(..., { failClosed: true })`로 디스크에 확정되고 이어서 `setKnownDiskContent`까지 갱신되므로 `.conflicts` 사본이 남지 않습니다(`:1449-1456`). 한 번의 이름 변경으로 그 노트를 링크하던 모든 노트가 영향을 받습니다. `$$`는 LaTeX나 가격 표기로 충분히 현실적입니다.
- **수정 방향**: 치환 문자열의 `$`를 `$$`로 이스케이프하거나, 치환 함수 형태(`(…) => replacement`)를 쓰면 해석이 일어나지 않습니다. `src/utils/migrateImageAssets.ts:94`의 `full.replace(dataUrl, src)`도 같은 계열이며 도달 가능성은 훨씬 낮습니다.

- **처리 (브랜치 `c/review-findings-backlog`)**: `d0a8abd`이 치환 함수 형태로 바꿨고, `$'` `$$` `$&` `` $` ``를 담은 제목으로 회귀 테스트를 두었습니다. `migrateImageAssets.ts`의 같은 계열은 검토에서 도달 가능하다고 확인되어(레거시 파일명이 id로 남고 `isValidNoteId`가 `$` `&` `'`를 허용) `d245b33`에서 같은 방식으로 고쳤습니다.

---

## 심각도: 중간 (특정 조건에서의 손실)

### R3. 휴지통 14일 퍼지가 벽시계 차이를 보정하지 않음
- **위치**: `src/hooks/useNotesLoader.ts:479, 517-521` (`purgeExpiredTrash`)
- **시나리오**: `Date.now() - note.trashedAt`을 14일과 비교하며 하한도 없고 `.trash` 파일 mtime과의 교차 확인도 없습니다. 시계가 14일 이상 뒤진 기기(CMOS 배터리 방전, 스냅샷에서 복원한 VM, NTP 이전에 부팅한 기기)에서 버린 노트는 정상 기기의 **다음 실행에서** 본문·사이드카·`.assets/<id>/`가 함께 영구 삭제됩니다. 사용자는 아직 복원할 수 있다고 기대하는 구간입니다. 반대 방향(`trashedAt > now`)은 영원히 보존되므로 무해합니다.
- **수정 방향**: `NoteMeta`에 이미 있는 `lastWriterMachineId`로 자기 기기 스탬프와 외부 스탬프를 구분하고, 두 시계가 허용 오차 이상 어긋나면 퍼지를 보류.

### R4. reconcile의 root 대 trash 판정이 로컬 mtime과 원격 벽시계를 직접 비교
- **위치**: `src/utils/reconcileFolder.ts:358`
- **시나리오**: `rootMtime > meta.trashedAt`으로 "삭제 이후에 본문이 수정되었는가"를 판정하는데, 좌변은 로컬 파일시스템 mtime이고 우변은 다른 기기의 벽시계입니다. 기기 B의 시계가 A보다 (B가 그 노트를 마지막으로 편집한 시점만큼) 앞서 있으면 A의 삭제가 B에서 취소되고 복원으로 역전파됩니다. 내용은 살아남지만(휴지통 본문이 먼저 `.conflicts`로 백업됨) 삭제가 붙지 않고 노트가 되돌아옵니다.
- **수정 방향**: R3과 동일하게 `lastWriterMachineId` 기반으로 바꾸거나, 두 시계를 비교하는 일 자체를 없애고 존재 여부로 판정.

### R5. `restoreNotesDir` 롤백이 baseline 맵을 비우고 재하이드레이션하지 않음
- **위치**: `src/hooks/useNotesLoader.ts:425-438` (`resetKnownDiskContent()` 호출), `src/App.tsx:846-851` (`revertNotesDirChange`가 `reloadKey`를 올리지 않음)
- **시나리오**: PR #60 이전에는 빈 baseline 맵이 무해했습니다(첫 저장이 조용히 seed). 이제는 세 가지가 동시에 일어납니다. (a) 롤백 이후 사용자가 건드리는 모든 노트의 첫 저장이 불필요한 `.conflicts` 사본을 만들고, (b) 세 prune이 그 세션 내내 거부되며, (c) 이후 저널에 기록되는 레코드가 `baseContent: null`이라 복구에서 절대 적용되지 못하고 `.conflicts`로만 갑니다.
- **경계**: 기존 코드지만 PR #60의 baseline 의미 변경이 결과를 악화시켰습니다. 우선순위를 높게 볼 근거가 됩니다.
- **수정 방향**: 롤백 경로에서 재하이드레이션하거나, 보존해 둔 `preserved` 스냅샷으로 baseline을 다시 seed.

### R6. 폴더 초기화가 대상 폴더를 가드 없이 지우고, 두 overwrite 경로가 `.conflicts`까지 삭제
- **위치**: `src/App.tsx:1007-1011, 1051` 대 `:883-893`; `src/utils/migrateNotesDir.ts:470-473`, `isManagedRootEntry`(`:110-118`)
- **시나리오**: `handleChangeNotesDir`는 `hasExistingNotenData`를 확인하고 병합/덮어쓰기/선택 폴더만 사용 중에서 고르게 합니다. `handleResetNotesDir`는 일반적인 확인 하나만 받고 `migrateNotesDir(oldDir, defaultDir, "overwrite")`를 호출하며, 이는 `clearDirContents`로 대상의 모든 관리 데이터를 지운 뒤 복사합니다. `merge` 경로에 있는 `backupOverwrittenBody`가 없습니다. 기본 폴더는 보통 비어 있지만, 이전 마이그레이션의 source clear가 유예되었거나 실패한 경우 도달합니다.
- **별개로**: `.conflicts`가 관리 항목 목록에 있어서 두 overwrite 경로 모두 대상 폴더의 충돌 보관함을 지웁니다. 앱이 이미 보존해 둔 본문이 있는 유일한 장소이고, 경고 문구(`i18n.ts:257`)는 그 사실을 말하지 않으며, `merge`는 의도적으로 `.conflicts`를 합집합 복사합니다(`migrateNotesDir.ts:588-594`).
- **수정 방향**: `isManagedRootEntry`에서 `.conflicts` 제외. 초기화 경로에도 목적지 데이터 확인을 추가.

### R7. `applyRemoteBody`가 baseline을 seed하지 않음
- **위치**: `src/hooks/useWindowSync.ts:270-292` (인라인 `content` 분기와 `:320`의 `readTextFile` 폴백 모두)
- **시나리오**: PR #60이 `doc-created`와 `restoreNote` 읽기에는 seed를 넣었지만 이 형제 경로는 빠졌습니다. 창 A가 노트 N을 저장하고 emit → B는 본문을 메모리에 반영하지만 baseline은 예전 값 유지 → B의 워처 이벤트가 도착하기 전에 사용자가 B에서 N을 편집하고 자동 저장이 돌면, `backupIfRemoteWroteFirst`가 `disk ≠ lastKnown`이자 `disk ≠ intended`를 보고 **이미 메모리에 갖고 있던 본문의** `.conflicts` 사본을 만듭니다. 창 간 편집 인계마다 불필요한 파일 하나입니다. 손실은 아니지만 `src/hooks/AGENTS.md`의 "본문을 알게 되는 모든 경로가 seed해야 한다" 규칙의 열거에서도 이 경로가 빠져 있어 코드와 문서가 함께 틀려 있습니다.
- **수정 방향**: `applyRemoteBody`가 `commitRemote`의 결과(거절 시 null)를 반환하므로, 워처와 같은 "채택했을 때만 seed" 패턴을 그대로 쓸 수 있습니다.

### R8. 순서 키의 표현 불가능한 두 경우에 재정규화 경로가 없음
- **위치**: `src/utils/groupsIO.ts:186-190, 214-221`, 유일한 호출부 `src/hooks/useNoteGroups.ts:262-265`
- **시나리오**: PR #60의 주석은 "호출부가 목록을 재정규화해야 한다"고 적었지만 그런 경로는 트리 어디에도 없습니다. `reorderGroups`는 받은 키를 그대로 persist합니다. 그룹을 맨 위로 열여덟 번쯤 끌면 첫 키가 `"0"`에 도달하고, `genOrderKeyBefore("0")`은 `"0i"`를 반환해 `"0"` **뒤에** 정렬됩니다. 그룹이 시각적으로는 두 번째에 놓이고 잘못된 키가 `.groups.json`에 기록되어 모든 기기로 전파되며, 같은 드래그를 반복해도 낫지 않습니다. `genOrderKeyBetween(a, a + "0")`도 같습니다. 퍼즈 테스트는 이 두 입력을 `continue`로 건너뛰므로 불변식이 성립하는 범위에서만 검증합니다.
- **수정 방향**: 호출부에서 `!(a < key && key < b)`를 감지하면 목록 전체를 다시 키잉.

### R9. `closeBlockedOnceRef`가 만료되지 않음
- **위치**: `src/App.tsx:452, 1428-1437`
- **시나리오**: 이 ref는 닫기 시도의 드레인이 **성공**할 때만 초기화됩니다. 10시에 일시적 클라우드 문제로 한 번 거부당한 사용자가 종일 작업하고 18시에 처음 닫기를 시도하면, 완전히 다른(그리고 고칠 수 있는) 원인에 대해 곧바로 "닫으면 버려집니다" 확인을 받습니다. 한 번의 클릭으로 저널이 덮지 않는 하루치 이름/핀/색상/그룹 변경이 사라집니다. 주석은 "첫 거부는 원인을 설명하고 창을 열어 둔다"고 약속하지만 창 수명당 한 번입니다.
- **수정 방향**: 에피소드 단위로 만료(시간 기반, 또는 실패 원인이 바뀌면 초기화).

### R10. 보조 창 레이블이 실행마다 새로 만들어지고 빈 디렉터리가 누적
- **위치**: `src/utils/newWindow.ts:7` (`win-${Date.now()}-${n}`), `src/utils/recoveryJournal.ts:149-162`, `src/hooks/editRecovery.ts:23-29`
- **시나리오**: 보조 창은 "자기 이전 실행의 레코드"를 절대 찾지 못합니다. 그 레코드는 오직 main의 고아 수거를 통해서만 돌아옵니다. 따라서 `close.unsavedJournalled`의 "다음에 Noten을 실행할 때 복구합니다"는, 닫는 창이 마지막 창이 아닐 때 사실이 아닙니다. 그리고 `clearRecoveryRecord`는 파일만 지우고 레이블 디렉터리는 남기므로 `recovery/`에 빈 `win-<ts>-<n>/`가 실행마다 하나씩 영구 누적되고, 매 시작 시 전부 `readDir`합니다.
- **수정 방향**: 레이블을 창 슬롯 단위로 안정화하거나, 레이블별 프레이밍을 버리고 main이 전부 수거한다고 문서와 코드에 명시. 빈 디렉터리는 수거 후 제거.

---

## 심각도: 성능 (수천 개 노트 라이브러리)

`bench/`는 노트 **크기**를 키우며 에디터를 측정합니다. 아래 둘은 라이브러리 **개수**에 비례하므로 기존 벤치에 잡히지 않습니다.

### R11. 타이핑이 이어지는 동안 매 워처 이벤트가 라이브러리 전체 reconcile을 유발
- **위치**: `src/hooks/useFileWatcher.ts:455-465`, `:541` → `performReconcile`(`:229`) → `invalidateReadAllMetaCache`(`:245`) → `readAllMeta`
- **시나리오**: `isOwnWriteContentMatch` 단축 경로(`:475`)는 dirty가 **아닌** 문서에서만 도달합니다(`:461-464`). `App.tsx:729-736`이 `state.isDirty`를 활성 문서에 반영하므로, 자동 저장 자신의 `.md` rename에 대한 1500 ms 지연 이벤트가 도착할 무렵 문서는 이미 다시 dirty입니다. 그래서 `shouldReconcile = true`로 빠지고, `scanAndAbsorbConflicts`(노트 디렉터리와 `.meta`의 `readDir`)와 캐시가 무효화된 사이드카 전수 읽기, `.trash`의 `readDir`이 워처 창마다 한 번씩, 사용자가 타이핑하는 내내 반복됩니다. 수천 개 노트 OneDrive 폴더에서 2초마다 수천 번의 IPC 왕복이며 각각이 플레이스홀더 하이드레이션을 유발할 수 있습니다.
- **수정 방향**: own-write 내용 일치를 dirty 검사보다 먼저 판정하거나, 변경된 `.md` 경로가 전부 알려진 own write일 때 reconcile을 생략.

### R12. 사이드바 검색이 `docs` 커밋마다 라이브러리 전체를 다시 소문자화
- **위치**: `src/components/Sidebar.tsx:579-609`
- **시나리오**: `strippedContentMap`은 문서 id별로 본문을 캐시하지만(`:558-577`), `filteredDocs`는 `docs`에 의존해 배열 identity가 바뀔 때마다 모든 노트에 대해 `stripped.toLowerCase().includes(q)`를 다시 계산합니다. `docs`는 자동 저장 커밋마다 새 배열입니다(`useAutoSave.ts:600`의 `sortNotes`). 검색 바를 열어 둔 채 타이핑하면 초당 한 번씩 라이브러리 전체의 소문자 사본을 할당하고 훑습니다.
- **수정 방향**: 소문자형을 `stripped` 옆에 함께 캐시.

---

## 구조 관찰 (버그 아님)

- **`customName`은 파괴적 경로가 읽는 필드인데 세 채널을 서로 다른 충실도로 건너갔습니다.** 사이드카 병합은 보호하고, `.meta` 워처는 복구하지만 문서가 clean일 때만이며, `doc-renamed`는 아예 떨어뜨렸습니다(R1, 처리됨). 채널마다 필드를 싣는 것만으로는 닫히지 않았고, 닫은 것은 필드의 성질(단조성)을 병합 규칙으로 만든 것이었습니다. 파괴적 경로가 읽는 다른 필드가 생기면 같은 질문, 즉 어떤 채널이 그 값을 되돌릴 수 있는지부터 물어야 합니다.
- **기기 간 순서를 네 개의 서로 다른 시계가 결정합니다.** 사이드카 `updatedAt`/`groupUpdatedAt`, 파일 mtime, `Date.now()` 보존 기간, 이벤트 채널의 `lastBodyAtByDoc`/`lastMembershipAtByNote`. 마지막 것만 창 안에서 단조입니다. 노트당 버전 하나로 모으는 이연 항목이 앞의 둘을 합치고, R3과 R4가 셋째가 실제로 데이터를 파괴하는 지점입니다.
- **reconcile 비용이 트리거당 O(라이브러리)이고 트리거는 로컬 쓰기가 만듭니다.** R11이 급성 증상이지만, 구조적 문제는 "원격에서 뭔가 바뀌었는가"에 대한 값싼 부정 검사(디렉터리 mtime, `.groups.json`의 세대 카운터, 패스별 목록 해시)가 없다는 점입니다.
- **모든 노트 본문이 세션 내내 메모리에 상주합니다**(`useNotesLoader.ts:626`의 `attachDocContents`). 사이드바 검색, `renameNote`의 역링크 스캔, `getLiveDocsSnapshot`이 모두 `doc.content`를 직접 읽기 때문입니다. R12가 가능한 이유이자 시작 비용이 라이브러리 총 바이트에 비례하는 이유입니다.
- **`migrateDataUrlImagesToAssets`가 `markOwnWrite` 없이 본문을 재작성하고**(`src/utils/migrateImageAssets.ts:161`), 개별 노트가 실패해도 `imageAssetMigrationV1CompletedAtCache`를 무조건 설정해 재시도가 없습니다. 영향이 낮아 여기 둡니다.

---

## 검토가 틀렸던 것

기록해 둡니다. 같은 지적이 다시 올라올 수 있습니다.

- "시작 시 모든 본문을 동시성 제한 없이 `Promise.all`로 읽는다" — `attachDocContents`는 이미 `mapWithConcurrency`를 씁니다. 실제 위반은 `readAllMeta`의 사이드카 읽기였고 PR #60에서 고쳤습니다.
- "`print_to_pdf`의 임시 파일명이 고정" — 이미 호출별로 pid + 나노초 + 시퀀스로 고유합니다.
