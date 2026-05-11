#!/bin/bash
# backup-roundtrip.sh — end-to-end backup + restore drill on an isolated test vault.
# Uses a separate container (vault-test-app) on port 8224 and /tmp dirs only.
# Never touches prod data/, prod container, or real ~/backups/vault/ files.

set -uo pipefail

GPG_RECIPIENT="${VAULT_GPG_RECIPIENT:-vault-backup@realchoice.co.kr}"
TEST_NAME="vault-test-app"
TEST_PORT="8224"
DATA_DIR="/tmp/vault-test-roundtrip"
RESTORE_DIR="/tmp/vault-test-restored"
ARCHIVE_PLAIN="/tmp/vault-test-roundtrip.tar"
ARCHIVE_ENC="/tmp/vault-test-roundtrip.tar.gpg"
MARKER_NAME="roundtrip-marker.txt"
MARKER_CONTENT="vault-roundtrip-$(date -Iseconds)-$$"

red()    { printf '\033[31m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }

log()  { echo "[roundtrip] $*"; }
fail() { echo "[$(red FAIL)] $*" >&2; exit 1; }
warn() { echo "[$(yellow WARN)] $*"; }
pass() { echo "[$(green PASS)] $*"; }

cleanup() {
  log "cleanup..."
  docker rm -f "$TEST_NAME" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR" "$RESTORE_DIR" "$ARCHIVE_PLAIN" "$ARCHIVE_ENC"
}
trap cleanup EXIT

# 0) Pre-flight: GPG key present? If not, WARN-skip (cannot exercise encryption path).
if ! gpg --list-keys "$GPG_RECIPIENT" >/dev/null 2>&1; then
  warn "GPG recipient '$GPG_RECIPIENT' not found — backup roundtrip skipped."
  warn "Generate with scripts/gpg-init.sh to enable this test."
  exit 0
fi

# 1) Prepare an isolated data dir with marker + a real sqlite db (users + ciphers).
log "preparing test data dir $DATA_DIR"
rm -rf "$DATA_DIR" "$RESTORE_DIR"
mkdir -p "$DATA_DIR"
echo "$MARKER_CONTENT" > "$DATA_DIR/$MARKER_NAME"
sqlite3 "$DATA_DIR/db.sqlite3" <<'SQL' >/dev/null
CREATE TABLE users (uuid TEXT PRIMARY KEY, email TEXT);
INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001', 'roundtrip@example.com');
CREATE TABLE ciphers (uuid TEXT PRIMARY KEY, user_uuid TEXT);
INSERT INTO ciphers VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001');
SQL
pass "test data dir seeded (marker + db.sqlite3 with 1 user / 1 cipher)"

# 2) Optionally start a test vault container — we only need it to validate that
#    an isolated container can mount the data dir. The roundtrip itself is on the dir.
log "starting test container $TEST_NAME on port $TEST_PORT (non-blocking)"
docker rm -f "$TEST_NAME" >/dev/null 2>&1 || true
if docker run -d --rm \
    --name "$TEST_NAME" \
    -p "127.0.0.1:${TEST_PORT}:80" \
    -v "$DATA_DIR:/data" \
    -e DOMAIN="http://127.0.0.1:${TEST_PORT}" \
    -e SIGNUPS_ALLOWED=false \
    vaultwarden/server:1.35.8-alpine >/dev/null 2>&1; then
  pass "test container started"
  sleep 2
  if docker ps --format '{{.Names}}' | grep -q "^${TEST_NAME}$"; then
    pass "test container running"
  else
    warn "test container exited early (continuing roundtrip on data dir only)"
  fi
else
  warn "could not start test container — continuing on data dir only"
fi

# 3) Tar + GPG encrypt — mirrors backup.sh's "tar -cf - | gpg --encrypt" pattern.
log "tar + gpg encrypt -> $ARCHIVE_ENC"
if ! tar -cf - -C "$DATA_DIR" . | \
     gpg --batch --yes --trust-model always \
         --encrypt --recipient "$GPG_RECIPIENT" \
         --output "$ARCHIVE_ENC" 2>/tmp/vault-roundtrip-gpg.err; then
  cat /tmp/vault-roundtrip-gpg.err >&2
  fail "encryption failed"
fi
[[ -s "$ARCHIVE_ENC" ]] || fail "encrypted archive empty"
pass "encrypted archive created ($(du -h "$ARCHIVE_ENC" | awk '{print $1}'))"

# 4) Decrypt + extract into a *separate* directory.
log "decrypt + extract -> $RESTORE_DIR"
mkdir -p "$RESTORE_DIR"
if ! gpg --batch --yes --decrypt "$ARCHIVE_ENC" 2>/tmp/vault-roundtrip-dec.err | \
     tar -xf - -C "$RESTORE_DIR"; then
  cat /tmp/vault-roundtrip-dec.err >&2
  fail "decrypt/extract failed"
fi
pass "decrypt + extract ok"

# 5) Verify marker.
log "verifying marker file content"
if [[ ! -f "$RESTORE_DIR/$MARKER_NAME" ]]; then
  fail "marker file missing after restore"
fi
RESTORED_CONTENT=$(cat "$RESTORE_DIR/$MARKER_NAME")
if [[ "$RESTORED_CONTENT" != "$MARKER_CONTENT" ]]; then
  echo "    expected: $MARKER_CONTENT" >&2
  echo "    got     : $RESTORED_CONTENT" >&2
  fail "marker content mismatch"
fi
pass "marker content matches original"

# 6) Verify sqlite content survived.
if [[ -f "$RESTORE_DIR/db.sqlite3" ]]; then
  u=$(sqlite3 "$RESTORE_DIR/db.sqlite3" "SELECT count(*) FROM users;" 2>/dev/null || echo "?")
  c=$(sqlite3 "$RESTORE_DIR/db.sqlite3" "SELECT count(*) FROM ciphers;" 2>/dev/null || echo "?")
  if [[ "$u" == "1" && "$c" == "1" ]]; then
    pass "sqlite restored (users=$u, ciphers=$c)"
  else
    fail "sqlite row counts wrong (users=$u, ciphers=$c, want 1/1)"
  fi
else
  fail "db.sqlite3 missing after restore"
fi

echo
echo "$(green "PASS") backup roundtrip complete — encrypt -> decrypt -> verify."
