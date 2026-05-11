#!/bin/bash
# monthly-check.sh — vault 월별 수동 점검 (10분)
# 호출: 매월 첫 영업일 운영자가 직접 실행.
# 출력: 사람이 읽는 표 (stdout) + JSON 요약 (~/realchoice-ssot/logs/vault-monthly-check-YYYY-MM.json)
# 비파괴: 라이브 컨테이너 건드리지 않음, 로그·디렉토리 read-only.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${HOME}/backups/vault"
LOG_DIR="${HOME}/realchoice-ssot/logs"
VW_LOG="${REPO_ROOT}/data/vaultwarden.log"
NOW_YM="$(date +%Y-%m)"
JSON_OUT="${LOG_DIR}/vault-monthly-check-${NOW_YM}.json"

mkdir -p "${LOG_DIR}"

JQ="/opt/homebrew/bin/jq"
[ -x "$JQ" ] || JQ="$(command -v jq || echo jq)"

# ----- 1) CVE check (silent — capture, report ok/update) ----------------------
CVE_RAW="$(bash "${REPO_ROOT}/scripts/cve-check.sh" 2>&1 || true)"
if printf '%s' "${CVE_RAW}" | grep -q 'UPDATE AVAILABLE'; then
  CVE_STATUS="update_available"
elif printf '%s' "${CVE_RAW}" | grep -q 'up to date'; then
  CVE_STATUS="up_to_date"
else
  CVE_STATUS="unknown"
fi
CVE_ADVISORY="none"
if printf '%s' "${CVE_RAW}" | grep -qE '^\[(HIGH|CRITICAL)\]'; then
  CVE_ADVISORY="present"
fi

# ----- 2) Backup file count / age / size --------------------------------------
BK_COUNT=0
BK_AVG_SIZE_BYTES=0
BK_OLDEST_AGE_DAYS=0
BK_NEWEST_AGE_DAYS=0
BK_STATUS="missing"

