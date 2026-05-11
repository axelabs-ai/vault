#!/bin/bash
# vault 복구 드릴 — 별 컨테이너에서 복원 검증 (분기 1회)
# 비파괴: 라이브 vault-app 건드리지 않음, 임시 컨테이너로만 검증

set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "usage: $0 <path-to-tar.gpg>" >&2
  exit 1
fi

WORK=$(mktemp -d -t vault-restore-XXXX)
trap 'rm -rf "$WORK"' EXIT

echo "[restore-test] decrypt $ARCHIVE -> $WORK"
gpg --decrypt "$ARCHIVE" | tar -xf - -C "$WORK"

if [[ ! -f "$WORK/db.sqlite3" ]]; then
  echo "[restore-test] FAIL: db.sqlite3 missing" >&2
  exit 1
fi

ROW_COUNT=$(sqlite3 "$WORK/db.sqlite3" "SELECT count(*) FROM users;" 2>/dev/null || echo "?")
CIPHER_COUNT=$(sqlite3 "$WORK/db.sqlite3" "SELECT count(*) FROM ciphers;" 2>/dev/null || echo "?")

echo "[restore-test] OK"
echo "  users   : $ROW_COUNT"
echo "  ciphers : $CIPHER_COUNT"
echo "  size    : $(du -h "$WORK/db.sqlite3" | awk '{print $1}')"
echo "[restore-test] drill done. Log result to Slack #data-ops."
