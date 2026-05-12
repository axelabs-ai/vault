#!/bin/bash
# L3-1: retention sweep for /backups and /logs.
# - backup tar.gpg older than VAULT_BACKUP_RETAIN_DAYS (30): delete
# - health JSONL: truncate lines older than VAULT_HEALTH_LOG_RETAIN_DAYS (7)

set -euo pipefail

LOG_PREFIX="[$(date -Iseconds)] retention:"

# 1. Backup retention
BACKUP_CUT_DAYS="${VAULT_BACKUP_RETAIN_DAYS:-30}"
BEFORE=$(ls -1 "${VAULT_BACKUP_DIR}"/*.tar.gpg 2>/dev/null | wc -l | tr -d ' ')
find "${VAULT_BACKUP_DIR}" -maxdepth 1 -name "*.tar.gpg" -mtime "+${BACKUP_CUT_DAYS}" -delete 2>/dev/null || true
AFTER=$(ls -1 "${VAULT_BACKUP_DIR}"/*.tar.gpg 2>/dev/null | wc -l | tr -d ' ')
echo "$LOG_PREFIX backups: $BEFORE -> $AFTER (kept ${BACKUP_CUT_DAYS}d)"

# 2. Health JSONL — keep only recent lines (JSONL contains ISO ts as first field)
HEALTH_FILE="${VAULT_LOG_DIR}/vault-health.jsonl"
HEALTH_CUT_DAYS="${VAULT_HEALTH_LOG_RETAIN_DAYS:-7}"
if [[ -f "$HEALTH_FILE" ]]; then
    BEFORE_LINES=$(wc -l < "$HEALTH_FILE" | tr -d ' ')
    CUTOFF_TS=$(date -u -d "${HEALTH_CUT_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
                || date -u -v "-${HEALTH_CUT_DAYS}d" +%Y-%m-%dT%H:%M:%SZ)
    TMP=$(mktemp)
    awk -v cut="$CUTOFF_TS" '
        {
            # Extract ts field via crude pattern (avoid jq for speed at retention time)
            if (match($0, /"ts":"[^"]+"/)) {
                t = substr($0, RSTART+6, RLENGTH-7)
                if (t >= cut) print
            }
        }' "$HEALTH_FILE" > "$TMP"
    mv "$TMP" "$HEALTH_FILE"
    AFTER_LINES=$(wc -l < "$HEALTH_FILE" | tr -d ' ')
    echo "$LOG_PREFIX health.jsonl: $BEFORE_LINES -> $AFTER_LINES lines (kept ${HEALTH_CUT_DAYS}d)"
fi

echo "$LOG_PREFIX done"