if [[ -d "${BACKUP_DIR}" ]]; then
  # collect files (bash 3.2 — no mapfile)
  BK_FILES=()
  while IFS= read -r line; do
    [[ -n "${line}" ]] && BK_FILES+=("${line}")
  done < <(/bin/ls -1t "${BACKUP_DIR}"/*.tar.gpg 2>/dev/null || true)
  BK_COUNT="${#BK_FILES[@]}"

  if (( BK_COUNT > 0 )); then
    NOW_EPOCH="$(date +%s)"
    TOTAL=0
    NEWEST_EPOCH=0
    OLDEST_EPOCH="${NOW_EPOCH}"
    for f in "${BK_FILES[@]}"; do
      SZ="$(stat -f %z "$f" 2>/dev/null || echo 0)"
      MT="$(stat -f %m "$f" 2>/dev/null || echo 0)"
      TOTAL=$(( TOTAL + SZ ))
      (( MT > NEWEST_EPOCH )) && NEWEST_EPOCH="$MT"
      (( MT < OLDEST_EPOCH )) && OLDEST_EPOCH="$MT"
    done
    BK_AVG_SIZE_BYTES=$(( TOTAL / BK_COUNT ))
    BK_NEWEST_AGE_DAYS=$(( (NOW_EPOCH - NEWEST_EPOCH) / 86400 ))
    BK_OLDEST_AGE_DAYS=$(( (NOW_EPOCH - OLDEST_EPOCH) / 86400 ))

    # expect 7 ± 1
    if (( BK_COUNT >= 6 && BK_COUNT <= 8 )); then
      BK_STATUS="ok"
    else
      BK_STATUS="anomaly_count_${BK_COUNT}"
    fi
  fi
fi

human_size() {
  # bytes -> human (no awk locale weirdness)
  python3 - "$1" <<'PY'
import sys
n = int(sys.argv[1])
for u in ("B","KiB","MiB","GiB","TiB"):
    if n < 1024 or u == "TiB":
        print(f"{n:.1f} {u}" if u != "B" else f"{n} B")
        break
    n = n / 1024.0
PY
}

BK_AVG_HUMAN="$(human_size "${BK_AVG_SIZE_BYTES}")"

# ----- 3) Admin access grep (vaultwarden.log) ---------------------------------
ADMIN_HITS=0
ADMIN_STATUS="no_log"
if [[ -f "${VW_LOG}" ]]; then
  # date filter — last 30 days (logs are line-oriented w/ ISO-ish timestamps)
  CUTOFF_DATE="$(date -v-30d +%Y-%m-%d 2>/dev/null || date -d '30 days ago' +%Y-%m-%d)"
  # grep for "/admin" path or "admin" token; restrict to lines whose date >= CUTOFF
  ADMIN_HITS="$(awk -v cutoff="${CUTOFF_DATE}" '
    {
      # extract first YYYY-MM-DD on line
      if (match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
        d = substr($0, RSTART, RLENGTH)
        if (d >= cutoff && tolower($0) ~ /admin/) print
      }
    }
  ' "${VW_LOG}" | wc -l | tr -d ' ')"
  if (( ADMIN_HITS == 0 )); then
    ADMIN_STATUS="ok"
  else
    ADMIN_STATUS="review_${ADMIN_HITS}"
  fi
fi

# ----- 4) Disk free for backup dir --------------------------------------------
DISK_FREE_HUMAN="?"
DISK_FREE_BYTES=0
DISK_STATUS="unknown"
if [[ -d "${BACKUP_DIR}" ]]; then
  FREE_KB="$(df -k "${BACKUP_DIR}" | awk 'NR==2 {print $4}')"
  if [[ -n "${FREE_KB}" ]]; then
    DISK_FREE_BYTES=$(( FREE_KB * 1024 ))
    DISK_FREE_HUMAN="$(human_size "${DISK_FREE_BYTES}")"
    # 5 GiB threshold
    if (( DISK_FREE_BYTES > 5 * 1024 * 1024 * 1024 )); then
      DISK_STATUS="ok"
    else
      DISK_STATUS="low"
    fi
  fi
fi

# ----- 5) Print human table ---------------------------------------------------
printf '\n=== vault monthly-check  %s ===\n' "$(date -Iseconds)"
printf '%-22s %s\n' "check"                "value"
printf '%-22s %s\n' "----------------------" "-----------------------------------"
printf '%-22s %s\n' "CVE / release"        "${CVE_STATUS}  (advisory=${CVE_ADVISORY})"
printf '%-22s %s\n' "backup count"         "${BK_COUNT}  [${BK_STATUS}]"
printf '%-22s %s\n' "backup avg size"      "${BK_AVG_HUMAN}"
printf '%-22s %s\n' "backup newest age"    "${BK_NEWEST_AGE_DAYS} day(s)"
printf '%-22s %s\n' "backup oldest age"    "${BK_OLDEST_AGE_DAYS} day(s)"
printf '%-22s %s\n' "admin log hits (30d)" "${ADMIN_HITS}  [${ADMIN_STATUS}]"
printf '%-22s %s\n' "disk free"            "${DISK_FREE_HUMAN}  [${DISK_STATUS}]"
printf '\nJSON summary -> %s\n' "${JSON_OUT}"

# ----- 6) JSON out ------------------------------------------------------------
"${JQ}" -n \
  --arg ts                "$(date -Iseconds)" \
  --arg month             "${NOW_YM}" \
  --arg cve_status        "${CVE_STATUS}" \
  --arg cve_advisory      "${CVE_ADVISORY}" \
  --argjson backup_count  "${BK_COUNT}" \
  --arg backup_status     "${BK_STATUS}" \
  --argjson backup_avg_b  "${BK_AVG_SIZE_BYTES}" \
  --argjson backup_new_d  "${BK_NEWEST_AGE_DAYS}" \
  --argjson backup_old_d  "${BK_OLDEST_AGE_DAYS}" \
  --argjson admin_hits    "${ADMIN_HITS}" \
  --arg admin_status      "${ADMIN_STATUS}" \
  --argjson disk_free_b   "${DISK_FREE_BYTES}" \
  --arg disk_status       "${DISK_STATUS}" \
  '{
    ts: $ts,
    month: $month,
    cve: { status: $cve_status, advisory: $cve_advisory },
    backups: {
      count: $backup_count,
      status: $backup_status,
      avg_size_bytes: $backup_avg_b,
      newest_age_days: $backup_new_d,
      oldest_age_days: $backup_old_d
    },
    admin_log: { hits_30d: $admin_hits, status: $admin_status },
    disk: { free_bytes: $disk_free_b, status: $disk_status }
  }' > "${JSON_OUT}"

# Hint reviewer if anything looks off
ALERTS=()
[[ "${CVE_STATUS}" == "update_available" ]] && ALERTS+=("vaultwarden update available")
[[ "${CVE_ADVISORY}" == "present" ]]        && ALERTS+=("recent high/critical advisory")
[[ "${BK_STATUS}" != "ok" ]]                && ALERTS+=("backup count anomaly (${BK_STATUS})")
[[ "${ADMIN_STATUS}" == review_* ]]         && ALERTS+=("admin log lines need review")
[[ "${DISK_STATUS}" == "low" ]]             && ALERTS+=("disk free low")

if (( ${#ALERTS[@]} > 0 )); then
  printf '\nALERTS:\n'
  for a in "${ALERTS[@]}"; do printf '  - %s\n' "$a"; done
  printf '\nLog summary to Slack #data-ops after review.\n'
else
  printf '\nAll checks green. Optional: log "monthly-check %s ok" to Slack #data-ops.\n' "${NOW_YM}"
fi

exit 0
