#!/bin/bash
# quarterly-drill.sh — vault 분기 복구 드릴 (1시간)
# - 가장 최근 *.tar.gpg 자동 선택
# - restore-test.sh 로 db 무결성 검증
# - TEMP vaultwarden 컨테이너를 8223 포트에 기동 → 사용자가 5분 안에 로그인 확인
# - Enter 입력 또는 5분 타임아웃 시 자동 정리
# - 결과 1줄을 ~/realchoice-ssot/logs/vault-drills.log 에 append
#
# 라이브 vault-app 컨테이너는 절대 건드리지 않음. 포트·컨테이너명·데이터디렉토리 전부 분리.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${HOME}/backups/vault"
LOG="${HOME}/realchoice-ssot/logs/vault-drills.log"
DRILL_PORT="${VAULT_DRILL_PORT:-8223}"
DRILL_NAME="vault-drill-$$"
DRILL_WORK="$(mktemp -d -t vault-drill-XXXXXX)"
DRILL_DATA="${DRILL_WORK}/data"
DRILL_IMG="vaultwarden/server:1.35.8-alpine"   # 기본은 라이브와 동일, override 가능
[[ -f "${REPO_ROOT}/compose.yaml" ]] && \
  DRILL_IMG="$(grep -E 'image:[[:space:]]*vaultwarden/server:' "${REPO_ROOT}/compose.yaml" \
                | head -1 | sed -E 's#.*image:[[:space:]]*##; s/[[:space:]]*$//')" || true

mkdir -p "$(dirname "${LOG}")" "${DRILL_DATA}"

# ---- always cleanup ---------------------------------------------------------
cleanup() {
  set +e
  if docker ps -a --format '{{.Names}}' | grep -q "^${DRILL_NAME}$"; then
    docker stop "${DRILL_NAME}" >/dev/null 2>&1
    docker rm   "${DRILL_NAME}" >/dev/null 2>&1
  fi
  rm -rf "${DRILL_WORK}"
}
trap cleanup EXIT INT TERM

# ---- 1) pick newest archive --------------------------------------------------
ARCHIVE="$(/bin/ls -1t "${BACKUP_DIR}"/*.tar.gpg 2>/dev/null | head -n1 || true)"
if [[ -z "${ARCHIVE}" ]]; then
  echo "[drill] FAIL: no *.tar.gpg in ${BACKUP_DIR}" >&2
  printf '%s archive=- result=FAIL reason=no_archive\n' "$(date -Iseconds)" >> "${LOG}"
  exit 1
fi
ARCHIVE_NAME="$(basename "${ARCHIVE}")"
echo "[drill] selected archive: ${ARCHIVE_NAME}"

# ---- 2) restore-test (uses existing script) ----------------------------------
echo "[drill] running restore-test.sh ..."
if ! RESTORE_OUT="$(bash "${REPO_ROOT}/scripts/restore-test.sh" "${ARCHIVE}" 2>&1)"; then
  echo "${RESTORE_OUT}" >&2
  printf '%s archive=%s result=FAIL reason=restore_test\n' "$(date -Iseconds)" "${ARCHIVE_NAME}" >> "${LOG}"
  exit 1
fi
echo "${RESTORE_OUT}"
CIPHERS="$(printf '%s\n' "${RESTORE_OUT}" | awk '/ciphers/ {print $3; exit}' || echo "?")"
USERS="$(  printf '%s\n' "${RESTORE_OUT}" | awk '/users/   {print $3; exit}' || echo "?")"

# ---- 3) decrypt again into drill data dir ------------------------------------
echo "[drill] decrypting into ${DRILL_DATA} ..."
gpg --decrypt "${ARCHIVE}" | tar -xf - -C "${DRILL_DATA}"

if [[ ! -f "${DRILL_DATA}/db.sqlite3" ]]; then
  echo "[drill] FAIL: db.sqlite3 missing after decrypt" >&2
  printf '%s archive=%s result=FAIL reason=decrypt\n' "$(date -Iseconds)" "${ARCHIVE_NAME}" >> "${LOG}"
  exit 1
fi

# ---- 4) stand up temp container ---------------------------------------------
echo "[drill] starting temp container ${DRILL_NAME} on :${DRILL_PORT} (image ${DRILL_IMG})..."
docker run -d \
  --name "${DRILL_NAME}" \
  -p "127.0.0.1:${DRILL_PORT}:80" \
  -v "${DRILL_DATA}:/data" \
  -e "SIGNUPS_ALLOWED=false" \
  -e "DISABLE_ADMIN_TOKEN=true" \
  -e "LOG_LEVEL=warn" \
  -e "TZ=Asia/Seoul" \
  "${DRILL_IMG}" >/dev/null

# wait for /alive (max 30s)
ALIVE="no"
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:${DRILL_PORT}/alive" >/dev/null 2>&1; then
    ALIVE="yes"
    break
  fi
  sleep 1
done

if [[ "${ALIVE}" != "yes" ]]; then
  echo "[drill] FAIL: temp container did not become alive" >&2
  docker logs "${DRILL_NAME}" 2>&1 | tail -20 >&2 || true
  printf '%s archive=%s result=FAIL reason=alive_timeout users=%s ciphers=%s\n' \
    "$(date -Iseconds)" "${ARCHIVE_NAME}" "${USERS}" "${CIPHERS}" >> "${LOG}"
  exit 1
fi

# ---- 5) prompt user to verify -----------------------------------------------
cat <<EOF

================================================================
Drill PASS — temp container at http://127.0.0.1:${DRILL_PORT}
  archive : ${ARCHIVE_NAME}
  users   : ${USERS}
  ciphers : ${CIPHERS}

Open the URL in your browser and try logging in with your master
password to verify a real cipher decrypts. You have 5 minutes.

Press [Enter] when done, or wait 5 min for auto-cleanup.
================================================================
EOF

# wait up to 5 min for Enter; auto-continue otherwise
if read -t 300 -r _ </dev/tty 2>/dev/null; then
  echo "[drill] user confirmed — tearing down ..."
else
  echo ""
  echo "[drill] 5 min elapsed — auto teardown ..."
fi

# ---- 6) cleanup happens via trap; record result -----------------------------
printf '%s archive=%s result=PASS users=%s ciphers=%s\n' \
  "$(date -Iseconds)" "${ARCHIVE_NAME}" "${USERS}" "${CIPHERS}" >> "${LOG}"

echo "[drill] done. Result appended to ${LOG}"
echo "[drill] REMINDER: post to Slack #data-ops:"
echo "        [drill $(date +Q%q-%Y)] PASS · users=${USERS} ciphers=${CIPHERS} · archive=${ARCHIVE_NAME}"

exit 0
