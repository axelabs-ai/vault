# vault ↔ stream 통합 설계

본 문서는 vault 프로젝트의 건강 신호(health signal)를 stream MCP로 전달하는
단방향 연동 계약을 정의한다. Bootstrap §3 / §8.2의 "vault → stream signal only"
원칙을 그대로 따른다.

---

## 1. 원칙 — 단방향, 단일 신호

- vault는 stream에게 **오직 하나의 신호**만 보낸다: `vault_health`.
- 방향은 **vault → stream 단방향**. stream이 vault의 데이터·API·secrets를
  역방향으로 조회하는 것은 금지된다.
- 채널 매핑: `vault_health` → stream MCP `magnet_alerts.vault_health` 토픽
  → Slack `#data-ops`.
- KISS: 백업 완료 알림(`vault_backup_done`) 같은 별도 이벤트는 **현 단계에서
  도입하지 않는다**. 향후 필요해지면 별도 이벤트 타입으로 분리하되, 본 문서를
  먼저 갱신한다.

### 절대 금지

- stream(또는 다른 MCP)이 vault 내부 DB/볼륨/`~/.config/vault/.env`를
  cross-read 하는 것.
- vault 측 admin token, secrets API를 통한 직접 호출.
- `magnet_alerts` 페이로드에 평문 PII(사용자 이메일·계정명·도메인 등) 노출.
  체크 결과는 라벨/상태 코드만 담는다.

---

## 2. JSON 스키마

`scripts/vault-health.sh`가 1줄 JSON으로 출력하는 형식.
`scripts/vault-health-emit.sh`가 동일 JSON을 stdin으로 다음 단계에 전달한다.

```json
{
  "ts": "2026-05-12T03:20:00Z",
  "status": "ok",
  "summary": "all checks passing",
  "checks": {
    "vault_app":    "ok:Up 12 hours (healthy)",
    "vault_caddy":  "ok:Up 12 hours (healthy)",
    "alive":        "ok:alive",
    "backup_fresh": "ok:age_42000s",
    "disk_free":    "ok:free_85899345920b",
    "admin_token":  "ok:present"
  }
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `ts` | string (RFC3339, UTC) | 측정 시각 |
| `status` | enum: `ok` / `degraded` / `down` | 집계 상태. 어떤 체크라도 `fail:`이면 `down`, `degraded:`만 있으면 `degraded` |
| `summary` | string | 사람이 읽는 한 줄 요약 (실패/디그레이드 체크 이름 나열) |
| `checks.*` | string `"<level>:<detail>"` | 각 프로브 결과. level은 `ok` / `degraded` / `fail` |

### 체크 6종

1. `vault_app` — `docker ps` 기준 `vault-app` 컨테이너의 `(healthy)` 여부.
2. `vault_caddy` — 동일 방식으로 `vault-caddy`.
3. `alive` — `curl http://127.0.0.1:8222/alive` 응답에 `Vaultwarden is running!` 포함.
4. `backup_fresh` — `~/backups/vault/*.tar.gpg` 최신 파일이 26시간 이내.
5. `disk_free` — `~/backups/vault`의 free space > 1 GiB.
6. `admin_token` — `~/.config/vault/.env`에 `ADMIN_TOKEN=` 라인 존재.

스크립트의 종료 코드: `0=ok / 1=degraded / 2=down` — LaunchAgent 로그와
다운스트림 알림 파이프라인에서 그대로 활용 가능.

---

## 3. stream 측 통합 시나리오

vault는 stream의 내부 구조를 모른 채 **shippable artifact**(1줄 JSON)을
stdout/stdin으로만 제공한다. 실제 적재 명령은 환경변수
`VAULT_STREAM_INSERT_CMD`로 주입한다.

### 시나리오 A — psql 직접 INSERT (단순)

```bash
export VAULT_STREAM_INSERT_CMD='psql "$STREAM_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -c "INSERT INTO magnet_alerts(topic, payload, created_at)
      VALUES (''vault_health'', \$(cat)::jsonb, now())"'
```

> 위 한 줄은 `bash -c` 안에서 실행되므로, vault-health-emit.sh가 JSON을
> stdin으로 흘려보내면 `$(cat)`이 받아 jsonb 캐스팅한다.
> `STREAM_DATABASE_URL`은 `~/stream/.env`에서 export 받는다.

### 시나리오 B — stream HTTP/MCP 엔드포인트 경유 (권장 진화 경로)

stream MCP가 `POST /alerts/vault_health` 같은 단순 수신 엔드포인트를 노출하면:

```bash
export VAULT_STREAM_INSERT_CMD='curl -fsS -m 5 \
  -H "Content-Type: application/json" \
  -H "X-Source: vault" \
  --data-binary @- \
  http://127.0.0.1:7311/alerts/vault_health'
```

이 경로는 인증/재시도/스키마 검증을 stream 쪽에서 일괄 관리할 수 있어 장기적으로
선호된다. 단, 현재는 endpoint가 없으므로 시나리오 A로 시작한다.

### 적재 실패 시

`vault-health-emit.sh`는 INSERT 명령 실패를 stderr로 한 줄 로그만 남기고 진행한다.
JSONL 로컬 로그(`~/realchoice-ssot/logs/vault-health.jsonl`)는 항상 append-only로
남으므로, stream 측 백필이 필요하면 그 파일을 다시 재생(replay)하면 된다.

---

## 4. Slack 메시지 포맷 제안 (`#data-ops`)

stream → Slack 릴레이가 토픽 `vault_health`를 받았을 때의 권장 포맷.

### status = ok
- 조용한 상태 — Slack에는 송신하지 않는다(noise 방지).
  필요 시 일 1회 요약 리포트만 별도 채널에 게시.

### status = degraded
```
[vault] ⚠ degraded — failing checks: backup_stale,disk_low
ts=2026-05-12T03:20:00Z
```

### status = down
```
[vault] 🔴 down — failing checks: vault_app,alive
ts=2026-05-12T03:20:00Z
summary: failing checks: vault_app,alive
```

규칙:
- 첫 줄은 `[vault] <아이콘> <status> — failing checks: <comma list>` 1줄.
- 2~3째 줄에 `ts`, `summary`만 노출. 체크별 detail 문자열은 비공개(내부 로그에만).
- 평문 사용자 데이터 / IP / 토큰은 절대 본문에 포함하지 않는다.
- 동일 상태가 연속 30분 이상 지속되면 stream 쪽에서 디바운스(예: 30분 1회)로
  반복 알림을 억제 — vault 스크립트는 매 10분 보내고, 억제는 stream 책임.

---

## 5. 운영 메모

- 실행 주기: `com.realchoice.vault-health.plist`의 `StartInterval=600`s (10분).
  StartCalendarInterval은 쓰지 않는다 — 균등 샘플링이 목적.
- 로그:
  - 구조화 로그: `~/realchoice-ssot/logs/vault-health.jsonl`
  - LaunchAgent stdout: `~/realchoice-ssot/logs/vault-health.out.log`
  - LaunchAgent stderr: `~/realchoice-ssot/logs/vault-health.err.log`
- 백필: 위 JSONL을 `jq -c` + `VAULT_STREAM_INSERT_CMD`로 재생 가능.
- 향후 확장 후보(현재 NO):
  - `vault_backup_done` — backup.sh 종료 시 별도 이벤트.
  - `vault_restore_verify` — 주 1회 restore-test 결과.
