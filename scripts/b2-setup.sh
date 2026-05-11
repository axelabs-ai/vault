#!/usr/bin/env bash
# b2-setup.sh — Backblaze B2 remote bootstrap for vault backups.
# Idempotent. Never echoes secrets.
set -euo pipefail

ENV_FILE="${HOME}/.config/vault/.env"
BUCKET_NAME="realchoice-vault-backups"
REMOTE_NAME="b2"
REMOTE_LINE="VAULT_B2_REMOTE=${REMOTE_NAME}:${BUCKET_NAME}"

log() { printf '[b2-setup] %s\n' "$*"; }

if ! command -v rclone >/dev/null 2>&1; then
  log "rclone missing, parallel brew install may not have finished. Re-run later."
  exit 1
fi

print_manual_steps() {
  cat <<'EOF'
[b2-setup] No 'b2:' remote found in rclone. Complete these manual steps, then re-run this script.

  1) Sign up: https://www.backblaze.com/sign-up/cloud-storage
     (가입 — 이메일/비밀번호/2FA TOTP)

  2) Buckets -> Create a Bucket
       Name: realchoice-vault-backups
       Files: Private
       Default Encryption: Enable (SSE-B2)
       Object Lock: leave off

  3) App Keys -> Add a New Application Key
       Name: vault-backup
       Allow access to Bucket(s): realchoice-vault-backups   (single bucket scope)
       Type of Access: Read and Write
       File name prefix: (empty)
       Duration: (empty)
       --> Save BOTH keyID and applicationKey.
           applicationKey is shown ONCE. Treat as a password.

  4) Configure rclone (interactive):
       rclone config
         n         (new remote)
         name>     b2
         Storage>  Backblaze B2          (pick the matching number)
         account>  <paste your keyID>
         key>      <paste your applicationKey>
         hard_delete> (leave default; press Enter)
         Edit advanced config? n
         Keep this "b2" remote? y
         q         (quit config)

  5) Re-run this script:
       ~/vault/scripts/b2-setup.sh
     It will probe the bucket and persist VAULT_B2_REMOTE to ~/.config/vault/.env.
EOF
}

if ! rclone listremotes 2>/dev/null | grep -qx "${REMOTE_NAME}:"; then
  print_manual_steps
  exit 0
fi

log "remote already configured"

# Probe: touch + ls + delete a unique marker. Surfaces auth/perm errors loudly.
TS="$(date -u +%Y%m%dT%H%M%SZ)"
PROBE_PATH="${REMOTE_NAME}:${BUCKET_NAME}/.vault-setup-probe-${TS}"
TMP_PROBE="$(mktemp -t vault-b2-probe.XXXXXX)"
trap 'rm -f "${TMP_PROBE}"' EXIT
printf 'vault b2-setup probe %s\n' "${TS}" > "${TMP_PROBE}"

log "probe: writing marker"
if ! rclone copyto "${TMP_PROBE}" "${PROBE_PATH}" >/dev/null; then
  log "probe FAILED on write — check rclone credentials / bucket name."
  exit 1
fi

log "probe: listing marker"
if ! rclone lsf "${PROBE_PATH}" >/dev/null; then
  log "probe FAILED on list — wrote but cannot read back."
  rclone deletefile "${PROBE_PATH}" >/dev/null 2>&1 || true
  exit 1
fi

log "probe: deleting marker"
if ! rclone deletefile "${PROBE_PATH}" >/dev/null; then
  log "probe WARN — could not delete marker; manual cleanup needed."
fi

log "probe OK"

# Persist VAULT_B2_REMOTE to env file (idempotent).
mkdir -p "$(dirname "${ENV_FILE}")"
if [[ ! -f "${ENV_FILE}" ]]; then
  : > "${ENV_FILE}"
fi
if grep -q '^VAULT_B2_REMOTE=' "${ENV_FILE}"; then
  log "VAULT_B2_REMOTE already present in ${ENV_FILE} — leaving as-is"
else
  printf '%s\n' "${REMOTE_LINE}" >> "${ENV_FILE}"
  log "appended VAULT_B2_REMOTE to ${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"

log "done."
