# vault — Vaultwarden 셀프호스팅 (회사 + 가족 패스워드 금고)

회사 자산 ~20개 계정 + 가족 1~2명 공유 계정. macmini Docker + Tailscale LAN. 비용 0, 데이터 주권 100%.

상세 설계는 `~/realchoice-ssot/docs/vault-bootstrap-2026-05-11.md` 참조.

---

## 토폴로지

```
인간 (Mac/iOS/가족 폰)
   ↓ Tailscale tailnet (LAN only, 공개 노출 X)
   ↓
macmini:8222 → Caddy → Vaultwarden (SQLite)
   ↓
~/backups/vault/ (매일 03:10, GPG)
   ↓
Backblaze B2 (rclone) + 분기 USB → 금고
```

- **MCP 평면과 격리** — magnet/stream/realchoice MCP는 vault 데이터 read/write 절대 금지
- **stream 신호 1개**: 백업 실패 → `magnet_alerts.vault_health` → Slack `#data-ops`

---

## 디렉터리

```
~/vault/                      ← 본 레포 (soohunkang/vault private)
├── compose.yaml              docker compose 정의
├── Caddyfile                 리버스 프록시 1줄
├── vault-backup.pub.asc      백업용 GPG 공개키 (커밋 가능)
├── data/                     Vaultwarden SQLite + 첨부 (gitignore)
├── caddy-data/               Caddy 캐시 (gitignore)
├── scripts/
│   ├── up.sh                 docker compose up -d (env_file 절대경로)
│   ├── down.sh
│   ├── backup.sh             매일 03:10 호출 (LaunchAgent)
│   ├── restore-test.sh       복구 드릴 (분기 1회)
│   ├── gpg-init.sh           백업용 GPG 키 페어 생성
│   └── com.realchoice.vault-backup.plist    LaunchAgent 정의
└── docs/
    └── onboarding-ko.md      가족용 한국어 가이드

~/.config/vault/              vault 외부 (gitignore 무관, 권한 700)
├── .env                      ADMIN_TOKEN(Argon2id) + DOMAIN + SIGNUPS_ALLOWED  (600)
└── ADMIN_TOKEN_PLAINTEXT     초기 admin 패널 진입용 평문 (600, vault entry 등록 후 삭제)

~/backups/vault/              백업 (gitignore 무관, 권한 700)
├── YYYY-MM-DD.tar.gpg        매일 GPG 암호화 아카이브
└── ...                       (7일 회전)
```

---

## 운영 명령

```bash
# 가동
~/vault/scripts/up.sh

# 정지
~/vault/scripts/down.sh

# 수동 백업
~/vault/scripts/backup.sh

# 복구 드릴
~/vault/scripts/restore-test.sh ~/backups/vault/2026-05-12.tar.gpg

# 로그
docker logs -f vault-app
docker logs -f vault-caddy
tail -f ~/realchoice-ssot/logs/vault-backup.log

# 헬스체크 (Tailscale LAN 안에서)
curl -fsS https://macmini.<TAILNET>.ts.net/alive
```

---

## Phase 진행 상태

| Phase | 상태 | 비고 |
|---|---|---|
| Phase 0 인프라 가동 | **완료 (2026-05-12)** | 컨테이너 healthy, GPG 키, 첫 백업, LaunchAgent 가동 |
| Phase 1 본인 운영자 셋업 | 부분 완료 | Master Password 후보 생성 — 본인 signup만 남음 |
| Phase 2 P0 마이그레이션 | 미진입 | Week 1 (8개) |
| Phase 3 P1·P2·가족 | 미진입 | Week 2~4 |
| Phase 4 운영 정착 | 자동 | 일/주/월/분기 daemon·체크리스트 가동 중 |

### Phase 0 배포 산출물 (2026-05-12 실측)

