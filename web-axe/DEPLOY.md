# web-axe 배포 (P1 — 2026-08-14 배포 + 루트 컷오버 + SSO 네이티브 재배포 완료)

`B-vault-axe-frontend` P1 산출물의 배포 설계 + 실제 배포 기록.

**LIVE: https://vault.axelabs.ai/ — 루트가 AXE Vault 앱이다.**
스톡 web-vault 는 **https://vault-classic.axelabs.ai/** 로 옮겨졌다 (같은 vaultwarden
컨테이너, 호스트명만 다르다). 구 진입점 `https://vault.axelabs.ai/axe/` 도 하위호환으로 산다.

같은 날 세 번에 나눠 배포했다: 먼저 `/axe/` 서브패스로 올리고(설계 원안), 이어서 운영자
지시로 루트 컷오버를 했고, 마지막으로 SSO 네이티브 로그인 + 브랜드 아이콘 빌드(`1249fa3`)를
재배포하며 **미적용으로 남아 있던 ingress 규칙 ④**를 넣었다. 설계의 1·4·5절은 그대로 살아
있고, 실행하며 사실과 달랐던 곳(2절 ingress 관리 방식, 3절 컨테이너 패키징)은 실측으로
교정했다. 남은 검증은 6절 "사전 확인" 의 운영자 입회 실사용 왕복 + `/favicon.ico` 엣지
캐시 만료(2절 ④)뿐이다.

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

## 2. 라우트: 루트가 앱, 서버 경로는 vaultwarden

```
                 Cloudflare
        ┌────────────┴─────────────┐
 vault.axelabs.ai          vault-classic.axelabs.ai
        │                          │
  cloudflared ingress              └─→ 전부 vaultwarden (스톡 web-vault + API)
        │
        ├─ ^/axe(/.*)?$              → web-axe   (구 진입점, 하위호환)
        ├─ ^/(|index\.html|assets/.*)$ → web-axe   (앱이 소유한 경로 allowlist)
        └─ (bare, 그 외 전부)        → vaultwarden
```

| 호스트 / 경로 | 도착지 | 역할 |
|---|---|---|
| `vault.axelabs.ai/` · `/index.html` · `/assets/*` | **web-axe** | AXE Vault 앱 |
| `vault.axelabs.ai/favicon.{ico,svg}` · `/apple-touch-icon.png` | **web-axe** (규칙 ④, 2026-08-14 적용됨) | AXE 브랜드 아이콘 |
| `vault.axelabs.ai/axe/*` | **web-axe** | 구 진입점 하위호환 |
| `vault.axelabs.ai` 의 **그 외 전부** | **vaultwarden** | `/api` `/identity` `/notifications` `/icons` `/attachments` `/alive` `/admin` `/css` `/vw_static` `/sso-connector.html` `/.well-known` `/app` `/images` · 루트 해시 파일(`styles.<hash>.css` 등) |
| `vault-classic.axelabs.ai/*` | **vaultwarden** | 스톡 web-vault — 관리 콘솔·SSO 첫 가입·P1 미구현 기능 폴백 |

### ⚠️ allowlist 이지 blocklist 가 아니다 (이 배포에서 제일 중요한 결정)

서버 경로를 **열거해서 vaultwarden 으로 보내는** 방식은 쓰지 않았다. 그 방식은
**실패 방향이 위험하다** — 목록에서 빠뜨린 경로는 정적 서버로 가서 404 가 되고,
데스크톱·CLI·확장이 조용히 죽는다. 경로 목록은 서버를 올릴 때마다 늘어날 수 있어
"지금 다 적었다"를 보장할 방법도 없다.

그래서 **뒤집었다**: 앱이 소유한 경로(`/`·`/index.html`·`/assets/*`·`/axe/*`)만 명시하고,
**나머지 전부는 기존 bare 규칙으로 흘러 vaultwarden 이 받는다.** 우리가 미처 생각 못 한
경로가 있어도 그건 컷오버 전과 똑같이 vaultwarden 이 처리한다 — 실패 방향이 안전하다.

이게 성립하는 근거(실측 2026-08-14): 스톡 web-vault 번들은 `images/`·`app/`·`css/` 와
루트 해시 파일만 참조하고 **`/assets/` 를 쓰지 않는다.** 즉 우리 allowlist 는 스톡
번들과 겹치지 않는다. Vite 의 출력 디렉터리가 `assets/` 라 이 분리가 자연스럽다.

