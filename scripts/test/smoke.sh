#!/bin/bash
# smoke.sh — one-shot health check for the vault project.
# Designed for non-experts: green = healthy, red = inspect.

set -uo pipefail

VAULT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS_DIR="$VAULT_ROOT/scripts"
TEST_DIR="$SCRIPTS_DIR/test"
ENV_FILE="$HOME/.config/vault/.env"
TOKEN_FILE="$HOME/.config/vault/ADMIN_TOKEN_PLAINTEXT"  # pragma: allowlist secret
BACKUP_DIR="$HOME/backups/vault"

PASS=0
FAIL=0
SKIP=0

red()    { printf '\033[31m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }

mark_pass() { echo "  [$(green " OK ")] $1"; PASS=$((PASS + 1)); }
mark_fail() { echo "  [$(red "FAIL")] $1${2:+ — $2}"; FAIL=$((FAIL + 1)); }
mark_skip() { echo "  [$(yellow "SKIP")] $1${2:+ — $2}"; SKIP=$((SKIP + 1)); }

perms_of() {
  # Portable mode read (macOS stat -f, GNU stat -c)
  if stat -f '%Lp' "$1" 2>/dev/null; then return; fi
  stat -c '%a' "$1" 2>/dev/null
}

echo "vault smoke test"
echo "================"
echo "project: $VAULT_ROOT"
echo

# (a) compose-validate.sh
echo "[a] compose validation"
if [[ -x "$TEST_DIR/compose-validate.sh" ]]; then
  if VAULT_ENV_FILE="$ENV_FILE" "$TEST_DIR/compose-validate.sh" >/tmp/vault-compose-validate.out 2>&1; then
    mark_pass "compose-validate.sh passed"
  else
    mark_fail "compose-validate.sh failed" "see /tmp/vault-compose-validate.out"
    sed 's/^/      /' /tmp/vault-compose-validate.out | tail -15
  fi
else
  mark_fail "compose-validate.sh missing or not executable"
fi
echo

# (b) env file perms 600
echo "[b] secret file permissions"
if [[ -f "$ENV_FILE" ]]; then
  mode=$(perms_of "$ENV_FILE")
  if [[ "$mode" == "600" ]]; then
    mark_pass "$ENV_FILE exists (600)"
  else
    mark_fail "$ENV_FILE perms = $mode (want 600)"
  fi
else
  mark_fail "$ENV_FILE missing"
fi

# (c) admin token file perms 600
if [[ -f "$TOKEN_FILE" ]]; then
  mode=$(perms_of "$TOKEN_FILE")
  if [[ "$mode" == "600" ]]; then
    mark_pass "$TOKEN_FILE exists (600)"
  else
    mark_fail "$TOKEN_FILE perms = $mode (want 600)"
  fi
else
  mark_fail "$TOKEN_FILE missing"
fi
echo

# (d) all *.sh under scripts/ are executable
echo "[d] script executable bits"
nonexec=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ ! -x "$f" ]] && nonexec+=("$f")
done < <(find "$SCRIPTS_DIR" -type f -name '*.sh')
if [[ ${#nonexec[@]} -eq 0 ]]; then
  mark_pass "all *.sh under scripts/ are executable"
else
  mark_fail "${#nonexec[@]} script(s) not executable"
  for f in "${nonexec[@]}"; do echo "      $f"; done
fi

# (e) bash -n on every *.sh
echo
echo "[e] bash syntax check"
syntax_bad=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if ! bash -n "$f" 2>/tmp/vault-syntax-err; then
    syntax_bad+=("$f: $(cat /tmp/vault-syntax-err)")
  fi
done < <(find "$SCRIPTS_DIR" -type f -name '*.sh')
if [[ ${#syntax_bad[@]} -eq 0 ]]; then
  mark_pass "bash -n clean on all *.sh"
else
  mark_fail "${#syntax_bad[@]} script(s) failed bash -n"
  for line in "${syntax_bad[@]}"; do echo "      $line"; done
fi
echo

# (f) git remote
echo "[f] git remote"
if git -C "$VAULT_ROOT" remote -v 2>/dev/null | grep -q .; then
  remote=$(git -C "$VAULT_ROOT" remote -v | head -1 | awk '{print $1" -> "$2}')
  mark_pass "git remote set ($remote)"
else
  mark_fail "no git remote configured"
fi
echo

# (g)/(h) liveness check
echo "[g] runtime liveness"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^vault-app$'; then
  body=$(curl -fsS --max-time 5 http://127.0.0.1:8222/alive 2>/dev/null || true)
  # Vaultwarden 1.35+ returns an ISO 8601 timestamp; older versions return
  # "Vaultwarden is running!". Accept both.
  if [[ "$body" == *"Vaultwarden is running!"* ]] \
       || [[ "$body" =~ ^\"?[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]]; then
    mark_pass "http://127.0.0.1:8222/alive responded"
  else
    mark_fail "/alive did not return expected body" "got: ${body:0:80}"
  fi
else
  mark_skip "vault-app not running" "start with scripts/up.sh"
  echo "      vault containers not running — start with scripts/up.sh"
fi
echo

# (i) .gitignore covers data/, env, *.gpg
echo "[i] .gitignore coverage"
GI="$VAULT_ROOT/.gitignore"
if [[ ! -f "$GI" ]]; then
  mark_fail ".gitignore missing"
else
  missing=()
  grep -qE '^data/?$' "$GI" || missing+=("data/")
  grep -qE '^(env\.local|\.env|\.env\.\*)$' "$GI" || missing+=("env files")
  grep -qE '^\*\.gpg$' "$GI" || missing+=("*.gpg")
  if [[ ${#missing[@]} -eq 0 ]]; then
    mark_pass ".gitignore covers data/, env files, *.gpg"
  else
    mark_fail ".gitignore missing patterns: ${missing[*]}"
  fi
fi
echo

# (j) ~/backups/vault directory exists
echo "[j] backup directory"
if [[ -d "$BACKUP_DIR" ]]; then
  mark_pass "$BACKUP_DIR exists"
else
  mark_fail "$BACKUP_DIR missing"
fi
echo

# Summary
TOTAL=$((PASS + FAIL))
echo "================"
if [[ $FAIL -eq 0 ]]; then
  echo "Result: $(green "PASS") — $PASS/$TOTAL checks ok${SKIP:+ ($SKIP skipped)}"
  exit 0
else
  echo "Result: $(red "FAIL") — $FAIL failed, $PASS passed${SKIP:+ ($SKIP skipped)}"
  exit 1
fi
