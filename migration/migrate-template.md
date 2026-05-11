# 계정 마이그레이션 워크플로 템플릿

> 한 계정당 약 **10분** 소요 (사이트 로그인이 느리거나 2FA 절차가 복잡하면 +5분).
> 이 템플릿을 `migrate-<id>-<YYYYMMDD>.md`로 복사해 채워라.

---

## 메타

- **계정 ID**: `<id>` (예: `coupang-wing`)
- **표시명**: `<이름>` (예: 쿠팡 윙)
- **Tier**: `P0` / `P1` / `P1.5` / `P2`
- **카테고리**: marketplace / ads / banking / saas / social / government / payment
- **담당**: ops / mkt / admin
- **API 동반?**: yes / no — yes면 `ssot_secrets.<key>` 동기화 필수
- **회전 시각(예정)**: `YYYY-MM-DD HH:MM KST`
- **회전 시각(실제)**: `YYYY-MM-DD HH:MM KST`

---

## 0. 사전 준비

- [ ] **백업 시점 확인** — 직전 24h 내 Vaultwarden 자동 백업 성공 여부 (`~/vault/scripts/backup.sh` 로그)
- [ ] **자동화 다운타임 공지** — 해당 계정이 ssot 자동화에 묶여있다면 영향 윈도(예: 15분) 사전 stop:
  - 쿠팡/네이버 marketplace → `~/realchoice-ssot`에서 sync 잠시 정지
  - 메타 광고 → `~/magnet` MCP 서버 stop
- [ ] **도미노 회피 (§7.4)** — 오늘 같은 카테고리(marketplace/ads/social) 다른 계정 회전 없음 확인
- [ ] **백업 코드 사전 확보** — 2FA 사이트는 회전 전 백업 코드 발급/다운로드, vault 별도 항목으로 저장

---

## 1. 신규 패스워드 생성

- [ ] Vaultwarden CLI / 웹에서 **24자 이상 무작위 비번 생성** (특수문자 제외 옵션은 사이트가 거절할 때만)
- [ ] 클립보드에 임시 복사 (작업 끝나면 클립보드 클리어)

```bash
# 예시
bw generate -uln --length 24
```

---

## 2. 사이트 로그인

- [ ] 시트의 평문 비번으로 사이트 로그인
- [ ] 로그인 정상 (만약 비번 만료/이미 변경 → 별도 핸들링 후 시트 갱신)

---

## 3. 비번 변경

- [ ] 사이트 보안 설정에서 비번 변경
- [ ] 1단계에서 생성한 신규 비번 입력 → 저장
- [ ] **로그아웃 후 신규 비번으로 재로그인** (검증)

---

## 4. 2FA TOTP 활성화

- [ ] 보안 설정에서 2FA TOTP 활성화 (Authenticator app 옵션 선택)
- [ ] 사이트가 보여주는 **TOTP secret(또는 QR)** 캡처
- [ ] Vaultwarden 항목의 `authenticator key (TOTP)` 필드에 secret 저장 → 6자리 코드 자동 생성 확인
- [ ] 사이트에 6자리 코드 입력하여 등록 완료
- [ ] **백업 코드 발급** → Vault에 별도 보안 메모로 저장

> SMS 2FA만 지원하는 사이트는 TOTP 스킵하고 메모에 "SMS only" 기록.

---

## 5. Vault entry 저장

- [ ] Vaultwarden에 항목 저장:
  - name: `<표시명>`
  - URI: `<url>`
  - username / password / TOTP
  - folder: `migrated-<YYYY-MM>`
  - custom fields: `tier`, `owner`, `category`, `api_secret_location`(있을 때)
- [ ] 동기화 확인 (CLI: `bw sync`)

---

## 6. ssot_secrets 동기화 (API 계정만)

쿠팡·네이버·메타 등 `has_api: true` 계정만 해당.

- [ ] `~/realchoice-ssot/ssot_secrets/<key>` 신규 비번으로 갱신
- [ ] 자동화 sync 재시작 + sanity test (마지막 24h 주문/광고 데이터 1건 수집)
- [ ] 실패 시 즉시 롤백 + 시트의 직전 비번으로 사이트 재변경

---

## 7. Slack 알림 1줄

```
[vault-migration] <tier>/<id> 회전 완료 (<HH:MM>) — 2FA on, ssot sync ok
```

- [ ] `#ops` 또는 `#alerts` 채널에 게시

---

## 8. 시트 행 마스킹

- [ ] Google Sheet 원본 행에서:
  - 비번 셀 → `[MIGRATED <YYYY-MM-DD>]` 로 덮어쓰기
  - 메모 셀 → vault 항목 ID 기록
- [ ] 행 색상 회색 (완료 표시)

---

## 9. 마무리

- [ ] `~/vault/scripts/migrate-status.sh mark-done <id>` 실행
- [ ] 클립보드 클리어 (`pbcopy < /dev/null`)
- [ ] 다음 계정 확인: `~/vault/scripts/migrate-status.sh next`

---

## 도미노 회피 규칙 (부트스트랩 §7.4)

1. **같은 카테고리 동일 일자 회전 금지** — marketplace 2개, ads 2개를 같은 날 절대 같이 하지 않는다.
2. **API 계정 → 평일 오전** — 자동화 실패 시 당일 복구 가능하도록.
3. **SSO 종주 계정(구글/MS365)은 last** — 다른 계정이 SSO로 묶여있을 수 있다.
4. **정산일·캠페인 마감일 회피** — 쿠팡(화·금), 네이버(월), 광고 캠페인 종료일.
5. **연속 회전 간 최소 30분 cool-down** — 한 사람이 연속 처리 시 실수 risk.
6. **자정~06시 회전 금지** — 자동화 알림이 묻히고, 외부 지원 받기 어려움.