검증도 이 결정에 맞췄다: 컷오버 전/후로 서버 경로 16종의 **상태코드 + 본문 sha256** 을
떠서 완전 일치를 확인했다(6절). "열거가 맞았는지" 대신 "계약이 안 변했는지"를 본다.

`/identity`·`/api` 는 allowlist 밖이라 앱이 `location.origin` 기준으로 쳐도 그대로
vaultwarden 에 닿는다 (`src/lib/api.ts` 의 `identityUrl()`/`apiUrl()`). same-origin 이므로
CORS 는 여전히 발생하지 않는다.

Vite `base` 는 이제 기본값(`/`)이라 빌드 플래그가 필요 없다:

```bash
npm run build          # 컷오버 전에는 -- --base=/axe/ 였다
```

### SSO 콜백 — 네이티브 완결 + 포워딩 심 (2026-08-14 갱신)

서버는 SSO 콜백을 자기 `DOMAIN` = `https://vault.axelabs.ai` 로 되돌린다. 정확한 경로는
`{DOMAIN}/sso-connector.html?code=…&state=…` 이고(서버가 `client_id=web` 에서 클라이언트가
보낸 redirect_uri 를 버리고 이 값으로 고정한다 — fork 소스 `src/sso.rs` `authorize_url`),
그 스톡 정적 파일이 마지막으로 **루트 + `#/sso?code=…&state=…`** 로 넘긴다. 즉 착지점은
이 앱이다. `sso-connector.html` 은 allowlist 밖이라 계속 vaultwarden 이 서빙한다.

컷오버 직후에는 이 앱이 그 흐름을 **완결할 수 없었다** — PKCE `code_verifier` 가 흐름을
시작한 오리진(=classic)의 `sessionStorage` 에 있었기 때문이다. 지금은 **이 앱도 흐름을
시작한다**(로그인 화면의 "SSO 로 로그인"). 그래서 판정이 하나 늘었다:

| 콜백의 state | 처리 | 근거 |
|---|---|---|
| 이 탭이 저장한 값과 **일치** | **네이티브 완결** — 코드 교환 → 마스터 패스워드 잠금해제 | verifier 가 이 오리진에 있다 |
| 불일치·부재 | 기존대로 **classic 포워딩** | verifier 가 저쪽에 있다 (외부 개시 흐름 보존) |

판정은 `src/lib/sso.ts` `ssoRoute`/`takeSsoRoute`, 포워딩 목적지 계산은 그대로
`src/lib/classic.ts`. 경계 정규식을 두 곳이 공유해 `#/ssoconfig` 같은 라우트를 삼키지
않는다 (`tests/classic.test.mjs` + `tests/sso.test.mjs`). 서버의 `DOMAIN` 은 여전히
건드리지 않는다 — 이메일 링크·SSO 등록 URL 이 연쇄로 흔들린다.

⚠️ **dev(:4290)에서는 왕복이 끝나지 않는다.** 서버 `DOMAIN` 이 프로덕션이라 콜백이
`vault.axelabs.ai` 로 착지한다. dev 에서 실측 가능한 것은 시작 레그(prevalidate →
authorize → Entra 도달)까지다. 완결 레그는 프로덕션에서만 육안 검증할 수 있다.

### ingress 추가 (EC2 cloudflared)

⚠️ **설계가 틀렸던 지점 (2026-08-14 실측 교정)**: 이 터널에는 `config.yml` 이 **없다.**
EC2 의 cloudflared 는 `TUNNEL_TOKEN` + `tunnel run` 으로 도는 **원격 관리형**(`config_src=cloudflare`)
이고 (`docker inspect cloudflared` → `Mounts: []`), ingress 는 Cloudflare 의 configurations API 에
산다. 게다가 이 터널은 **플랫폼 전체가 공유**한다 — 편집 전 25개 규칙이 gate·layer·hive·frame·
blueprint·matrix 등을 전부 라우팅하고 있었다. 손으로 PUT 하면 전 서비스가 걸린다.

그래서 파일을 고치는 대신 전용 도구를 쓴다 (INSERT-only, 동일 규칙이면 무동작, catch-all 과
같은 호스트의 bare 규칙 **앞**에 자동 삽입):

