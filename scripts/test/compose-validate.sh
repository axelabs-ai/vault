#!/bin/bash
# compose-validate.sh — static validation of compose.yaml
# Verifies env interpolation, pinned image tag, memory limit.
# Exits 0 only when every check passes.

set -uo pipefail

VAULT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="$VAULT_ROOT/compose.yaml"
ENV_FILE_DEFAULT="$HOME/.config/vault/.env"
export VAULT_ENV_FILE="${VAULT_ENV_FILE:-$ENV_FILE_DEFAULT}"

PASS=0
FAIL=0

red()   { printf '\033[31m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }

check() {
  local name="$1"; local status="$2"; local detail="${3:-}"
  if [[ "$status" == "PASS" ]]; then
    echo "  [$(green PASS)] $name${detail:+ — $detail}"
    PASS=$((PASS + 1))
  else
    echo "  [$(red FAIL)] $name${detail:+ — $detail}"
    FAIL=$((FAIL + 1))
  fi
}

echo "compose-validate.sh"
echo "  file: $COMPOSE_FILE"
echo "  env : $VAULT_ENV_FILE"
echo

# 1) compose config quiet — no warnings about unset variables
if [[ ! -f "$VAULT_ENV_FILE" ]]; then
  check "env file exists" FAIL "$VAULT_ENV_FILE missing"
else
  check "env file exists" PASS
fi

CONFIG_OUT=$(docker compose -f "$COMPOSE_FILE" config --quiet 2>&1)
CONFIG_RC=$?
if [[ $CONFIG_RC -eq 0 && -z "$CONFIG_OUT" ]]; then
  check "compose config --quiet" PASS
else
  # Some docker compose versions print to stderr even on success; check for WARN
  if [[ $CONFIG_RC -eq 0 ]]; then
    if echo "$CONFIG_OUT" | grep -qiE "warn|unset|not set"; then
      check "compose config --quiet" FAIL "warnings present"
      echo "    $CONFIG_OUT" | head -5
    else
      check "compose config --quiet" PASS "(silent rc=0)"
    fi
  else
    check "compose config --quiet" FAIL "rc=$CONFIG_RC"
    echo "$CONFIG_OUT" | head -5 | sed 's/^/    /'
  fi
fi

# 2) No "variable is not set" warnings (re-run without --quiet to catch warnings)
FULL_OUT=$(docker compose -f "$COMPOSE_FILE" config 2>&1 >/dev/null)
if echo "$FULL_OUT" | grep -qiE "variable is not set|warn"; then
  check "no unset variable warnings" FAIL
  echo "$FULL_OUT" | grep -iE "variable is not set|warn" | head -3 | sed 's/^/    /'
else
  check "no unset variable warnings" PASS
fi

# 3) Image tag pinned (not "latest", not missing)
RESOLVED=$(docker compose -f "$COMPOSE_FILE" config 2>/dev/null || true)
IMAGES=$(echo "$RESOLVED" | grep -E '^\s*image:' | awk '{print $2}')
if [[ -z "$IMAGES" ]]; then
  check "image tag present" FAIL "no images found"
else
  BAD_TAG=0
  while IFS= read -r img; do
    [[ -z "$img" ]] && continue
    tag="${img##*:}"
    if [[ "$img" != *:* || "$tag" == "latest" ]]; then
      check "image $img pinned" FAIL "uses 'latest' or no tag"
      BAD_TAG=1
    fi
  done <<<"$IMAGES"
  if [[ $BAD_TAG -eq 0 ]]; then
    pinned_list=$(echo "$IMAGES" | tr '\n' ' ')
    check "image tags pinned" PASS "$pinned_list"
  fi
fi

# 4) Memory limit present on vaultwarden service.
# docker compose renders the value either as "512M" or quoted bytes ("536870912"),
# so we accept any non-empty value after `memory:`.
if echo "$RESOLVED" | grep -A 30 'vaultwarden:' | grep -qE 'memory:[[:space:]]*"?[0-9]'; then
  MEM=$(echo "$RESOLVED" | grep -E 'memory:' | head -1 | awk '{print $2}' | tr -d '"')
  check "memory limit present" PASS "$MEM bytes"
else
  check "memory limit present" FAIL "no memory: directive under deploy.resources.limits"
fi

echo
TOTAL=$((PASS + FAIL))
if [[ $FAIL -eq 0 ]]; then
  echo "Summary: $(green "$PASS/$TOTAL PASS")"
  exit 0
else
  echo "Summary: $(red "$FAIL/$TOTAL FAIL"), $PASS pass"
  exit 1
fi
