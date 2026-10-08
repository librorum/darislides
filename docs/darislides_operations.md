# darislides 실행과 배포

## 개발

다리챗 루트에서:

```sh
pnpm install
pnpm slides:install
pnpm slides:build
pnpm slides:sync
pnpm dev
```

백엔드 `.dev.vars`에는 `SLIDES_SYNC_URL=ws://localhost:8892`를 설정한다. 문서의 실제 `collab.room`에 이 주소가 저장된다. 독립 편집기로 새 문서를 만들 때도 로컬 relay를 사용하려면 `DARISLIDES_SYNC_HOST=ws://localhost:8892 pnpm slides`로 실행한다. 이 환경 변수는 HTML 빌드에도 사용할 수 있다.

로컬 DB에는 기존 migration에 이어 `migrations/031_slide_document.sql`을 적용한다. 백엔드의 `SLIDE_DOCUMENTS` 바인딩은 로컬 개발 중 Wrangler가 모의 실행한다. 공개 `IMAGES` 버킷과 문서 저장 버킷은 분리되어 있다.

별도 darislides clone에서는 `pnpm install`, `pnpm dev`, `pnpm build:single`, `pnpm sync:dev`, `pnpm test`를 사용한다. 단독 HTML 파일명은 원본 빌드 도구와의 호환성을 위해 `slides/dist-single/Bento_Slides.bento.html`로 유지한다. 외부 배포 이름은 `darislides.bento.html`이다.

## 운영 준비

다음은 운영 배포를 요청받았을 때 실행할 작업이다. 개발 과정에서는 원격 리소스를 만들거나 운영 데이터를 변경하지 않는다.

1. 같은 Cloudflare 계정에 R2 Standard 버킷 `darislides-documents`(비공개), `darislides-blobs`(비공개), `darislides-releases`(공개 파일 배포용)를 만든다.
2. 다리챗 D1에 migration 031을 적용한다.
3. `darislides/wrangler.jsonc`의 계정·도메인을 확인하고 `darislides-sync` Worker를 배포한다. 도메인은 `sync.slides.darichat.com`이다. DO와 R2 relay 코드는 원본 그대로다.
4. release 버킷에 `slides.darichat.com` 커스텀 도메인을 연결한다. 공개 읽기용 CORS는 GET·HEAD, origin `*`로 설정한다. 독립 파일에서도 manifest와 HTML을 읽을 수 있어야 한다.
5. 우리 발행자의 P-256 서명 키를 저장소 밖에서 한 번 생성한다. 원본의 `~/.bento/release-key.json`은 사용하지 않는다. 개인키는 Git·CI에 넣지 않고 백업한다. 공개키만 `config/release_config.example.json`을 참고한 별도 설정 파일에 넣는다.
6. `DARISLIDES_RELEASE_CONFIG`를 해당 설정 파일의 절대 경로로 지정하고, `DARISLIDES_RELEASE=1`로 release 빌드를 실행한다. 공개키 없는 release 빌드는 실패한다.
7. conformance gate와 테스트 후 우리 키로 서명한다. 앱 이름은 `darislides`, 버전은 앱 버전, 다운로드 URL은 `https://slides.darichat.com/releases/slides/<버전>/darislides.bento.html`로 지정한다.
8. `node scripts/publish_r2.mjs darislides-releases <manifest.json>`을 실행한다. 이 명령은 서명·앱·버전·파일 해시·우리 배포 URL을 검증한 뒤 버전별 HTML을 먼저 올리고 manifest를 마지막에 올린다. `pnpm exec wrangler` 인증이 필요하다.
9. 다리챗 버전업·커밋·푸시 후 `pnpm run deploy`로 웹을 배포한다. 앱 반영은 별도 `pnpm run release:app` 과정이다.

HTML은 버전별 경로에 보관하고 `max-age=31536000, immutable`, manifest는 `max-age=60`을 설정한다. 이전 HTML은 삭제하지 않아 내려받기와 롤백에 사용할 수 있게 한다. 서버가 바뀌어도 이미 내려받은 파일은 빌드 시 지정한 주소·공개키를 유지한다.

업로드 후 D1 기록 전에 장애가 나면 R2에 미참조 스냅샷이 남을 수 있다. `SlideRevision`에 기록된 모든 키와 대조해 미참조 파일만 정리한다. 보존 중인 이력 객체에 일괄 TTL을 적용하지 않는다.

## 검증

```sh
pnpm test:slides                         # 다리챗 루트: 실제 SQLite를 사용한 저장·권한·경쟁 저장 테스트
pnpm -C darislides test            # 우리 업데이트 서명 채널과 협업 키 호환성
pnpm build                              # 편집기 HTML + 다리챗 빌드
pnpm -C darislides sync:check      # 협업 Worker 패키징 dry-run
pnpm exec wrangler deploy --dry-run      # 다리챗 패키징 dry-run
```

로컬 브라우저 검증은 다리챗 루트에서 `node test/slides_browser_server.js`를 실행하고 `http://localhost:9000/__slides_test_login`을 연다. SQLite·R2 모의 저장소와 실제 Slides API를 사용하며 운영 로그인이나 데이터를 사용하지 않는다. 별도로 로컬 relay를 실행하면 서로 다른 브라우저 세션의 암호화 협업도 확인할 수 있다.
