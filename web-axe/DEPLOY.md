# web-axe 배포 설계 (P1 — 설계만, 구현은 후속)

`B-vault-axe-frontend` P1 산출물의 배포안. **아직 배포하지 않는다** — 이 문서는 상위 세션이
운영자와 실사용 검증을 마친 뒤 실행할 계획서다.

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

`config.yml` 의 ingress 규칙은 **위에서부터** 매칭되므로 `/axe` 규칙이 기존 catch-all 보다 앞서야 한다.

```yaml
ingress:
  - hostname: vault.axelabs.ai
    path: ^/axe(/.*)?$
    service: http://axe-vault-web:80      # 새 정적 컨테이너
  - hostname: vault.axelabs.ai
    service: http://vault-caddy:80        # 기존 (변경 없음)
  - service: http_status:404
```

롤백 = 첫 규칙 한 블록 삭제 후 `cloudflared` 재기동. 기존 볼트 경로는 애초에 건드리지 않으므로
롤백에 데이터 위험이 없다.

## 3. 정적 서빙 컨테이너

```dockerfile
# 빌드는 CI/호스트에서 끝내고 이미지는 산출물만 담는다 (런타임에 node 불필요).
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html/axe/
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

`dist/` 를 `/axe/` 아래에 두면 nginx `try_files` 가 프리픽스를 그대로 서빙한다. SPA 라우팅이
없으므로(단일 진입점) fallback 규칙도 불필요하다.

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

## 6. 배포 절차 (예정)

```bash
cd web-axe
npm ci
npm run axe-ui:check          # @axe/ui Consumer Kit 드리프트 확인
npm test                      # 크립토 KAT + 서버 계약 카나리
npm run build -- --base=/axe/
# → dist/ 를 이미지에 담아 EC2 로, ingress 규칙 추가 후 cloudflared 재기동
```

### 사전 확인

- [ ] `npm run axe-ui:check` 통과 (kit 이 axelabs 정본과 동일한 content-sha256)
- [ ] `dist/index.html` 에 인라인 `<script>` 0 개
- [ ] `/axe/` 로 열었을 때 `/identity/accounts/prelogin` 이 same-origin 으로 200
- [ ] 실계정 로그인 → sync → 복호 → TOTP → 잠금/해제 왕복 (운영자 입회)
- [ ] 스톡 볼트(`/`) 무영향 확인

## 7. 미결 사항

- **@axe/ui 드리프트 게이트**: `axe ship` 의 consumer-kit 게이트는 `SHIP_SERVICES` 에 등록된
  서비스에만 돈다. `/Users/axe/vault` 는 미등록이라 지금은 `npm run axe-ui:check` 를 수동/CI 로
  돌려야 한다. 등록한다면 서비스 키를 `vault` 로 잡지 말 것 — 그 이름은 axe CLI 안에서 이미
  Vaultwarden **비밀 서비스**를 가리킨다 (`~/.axe/vault`). `vault-web` 류로 구분한다.
  또한 게이트는 `axe-ui.consumer.json` 을 **repo 루트**에서 찾는다 — 지금은 `web-axe/` 안에 있다.
- **`Bitwarden-Client-Version` 핀**: 서버의 스톡 web-vault 를 올리면 `src/lib/api.ts` 의 상수도
  같이 올려야 한다. `tests/server-contract.test.mjs` 가 라이브 번들과 대조해 감시한다.
- **압축 산출물**: `.br`/`.gz` 사전 압축을 빌드 파이프라인 어디서 만들지 미정 (Dockerfile 빌드
  스테이지 vs CI).
