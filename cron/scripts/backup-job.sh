#!/bin/bash
# vault backup — container-native version of ~/vault/scripts/backup.sh.
# Pulls a WAL-safe snapshot via `docker exec vault-app /vaultwarden backup`,
# tars + attachments, GPG-encrypts with public key, copies to /backups,
# optional rclone B2 sync. 30-day retention handled by retention-job.sh.

set -euo pipefail

TODAY=$(date +%F)
# BusyBox mktemp uses positional template, not -t flag
STAGE=$(mktemp -d /tmp/vault-backup-XXXXXX)
ARCHIVE="${VAULT_BACKUP_DIR}/${TODAY}.tar.gpg"
LOG="${VAULT_LOG_DIR}/vault-backup.log"

log() { echo "[$(date -Iseconds)] backup: $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; rm -rf "$STAGE"; exit 1; }
trap 'fail "aborted on line $LINENO"' ERR

log "begin $TODAY"

# 1. SQLite WAL-safe snapshot
docker exec "$VAULT_CONTAINER" /vaultwarden backup >/dev/null
SNAP=$(docker exec "$VAULT_CONTAINER" sh -c 'ls -1t /data/db_*.sqlite3 2>/dev/null | head -1')
if [[ -z "$SNAP" ]]; then
    fail "no snapshot file from /vaultwarden backup"
fi
docker cp "${VAULT_CONTAINER}:${SNAP}" "$STAGE/db.sqlite3"
docker exec "$VAULT_CONTAINER" rm "$SNAP"
DBSZ=$(du -h "$STAGE/db.sqlite3" | awk '{print $1}')
log "sqlite snapshot $DBSZ"

# 2. attachments + sends + config + rsa keys (best-effort, may not exist)
for f in attachments sends config.json rsa_key.pem rsa_key.pub.pem; do
    docker cp "${VAULT_CONTAINER}:/data/${f}" "$STAGE/" 2>/dev/null || true
done

# 3. GPG encrypt (public-key — no private key in container)
if ! gpg --list-keys "$VAULT_GPG_RECIPIENT" >/dev/null 2>&1; then
    fail "GPG recipient $VAULT_GPG_RECIPIENT not in keyring (entrypoint import failed?)"
fi
tar -cf - -C "$STAGE" . | \
    gpg --batch --yes --trust-model always \
        --encrypt --recipient "$VAULT_GPG_RECIPIENT" \
        --output "$ARCHIVE"
rm -rf "$STAGE"
ASZ=$(du -h "$ARCHIVE" | awk '{print $1}')
log "encrypted -> $ARCHIVE ($ASZ)"

# 4. Backblaze B2 (optional)
if rclone listremotes 2>/dev/null | grep -q "^b2:"; then
    REMOTE="${VAULT_B2_REMOTE:-b2:realchoice-vault-backups}"
    if rclone copy "$ARCHIVE" "$REMOTE/" --quiet; then
        log "B2 sync ok -> $REMOTE"
    else
        log "B2 sync FAILED (continuing — local copy intact)"
    fi
else
    log "B2 skip (no rclone remote)"
fi

log "done $TODAY OK"