```bash
export AXE_CF_TUNNEL_UUID=54ba125d-3564-4b8f-bda6-8eda6ad1f2a0

# ① 구 진입점 (최초 배포)                              → index 22
axe tunnel add-ingress vault.axelabs.ai '^/axe(/.*)?$' http://web-axe:80

# ② 스톡 볼트의 새 집 — DNS 먼저, 그다음 규칙           → index 26
axe cf dns-ensure vault-classic.axelabs.ai \
  --cname 54ba125d-3564-4b8f-bda6-8eda6ad1f2a0.cfargotunnel.com --proxied
axe tunnel add-ingress vault-classic.axelabs.ai '.*' http://vaultwarden:80

# ③ 루트 컷오버 — 이 한 줄이 컷오버 그 자체다             → index 23
axe tunnel add-ingress vault.axelabs.ai '^/(|index\.html|assets/.*)$' http://web-axe:80

# ④ 브랜드 아이콘 (2026-08-14 적용됨)                     → index 24, version 21→22
#    이 규칙이 없으면 /favicon.* 는 allowlist 밖이라 vaultwarden 이 받아
#    **Bitwarden 아이콘**을 계속 낸다. index.html 의 <link> 만으로는 효과가 없다.
axe tunnel add-ingress vault.axelabs.ai '^/(favicon\.(ico|svg)|apple-touch-icon\.png)$' http://web-axe:80
```

⚠️ **④ 의 함정 — 규칙이 맞아도 `/favicon.ico` 는 즉시 안 바뀐다 (2026-08-14 실측)**:
`.svg`·`.png` 는 규칙 적용 직후 AXE 아이콘이 나갔지만 `.ico` 만 **Bitwarden 것이 계속
나왔다**. 오리진은 정상이었다 — 캐시키를 비껴가는 `?cachebust=…` 로 치면 AXE 마스터가
바이트 단위로 일치했다. 원인은 **Cloudflare 엣지 캐시**다: 규칙 적용 *전*에 vaultwarden 이
`Cache-Control: public, max-age=604800, immutable` 로 내준 응답을 엣지가 물고 있었고
(`cf-cache-status: HIT`, `age` 약 4.4시간), `.svg`·`.png` 는 그 전에 404 라 캐시된 객체가
없어서 바로 바뀐 것이다. 즉 **"이미 200 으로 서빙되던 경로를 새 오리진으로 옮길 때만"**
나오는 함정이다.

정상 해소 = 단일 URL 퍼지 (zone 전체 `--everything` 은 플랫폼 공유라 금지):

```bash
axe cf purge https://vault.axelabs.ai/favicon.ico
```

**단, 지금은 이 명령이 HTTP 401 로 막힌다** — vault 의 `Cloudflare API - axelabs` 토큰에
`Zone: Cache Purge` 권한이 없다 (`cloudflare/axe/zone-settings-token`·
`account-tunnel-dns-token` 도 동일하게 401). 권한을 추가하기 전까지는 엣지 TTL 이 자연
만료될 때까지(적용 시점 기준 약 6.8일) 콜로별로 순차 반영된다 — 캐시가 없던 콜로는 첫
요청에 바로 AXE 아이콘을 받는다. 백로그 = `B-cf-token-cache-purge`.

네 번 다 **INSERT-only** 다 (①~④ 전부 적용됨). 기존 규칙을 고치거나 지우지 않는다 —
그래서 각각 그 한 줄만 빼면 정확히 이전 상태로 돌아간다. `add-ingress` 는 같은 호스트의 bare 규칙 **앞**에
자동 삽입하므로 순서를 손으로 계산할 필요도 없다.

**cloudflared 재기동은 불필요하다** (설계에는 필요하다고 적혀 있었다). 원격 관리형이라 엣지가
새 config 를 커넥터에 밀어 넣는다 — 실측 로그 `INF Updated to new configuration ... version=19`,
`RestartCount=0`, 업타임 유지. 즉 **블립 0**. 컷오버 전 구간(v19→v21)도 재기동 0 이었다.

**롤백** = 컷오버 규칙 한 줄 제거. 스냅샷을 미리 떠 두고 시작한다
(`add-ingress` 는 백업을 남기지 않는다 — `set-ingress` 만 남긴다):

