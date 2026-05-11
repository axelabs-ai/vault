# Vault 운영 런북 (Operations Runbook)

> Vaultwarden self-host (macmini · Docker) 운영자용 정기 점검·사고 대응 가이드.
> Bootstrap §13 (체크리스트) + §5.6 (24h SLA) 의 실행 매뉴얼.
> 모든 시각은 KST (Asia/Seoul).

---

## 1. 일별 (자동, 사람 개입 0)

| 시각 | 작업 | 실행 주체 | 검증 방법 |
|---|---|---|---|
| 03:10 | 백업 (db.sqlite3 + attachments → GPG → B2) | LaunchAgent `com.realchoice.vault-backup` | `~/realchoice-ssot/logs/vault-backup.log` 마지막 줄 `done … OK` |
| 매 10분 | 헬스체크 (alive, 컨테이너, 디스크, 백업 신선도) | LaunchAgent `com.realchoice.vault-health` | `~/realchoice-ssot/logs/vault-health.jsonl` 마지막 라인 `"status":"ok"` |
| 매 10분 | 헬스 알람 emit — degraded/down 시 Slack #data-ops 전송 | `vault-health-emit.sh` (magnet relay 경유) | Slack 채널 확인 |

**개입 트리거**: `status:"down"` 이 2회 연속이면 Slack 알람 → 즉시 §6 사고 대응 진입.

---

## 2. 주별 (5분, 매주 월요일 아침)

수동 체크리스트:

```bash
# 1) 헬스 jsonl 최근 1주 요약 — fail / degraded 줄 카운트
grep -c '"status":"down"'     ~/realchoice-ssot/logs/vault-health.jsonl
grep -c '"status":"degraded"' ~/realchoice-ssot/logs/vault-health.jsonl

# 2) 백업 로그 FAIL 스캔
grep -i "FAIL" ~/realchoice-ssot/logs/vault-backup.log | tail -20

# 3) 백업 디스크 사용량
du -sh ~/backups/vault
df -h  ~/backups/vault | tail -1

# 4) 라이브 컨테이너 상태
docker ps --filter "name=vault-" --format 'table {{.Names}}\t{{.Status}}'
```

**판정 기준**:
- down 1회 이상 → 헬스 jsonl 해당 줄 분석, 원인 기록.
- backup FAIL 1줄이라도 → 그날의 백업 재실행 (`bash ~/vault/scripts/backup.sh`).
- 디스크 free < 5 GiB → 백업 보존일 조정 (`VAULT_BACKUP_RETAIN_DAYS`) 검토.

---

## 3. 월별 (10분, 매월 첫 영업일)

```bash
bash ~/vault/scripts/monthly-check.sh
```

위 한 줄이 다음을 자동 점검·표 출력:

- [x] `scripts/cve-check.sh` 호출 — Vaultwarden 신규 릴리스 / CVE 확인
- [x] `~/backups/vault/*.tar.gpg` 파일 카운트 (기대 7 ± 1)
- [x] 평균 백업 크기 / 가장 오래된·새로운 백업 나이
- [x] `~/vault/data/vaultwarden.log` 에서 `admin` 접근 검색 (지난 30일) — 의도된 관리 작업 외 0건 기대
- [x] `~/backups/vault` 디스크 free 용량

추가로 사람이 직접:
- [ ] Vaultwarden admin 패널 (`https://vault.<tailnet>/admin`) 열어 가족 활성 세션 검토 → 6개월+ 미접속 세션 삭제 권유 안내
- [ ] CVE 점검 결과 *"UPDATE AVAILABLE"* 면 §7 롤백 준비 후 업그레이드 일정 잡기

JSON 요약: `~/realchoice-ssot/logs/vault-monthly-check-YYYY-MM.json` (감사 추적용).

---

## 4. 분기별 (1시간, 매 분기 첫째 주)

### 4.1 백업 복구 드릴 (자동)

```bash
bash ~/vault/scripts/quarterly-drill.sh
```

- 가장 최근 `*.tar.gpg` 자동 선택
- `restore-test.sh` 로 db.sqlite3 무결성 검증
- **임시** 컨테이너를 포트 `8223` / 데이터 `/tmp/vault-drill-XXXX` 로 기동 (라이브 8222 는 절대 건드리지 않음)
- 5분 안에 브라우저로 `http://127.0.0.1:8223` 열어 1개 항목 로그인 확인
- Enter 입력 또는 5분 타임아웃 시 자동 폐기 (`docker stop` + `rm -rf` tmp dir)
- 결과 1줄을 `~/realchoice-ssot/logs/vault-drills.log` 에 append

### 4.2 수동 작업

- [ ] Vaultwarden **JSON export** → USB 외장 → 금고 보관 (분기당 1개, 4세대 순환)
- [ ] 종이 백업 (master password recovery 카드) 금고 위치·습기·온도 점검
- [ ] CVE 점검 결과 누적 리뷰 (`cve-check.sh` 출력 캡처)

### 4.3 보고

드릴 완료 후 Slack `#data-ops` 에 1줄:
```
[drill Q?-2026] PASS · users=N ciphers=M · archive=YYYY-MM-DD.tar.gpg
```

---

## 5. 연 1회 (반나절, 매년 1월 셋째 주)

전체 재해복구 드릴 + 자격 회전:

