# darislides 개발 계획

다리챗에서 `@slides`로 발표자료를 만들고 편집한다. Bento 편집기·발표·파일 내보내기·암호화 협업·서명 업데이트는 재사용한다. 원본 서버 대신 우리 R2 업데이트 채널과 Cloudflare 협업 서버를 사용한다.

## 저장소와 원본 업데이트

- GitHub: `librorum/darislides`, 원본: `nyblnet/bento`.
- 다리챗의 `darislides/` 서브모듈로 특정 커밋을 고정한다.
- 전체 원본 이력을 보존한다. 공통 kernel과 CRDT 엔진은 수정하지 않는다.
- 자체 변경은 앱 설정·한국어 기본 제공·다리챗 메시지 브리지·협업 키 발급·배포 도구에 둔다.
- 원본 파일명과 포맷 `bento/slides`, `bento-doc`, 요소 ID를 유지한다. 새로 작성한 연동 코드는 다리챗 명명 규칙을 따른다.

원본 반영은 깨끗한 작업 트리에서 다음 순서로 진행한다. 자동으로 운영에 반영하지 않는다.

```sh
git remote add upstream https://github.com/nyblnet/bento.git # 최초 한 번
git fetch upstream --tags
git switch -c update/bento_YYYYMMDD
git merge upstream/main
pnpm install
pnpm build:single
pnpm test
node scripts/shell-gate.mjs slides/dist-single/Bento_Slides.bento.html
node scripts/test-sync-session.ts
```

충돌 검토 후 브라우저에서 기존 문서 열기·저장·부분 수정·협업·내보내기를 확인한다. 승인된 변경을 darislides main에 병합하고, 다리챗에서 서브모듈 커밋을 올린다. 앱 버전과 Bento 원본 버전은 별도로 관리한다.

## 첫 구현

- `@slides`: 문서 목록·조회·생성·부분 수정. 텍스트·노트·제목·슬라이드 추가/삭제/순서·표/차트 등 요소 교체.
- 채팅방의 현재 참여자만 저장 문서를 읽고 편집할 수 있다. 퇴장·강퇴·정지·삭제 상태를 요청마다 확인한다.
- 본문은 별도 비공개 R2 `darislides-documents`에 불변 스냅샷으로 저장한다. D1 `SlideDocument`와 `SlideRevision`은 현재 포인터·버전·이력을 관리한다.
- D1 버전 비교로 저장 충돌을 감지한다. 기존 스냅샷은 보존하고 복원도 새 버전으로 기록한다.
- `/#/slides/:doc_id`는 기본 뷰어로 연다. 명시적으로 수정 버튼을 눌러야 편집기를 시작한다. 독립 HTML도 기본 뷰어이며 발표를 종료한 카드에서 Edit를 선택한다. 초기 문서를 HTML에 넣고 편집기를 시작하므로 docId와 협업 방이 처음부터 일치한다.
- 서버 자동 저장, 변경 이력, 사용자 확인 후 복원, 저장되지 않은 변경 경고. 다리챗 안에서는 별도 평문 IndexedDB 자동 저장을 끄며, 독립 HTML의 원본 로컬 저장·복구 기능은 유지한다.
- AI 변경은 편집 중인 브라우저가 최신 버전을 확인해 기존 Bento 세션으로 적용한다. 로컬 편집과 충돌하면 덮어쓰지 않는다.
- 문서 생성 때 협업 키를 한 번 발급해 서로 다른 최초 편집자가 같은 방에 접속하게 한다. AI에는 협업 키와 자산 본문을 전달하지 않는다.

## 배포 전에 필요한 설정

개발과 운영 배포는 별개다. R2 버킷 생성, D1 migration, 협업 Worker 배포, 업데이트용 도메인·CORS, 자체 서명 키 설정은 운영 전 수행한다. 운영 빌드는 우리 발행자 공개키를 포함하며, 개인키는 저장소 밖에서 관리한다.

채팅방 권한은 서버에 저장된 문서 접근을 통제한다. 내려받은 HTML의 협업 키는 Bento의 파일 기반 권한이다. 채팅방에서 사용자를 강퇴해도 이미 받은 파일의 키는 자동으로 취소되지 않는다. Bento의 공유 키 교체·사용자 취소 기능을 사용하며, 채팅방 권한과 협업 권한의 자동 연계는 다음 단계에서 설계한다.

웹 버전을 우선 검증한다. Electron/Capacitor에는 별도 앱 번들 빌드와 브리지 origin 검증이 필요하다. 웹 배포만으로 기존 데스크톱 앱에 편집기가 추가되지는 않는다.

서버에 저장하는 원본은 AI 편집을 위해 서비스가 읽을 수 있다. 협업 relay가 암호문만 처리한다는 사실과 문서 저장소의 접근 방식은 구분한다. 비밀번호로 암호화된 파일의 서버 AI 편집은 이번 범위에 포함하지 않는다.
