#!/usr/bin/env bash
# vault-health-emit.sh
# Run vault-health.sh, append the result to the JSONL log, optionally pipe
# it to a user-supplied insert command, and surface non-ok statuses to stderr.
#
# Append-only; no shared mutable state -> no locking required.
set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_BIN="${SCRIPT_DIR}/vault-health.sh"

LOG_DIR="${HOME}/realchoice-ssot/logs"
LOG_FILE="${LOG_DIR}/vault-health.jsonl"

mkdir -p "${LOG_DIR}"

# Capture JSON and exit code without aborting on non-zero (degraded/down).
set +e
json="$("${HEALTH_BIN}")"
rc=$?
set -e

# Defensive: if the probe produced nothing parseable, synthesize a down event.
if [[ -z "${json}" ]] || ! printf '%s' "${json}" | jq -e . >/dev/null 2>&1; then
  json="$(jq -cn \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg summary "vault-health.sh produced no parseable JSON (rc=${rc})" \
    '{ts:$ts, status:"down", summary:$summary, checks:{}}')"
  rc=2
fi

# (a) Append-only JSONL log.
printf '%s\n' "${json}" >> "${LOG_FILE}"

# (b) Optional shippable sink. The user wires this to stream MCP later, e.g.:
#     export VAULT_STREAM_INSERT_CMD='psql "$DATABASE_URL" -c "INSERT INTO magnet_alerts(payload) VALUES (\$1::jsonb)"'
# We pipe the JSON on stdin so the command can read it however it likes.
if [[ -n "${VAULT_STREAM_INSERT_CMD:-}" ]]; then
  if ! printf '%s\n' "${json}" | bash -c "${VAULT_STREAM_INSERT_CMD}"; then
    printf 'vault-health-emit: VAULT_STREAM_INSERT_CMD failed\n' >&2
  fi
fi

# Echo non-ok events to stderr so LaunchAgent captures them; the Slack relay
# downstream is responsible for routing to #data-ops.
status="$(printf '%s' "${json}" | jq -r '.status')"
if [[ "${status}" != "ok" ]]; then
  printf '%s\n' "${json}" >&2
fi

exit "${rc}"