```bash
# 스냅샷 (실제 파일, ~/.axe/tunnels/ingress-backups/ 아래):
#   54ba125d-…-20260814T012000Z-precutover.json   ← 루트 컷오버 직전 (version 21 이전)
#   54ba125d-…-20260814T052753Z-prefavicon.json   ← 규칙 ④ 직전 (version 21, 28 rules)
# 롤백 = 그 파일의 result.config 를 그대로 PUT:
PUT https://api.cloudflare.com/client/v4/accounts/<acct>/cfd_tunnel/<uuid>/configurations
    body = {"config": <스냅샷의 result.config>}
```

루트 컷오버만 되돌리고 `/axe/` 는 남기고 싶다면 `^/(|index\.html|assets/.*)$` 규칙 하나만
배열에서 빼고 PUT 한다. 어느 쪽이든 vaultwarden 컨테이너와 데이터는 무접촉이다.

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
- `dist/` 를 `/usr/share/nginx/html` 에 두면 `/` · `/assets/*` 가 그대로 파일 경로에
  매핑된다 (컷오버 전에는 `.../html/axe` 였다 — 마운트 지점만 바뀌었다).
  SPA 라우팅이 없으므로(단일 진입점) fallback 규칙이 불필요하다. 구 `/axe/` 는 nginx 가
  같은 index 를 내주는 exact-match location 으로 살려 둔다.
- **volume 을 바꾸면 컨테이너 재생성이 필요하다** (`up -d web-axe`). 이때도 서비스명을
  반드시 명시할 것 — 아래 경고 참조.

⚠️ **`docker compose up -d` 를 인자 없이 돌리지 말 것.** 이 노드의 cloudflared 는 compose 가
모르는 10개 네트워크에 추가로 붙어 있어서, 재생성되면 그 연결을 잃고 **플랫폼 전체가 끊긴다.**
반드시 서비스명을 명시한다: `docker compose up -d web-axe`.

## 4. 캐싱 전략

Vite 가 이미 **content-hash 파일명**을 붙인다 (`index-CUA0DEhF.js`, `PretendardVariable.subset.2-dCZkyKLw.woff2`).
해시가 붙은 것과 안 붙은 것을 정확히 갈라야 한다.

| 경로 | `Cache-Control` | 근거 |
|---|---|---|
| `/` · `/index.html` · `/axe/` | `no-cache` | 해시 없음. 항상 재검증해 새 번들 해시를 집어야 한다 |
| `/assets/*` (js·css·woff2) | `public, max-age=31536000, immutable` | 파일명에 content hash → 내용이 바뀌면 이름이 바뀐다 |
| `/assets/*.wasm` | `public, max-age=31536000, immutable` | 동일. 아래 WASM 절 참조 |

⚠️ **nginx `add_header` 상속 함정 (리뷰 반영)**: location 블록에 `add_header` 가 **하나라도** 있으면
부모(server) 레벨의 `add_header` 는 **전부 상속되지 않는다.** 아래처럼 캐시 헤더만 추가하면 그
응답들은 5절의 보안 헤더를 통째로 잃는다. 그래서 보안 헤더 전체를 스니펫으로 빼고, `add_header`
를 쓰는 **모든** location 에서 다시 include 한다:

```nginx
# /etc/nginx/snippets/axe-security-headers.conf — 5절의 add_header 7줄 전체가 여기 들어간다

server {
  include snippets/axe-security-headers.conf;   # add_header 없는 location 들의 기본값

  location = /index.html {
    include snippets/axe-security-headers.conf; # add_header 를 쓰는 순간 상속이 끊기므로 재-include 필수
    add_header Cache-Control "no-cache" always;
  }
  location /assets/ {
    include snippets/axe-security-headers.conf;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }
}
```

배포 검증 시 `curl -sI` 로 **세 경로 모두**( `/` · `/index.html` · `/assets/<파일>` )에서
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
npm run build                       # base=/ (기본값). 컷오버 전에는 -- --base=/axe/ 였다

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
  을 로컬/호스트 양쪽에서 떠서 대조한다 (파일 수까지 함께).
  현재 배포된 값 = `bf130abc…`, 104 files (`1249fa3` SSO 네이티브 빌드 — 아이콘 3개가 늘어
  101 → 104). 이전: 루트 컷오버 `160a2a05…`/101, 그 전 `/axe/` 빌드 `1f8fe31c…`.
