#!/bin/bash
# vault 백업 — 3-2-1 분산 (로컬 + B2 + 분기 USB)
# 호출: 매일 03:10 LaunchAgent (com.realchoice.vault-backup)

set -euo pipefail

TODAY=$(date +%F)
BACKUP_ROOT="$HOME/backups/vault"
STAGE="$BACKUP_ROOT/$TODAY"
ARCHIVE="$BACKUP_ROOT/$TODAY.tar.gpg"
LOG="$HOME/realchoice-ssot/logs/vault-backup.log"
GPG_RECIPIENT="${VAULT_GPG_RECIPIENT:-vault-backup@realchoice.co.kr}"
B2_REMOTE="${VAULT_B2_REMOTE:-b2:realchoice-vault-backups}"
RETAIN_DAYS="${VAULT_BACKUP_RETAIN_DAYS:-7}"

mkdir -p "$STAGE" "$(dirname "$LOG")"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG"
}

fail() {
  log "FAIL: $*"
  exit 1
}

trap 'fail "aborted on line $LINENO"' ERR

log "begin backup $TODAY"

# 1) SQLite — use Vaultwarden's built-in backup (WAL-safe).
# `/vaultwarden backup` writes data/db_YYYYMMDD_HHMMSS.sqlite3 inside the container.
# Older bootstrap docs assumed a sqlite3 CLI in the image, but vaultwarden:*-alpine
# does NOT ship sqlite3. The built-in subcommand is the supported path.
docker exec vault-app /vaultwarden backup >/dev/null
SNAPSHOT=$(docker exec vault-app sh -c 'ls -1t /data/db_*.sqlite3 2>/dev/null | head -1')
if [[ -z "$SNAPSHOT" ]]; then
  fail "vaultwarden backup snapshot not found"
fi
docker cp "vault-app:$SNAPSHOT" "$STAGE/db.sqlite3"
docker exec vault-app rm "$SNAPSHOT"
log "sqlite ok ($(du -h "$STAGE/db.sqlite3" | awk '{print $1}'))"

# 2) attachments / sends / config
for d in attachments sends config.json rsa_key.pem rsa_key.pub.pem; do
  docker cp "vault-app:/data/$d" "$STAGE/" 2>/dev/null || true
done

# 3) GPG encrypt (asymmetric — private key lives outside vault)
if ! gpg --list-keys "$GPG_RECIPIENT" >/dev/null 2>&1; then
  fail "GPG recipient '$GPG_RECIPIENT' not found — run scripts/gpg-init.sh"
fi
tar -cf - -C "$STAGE" . | gpg --batch --yes --trust-model always \
  --encrypt --recipient "$GPG_RECIPIENT" --output "$ARCHIVE"
rm -rf "$STAGE"
log "encrypted -> $ARCHIVE ($(du -h "$ARCHIVE" | awk '{print $1}'))"

# 4) Backblaze B2 (rclone) — skip if rclone or remote not configured
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q "^${B2_REMOTE%%:*}:"; then
  rclone copy "$ARCHIVE" "$B2_REMOTE/" --quiet
  log "B2 sync ok -> $B2_REMOTE"
else
  log "B2 skip (rclone or remote not configured)"
fi

# 5) Rotate local
find "$BACKUP_ROOT" -maxdepth 1 -name "*.tar.gpg" -mtime "+$RETAIN_DAYS" -delete
log "rotated (retain ${RETAIN_DAYS}d)"

log "done $TODAY OK"
