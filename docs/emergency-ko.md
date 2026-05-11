# Vault 비상 대응 매뉴얼 (한국어)

본 문서는 vault(Vaultwarden self-host) 운영 중 발생할 수 있는 8가지 사고 시나리오와 24시간 SLA 분 단위 대응 플레이북을 정의한다. 비전문가도 단계별로 따라 실행할 수 있도록 작성됨.

**즉시 사용 가능한 명령:**
- 락다운: `~/vault/scripts/emergency-lockdown.sh`
- 복구: `~/vault/scripts/emergency-restore.sh`
- 로그: `~/realchoice-ssot/logs/vault-emergency.log`

---

## 1. 시나리오 매트릭스 (8가지)

각 시나리오는 3단계로 대응: **0~1h (즉시)**, **1~4h (단기)**, **4~24h (중기)**.

### 시나리오 A. macmini 도난·분실

- **위협 등급:** CRITICAL
- **0~1h (즉시):**
  1. 다른 디바이스(가족 폰, 노트북)에서 Tailscale Admin → macmini 노드 **Disable**.
  2. iCloud `나의 찾기` → macmini **분실 모드 + 원격 잠금** + 활성화 잠금 활성화.
  3. 가능하면 **원격 지우기** 트리거 (FileVault 켜져 있어 즉시 데이터는 보호되지만 secure erase).
  4. 네이버/구글/은행 등 P0 계정의 활성 세션 강제 로그아웃.
- **1~4h (단기):**
  1. B2 백업이 살아있는지 확인 — `b2 ls realchoice-vault-backup`.
  2. 임시 머신(가족 노트북)에서 신규 Vaultwarden 인스턴스 부팅 또는 모바일 Bitwarden 앱만으로 임시 운영.
  3. ADMIN_TOKEN, master password 즉시 회전 (§5.6 phase 4 참조).
- **4~24h (중기):**
  1. 경찰 분실 신고(분실 사실 입증용).
  2. 신규 macmini 수령 후 B2에서 복원 (`restore-test.sh` 절차 따라).
  3. 사고 보고서 작성.

### 시나리오 B. vault 데이터 유출 의심 (`.tar.gpg` + GPG 키 동시 유출)

- **위협 등급:** CRITICAL — 암호화가 무력화됨.
- **0~1h (즉시):**
  1. `emergency-lockdown.sh` 실행.
  2. B2 버킷 **객체 잠금** + 새 토큰 발급(기존 application key 폐기).
  3. GPG 키쌍 즉시 폐기: `gpg --gen-revoke <KEYID>` + 키서버에 revoke 업로드.
- **1~4h (단기):**
  1. P0 8개 사이트 비밀번호 전수 회전 (§5.6 phase 2).
  2. 2FA seed 전면 재발급 (Authy/TOTP).
- **4~24h (중기):**
  1. 신규 GPG 키쌍 생성 → B2 새 버킷 → 백업 재구성.
  2. master password 회전.

### 시나리오 C. 가족 디바이스 분실 (배우자/자녀 폰·노트북)

- **위협 등급:** HIGH
- **0~1h (즉시):**
  1. 해당 가족원에게 즉시 전화. 사실 확인.
  2. Vaultwarden Admin → 해당 user의 active sessions **invalidate** + 비번 초기화 요구.
  3. 그 사람의 디바이스 `나의 찾기` 분실모드.
- **1~4h (단기):**
  1. 해당 가족원이 master password 변경 (반드시 본인이 직접).
  2. 자주 쓰는 사이트(인스타, 카톡 등)에서 해당 디바이스 로그아웃.
- **4~24h (중기):**
  1. 신규 디바이스 등록 + 다시 vault 동기화 (`vault-onboard-family.sh`).
  2. 2FA 백업 코드 점검.

### 시나리오 D. Vaultwarden CVE 공시 (high/critical)

- **위협 등급:** HIGH (조건부)
- **0~1h (즉시):**
  1. CVE 내용 확인 — `cve-check.sh` 또는 https://github.com/dani-garcia/vaultwarden/security/advisories.
  2. 영향 받는 버전이면 **`docker compose stop vault-app`** 우선.
  3. 외부 접근(Tailscale serve) 즉시 해제.
- **1~4h (단기):**
  1. 패치 버전 release note 확인 → `compose.yaml` image tag 갱신.
  2. `docker compose pull && docker compose up -d` 후 health check.
- **4~24h (중기):**
  1. CVE 사후 분석: 우리 인스턴스가 실제 노출됐는지 로그 점검.
  2. 노출 흔적 발견 시 시나리오 B로 격상.

### 시나리오 E. ADMIN_TOKEN 유출

- **위협 등급:** HIGH — Admin Panel을 통해 모든 user 조작 가능.
- **0~1h (즉시):**
  1. `~/.config/vault/.env` 열어 `ADMIN_TOKEN=` 신규 값 생성 (`openssl rand -base64 48`).
  2. `docker compose restart vault-app`.
  3. Vaultwarden Admin 로그 열람 — 침입자 활동 흔적 확인.
