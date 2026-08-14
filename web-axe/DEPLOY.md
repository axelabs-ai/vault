# web-axe 배포 (P1 — 2026-08-14 배포 완료)

`B-vault-axe-frontend` P1 산출물의 배포 설계 + 실제 배포 기록.
**LIVE: https://vault.axelabs.ai/axe/** (2026-08-14, origin/main `e9c87b5` 빌드).

설계는 아래 1·4·5절이 그대로 살아 있고, 실행하면서 사실과 달랐던 두 곳(2절 ingress 관리
방식, 3절 컨테이너 패키징)을 실측으로 교정했다. 남은 검증은 6절 "사전 확인" 의 운영자
입회 실사용 왕복뿐이다.

## 1. 왜 same-origin 이어야 하는가 (선택이 아니라 제약)

`vault.axelabs.ai` 는 preflight 응답에 `Access-Control-Allow-Origin` 을 붙이지 않는다
(실측 2026-08-13: `allow-credentials`/`methods`/`headers` 만 회신). 따라서 다른 오리진에서
`/identity`·`/api` 를 치면 브라우저가 차단한다.

선택지는 둘뿐이었다.

| 안 | 판정 |
|---|---|
| 서버에 CORS 헤더 추가 | ✗ 금고 API 의 오리진 경계를 넓히는 변경 — 얻는 것 대비 표면이 커진다 |
| **정적 자산을 같은 오리진에서 서빙** | ✓ 채택. CORS 가 아예 발생하지 않고 `connect-src 'self'` CSP 로 잠글 수 있다 |

부수 효과로 CSP 를 최대로 조일 수 있다 — 이 앱은 **자기 오리진 밖으로 나가는 요청이 하나도 없다**
(폰트·CSS·WASM 전부 번들, 외부 CDN 0).

## 2. 라우트: `vault.axelabs.ai/axe/*`

기존 스톡 web-vault(`/`, `/identity`, `/api`, `/notifications`)를 건드리지 않고 `/axe/` 프리픽스만
새로 잡는다. 스톡 볼트는 그대로 남아 SSO·항목 편집·계정 설정 등 P1 밖의 일을 계속 맡는다
(앱 안의 "기본 볼트 열기" 링크가 그리로 보낸다).

```
                    Cloudflare (vault.axelabs.ai)
                              │
                        cloudflared ingress
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
   /axe/*  →  axe-vault-web (정적)          그 외  →  기존 vaultwarden
   (nginx/Caddy 정적 서버)                    (/, /identity, /api, /notifications)
```

`/identity`·`/api` 는 **프리픽스 밖**이므로 앱이 `location.origin` 기준으로 그대로 친다
(`src/lib/api.ts` 의 `identityUrl()`/`apiUrl()` 이 오리진 루트를 쓰는 이유). 앱을 서브패스에
두어도 API 주소는 변하지 않는다.

Vite 는 `base` 를 `/axe/` 로 잡아 빌드해야 자산 경로가 맞는다:

```bash
npm run build -- --base=/axe/
```

`base` 를 vite.config 에 박지 않고 빌드 플래그로 두는 이유 = dev(`/`)와 prod(`/axe/`)의 유일한 차이라서.

### ingress 추가 (EC2 cloudflared)

⚠️ **설계가 틀렸던 지점 (2026-08-14 실측 교정)**: 이 터널에는 `config.yml` 이 **없다.**
EC2 의 cloudflared 는 `TUNNEL_TOKEN` + `tunnel run` 으로 도는 **원격 관리형**(`config_src=cloudflare`)
이고 (`docker inspect cloudflared` → `Mounts: []`), ingress 는 Cloudflare 의 configurations API 에
산다. 게다가 이 터널은 **플랫폼 전체가 공유**한다 — 편집 전 25개 규칙이 gate·layer·hive·frame·
blueprint·matrix 등을 전부 라우팅하고 있었다. 손으로 PUT 하면 전 서비스가 걸린다.

그래서 파일을 고치는 대신 전용 도구를 쓴다 (INSERT-only, 동일 규칙이면 무동작, catch-all 과
같은 호스트의 bare 규칙 **앞**에 자동 삽입):

```bash
AXE_CF_TUNNEL_UUID=54ba125d-3564-4b8f-bda6-8eda6ad1f2a0 \
  axe tunnel add-ingress vault.axelabs.ai '^/axe(/.*)?$' http://web-axe:80
# → inserted at index 22 (바로 뒤 23번이 기존 vault.axelabs.ai → vaultwarden)
```

**cloudflared 재기동은 불필요하다** (설계에는 필요하다고 적혀 있었다). 원격 관리형이라 엣지가
새 config 를 커넥터에 밀어 넣는다 — 실측 로그 `INF Updated to new configuration ... version=19`,
`RestartCount=0`, 업타임 유지. 즉 **블립 0**.