- [ ] Master Password 회전 검토 (강제 X, 유출 의심·키 노출 시만)
- [ ] YubiKey 백업 키 (Yubico Authenticator) 실 동작 확인 — 운영자 + 가족 단위
- [ ] Emergency Access 연락처 갱신 (배우자·부모 등 — 기간·grant level 검토)
- [ ] 전체 재해복구 드릴: §8 시나리오 그대로 신규 macmini / Cloud VM 에서 0 → live 복원, 가족 1명 합류까지 (반나절 예상)
- [ ] B2 보존 정책 검토 — lifecycle rule (30일+ 버전 cold tier) 확인
- [ ] GPG 백업 키 fingerprint / passphrase 종이 위치 재점검

---

## 6. 사고 대응 — 24h SLA (Bootstrap §5.6)

vault 유출 의심 (master password 노출, B2 키 leak, Tailscale auth-key 유출 등) 시 4단계:

### Phase 0 — 발견 ~ 1h: 차단 + 진단

| 분 | 액션 |
|---|---|
| 0–10 | Slack #data-ops 사고 선언, 시각·정황 기록 시작 |
| 10–20 | Tailscale Serve down: `tailscale serve --https=443 off` (외부 도달 차단) |
| 20–40 | 모든 세션 invalidate: admin panel → Users → 각 사용자 *"Logout all sessions"* (or `vault-app` 재시작) |
| 40–60 | 침입 경로 진단: vaultwarden.log + Caddy access log + macOS audit trail 동시 grep |

### Phase 1 — 1~4h: P0 자격 회전

은행·금융, Google/Apple ID (이메일 회복용), 도메인 등록, GCP/AWS root.
사전 태그 `#tier:p0` 가 부여된 항목만 `bw list --search "#tier:p0"` 로 즉시 추출.

### Phase 2 — 4~12h: P1 자격 회전

광고 플랫폼 (Meta/Google Ads), Slack workspace owner, GitHub PAT/SSH, 정부 인증서.

### Phase 3 — 12~24h: P2 + 마무리

SNS, 기타 SaaS, 가족 공유 계정. 가족 전원에 master password 재설정 안내.

### Phase 4 — 24~48h: 신규 인프라

- master password + 2FA seed 전면 교체
- 신규 Vaultwarden 인스턴스 마이그레이션 (§8 절차)
- 사고 보고서 작성 (`~/realchoice-ssot/docs/incidents/YYYY-MM-DD-vault.md`)

---

## 7. 롤백 절차 (Vaultwarden 업그레이드 실패 시)

업그레이드 후 `/alive` 응답 없음 · 로그인 실패 · DB 마이그레이션 오류 시:

```bash
# 1) 현재 컨테이너 다운
~/vault/scripts/down.sh

# 2) 이전 image 태그로 compose.yaml 복귀 (예: 1.35.8-alpine 로 복귀)
#    git 으로 관리 중이므로 단순 reset
cd ~/vault && git diff compose.yaml | head      # 변경 확인
git checkout HEAD~1 -- compose.yaml             # 직전 커밋 복귀

# 3) 데이터 디렉토리는 새 버전이 마이그레이션했을 수 있음 → 백업에서 복원
LATEST=$(/bin/ls -1t ~/backups/vault/*.tar.gpg | head -1)
mv ~/vault/data ~/vault/data.broken-$(date +%s)
mkdir -p ~/vault/data
gpg --decrypt "$LATEST" | tar -xf - -C ~/vault/data

# 4) 재기동
~/vault/scripts/up.sh

# 5) 검증
curl -fsS http://127.0.0.1:8222/alive
```

핵심: **데이터 디렉토리는 항상 백업에서 복원** (in-place rollback 은 schema 불일치로 실패할 수 있음).

---

## 8. 재해복구 — macmini 사망 시 신규 호스트 복원 7단계

새 Mac (또는 Linux + Docker) 에서:

1. **사전 자료 확보**: GPG 개인키 (오프라인 보관), B2 application key, Tailscale auth-key — 모두 비-vault 저장소에서.
2. **OS 기본 셋업**: Docker Desktop / Docker Engine, `gpg`, `rclone`, `tailscale` 설치.
3. **소스 가져오기**: `git clone <vault repo> ~/vault` (compose.yaml / scripts / Caddyfile 일체).
4. **백업 받아오기**: `rclone copy b2:realchoice-vault-backups/ ~/backups/vault/` → 가장 최신 `.tar.gpg` 1개면 충분.
5. **복원**:
   ```bash
   LATEST=$(/bin/ls -1t ~/backups/vault/*.tar.gpg | head -1)
   mkdir -p ~/vault/data
   gpg --decrypt "$LATEST" | tar -xf - -C ~/vault/data
   ```
6. **secrets 재주입**: `~/.config/vault/.env` (ADMIN_TOKEN argon2, DOMAIN, SIGNUPS_ALLOWED=false) 종이/금고에서 복원.
7. **기동 + 검증**: `~/vault/scripts/up.sh` → `curl /alive` → admin 패널 로그인 → 가족 1명 로그인 테스트 → Tailscale Serve 재바인딩.

목표 RTO: **4시간**. RPO: 24시간 (마지막 03:10 백업).

---

## 9. 운영 연락처

| 채널 | 용도 |
|---|---|
| Slack `#data-ops` | 헬스 알람, 사고 선언, 드릴 결과 보고 |
| Tailscale admin console | tailnet 토폴로지, ACL, auth-key 발급 |
| 가족 비상 연락 | (별도 종이 — 금고 안 봉투 "Vault Emergency"); Emergency Access grantee 명단 동봉 |
| GPG 개인키 보관처 | 운영자 YubiKey (primary) + 오프라인 금고 (secondary) |
| B2 콘솔 | `realchoice-vault-backups` 버킷 — application key 는 종이 봉투 |

운영자 부재 시 Emergency Access (Vaultwarden 내장) 가 자동 트리거 → grant level *"View"* 로 비상 자격 노출.
