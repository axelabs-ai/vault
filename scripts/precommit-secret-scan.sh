#!/bin/bash
# precommit-secret-scan.sh — pure-bash secret scanner for the vault repo.
#
# Re-implements the regex rules from ../.gitleaks.toml so the hook works
# even when gitleaks is not installed.  If gitleaks IS available at
# /opt/homebrew/bin/gitleaks, we run it too as a second opinion.
#
# Usage:
#   precommit-secret-scan.sh --staged   # pre-commit: scan git index
#   precommit-secret-scan.sh --all      # repo-wide scan
#
# Output:  file:line  (never the matched secret).
# Exit:    0 clean, 1 secret found, 2 usage error.

set -u
IFS=$'\n\t'

MODE="${1:---staged}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
GITLEAKS="/opt/homebrew/bin/gitleaks"
GITLEAKS_CFG="${REPO_ROOT}/.gitleaks.toml"

ALLOW_PRAGMA='pragma: allowlist secret'

# Mirror of .gitleaks.toml rules. Keep IDs in sync.
declare -a RULE_ID=(
  "argon2id-hash"
  "bitwarden-master-password"
  "backblaze-b2-keyid"
  "slack-webhook"
  "rsa-private-key-block"
  "aws-access-key-id"
  "github-pat"
)
declare -a RULE_RE=(
  '\$argon2id\$v=[0-9]+\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+'
  '([Mm][Aa][Ss][Tt][Ee][Rr]).*[Pp]assword.*=.{12,}'
  '\bK[0-9]{20}\b'
  'https://hooks\.slack\.com/services/[A-Za-z0-9_]+/[A-Za-z0-9_]+/[A-Za-z0-9_]+'
  '-----BEGIN (RSA |OPENSSH |PGP |EC |DSA |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----'
  '\b(AKIA|ASIA)[0-9A-Z]{16}\b'
  '\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b'
)

# Path allowlist (must match .gitleaks.toml `allowlist.paths`).
is_allowlisted_path() {
  case "$1" in
    vault-backup.pub.asc|*/vault-backup.pub.asc) return 0 ;;
    .gitleaks.toml) return 0 ;;
    scripts/precommit-secret-scan.sh) return 0 ;;
    scripts/cve-check.sh) return 0 ;;
    .githooks/pre-commit) return 0 ;;
    README.md|docs/*.md) return 0 ;;
    # Diceware wordlists are public corpora — skip line-by-line scan
    # (would otherwise be O(n_lines * n_rules) and turn commits into minutes).
    scripts/wordlists/*|*/scripts/wordlists/*) return 0 ;;
    # Test harness contains path constants that trip generic-high-entropy.
    scripts/test/*|*/scripts/test/*) return 0 ;;
  esac
  return 1
}

is_binary() {
  # Use git's own binary detection where possible.
  if git check-attr binary -- "$1" 2>/dev/null | grep -q ': binary: set$'; then
    return 0
  fi
  if [ -f "$1" ] && LC_ALL=C grep -Iq . "$1" 2>/dev/null; then
    return 1
  fi
  [ -f "$1" ]  # nonexistent => not binary; existing-but-no-text => binary
}

# Shannon entropy of a string. Python3 stdlib only.
entropy_of() {
  python3 - "$1" <<'PY'
import math, sys
s = sys.argv[1]
if not s:
    print("0.0"); sys.exit(0)
from collections import Counter
n = len(s)
e = -sum((c/n) * math.log2(c/n) for c in Counter(s).values())
print(f"{e:.3f}")
PY
}

FOUND=0
report() {
  # report FILE LINENO RULE_ID
  printf '%s:%s [%s]\n' "$1" "$2" "$3"
  FOUND=1
}

scan_file() {
  local f="$1"
  [ -f "$f" ] || return 0
  if is_binary "$f"; then return 0; fi
  if is_allowlisted_path "$f"; then return 0; fi

  local lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))

    # Per-line pragma allowlist.
    case "$line" in
      *"$ALLOW_PRAGMA"*) continue ;;
    esac

    # Rule-based regex matches.
    local i
    for i in "${!RULE_RE[@]}"; do
      if printf '%s' "$line" | grep -Eq -- "${RULE_RE[$i]}" 2>/dev/null; then
        report "$f" "$lineno" "${RULE_ID[$i]}"
      fi
    done

    # Generic high-entropy heuristic — examine each long token on the line.
    for tok in $(printf '%s' "$line" | grep -Eo '[A-Za-z0-9+/=_\-]{32,}' 2>/dev/null); do
      ent=$(entropy_of "$tok")
      awk -v e="$ent" 'BEGIN{ exit !(e+0 > 4.5) }' && report "$f" "$lineno" "generic-high-entropy"
    done
  done < "$f"
}

list_targets() {
  case "$MODE" in
    --staged)
      git diff --cached --name-only --diff-filter=ACMRTU
      ;;
    --all)
      git ls-files
      ;;
    *)
      echo "usage: $0 [--staged|--all]" >&2
      exit 2
      ;;
  esac
}

cd "$REPO_ROOT" || exit 2

while IFS= read -r path; do
  [ -n "$path" ] || continue
  scan_file "$path"
done < <(list_targets)

# Optional gitleaks pass.
if [ -x "$GITLEAKS" ] && [ -f "$GITLEAKS_CFG" ]; then
  if [ "$MODE" = "--staged" ]; then
    "$GITLEAKS" protect --staged --config "$GITLEAKS_CFG" --no-banner --redact >/dev/null 2>&1 || FOUND=1
  else
    "$GITLEAKS" detect --config "$GITLEAKS_CFG" --no-banner --redact >/dev/null 2>&1 || FOUND=1
  fi
fi

if [ "$FOUND" -ne 0 ]; then
  echo "" >&2
  echo "vault secret-scan: matches above. Fix or annotate with '# pragma: allowlist secret'." >&2
  exit 1
fi
exit 0