롤백 = 그 규칙 하나만 되돌린다. 기존 볼트 경로는 애초에 건드리지 않아 데이터 위험이 없다:

```bash
# 편집 직전 전체 config 스냅샷을 떠 두고 시작할 것 (add-ingress 는 백업을 남기지 않는다).
# 롤백: 스냅샷의 result.config 를 그대로 PUT 하거나, 규칙 하나만 빼고 PUT.
GET/PUT https://api.cloudflare.com/client/v4/accounts/<acct>/cfd_tunnel/<uuid>/configurations
```

## 3. 정적 서빙 컨테이너 — 이미지가 아니라 bind mount

설계는 Dockerfile 로 산출물을 구운 이미지였다. **실제로는 스톡 `nginx:alpine` + bind mount 로
갔다**: 정적 파일 11 MB 때문에 이미지 태그 수명주기(빌드·푸시·레지스트리·pull)를 하나 더 만들
이유가 없고, 롤백이 "이전 dist 를 되돌리고 restart" 로 끝난다.

실제 배포된 조각 = [`deploy/compose-web-axe.yml`](deploy/compose-web-axe.yml)
(`/opt/axe/vault/docker-compose.yml` 의 `services:` 아래에 그대로 들어가 있다).
conf 2파일 = [`deploy/nginx/`](deploy/nginx/).

- **호스트 포트를 열지 않는다.** cloudflared 가 `vault_default` 네트워크 안에서
  `http://web-axe:80` 으로 직접 붙는다 (cloudflared 는 이 노드에서 11개 네트워크에 붙어 있다).
- **디렉터리를 마운트한다, 단일 파일이 아니라.** 단일 파일 bind mount 는 inode 를 묶어서,
  나중에 conf 를 에디터로 다시 쓰면 새 inode 가 생기고 컨테이너는 옛 파일에 고착된다.
- `dist/` 를 `/usr/share/nginx/html/axe` 에 두면 `/axe/*` 가 그대로 파일 경로에 매핑된다.
  SPA 라우팅이 없으므로(단일 진입점) fallback 규칙이 불필요하다.

⚠️ **`docker compose up -d` 를 인자 없이 돌리지 말 것.** 이 노드의 cloudflared 는 compose 가
모르는 10개 네트워크에 추가로 붙어 있어서, 재생성되면 그 연결을 잃고 **플랫폼 전체가 끊긴다.**
반드시 서비스명을 명시한다: `docker compose up -d web-axe`.

## 4. 캐싱 전략

Vite 가 이미 **content-hash 파일명**을 붙인다 (`index-CUA0DEhF.js`, `PretendardVariable.subset.2-dCZkyKLw.woff2`).
해시가 붙은 것과 안 붙은 것을 정확히 갈라야 한다.

| 경로 | `Cache-Control` | 근거 |
|---|---|---|
| `/axe/index.html` | `no-cache` | 해시 없음. 항상 재검증해 새 번들 해시를 집어야 한다 |
| `/axe/assets/*` (js·css·woff2) | `public, max-age=31536000, immutable` | 파일명에 content hash → 내용이 바뀌면 이름이 바뀐다 |
| `/axe/assets/*.wasm` | `public, max-age=31536000, immutable` | 동일. 아래 WASM 절 참조 |

⚠️ **nginx `add_header` 상속 함정 (리뷰 반영)**: location 블록에 `add_header` 가 **하나라도** 있으면
부모(server) 레벨의 `add_header` 는 **전부 상속되지 않는다.** 아래처럼 캐시 헤더만 추가하면 그
응답들은 5절의 보안 헤더를 통째로 잃는다. 그래서 보안 헤더 전체를 스니펫으로 빼고, `add_header`
를 쓰는 **모든** location 에서 다시 include 한다:

```nginx
# /etc/nginx/snippets/axe-security-headers.conf — 5절의 add_header 7줄 전체가 여기 들어간다

server {
  include snippets/axe-security-headers.conf;   # add_header 없는 location 들의 기본값

  location = /axe/index.html {
    include snippets/axe-security-headers.conf; # add_header 를 쓰는 순간 상속이 끊기므로 재-include 필수
    add_header Cache-Control "no-cache" always;
  }
  location /axe/assets/ {
    include snippets/axe-security-headers.conf;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }
}
```

배포 검증 시 `curl -sI` 로 **세 경로 모두**( `/axe/` · `/axe/index.html` · `/axe/assets/<파일>` )에서
CSP 헤더가 실제로 나오는지 확인할 것 — 이 함정은 설정이 조용히 통과하고 헤더만 사라진다.

