#!/bin/bash
# L3-1: log rotation for /logs (mounted to ~/realchoice-ssot/logs).
# Pattern: stream/data_ops/logrotate.sh — gzip > 50 MB, retain 30d.

set -euo pipefail

LOG_DIR="${VAULT_LOG_DIR}"
ROTATE_SIZE_MB=50
RETAIN_DAYS=30

cd "$LOG_DIR" || exit 1

# Only rotate vault-specific logs (don't touch stream/magnet/n8n logs in same dir)
for f in vault-backup.log vault-health.jsonl tailscaled.log tailscaled.err.log; do
    [[ -f "$f" ]] || continue
    size_mb=$(( $(stat -c %s "$f" 2>/dev/null || echo 0) / 1048576 ))
    if [[ "$size_mb" -ge "$ROTATE_SIZE_MB" ]]; then
        gzip -c "$f" > "${f}.$(date +%Y-%m-%d).gz" && : > "$f"
        echo "[$(date -Iseconds)] logrotate: rotated $f (${size_mb}MB)"
    fi
done

# Retention for our rotated logs
find "$LOG_DIR" -maxdepth 1 -name "vault-*.gz" -mtime "+${RETAIN_DAYS}" -delete 2>/dev/null || true
find "$LOG_DIR" -maxdepth 1 -name "tailscaled*.gz" -mtime "+${RETAIN_DAYS}" -delete 2>/dev/null || true

echo "[$(date -Iseconds)] logrotate: done"