- **1~4h (단기):**
  1. user 목록 / org 설정에 비정상 변경 있는지 점검.
  2. 비정상 user 발견 시 시나리오 B로 격상.
- **4~24h (중기):**
  1. ADMIN_TOKEN 어떤 경로로 유출됐는지 RCA(`git log`, shell history 등).
  2. 향후 ADMIN_TOKEN 비활성화 검토 (`/admin` route 차단).

### 시나리오 F. Master Password 유출 의심

- **위협 등급:** CRITICAL
- **0~1h (즉시):**
  1. 본인 vault Web Vault 로그인 → **즉시 master password 변경**.
  2. `Account Settings` → **Deauthorize Sessions** 모든 디바이스 강제 로그아웃.
  3. 2FA가 켜져 있는지 재확인 (없으면 즉시 활성화).
- **1~4h (단기):**
  1. P0 8개 사이트 비번 전수 회전 (§5.6 phase 2). master password와 동일하거나 유사한 비번이 다른 사이트에서 쓰였을 위험.
  2. recovery code 재발급.
- **4~24h (중기):**
  1. 어떻게 노출됐는지 추적 (입력 화면 어깨너머, 키로거 의심 디바이스 등).
  2. 의심 디바이스 OS 재설치.

### 시나리오 G. Recovery Code 종이 분실

- **위협 등급:** MEDIUM — 즉시 위협은 낮으나 master pw 분실 시 vault 복구 불가.
- **0~1h (즉시):**
  1. 분실 위치 추적 (집·차·사무실 등).
  2. 분실 확정 시 Web Vault 로그인 → `Account Settings` → **View Recovery Code** → 신규 발급.
- **1~4h (단기):**
  1. 신규 recovery code 출력 → 인쇄 → 봉투 봉인 → 새 보관 위치 결정.
  2. 이전 보관 위치 폐기.
- **4~24h (중기):**
  1. 백업 위치 2nd copy 검토 (가정 + 사무실 분산 권장).
  2. 폐기한 종이 출처 추적 가능 여부 점검 (분리수거함 등).

### 시나리오 H. Tailscale 어카운트 침해

- **위협 등급:** HIGH — vault 인스턴스 외부 노출 위험.
- **0~1h (즉시):**
  1. Tailscale Admin Console → 모든 디바이스 **revoke**.
  2. Tailscale 어카운트 비번 변경 + 2FA 강제.
  3. macmini에서 `tailscale logout` + 신규 재인증.
- **1~4h (단기):**
  1. ACL 재점검 — vault 노드 외부 접근 차단 규칙 재확인.
  2. `tailscale serve` 매핑 일시 해제 → 필요 시만 재설정.
- **4~24h (중기):**
  1. Tailscale audit log 검토 (의심 디바이스 등록 흔적).
  2. SSO 연결 계정(Google/GitHub) 역시 침해 의심 → 시나리오 F로 격상 검토.

---

## 2. 24h SLA 분 단위 플레이북 (§5.6 4 phase)

### Phase 1 — **0~1h**: 차단 + 진단

| 시각 (분) | 작업 | 명령/위치 |
|---|---|---|
| T+0 | 사고 인지·기록 | 시계 메모 + 사진 |
| T+5 | `emergency-lockdown.sh` 실행 | `~/vault/scripts/emergency-lockdown.sh` |
| T+10 | 락다운 사유 입력 + LOCKDOWN 파일 생성 확인 | `~/vault/LOCKDOWN` |
| T+15 | Tailscale serve 매핑 해제 확인 | `tailscale serve status` |
| T+20 | 모든 active session invalidate (container stop으로 자동) | docker ps 확인 |
| T+25 | 침입 경로 가설 1차 작성 | `~/incidents/<ts>/hypothesis.md` |
| T+45 | 가족 통지 (SMS/Kakao 템플릿 §3) | 폰 |
| T+60 | Phase 1 종료 보고 (간단 메모) | log |

### Phase 2 — **1~4h**: P0 회전 (8개)

P0 = 손실 시 즉시 사업 마비. bw CLI에서 `bw list items --search "#tier:p0"`로 enumerate.

| 시각 | 작업 |
|---|---|
| T+1h | bw CLI 로그인 (별도 임시 디바이스에서) `bw login --apikey` |
| T+1h10 | `bw list items --search "#tier:p0"` 출력 → 8개 목록 확보 |
| T+1h15~3h | 각 사이트 비번 재설정. 우선순위: ① 메인뱅크 ② 네이버 ③ 구글 ④ 쿠팡 셀러 ⑤ Meta Business ⑥ 카카오 ⑦ AWS/GCP ⑧ GitHub org |
| T+3h | 각 사이트 active session 강제 로그아웃 |
| T+3h30 | 2FA seed 재발급 (TOTP 앱 새 디바이스) |
| T+4h | Phase 2 종료. 회전 완료 8개 체크리스트 로그 기록 |