### WASM 이 캐싱 설계의 중심인 이유

`bitwarden_wasm_internal_bg.wasm` = **7.5 MB (gzip 2.9 MB)** 로 전체 페이로드를 지배한다.
나머지(JS 320 KB + CSS 209 KB + 폰트 서브셋)를 다 합쳐도 이것의 1/5 이다.

1. **`Content-Type: application/wasm` 필수.** 이게 틀리면 `WebAssembly.instantiateStreaming` 이
   스트리밍 컴파일을 포기하고 전체 다운로드 후 컴파일로 떨어진다. nginx `mime.types` 최신본에는
   있으나 확인할 것 — `types { application/wasm wasm; }`.
2. **압축은 사전 압축으로.** 7.5 MB 를 매 요청 gzip 하는 건 낭비다. 빌드 때 `.wasm.gz` 를 만들어 두고
   `gzip_static on` 으로 낸다. ⚠️ `brotli_static` 은 쓰지 않는다 (리뷰 반영) — 공식 `nginx:alpine`
   이미지에는 brotli 모듈이 없어 그 지시어가 기동 실패를 부른다. Brotli(gzip 대비 ~15% 추가 절감)가
   정말 필요해지면 ngx_brotli 를 포함해 빌드된 이미지로 교체하는 별도 결정으로 다룬다.
3. **immutable 이 실질적으로 유일한 최적화.** 파일명 해시 덕에 첫 방문 후 재방문은 네트워크 0 이다.
   SDK 를 올리면 해시가 바뀌어 자동으로 새로 받는다 — 무효화 절차가 따로 없다.
4. 폰트도 같은 규칙을 탄다. Pretendard 는 **dynamic subset** 이라 실제로 쓰이는 서브셋 몇 개만
   내려간다 (전체 90여 개가 아니다). Sarasa(534 KB)는 mono 가 실제로 그려질 때만 받는다.

## 5. 보안 헤더 (엣지에서 강제)

`index.html` 의 `<meta http-equiv="Content-Security-Policy">` 는 2선이다. meta 는 `frame-ancestors` 를
지원하지 않으므로 **진짜 방어선은 아래 HTTP 헤더**다.

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
```

- `'wasm-unsafe-eval'` 은 **뺄 수 없다** — 이게 없으면 크립토가 통째로 죽는다.
- `script-src` 에 `'unsafe-inline'` 이 없다: 빌드 산출물에 인라인 `<script>` 가 0 개다
  (`build.modulePreload.polyfill = false` 로 Vite 의 인라인 폴리필까지 제거했다). `dist/index.html` 을
  열어 보면 정책의 증거가 그대로 보인다.
- `style-src 'unsafe-inline'` 은 남아 있다 — React 가 인라인 `style` 속성을 쓴다(레일 카운트 정렬,
  TOTP 배지 등). **하드닝 항목**: 이 인라인 스타일들을 걷어내면 `'unsafe-inline'` 을 뺄 수 있다.
- `connect-src 'self'` 는 이 앱의 성질을 그대로 못박는다 — 자기 오리진(=금고 서버) 외에는 어디에도
  말을 걸지 않는다.

## 6. 배포 절차 (실행됨)

빌드 → S3 스테이징 → SSM 으로 호스트에 전개 → compose 서비스 기동 → ingress 한 줄.
재배포는 [`deploy/redeploy.sh`](deploy/redeploy.sh) 가 이 순서를 그대로 담고 있다.

```bash
cd web-axe
npm ci
npm run axe-ui:check                # @axe/ui Consumer Kit 드리프트
npm test                            # 크립토 KAT + 서버 계약 카나리 (라이브 서버 왕복 포함)
npm run build -- --base=/axe/       # base 는 vite.config 에 박지 않는다 (dev=/ 와의 유일한 차이)

# 사전 압축 — gzip 만. 폰트(woff2)는 이미 압축돼 있어 제외한다.
find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.wasm' -o -name '*.html' \) \
  -exec gzip -9 -k -f {} +
```

호스트 전개 (`axe` CLI 의 기존 관례 = SSE S3 스테이징 + SSM):

```bash
COPYFILE_DISABLE=1 tar czf web-axe-deploy.tgz -C stage .   # ⚠️ 아래 함정 참조
aws s3 cp web-axe-deploy.tgz \
  s3://axelabs-axe-backup-offsite-6051/_deploy-staging/vault-web-axe/web-axe-deploy.tgz \
  --sse AES256 --region ap-northeast-2
