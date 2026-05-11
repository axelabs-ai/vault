#!/usr/bin/env bash
#
# emergency-lockdown.sh — Vault 비상 락다운 스크립트
#
# 절차:
#   1. 사용자 확인 (반드시 'LOCKDOWN' 타이핑)
#   2. docker stop vault-app vault-caddy
#   3. tailscale serve 외부 매핑 제거
#   4. .env 파일 rename → 자동 재시작 방지
#   5. LOCKDOWN 마커 파일 생성 (사유 포함)
#   6. db.sqlite3 스냅샷 → ~/incidents/<ts>/
#   7. 세션 무효화 로그
#   8. ~/realchoice-ssot/logs/vault-emergency.log 기록
#   9. 다음 단계 체크리스트 stdout 출력
#
# 사용:  bash ~/vault/scripts/emergency-lockdown.sh
# 복구:  bash ~/vault/scripts/emergency-restore.sh
#
set -euo pipefail

# -----------------------------------------------------------------------------
# 경로 상수
# -----------------------------------------------------------------------------
VAULT_DIR="${HOME}/vault"
ENV_FILE="${HOME}/.config/vault/.env"
LOCKDOWN_FILE="${VAULT_DIR}/LOCKDOWN"
LOG_DIR="${HOME}/realchoice-ssot/logs"
LOG_FILE="${LOG_DIR}/vault-emergency.log"
INCIDENTS_DIR="${HOME}/incidents"
DB_FILE="${VAULT_DIR}/data/db.sqlite3"

TS="$(date +%Y%m%d-%H%M%S)"
TS_HUMAN="$(date '+%Y-%m-%d %H:%M:%S %Z')"
INCIDENT_DIR="${INCIDENTS_DIR}/vault-lockdown-${TS}"
ENV_BACKUP="${ENV_FILE}.lockdown-${TS}"

mkdir -p "${LOG_DIR}" "${INCIDENTS_DIR}"

log() {
  local msg="$1"
  echo "[${TS_HUMAN}] [lockdown] ${msg}" | tee -a "${LOG_FILE}"
}

# -----------------------------------------------------------------------------
# Step 1. 사용자 확인 — 'LOCKDOWN' 정확히 입력해야 진행
# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "        VAULT EMERGENCY LOCKDOWN"
echo "============================================================"
echo ""
echo "이 스크립트는 다음을 수행합니다:"
echo "  - vault-app / vault-caddy 컨테이너 중지"
echo "  - Tailscale 외부 serve 매핑 제거"
echo "  - .env 파일을 .env.lockdown-${TS} 로 이동 (재시작 차단)"
echo "  - LOCKDOWN 마커 파일 생성"
echo "  - db.sqlite3 스냅샷을 ${INCIDENT_DIR} 에 보관"
echo ""
echo "되돌리려면: ~/vault/scripts/emergency-restore.sh"
echo ""
read -r -p "VAULT EMERGENCY LOCKDOWN — type 'LOCKDOWN' to proceed: " CONFIRM

if [[ "${CONFIRM}" != "LOCKDOWN" ]]; then
  echo "확인 문자열 불일치. 락다운 취소됨."
  log "ABORT — confirmation string mismatch (got: '${CONFIRM}')"
  exit 1
fi

# -----------------------------------------------------------------------------
# 사유 입력
# -----------------------------------------------------------------------------
echo ""
read -r -p "락다운 사유를 한 줄로 입력하세요 (예: 'macmini 도난 의심'): " REASON
if [[ -z "${REASON}" ]]; then
  REASON="(사유 미입력)"
fi

log "START — reason: ${REASON}"

# -----------------------------------------------------------------------------
# Step 2. docker stop
# -----------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  for c in vault-app vault-caddy; do
    if docker ps --format '{{.Names}}' | grep -qx "${c}"; then
      log "stopping container ${c}"
      docker stop "${c}" >/dev/null 2>&1 || log "WARN — failed to stop ${c}"
    else
      log "container ${c} already not running"
    fi
  done
else
  log "WARN — docker not found in PATH; skipping container stop"
fi

