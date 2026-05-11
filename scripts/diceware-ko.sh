#!/usr/bin/env bash
# diceware-ko.sh — Korean passphrase generator (4096-noun curated list)
# Output goes to stdout only. Generated phrases are NEVER written to disk.
# Usage: bash diceware-ko.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WL_DIR="${SCRIPT_DIR}/wordlists"
WL_FILE="${WL_DIR}/ko_nouns.txt"
WL_BUILDER="${WL_DIR}/_build_ko_nouns.py"

if [[ ! -f "${WL_FILE}" ]]; then
  if [[ -f "${WL_BUILDER}" ]]; then
    echo "[*] Building Korean noun wordlist (one-time)..." >&2
    python3 "${WL_BUILDER}" "${WL_FILE}"
  else
    echo "[!] Wordlist not found: ${WL_FILE}" >&2
    echo "    Builder also missing: ${WL_BUILDER}" >&2
    exit 1
  fi
fi

# Generate 5 phrases at 4 words and 5 phrases at 5 words.
python3 - "${WL_FILE}" <<'PY'
import math, secrets, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    words = [w.strip() for w in f if w.strip()]

n = len(words)
# Find largest power-of-two we can use cleanly
if n >= 4096:
    pool = words[:4096]
    bits_per = 12
elif n >= 2048:
    pool = words[:2048]
    bits_per = 11
else:
    print(f"[!] Wordlist only has {n} words - below minimum 2048", file=sys.stderr)
    sys.exit(1)

rng = secrets.SystemRandom()

def phrase(k):
    return "-".join(rng.choice(pool) for _ in range(k))

def crack_years(bits, gps):
    return (2 ** bits) / gps / 3.154e7

# 두 시나리오:
# - 단순 해시 (SHA-256 GPU): ~10^10 guesses/sec
# - KDF 보호 (Argon2id/PBKDF2-600k): ~10^7 guesses/sec (Bitwarden 기본)
GPS_FAST = 1e10
GPS_KDF  = 1e7

print()
print("=" * 64)
print(f" 한국어 패스프레이즈 — {len(pool)}개 단어 풀 ({bits_per} bits/word)")
print("=" * 64)
print()
print(f" [4단어] 엔트로피 {4*bits_per} bits")
print(f"   - 단순해시 10^10/s: ~{crack_years(4*bits_per, GPS_FAST):.2e} 년")
print(f"   - KDF보호  10^7 /s: ~{crack_years(4*bits_per, GPS_KDF):.2e} 년")
for i in range(1, 6):
    print(f"   ({i}) {phrase(4)}")
print()
print(f" [5단어] 엔트로피 {5*bits_per} bits")
print(f"   - 단순해시 10^10/s: ~{crack_years(5*bits_per, GPS_FAST):.2e} 년")
print(f"   - KDF보호  10^7 /s: ~{crack_years(5*bits_per, GPS_KDF):.2e} 년")
for i in range(1, 6):
    print(f"   ({i}) {phrase(5)}")
print()
print(" 권장:")
if bits_per == 12:
    print("   - 4단어 (48 bits): 단순해시 기준 약 1개월에 깨질 수 있음 — 5단어 권장.")
    print("   - 5단어 (60 bits): KDF 보호하에 약 3600년+ — 가족용으로 안전.")
else:
    print(f"   - 4단어 ({4*bits_per} bits) 수준이면 5단어 권장.")
    print(f"   - 5단어 ({5*bits_per} bits) 면 가족용으로 안전.")
print()
print(" 경고:")
print("   - 한 장면으로 시각화할 수 있는 조합을 고르세요.")
print("   - 종이에 손글씨로 2부 작성, 금고와 은행 대여금고에 분산 보관.")
print("   - 채팅, 이메일, 메모앱, 시트, 스크린샷에 절대 입력 금지.")
print("   - 외운 후 터미널 스크롤 버퍼를 지우세요. (Cmd+K)")
print()
PY
