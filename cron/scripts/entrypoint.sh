#!/bin/bash
# vault-cron entrypoint — runs once at container start, then execs supercronic.
set -euo pipefail

LOG_PREFIX="[vault-cron:init]"

echo "$LOG_PREFIX starting (TZ=$TZ, recipient=$VAULT_GPG_RECIPIENT)"

# Import GPG public key (idempotent).
if [[ -f /app/keys/vault-backup.pub.asc ]]; then
    if ! gpg --list-keys "$VAULT_GPG_RECIPIENT" >/dev/null 2>&1; then
        gpg --batch --import /app/keys/vault-backup.pub.asc
        echo "$LOG_PREFIX GPG public key imported"
    else
        echo "$LOG_PREFIX GPG key already present"
    fi
else
    echo "$LOG_PREFIX WARN: /app/keys/vault-backup.pub.asc missing — backups will fail" >&2
fi

# Validate docker socket access (mount required for `docker exec vault-app`).
if [[ ! -S /var/run/docker.sock ]]; then
    echo "$LOG_PREFIX FATAL: /var/run/docker.sock not mounted" >&2
    exit 1
fi
if ! docker ps >/dev/null 2>&1; then
    echo "$LOG_PREFIX WARN: docker socket present but ps failed (will retry per cron)" >&2
fi

# Validate bind mounts.
for d in "$VAULT_BACKUP_DIR" "$VAULT_LOG_DIR"; do
    if [[ ! -d "$d" ]]; then
        echo "$LOG_PREFIX FATAL: $d missing (compose volume mount missing)" >&2
        exit 1
    fi
done

# Optional: rclone B2 remote
if rclone listremotes 2>/dev/null | grep -q "^b2:"; then
    echo "$LOG_PREFIX rclone B2 remote configured"
else
    echo "$LOG_PREFIX no rclone B2 remote — backups stay local (configure on host)"
fi

echo "$LOG_PREFIX ready — exec $*"
exec "$@"