# -----------------------------------------------------------------------------
# Step 3. tailscale serve --remove
# -----------------------------------------------------------------------------
if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then
    log "removing tailscale serve mapping (--https=443 /)"
    tailscale serve --remove --https=443 / >/dev/null 2>&1 \
      || log "WARN — tailscale serve --remove failed or no mapping existed"
  else
    log "tailscale not logged in; skipping serve remove"
  fi
else
  log "WARN — tailscale not found in PATH; skipping serve remove"
fi

# -----------------------------------------------------------------------------
# Step 4. .env rename — backup.sh fails-fast + 재시작 차단
# -----------------------------------------------------------------------------
if [[ -f "${ENV_FILE}" ]]; then
  mv "${ENV_FILE}" "${ENV_BACKUP}"
  log ".env moved → ${ENV_BACKUP}"
else
  log "WARN — ${ENV_FILE} not found; nothing to rename"
fi

# -----------------------------------------------------------------------------
# Step 5. LOCKDOWN 마커 파일
# -----------------------------------------------------------------------------
cat > "${LOCKDOWN_FILE}" <<EOF
VAULT LOCKDOWN
==============
timestamp:    ${TS_HUMAN}
reason:       ${REASON}
env_backup:   ${ENV_BACKUP}
snapshot_dir: ${INCIDENT_DIR}
operator:     $(whoami)@$(hostname -s)

다음 단계:
  1. emergency-ko.md Phase 1 절차 따라 가족·관계자 통지
  2. P0 회전 시작 (bw list items --search "#tier:p0")
  3. 복구 준비되면: ~/vault/scripts/emergency-restore.sh
EOF
log "LOCKDOWN marker created at ${LOCKDOWN_FILE}"

# -----------------------------------------------------------------------------
# Step 6. db.sqlite3 스냅샷 (평문 — FileVault 의존, 로컬에만 보관)
# -----------------------------------------------------------------------------
mkdir -p "${INCIDENT_DIR}"
if [[ -f "${DB_FILE}" ]]; then
  cp "${DB_FILE}" "${INCIDENT_DIR}/db.sqlite3"
  chmod 600 "${INCIDENT_DIR}/db.sqlite3"
  log "snapshot saved → ${INCIDENT_DIR}/db.sqlite3 (plaintext, local FileVault only)"
else
  log "WARN — ${DB_FILE} not found; no snapshot taken"
fi

# 사유·메타 정보도 incident 디렉토리에 복사
cat > "${INCIDENT_DIR}/incident.md" <<EOF
# Incident — vault-lockdown-${TS}

- timestamp: ${TS_HUMAN}
- reason: ${REASON}
- operator: $(whoami)@$(hostname -s)
- env_backup: ${ENV_BACKUP}

다음 액션: emergency-ko.md Phase 1 ~ Phase 4 따라가기.
EOF

# -----------------------------------------------------------------------------
# Step 7. 세션 무효화 로그
# -----------------------------------------------------------------------------
log "all active sessions invalidated by container stop (vault-app down)"

# -----------------------------------------------------------------------------
# Step 9. 다음 단계 체크리스트
# -----------------------------------------------------------------------------
cat <<EOF

============================================================
        LOCKDOWN COMPLETE — ${TS_HUMAN}
============================================================

사유: ${REASON}
스냅샷: ${INCIDENT_DIR}/db.sqlite3
로그: ${LOG_FILE}

다음 단계 (즉시 시행):

  1. 가족 통지 — SMS/Kakao 템플릿:
     "[보안 알림] vault 사고 발생. Bitwarden 비번 즉시 변경.
      분실 디바이스 있으면 알려줘. 24h 동안 평소보다 자주 확인."

  2. Phase 1 진행 — emergency-ko.md §2 Phase 1 (0~1h)
     - 침입 경로 가설 ${INCIDENT_DIR}/hypothesis.md 작성
     - Tailscale Admin Console에서 macmini 노드 disable 확인
     - 가족 디바이스 분실 여부 재확인

  3. Slack #data-ops 채널 공지:
     "vault incident START — ${TS_HUMAN}
      스코프: <영향 범위>
      24h 회전 진행 중. 외부 공유 자제 요청"

  4. Phase 2 (1~4h) 진입 — P0 회전:
     bw list items --search "#tier:p0"

복구가 준비되면:
  bash ~/vault/scripts/emergency-restore.sh

============================================================
EOF

log "END — lockdown complete"
exit 0