- ⚠️ **이미 200 이던 경로를 새 오리진으로 옮기면 Cloudflare 엣지가 옛 응답을 물고 있다**:
  ingress 규칙이 맞아도 공개 URL 이 안 바뀐다. `?cachebust=…` 로 캐시키를 비껴가 오리진을
  먼저 분리 확인하고, `axe cf purge <url>` 로 단일 URL 만 퍼지한다. 상세 = 2절 ④ 의 함정.
- ⚠️ **컷오버는 마지막 한 줄이어야 한다**: 컨테이너를 새 마운트로 먼저 띄우고 내부에서
  전부 확인한 뒤, ingress 규칙을 마지막에 넣는다. 그러면 공개 트래픽이 바뀌는 순간이
  단 한 번이고, 롤백도 그 한 줄만 되돌리면 된다.

### 사전 확인

- [x] `npm run axe-ui:check` 통과 — @axe/ui 0.36.0, 555 selectors, `ff27964ef334`
- [x] `npm test` 39/39 통과 (라이브 `prelogin` 왕복 + 클라이언트 버전 핀 + SSO 심 경계
      + 네이티브 SSO PKCE/교환/2FA)
- [x] `dist/index.html` 에 인라인 `<script>` 0 개
- [x] 루트 `/` 200 + `<title>AXE Vault</title>` + 자산이 `/assets/…`
- [x] **루트가 새 빌드** — 공개 `index.html` + 참조 자산 2개가 로컬 `dist/` 와 sha256 완전 일치
      (`index-MflxdPX7.js` · `index-DXZzmPRn.css`)
- [x] **브랜드 아이콘** — `/favicon.svg`·`/apple-touch-icon.png` 이 `~/AXE/favicon-build/`
      마스터와 sha256 일치. `/favicon.ico` 는 오리진 일치, 공개 URL 은 엣지 캐시 만료 대기(2절 ④)
- [x] CSP 등 보안 헤더 7종이 **세 경로 모두**(`/`·`/index.html`·`/assets/<파일>`)에서 실측
- [x] `.wasm` = `application/wasm` + `immutable` + gzip 사전압축(2.75 MB/7.5 MB),
      압축 해제 후 sha256 이 로컬 원본과 일치
- [x] **서버 경로 계약 무변화** — 컷오버 전/후 16종의 상태코드 + 본문 sha256 완전 일치
      (`/api/config` `/alive` `/css/vaultwarden.css` `/vw_static/*` `/icons/*`
      `/sso-connector.html` `/admin` `/app/*` `/images/*` 루트 해시 파일
      `/.well-known/*` `/notifications/*` `/attachments/*` + POST `prelogin`·`prelogin/password`)
- [x] **재배포(`1249fa3`) 전/후에도 계약 무변화** — `/api/config` `/css/vaultwarden.css`
      `/sso-connector.html` `/vw_static/*` 의 상태코드 + 본문 sha256 동일, POST `prelogin` 동일,
      `/alive` 200(타임스탬프라 값만 다름), 루트 해시 파일 `styles.*.css`·`app/vendor.*.js` 200
- [x] `vault-classic.axelabs.ai` = 스톡 볼트 (테마 CSS·번들 200, 절대주소로 튕기지 않음)
- [x] `/axe/` 하위호환 200, `/axe` → 301
- [x] SSO 심 — 출고된 minified 코드를 그대로 실행해 경계 동작 확인
- [x] vaultwarden·cloudflared 컨테이너 ID 불변, cloudflared 재기동 0
      (규칙 ④ 적용 후에도 `RestartCount=0`, `StartedAt` 불변 — 원격 관리형이라 블립 0)
- [ ] **`/favicon.ico` 공개 URL** — 오리진은 확인됨, 엣지 캐시가 만료(또는 퍼지)되어야 반영 (2절 ④)
- [ ] **실계정 로그인 → sync → 복호 → TOTP → 잠금/해제 왕복 (운영자 입회)**
- [ ] **SSO 실왕복 (운영자 입회)**: classic 에서 SSO 시작 → 콜백이 루트로 떨어짐 →
      심이 classic 으로 되돌려 완결되는지. 심 로직은 단위/출고물 검증까지 끝났고
      남은 건 실제 IdP 왕복이다.

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