### Phase 3 — **4~12h**: P1 회전 (6개) + Slack + GitHub 개인

P1 = `#tier:p1` 태그. Slack workspace, GitHub 개인 어카운트, 부 은행, 부 SNS 등.

| 시각 | 작업 |
|---|---|
| T+4h | `bw list items --search "#tier:p1"` 6개 목록 |
| T+5~8h | 각 사이트 비번 재설정 + 세션 invalidate |
| T+8h | Slack workspace owner 비번 회전 + 모든 디바이스 sign-out |
| T+9h | GitHub: SSH key revoke + PAT 전수 회전 + OAuth apps 점검 |
| T+10h | 가족 공유 vault(가족 폴더) 항목 점검 — 가족원이 P0/P1에 접근 가능했는지 |
| T+12h | Phase 3 종료 |

### Phase 4 — **12~24h**: P2 + SNS + 가족 공유 정리

| 시각 | 작업 |
|---|---|
| T+12h | `bw list items --search "#tier:p2"` (또는 untagged 전체) |
| T+14~20h | 자주 안 쓰는 SNS, 쇼핑몰, 구독 서비스 비번 회전 (우선순위 낮음) |
| T+20h | 가족 공유 항목 별도 검토 — 가족원 본인이 직접 변경하도록 안내 |
| T+22h | 누락 점검 — bw list 전체 갯수 vs 회전 완료 갯수 비교 |
| T+24h | **24h SLA 종료**. Phase 4 완료 보고 |

### Phase 5 — **24~48h**: 전면 재구축

| 시각 | 작업 |
|---|---|
| T+24~30h | master password 회전 (Web Vault에서 직접) |
| T+30~36h | 2FA seed 전면 교체 (Authy 백업 → 새 디바이스로 이동) |
| T+36~42h | 신규 Vaultwarden 인스턴스 마이그레이션 (다른 호스트 또는 재설치) — `migration/` 디렉토리 절차 참조 |
| T+42~48h | 사고 보고서 작성·공유 (§4 템플릿) |

---

## 3. 연락처 트리거 템플릿

### 운영자 → 가족 (SMS/Kakao)

```
[보안 알림]
vault에 사고가 발생했어. 지금부터 다음 절차를 따라줘:
1. Bitwarden 앱에서 비밀번호 즉시 변경
2. 분실한 디바이스가 있으면 알려줘
3. 이상한 로그인 알림 받으면 즉시 나에게 알려줘
24시간 동안 평소보다 더 자주 확인해줘.
```

### 운영자 → 은행 보안센터

```
유선 전화: 메인뱅크 보안센터 (각 은행 공식 콜센터)
요청 사항:
1. 최근 24h 내 비정상 로그인·이체 차단
2. OTP/공인인증서 일시 정지
3. 신규 거래 한도 임시 하향
```

### 운영자 → 사내 협업툴 (Slack)

```
#data-ops 채널:
"vault incident START — <시각>
스코프: <영향 범위>
임시 차단: vault external 접근 차단됨
24h 회전 진행 중. 외부 공유 자제 요청"
```

---

## 4. 사고 후 보고서 템플릿

```markdown
# Incident Report — <YYYY-MM-DD>

## 1. Metadata
- 사고 인지 시각: <YYYY-MM-DD HH:MM KST>
- 락다운 시각: <YYYY-MM-DD HH:MM KST>
- 복구 완료 시각: <YYYY-MM-DD HH:MM KST>
- 시나리오 (A~H): <시나리오 식별자>
- Severity: CRITICAL / HIGH / MEDIUM / LOW

## 2. Scope
- 영향 받은 시스템: <vault / B2 / Tailscale / 사이트들>
- 영향 받은 사용자: <본인 / 가족원 N명>
- 노출 가능성 있는 데이터: <메일·비번·2FA seed·금융 등>

## 3. Timeline
| 시각 (KST) | 이벤트 |
|---|---|
| HH:MM | (인지) ... |
| HH:MM | (락다운) ... |
| HH:MM | (P0 회전 시작) ... |
| HH:MM | (24h SLA 종료) ... |

## 4. Root Cause
<무엇이 사고를 일으켰는지 가설 + 증거>

## 5. Mitigation
<어떻게 차단했고, 회전·재발급한 자산 목록>

## 6. Lessons Learned
<재발 방지 액션 아이템 3~5개>

## 7. Follow-up Tasks
- [ ] action 1
- [ ] action 2
- [ ] action 3
```

---

## 5. 부록 — 자주 쓰는 명령

```bash
# 즉시 차단
~/vault/scripts/emergency-lockdown.sh

# P0 항목 enumerate
bw list items --search "#tier:p0"

# Tailscale serve 매핑 해제
tailscale serve --remove --https=443 /

# 모든 컨테이너 정지
docker stop vault-app vault-caddy

# 복구
~/vault/scripts/emergency-restore.sh

# 로그 확인
tail -f ~/realchoice-ssot/logs/vault-emergency.log
```
