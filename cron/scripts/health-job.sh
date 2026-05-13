#!/bin/bash
# vault health probe — container-native version of vault-health.sh + emit.
# Output: single-line JSON appended to /logs/vault-health.jsonl.
# Exits 0=ok 1=degraded 2=down (supercronic logs the exit code).

set -uo pipefail

LOGFILE="${VAULT_LOG_DIR}/vault-health.jsonl"
# vault-app 직접 호출 — Caddy :80 → :443 자동 redirect (308) 우회.
# vault-app 컨테이너 안 Rocket(Vaultwarden) 이 직접 응답.
ALIVE_URL="http://${VAULT_CONTAINER}:80/alive"
BACKUP_MAX_AGE_SEC=$((26 * 3600))
DISK_MIN_FREE_BYTES=$((1024 * 1024 * 1024))   # 1 GiB

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

probe_container() {
    local name="$1" mode="${2:-healthy}" line
    line=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep "^${name} " || true)
    if [[ -z "$line" ]]; then
        printf 'fail:not_running'; return
    fi
    local status="${line#${name} }"
    if [[ "$mode" == "any-up" && "$status" == Up* ]]; then
        printf 'ok:%s' "$status"
    elif [[ "$status" == Up*"(healthy)"* ]]; then
        printf 'ok:%s' "$status"
    elif [[ "$status" == Up* ]]; then
        printf 'degraded:%s' "$status"
    else
        printf 'fail:%s' "$status"
    fi
}

probe_alive() {
    local body
    if ! body=$(curl -fsS -m 5 "$ALIVE_URL" 2>/dev/null); then
        printf 'fail:no_response'; return
    fi
    if [[ "$body" =~ ^\"?[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || [[ "$body" == *"Vaultwarden is running!"* ]]; then
        printf 'ok:alive'
    else
        printf 'degraded:unexpected_body'
    fi
}

probe_backup_fresh() {
    local newest age now
    newest=$(ls -1t "${VAULT_BACKUP_DIR}"/*.tar.gpg 2>/dev/null | head -1 || true)
    if [[ -z "$newest" ]]; then
        printf 'fail:no_backup_files'; return
    fi
    now=$(date +%s)
    age=$(( now - $(stat -c %Y "$newest") ))
    if (( age < BACKUP_MAX_AGE_SEC )); then
        printf 'ok:age_%ds' "$age"
    else
        printf 'fail:stale_%ds' "$age"
    fi
}

probe_disk() {
    local free_kb free_bytes
    free_kb=$(df -k "$VAULT_BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
    if [[ -z "$free_kb" ]]; then printf 'fail:df'; return; fi
    free_bytes=$(( free_kb * 1024 ))
    if (( free_bytes > DISK_MIN_FREE_BYTES )); then
        printf 'ok:free_%db' "$free_bytes"
    else
        printf 'fail:low_%db' "$free_bytes"
    fi
}

probe_admin_token() {
    # Re-verify by probing /admin (any 200/302/401 means Vaultwarden is serving the route).
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://${VAULT_CONTAINER}:80/admin" || echo 000)
    if [[ "$code" =~ ^(200|301|302|401)$ ]]; then
        printf 'ok:admin_route_%s' "$code"
    else
        printf 'fail:%s' "$code"
    fi
}

vault_app=$(probe_container "$VAULT_CONTAINER" healthy)
vault_caddy=$(probe_container "$VAULT_CADDY" any-up)
alive=$(probe_alive)
backup=$(probe_backup_fresh)
disk=$(probe_disk)
admin=$(probe_admin_token)

failed=()
degraded=()
for kv in \
    "vault_app=${vault_app}" \
    "vault_caddy=${vault_caddy}" \
    "alive=${alive}" \
    "backup_fresh=${backup}" \
    "disk_free=${disk}" \
    "admin_token=${admin}"; do
    name="${kv%%=*}"; val="${kv#*=}"
    case "$val" in
        fail:*)     failed+=("$name") ;;
        degraded:*) degraded+=("$name") ;;
    esac
done

if (( ${#failed[@]} > 0 )); then
    status="down"; exit_code=2
elif (( ${#degraded[@]} > 0 )); then
    status="degraded"; exit_code=1
else
    status="ok"; exit_code=0
fi
sum_f=$(IFS=, ; echo "${failed[*]-}")
sum_d=$(IFS=, ; echo "${degraded[*]-}")
if [[ "$status" == "ok" ]]; then
    summary="all checks passing"
elif [[ "$status" == "degraded" ]]; then
    summary="degraded: ${sum_d}"
else
    summary="failing: ${sum_f}${sum_d:+; degraded: ${sum_d}}"
fi

JSON=$(jq -nc \
    --arg ts "$ts" --arg status "$status" --arg summary "$summary" \
    --arg vault_app "$vault_app" --arg vault_caddy "$vault_caddy" \
    --arg alive "$alive" --arg backup_fresh "$backup" \
    --arg disk_free "$disk" --arg admin_token "$admin" \
    '{ts:$ts, status:$status, summary:$summary,
      checks:{vault_app:$vault_app, vault_caddy:$vault_caddy, alive:$alive,
              backup_fresh:$backup_fresh, disk_free:$disk_free, admin_token:$admin_token}}')

echo "$JSON" >> "$LOGFILE"
if [[ "$status" != "ok" ]]; then
    echo "[$(date -Iseconds)] health.$status $summary" >&2
fi
exit "$exit_code"