| 항목 | 상태 |
|---|---|
| `vault-app` (Vaultwarden 1.35.8-alpine) | Up, healthy |
| `vault-caddy` (Caddy 2-alpine) | Up |
| `/alive` ([localhost:8222](http://127.0.0.1:8222/alive)) | 200 OK |
| GPG keypair `vault-backup@realchoice.co.kr` | 생성됨 (ed25519+cv25519, unattended) |
| 첫 백업 `~/backups/vault/2026-05-12.tar.gpg` | 12K, restore-test PASS |
| `com.realchoice.vault-backup` LaunchAgent | bootstrapped (매일 03:10) |
| `com.realchoice.vault-health` LaunchAgent | running (10분 주기, `~/realchoice-ssot/logs/vault-health.jsonl`) |
| Master Password 후보 | `~/.config/vault/MASTER_PASSWORD_INITIAL` (600) |
| GitHub repo | [soohunkang/vault](https://github.com/soohunkang/vault), main branch pushed |

### 외부 노출 (Tailscale) — 마지막 1단계

vault 컨테이너는 macmini 로컬에서만 접속 가능한 상태. 가족·다른 디바이스 접근은 Tailscale Serve 활성화 시 자동 연결.

```bash
# 1. Tailscale 가입 + macmini를 첫 디바이스로 등록 (브라우저 SSO, 5분)
sudo tailscale up

# 2. macmini DOMAIN 자동 채움 + 외부 LAN 노출 활성화 (1줄)
~/vault/scripts/tailscale-setup.sh

# 3. 컨테이너 재기동으로 DOMAIN 반영
~/vault/scripts/down.sh && ~/vault/scripts/up.sh

# 4. 본인 signup — Master Password 후보는 ~/.config/vault/MASTER_PASSWORD_INITIAL
open https://macmini.<tailnet>.ts.net   # 또는 http://127.0.0.1:8222 from macmini
```

### 운영자 첫 signup 후 즉시 할 일 (5분)

```bash
# A. 가입 완료 후 신규 가입 차단
sed -i.bak 's/^SIGNUPS_ALLOWED=true/SIGNUPS_ALLOWED=false/' ~/.config/vault/.env
~/vault/scripts/down.sh && ~/vault/scripts/up.sh

# B. 초기 비밀 파일 폐기 (Master Password를 손글씨 종이 2부로 옮긴 후)
shred -u ~/.config/vault/ADMIN_TOKEN_PLAINTEXT
shred -u ~/.config/vault/MASTER_PASSWORD_INITIAL
```

---

## 보안 규칙 (요약)

- `~/.config/vault/.env`, `ADMIN_TOKEN_PLAINTEXT`, `*.tar.gpg`, `~/.gnupg/` — **commit 금지**
- Master Password / Recovery Code / ADMIN_TOKEN 평문 — **채팅 노출 금지**
- 외부 노출 — Tailscale Serve LAN tailnet 한정. Funnel·포트포워딩·Cloudflare Tunnel 금지
- 자동화·MCP가 vault 데이터 read/write — **영구 금지** (인간 클라이언트 only)

전체 정책은 부트스트랩 §5·§14.

---

## 인접 문서

- `~/realchoice-ssot/docs/vault-bootstrap-2026-05-11.md` — 본 vault 설계 문서
- `~/SHARED-CONTEXT/topology.md` — 전체 토폴로지 (Phase 0 완료 시 vault 추가)
- `~/SHARED-CONTEXT/secrets-policy.md` — secrets git 정책
- `~/SHARED-CONTEXT/daemons-registry.md` — LaunchAgent 등록부

---

## Security

이 repo는 secret leak을 차단하는 pre-commit 훅과 weekly CVE 체크를 포함한다.

```bash
# 1. clone 직후 한 번만 — pre-commit 훅 활성화
git config core.hooksPath .githooks

# 2. (선택) 전체 repo 스캔
./scripts/precommit-secret-scan.sh --all

# 3. Vaultwarden 신규 릴리스 / 권고 점검 (weekly LaunchAgent용)
./scripts/cve-check.sh
```

훅이 차단하는 패턴: Argon2id 해시, `master.*password=…`, B2 keyID (`K` + 20자리),
Slack webhook, PEM private key, AWS / GitHub 토큰, 고엔트로피 문자열. 검증된 라인은
`# pragma: allowlist secret` 주석으로 예외 가능. 규칙 정의는 `.gitleaks.toml`.
