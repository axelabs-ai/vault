#!/usr/bin/env bash
# vault-health.sh
# Single-shot health probe for the vault stack.
# Emits one compact JSON line on stdout. Exits 0=ok, 1=degraded, 2=down.
set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

BACKUP_DIR="${HOME}/backups/vault"
ENV_FILE="${HOME}/.config/vault/.env"
ALIVE_URL="http://127.0.0.1:8222/alive"
# Vaultwarden 1.35+ returns ISO 8601 timestamp; <1.35 returned this string.
ALIVE_EXPECT_LEGACY="Vaultwarden is running!"
ALIVE_EXPECT_TS_REGEX='^"?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
BACKUP_MAX_AGE_SEC=$((26 * 3600))   # 26h slop on top of 03:10 daily run
DISK_MIN_FREE_BYTES=$((1024 * 1024 * 1024))  # 1 GiB

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---- probe helpers ----------------------------------------------------------

probe_container() {
  # $1 = container name; $2 = "healthy" if a docker HEALTHCHECK is expected,
  # "any-up" if just "Up" should count as ok (e.g. Caddy with no healthcheck).
  local name="$1" mode="${2:-healthy}" line status
  if ! line="$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep "^${name} " || true)"; then
    line=""
  fi
  if [[ -z "${line}" ]]; then
    printf '%s' "fail:not_running"
    return
  fi
  status="${line#${name} }"
  if [[ "${mode}" == "any-up" && "${status}" == Up* ]]; then
    printf '%s' "ok:${status}"
  elif [[ "${status}" == Up*"(healthy)"* ]]; then
    printf '%s' "ok:${status}"
  elif [[ "${status}" == Up* ]]; then
    printf '%s' "degraded:${status}"
  else
    printf '%s' "fail:${status}"
  fi
}

probe_alive() {
  local body
  if ! body="$(curl -fsS -m 5 "${ALIVE_URL}" 2>/dev/null)"; then
    printf '%s' "fail:no_response"
    return
  fi
  if [[ "${body}" == *"${ALIVE_EXPECT_LEGACY}"* ]] \
       || [[ "${body}" =~ ${ALIVE_EXPECT_TS_REGEX} ]]; then
    printf '%s' "ok:alive"
  else
    printf '%s' "degraded:unexpected_body"
  fi
}

probe_backup_fresh() {
  if [[ ! -d "${BACKUP_DIR}" ]]; then
    printf '%s' "fail:no_backup_dir"
    return
  fi
  local newest age now
  newest="$(/bin/ls -1t "${BACKUP_DIR}"/*.tar.gpg 2>/dev/null | head -n1 || true)"
  if [[ -z "${newest}" ]]; then
    printf '%s' "fail:no_backup_files"
    return
  fi
  now="$(date +%s)"
  age=$(( now - $(stat -f %m "${newest}") ))
  if (( age < BACKUP_MAX_AGE_SEC )); then
    printf '%s' "ok:age_${age}s"
  else
    printf '%s' "fail:stale_${age}s"
  fi
}

probe_disk() {
  if [[ ! -d "${BACKUP_DIR}" ]]; then
    printf '%s' "fail:no_backup_dir"
    return
  fi
  # df -k -> KiB; multiply by 1024.
  local free_kb free_bytes
  free_kb="$(df -k "${BACKUP_DIR}" | awk 'NR==2 {print $4}')"
  if [[ -z "${free_kb}" ]]; then
    printf '%s' "fail:df_unreadable"
    return
  fi
  free_bytes=$(( free_kb * 1024 ))
  if (( free_bytes > DISK_MIN_FREE_BYTES )); then
    printf '%s' "ok:free_${free_bytes}b"
  else
    printf '%s' "fail:low_${free_bytes}b"
  fi
}

probe_admin_token() {
  if [[ -f "${ENV_FILE}" ]] && grep -q '^ADMIN_TOKEN=' "${ENV_FILE}"; then
    printf '%s' "ok:present"
  else
    printf '%s' "fail:missing"
  fi
}

# ---- run probes -------------------------------------------------------------

vault_app="$(probe_container vault-app healthy)"
vault_caddy="$(probe_container vault-caddy any-up)"
alive="$(probe_alive)"
backup="$(probe_backup_fresh)"
disk="$(probe_disk)"
admin="$(probe_admin_token)"

# ---- aggregate status -------------------------------------------------------

declare -a failed=() degraded=()
for kv in \
    "vault_app=${vault_app}" \
    "vault_caddy=${vault_caddy}" \
    "alive=${alive}" \
    "backup_fresh=${backup}" \
    "disk_free=${disk}" \
    "admin_token=${admin}"; do
  name="${kv%%=*}"
  val="${kv#*=}"
  case "${val}" in
    fail:*)     failed+=("${name}") ;;
    degraded:*) degraded+=("${name}") ;;
  esac
done

if (( ${#failed[@]} > 0 )); then
  status="down"
  exit_code=2
elif (( ${#degraded[@]} > 0 )); then
  status="degraded"
  exit_code=1
else
  status="ok"
  exit_code=0
fi

summary_failed="$(IFS=, ; echo "${failed[*]-}")"
summary_degraded="$(IFS=, ; echo "${degraded[*]-}")"
if [[ "${status}" == "ok" ]]; then
  summary="all checks passing"
elif [[ "${status}" == "degraded" ]]; then
  summary="degraded checks: ${summary_degraded}"
else
  summary="failing checks: ${summary_failed}"
  if [[ -n "${summary_degraded}" ]]; then
    summary="${summary}; degraded: ${summary_degraded}"
  fi
fi

# ---- emit JSON --------------------------------------------------------------

jq -cn \
  --arg ts            "${ts}" \
  --arg status        "${status}" \
  --arg summary       "${summary}" \
  --arg vault_app     "${vault_app}" \
  --arg vault_caddy   "${vault_caddy}" \
  --arg alive         "${alive}" \
  --arg backup_fresh  "${backup}" \
  --arg disk_free     "${disk}" \
  --arg admin_token   "${admin}" \
  '{
    ts: $ts,
    status: $status,
    summary: $summary,
    checks: {
      vault_app:    $vault_app,
      vault_caddy:  $vault_caddy,
      alive:        $alive,
      backup_fresh: $backup_fresh,
      disk_free:    $disk_free,
      admin_token:  $admin_token
    }
  }'

exit "${exit_code}"