# SSM: s3 cp → sha256 -c → rsync -a --delete 로 /opt/axe/vault/{web-axe-dist,web-axe-nginx}
docker compose -f /opt/axe/vault/docker-compose.yml up -d web-axe   # 서비스명 명시 필수 (3절)
```

### 실행하며 밟은 함정 (다음 사람이 같은 데 빠지지 않게)

- ⚠️ **macOS `tar` 의 AppleDouble**: 그냥 `tar czf` 하면 xattr 가 `._*` 파일로 딸려 간다.
  그중 `conf.d/._default.conf` 는 nginx 의 `include conf.d/*.conf` 에 **걸려서 파싱되고**,
  바이너리라 기동이 깨진다. `COPYFILE_DISABLE=1` (+ `xattr -rc`) 로 차단할 것.
  검산: `tar tzf … | grep -c '\._'` 가 0.
- ⚠️ **디렉터리를 `mv` 로 갈아치우지 말 것**: bind mount 가 옛 inode 에 고착된다.
  재배포는 `rsync -a --delete` 로 **내용만** 교체한다. 파일명이 content-hash 라
  "새 파일 추가 → index.html 교체" 순서가 자연스럽게 무중단이다.
- **전개 검산은 매니페스트 해시로**: `find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum`
  을 로컬/호스트 양쪽에서 떠서 대조한다 (파일 수까지 함께). 배포된 값 = `1f8fe31c…`, 101 files.

### 사전 확인

- [x] `npm run axe-ui:check` 통과 — @axe/ui 0.36.0, 555 selectors, `ff27964ef334`
- [x] `npm test` 14/14 통과 (라이브 `prelogin` 왕복 + 클라이언트 버전 핀 대조 포함)
- [x] `dist/index.html` 에 인라인 `<script>` 0 개
- [x] `/axe/` 200 + 자산 경로가 `/axe/assets/…` 로 나옴
- [x] CSP 등 보안 헤더 7종이 **세 경로 모두**에서 실측됨 (4절 상속 함정)
- [x] `.wasm` = `application/wasm` + `immutable` + gzip 사전압축(2.75 MB/7.5 MB),
      압축 해제 후 sha256 이 로컬 원본과 일치
- [x] 스톡 볼트 무영향 — `/` 200 · `/alive` 200 · `/identity/accounts/prelogin` 200 ·
      `/api/config` 200, vaultwarden 컨테이너 ID·기동시각 불변
- [ ] **실계정 로그인 → sync → 복호 → TOTP → 잠금/해제 왕복 (운영자 입회)** ← 유일한 잔여

## 7. 미결 사항

- **@axe/ui 드리프트 게이트**: `axe ship` 의 consumer-kit 게이트는 `SHIP_SERVICES` 에 등록된
  서비스에만 돈다. `/Users/axe/vault` 는 미등록이라 지금은 `npm run axe-ui:check` 를 수동/CI 로
  돌려야 한다. 등록한다면 서비스 키를 `vault` 로 잡지 말 것 — 그 이름은 axe CLI 안에서 이미
  Vaultwarden **비밀 서비스**를 가리킨다 (`~/.axe/vault`). `vault-web` 류로 구분한다.
  또한 게이트는 `axe-ui.consumer.json` 을 **repo 루트**에서 찾는다 — 지금은 `web-axe/` 안에 있다.
- **`Bitwarden-Client-Version` 핀**: 서버의 스톡 web-vault 를 올리면 `src/lib/api.ts` 의 상수도
  같이 올려야 한다. `tests/server-contract.test.mjs` 가 라이브 번들과 대조해 감시한다.
- ~~**압축 산출물**: `.br`/`.gz` 사전 압축을 빌드 파이프라인 어디서 만들지 미정~~
  → **확정**: 이미지 빌드 스테이지가 사라졌으므로(3절) **호스트 빌드 직후 `gzip -9 -k`**
  로 만들어 dist 와 함께 전개한다 (6절). brotli 는 계속 쓰지 않는다 — `nginx:alpine` 에
  모듈이 없다.
- **`index.html` 에 CSP meta 가 2개 나온다** (신규 발견, 배포와는 무관):
  `vite.config.ts` 의 `cspMeta` 플러그인이 하나를 주입하는데, `e9c87b5` 가 `index.html`
  소스에도 실물을 하나 넣었다. prod 는 두 정책이 **동일**해서 교집합도 동일 — 무해하다.
  하지만 **dev 는 깨진다**: 플러그인은 dev 에서 `script-src` 에 `'unsafe-inline'` 을 넣는데
  소스의 meta 에는 없고, CSP 가 여러 개면 브라우저는 **교집합**을 적용하므로 HMR 인라인
  스크립트가 차단된다. 둘 중 하나로 정리해야 한다 (플러그인만 남기거나, 플러그인이 소스의
  meta 를 치환하도록). 배포된 산출물에는 영향이 없어 이번 배포에서는 손대지 않았다.
