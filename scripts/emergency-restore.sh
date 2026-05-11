#!/usr/bin/env bash
#
# emergency-restore.sh — emergency-lockdown.sh로부터 복구
#
# 절차:
#   1. 사용자 확인 ('RESTORE' 타이핑)
#   2. 최신 .env.lockdown-* 파일 자동 탐지
#   3. 사용자에게 어떤 백업을 복원할지 확인
#   4. .env 복원
#   5. docker compose up -d
#   6. tailscale serve 재설정 (사용자 확인 후)
#   7. LOCKDOWN 마커 제거 (아카이브)
#   8. 로그 기록
#
set -euo pipefail

VAULT_DIR="${HOME}/vault"
ENV_FILE="${HOME}/.config/vault/.env"
ENV_DIR="${HOME}/.config/vault"
LOCKDOWN_FILE="${VAULT_DIR}/LOCKDOWN"
LOG_DIR="${HOME}/realchoice-ssot/logs"
LOG_FILE="${LOG_DIR}/vault-emergency.log"
COMPOSE_FILE="${VAULT_DIR}/compose.yaml"

TS_HUMAN="$(date '+%Y-%m-%d %H:%M:%S %Z')"

mkdir -p "${LOG_DIR}"

log() {
  echo "[${TS_HUMAN}] [restore] $1" | tee -a "${LOG_FILE}"
}

echo ""
echo "============================================================"
echo "        VAULT EMERGENCY RESTORE"
echo "============================================================"
echo ""
echo "이 스크립트는 락다운 상태에서 vault를 복원합니다:"
echo "  - .env.lockdown-* → .env 되돌리기"
echo "  - docker compose up -d"
echo "  - tailscale serve 재설정 (확인 후)"
echo "  - LOCKDOWN 마커 아카이브"
echo ""
echo "복원 전 다음을 확인하세요:"
echo "  - 사고 원인 파악·차단 완료"
echo "  - P0 회전 완료 (emergency-ko.md Phase 2)"
echo "  - ADMIN_TOKEN 등 secrets 회전 완료"
echo ""
read -r -p "복원하려면 'RESTORE' 를 입력하세요: " CONFIRM
if [[ "${CONFIRM}" != "RESTORE" ]]; then
  echo "확인 문자열 불일치. 복원 취소됨."
  log "ABORT — confirmation string mismatch (got: '${CONFIRM}')"
  exit 1
fi

log "START"

# -----------------------------------------------------------------------------
# Step 2. .env 백업 자동 탐지
# -----------------------------------------------------------------------------
if [[ ! -d "${ENV_DIR}" ]]; then
  log "ERROR — ${ENV_DIR} 없음"
  echo "복원할 환경설정 디렉토리가 없습니다."
  exit 1
fi

# 최신 .env.lockdown-* 찾기
LATEST_BACKUP="$(find "${ENV_DIR}" -maxdepth 1 -type f -name '.env.lockdown-*' 2>/dev/null \
                 | sort -r | head -n 1 || true)"

if [[ -z "${LATEST_BACKUP}" ]]; then
  log "ERROR — .env.lockdown-* 파일을 찾을 수 없음"
  echo "복원할 백업이 없습니다. ${ENV_DIR} 디렉토리를 확인하세요."
  exit 1
fi

echo ""
echo "가장 최신 락다운 백업: ${LATEST_BACKUP}"
read -r -p "이 백업을 복원할까요? [y/N]: " CONFIRM_FILE
if [[ "${CONFIRM_FILE}" != "y" && "${CONFIRM_FILE}" != "Y" ]]; then
  echo "사용자 취소."
  log "ABORT — user declined backup file"
  exit 1
fi

# -----------------------------------------------------------------------------
# Step 3. 기존 .env가 있으면 충돌 — 사용자에게 알림
# -----------------------------------------------------------------------------
if [[ -f "${ENV_FILE}" ]]; then
  echo "경고: ${ENV_FILE} 이미 존재합니다."
  read -r -p "덮어쓸까요? 기존 파일은 .env.pre-restore 로 백업됩니다 [y/N]: " OVERWRITE
  if [[ "${OVERWRITE}" != "y" && "${OVERWRITE}" != "Y" ]]; then
    echo "복원 취소."
    log "ABORT — user declined to overwrite existing .env"
    exit 1
  fi
  mv "${ENV_FILE}" "${ENV_FILE}.pre-restore-$(date +%Y%m%d-%H%M%S)"
  log "existing .env moved to .env.pre-restore-*"
fi

# -----------------------------------------------------------------------------
# Step 4. .env 복원
# -----------------------------------------------------------------------------
mv "${LATEST_BACKUP}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
log ".env restored from ${LATEST_BACKUP}"

# -----------------------------------------------------------------------------
# Step 5. docker compose up -d
# -----------------------------------------------------------------------------
if [[ ! -f "${COMPOSE_FILE}" ]]; then
  log "ERROR — compose.yaml not found at ${COMPOSE_FILE}"
  echo "compose.yaml 없음. 수동 시작 필요."
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  log "starting docker compose"
  (cd "${VAULT_DIR}" && docker compose up -d) || {
    log "ERROR — docker compose up 실패"
    echo "compose up 실패. 로그 확인: docker compose logs"
    exit 1
  }
  log "containers started"
else
  log "WARN — docker not found; skipping compose up"
fi

# -----------------------------------------------------------------------------
# Step 6. tailscale serve 재설정 (확인 후)
# -----------------------------------------------------------------------------
if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then
    echo ""
    read -r -p "Tailscale serve 외부 매핑(--https=443 /)을 다시 켤까요? [y/N]: " TS_CONFIRM
    if [[ "${TS_CONFIRM}" == "y" || "${TS_CONFIRM}" == "Y" ]]; then
      tailscale serve --https=443 / http://localhost:8080 >/dev/null 2>&1 \
        && log "tailscale serve re-enabled (https=443 → localhost:8080)" \
        || log "WARN — tailscale serve 재설정 실패. 수동으로 'tailscale serve' 실행 필요"
    else
      log "tailscale serve 재설정 건너뜀 (사용자 선택)"
    fi
  fi
fi

# -----------------------------------------------------------------------------
# Step 7. LOCKDOWN 마커 아카이브
# -----------------------------------------------------------------------------
if [[ -f "${LOCKDOWN_FILE}" ]]; then
  ARCHIVE_DIR="${HOME}/incidents/archive"
  mkdir -p "${ARCHIVE_DIR}"
  mv "${LOCKDOWN_FILE}" "${ARCHIVE_DIR}/LOCKDOWN-$(date +%Y%m%d-%H%M%S)"
  log "LOCKDOWN marker archived"
else
  log "WARN — LOCKDOWN marker not found at ${LOCKDOWN_FILE}"
fi

# -----------------------------------------------------------------------------
# 완료
# -----------------------------------------------------------------------------
cat <<EOF

============================================================
        RESTORE COMPLETE — ${TS_HUMAN}
============================================================

다음 점검 사항:
  1. docker ps — vault-app, vault-caddy 정상 동작 확인
  2. health check — bash ~/vault/scripts/vault-health.sh
  3. Web Vault 로그인 테스트
  4. 사고 보고서 작성 — emergency-ko.md §4 템플릿 참조
  5. ~/incidents/vault-lockdown-* 디렉토리 정리

로그: ${LOG_FILE}
============================================================
EOF

log "END — restore complete"
exit 0
