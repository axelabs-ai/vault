#!/usr/bin/env bash
# tailscale-setup.sh — Configure Tailscale Serve for Vaultwarden and update DOMAIN in env file.
#
# Idempotent: safe to re-run. Will not modify ~/.config/vault/.env unless tailscale is
# authenticated. Does NOT run `sudo tailscale up` (interactive); prints instructions instead.

set -euo pipefail

LOG_PREFIX="[tailscale-setup]"
ENV_FILE="${HOME}/.config/vault/.env"
VAULT_LOCAL_URL="http://127.0.0.1:8222"

log() { printf '%s %s\n' "${LOG_PREFIX}" "$*"; }
warn() { printf '%s WARN: %s\n' "${LOG_PREFIX}" "$*" >&2; }
err() { printf '%s ERROR: %s\n' "${LOG_PREFIX}" "$*" >&2; }

# 1. Check tailscale CLI is present
if ! command -v tailscale >/dev/null 2>&1; then
  err "tailscale CLI not found in PATH."
  err "Next step: install the Tailscale macOS app (brew install --cask tailscale-app)"
  err "After install, the CLI should be at /usr/local/bin/tailscale (symlinked from /Applications/Tailscale.app)."
  exit 1
fi

log "tailscale CLI found at $(command -v tailscale)"

# 2. Check authentication status (no sudo)
STATUS_OUTPUT="$(tailscale status 2>&1 || true)"

if printf '%s' "${STATUS_OUTPUT}" | grep -qiE 'logged out|not (logged in|running)|please login|stopped'; then
  log "Tailscale is not authenticated yet."
  log ""
  log "Next steps (do these manually, then re-run this script):"
  log "  1) Open the Tailscale macOS app and sign in with your SSO (Google/Apple),"
  log "     OR run in a terminal:  sudo tailscale up"
  log "     (it will open a browser for SSO; follow the prompts)"
  log "  2) Once you see your device in the Tailscale admin console, re-run:"
  log "     bash ~/vault/scripts/tailscale-setup.sh"
  exit 0
fi

# Some installs print nothing useful but exit 0 even when logged out — sanity-check JSON
if ! tailscale status --json >/dev/null 2>&1; then
  log "tailscale status --json failed. Likely not yet authenticated."
  log "Run the Tailscale app login (or 'sudo tailscale up') and re-run this script."
  exit 0
fi

# 3. Parse Self.DNSName from JSON status
parse_dns_name() {
  if command -v jq >/dev/null 2>&1; then
    tailscale status --json | jq -r '.Self.DNSName // empty'
  else
    tailscale status --json | /usr/bin/python3 -c \
      'import json,sys; d=json.load(sys.stdin); print(d.get("Self",{}).get("DNSName",""))'
  fi
}

DNS_NAME_RAW="$(parse_dns_name || true)"
if [[ -z "${DNS_NAME_RAW}" ]]; then
  err "Could not parse Self.DNSName from tailscale status. Is the device fully registered?"
  err "Check the Tailscale admin console at https://login.tailscale.com/admin/machines"
  exit 1
fi

# Strip trailing dot (FQDN form)
DNS_NAME="${DNS_NAME_RAW%.}"
DOMAIN_URL="https://${DNS_NAME}"

log "Tailscale device DNS name: ${DNS_NAME}"
log "Target DOMAIN URL:         ${DOMAIN_URL}"

# 4. Configure tailscale serve (modern syntax) — idempotent
# `tailscale serve --bg --https=443 / http://127.0.0.1:8222`
# If a previous mapping exists with the same target, this is effectively a no-op.

log "Configuring tailscale serve --https=443 / -> ${VAULT_LOCAL_URL}"
if tailscale serve --bg --https=443 / "${VAULT_LOCAL_URL}" 2>&1 | sed "s|^|${LOG_PREFIX} serve: |"; then
  log "tailscale serve command completed."
else
  warn "tailscale serve command returned non-zero. Continuing to verify status..."
fi

# 5. Verify serve mapping is present
SERVE_STATUS="$(tailscale serve status 2>&1 || true)"
log "Current tailscale serve status:"
printf '%s\n' "${SERVE_STATUS}" | sed "s|^|${LOG_PREFIX}   |"

if printf '%s' "${SERVE_STATUS}" | grep -q "127.0.0.1:8222"; then
  log "Verified: serve mapping to 127.0.0.1:8222 is active."
else
  warn "Could not confirm serve mapping to 127.0.0.1:8222 in 'tailscale serve status' output."
  warn "Vaultwarden may still be reachable; verify manually."
fi

# 6. Update DOMAIN in ~/.config/vault/.env (only after we confirmed auth)
if [[ ! -f "${ENV_FILE}" ]]; then
  warn "Env file not found at ${ENV_FILE}; skipping DOMAIN update."
else
  # Use a temp file to preserve perms and atomically replace.
  TMP_ENV="$(mktemp "${ENV_FILE}.XXXXXX")"
  # Escape forward slashes in DOMAIN_URL for sed (it contains https://)
  ESCAPED_DOMAIN="$(printf '%s' "${DOMAIN_URL}" | sed -e 's/[\/&]/\\&/g')"

  if grep -qE '^DOMAIN=' "${ENV_FILE}"; then
    sed -E "s|^DOMAIN=.*|DOMAIN=${ESCAPED_DOMAIN}|" "${ENV_FILE}" > "${TMP_ENV}"
  else
    cat "${ENV_FILE}" > "${TMP_ENV}"
    printf 'DOMAIN=%s\n' "${DOMAIN_URL}" >> "${TMP_ENV}"
  fi

  mv "${TMP_ENV}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  log "Updated DOMAIN in ${ENV_FILE} (perms reset to 600)."
fi

# 7. Health check Vaultwarden local endpoint (best-effort)
log "Probing ${VAULT_LOCAL_URL}/alive ..."
HTTP_CODE="$(curl -fsS -o /tmp/vault-alive.$$ -w '%{http_code}' --max-time 5 "${VAULT_LOCAL_URL}/alive" || true)"
BODY="$(cat /tmp/vault-alive.$$ 2>/dev/null || true)"
rm -f /tmp/vault-alive.$$

if [[ "${HTTP_CODE}" == "200" ]] || printf '%s' "${BODY}" | grep -qi 'Vaultwarden is running'; then
  log "Vaultwarden /alive responded OK (HTTP ${HTTP_CODE:-?}). Setup looks good."
else
  warn "Vaultwarden /alive did not respond as expected (HTTP=${HTTP_CODE:-none})."
  warn "This is fine if you haven't started the containers yet (docker compose up -d)."
fi

log "Done. Open ${DOMAIN_URL} from any device on your tailnet."
