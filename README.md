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
| Phase 0 인프라 가동 | 진행 중 | 본 부트스트랩 |
| Phase 1 본인 운영자 셋업 | 대기 | Master Password 사용자 결정 후 |
| Phase 2 P0 마이그레이션 | 미진입 | Week 1 (8개) |
| Phase 3 P1·P2·가족 | 미진입 | Week 2~4 |
| Phase 4 운영 정착 | 미진입 | 영구 |

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
