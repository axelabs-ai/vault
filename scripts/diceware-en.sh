#!/usr/bin/env bash
# diceware-en.sh — English Diceware passphrase generator (EFF long wordlist)
# Output goes to stdout only. Generated phrases are NEVER written to disk.
# Usage: bash diceware-en.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WL_DIR="${SCRIPT_DIR}/wordlists"
WL_RAW="${WL_DIR}/eff_long_raw.txt"
WL_FILE="${WL_DIR}/eff_long.txt"
WL_URL="https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt"
WL_SHA256="addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e"

mkdir -p "${WL_DIR}"

# Download once and verify SHA256 of the raw EFF file
if [[ ! -f "${WL_FILE}" ]]; then
  echo "[*] Downloading EFF long wordlist (one-time)..." >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${WL_URL}" -o "${WL_RAW}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "${WL_URL}" -O "${WL_RAW}"
  else
    echo "[!] curl or wget required" >&2
    exit 1
  fi

  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${WL_RAW}" | awk '{print $1}')"
  else
    ACTUAL="$(sha256sum "${WL_RAW}" | awk '{print $1}')"
  fi
  if [[ "${ACTUAL}" != "${WL_SHA256}" ]]; then
    echo "[!] SHA256 mismatch:" >&2
    echo "    expected ${WL_SHA256}" >&2
    echo "    actual   ${ACTUAL}" >&2
    rm -f "${WL_RAW}"
    exit 1
  fi
  echo "[*] SHA256 verified." >&2

  # Extract word column ("11111 abacus" -> "abacus")
  awk '{print $2}' "${WL_RAW}" > "${WL_FILE}"
  LINES="$(wc -l < "${WL_FILE}" | tr -d ' ')"
  if [[ "${LINES}" != "7776" ]]; then
    echo "[!] Expected 7776 words, got ${LINES}" >&2
    exit 1
  fi
fi

# Generate 5 candidate passphrases using Python secrets.SystemRandom (CSPRNG)
# Words are read from disk; passphrases live only in stdout.
python3 - "${WL_FILE}" <<'PY'
import math, secrets, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    words = [w.strip() for w in f if w.strip()]
assert len(words) == 7776, f"Expected 7776 words, got {len(words)}"

rng = secrets.SystemRandom()
N = 6  # words per phrase
bits = N * math.log2(len(words))
guesses = 2 ** bits

print()
print("=" * 64)
print(f" English Diceware — {N} words from EFF long list ({len(words)} words)")
print("=" * 64)
print()
for i in range(1, 6):
    phrase = "-".join(rng.choice(words) for _ in range(N))
    print(f"  [{i}] {phrase}")
print()
print(f" Entropy : {bits:.1f} bits  (~{guesses:.2e} guesses)")
print(f" Crack   : at 10^10 guesses/sec  -->  ~{guesses/1e10/3.154e7:.2e} years")
print()
print(" WARNING:")
print("   - Pick ONE you can visualize as a single scene/story.")
print("   - Write TWO paper copies by hand. Store separately (home safe + bank box).")
print("   - NEVER type this into chat, email, notes app, sheet, or screenshot.")
print("   - Clear your terminal scrollback after committing it to memory.")
print()
PY
