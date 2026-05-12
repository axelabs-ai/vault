#!/bin/bash
# vault 셋업 마무리 — 단일 실행 스크립트
#
# 자동 처리:
#   1. Tailscale SSO 대기 (URL을 사용자에게 띄움)
#   2. tailscale serve 설정 + DOMAIN 갱신
#   3. vault 컨테이너 재기동 (새 DOMAIN 반영)
#   4. 본인 signup 폴링 (admin API)
#   5. SIGNUPS_ALLOWED=false flip + 재기동
#   6. 평문 파일 폐기 안내
#
# 사용자 행위 (2번):
#   A. 브라우저에서 Tailscale SSO 클릭
#   B. 브라우저에서 Vaultwarden 가입 폼 작성

set -uo pipefail

VAULT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HOME/.config/vault/.env"
MP_FILE="$HOME/.config/vault/MASTER_PASSWORD_INITIAL"  # pragma: allowlist secret
ADMIN_TOKEN_FILE="$HOME/.config/vault/ADMIN_TOKEN_PLAINTEXT"  # pragma: allowlist secret
TS_SOCKET="$HOME/Library/Application Support/Tailscale/tailscaled.sock"
TS_UP_LOG="/tmp/vault-tsup.log"

# colors
g() { printf '\033[32m%s\033[0m' "$*"; }
y() { printf '\033[33m%s\033[0m' "$*"; }
r() { printf '\033[31m%s\033[0m' "$*"; }
b() { printf '\033[1m%s\033[0m'  "$*"; }

step() { echo; echo "$(b "▶  $*")"; }
say()  { echo "    $*"; }
ok()   { echo "    $(g "✓") $*"; }
warn() { echo "    $(y "!") $*"; }
fail() { echo "    $(r "✗") $*"; exit 1; }

# ----- step 1: Tailscale ----------------------------------------------------

step "1/5 — Tailscale 가입·로그인"

if ! command -v tailscale >/dev/null 2>&1; then
  fail "tailscale CLI not found. Install: brew install tailscale"
fi

# Ensure daemon socket exists (com.realchoice.tailscaled LaunchAgent should provide it)
if [[ ! -S "$TS_SOCKET" ]]; then
  warn "tailscaled socket not present at $TS_SOCKET"
  warn "Loading LaunchAgent..."
  cp "$VAULT_ROOT/scripts/com.realchoice.tailscaled.plist" "$HOME/Library/LaunchAgents/" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.realchoice.tailscaled.plist" 2>/dev/null || true
  sleep 3
fi

ts() { tailscale --socket="$TS_SOCKET" "$@"; }

STATE=$(ts status 2>&1 || true)
if echo "$STATE" | grep -q "Logged out"; then
  say "현재 상태: Logged out"
  say "Tailscale SSO를 시작합니다 — 브라우저에서 로그인하세요."
  rm -f "$TS_UP_LOG"
  nohup tailscale --socket="$TS_SOCKET" up --reset >"$TS_UP_LOG" 2>&1 &
  TSUP_PID=$!
  # wait for the URL line
  for _ in $(seq 1 20); do
    sleep 1
    if grep -q "https://login.tailscale.com" "$TS_UP_LOG" 2>/dev/null; then break; fi
  done
  URL=$(grep -Eo 'https://login\.tailscale\.com[^ ]+' "$TS_UP_LOG" | head -1)
  if [[ -z "$URL" ]]; then
    fail "Tailscale 로그인 URL을 얻지 못함. 수동 실행: tailscale --socket=\"$TS_SOCKET\" up"
  fi
  echo
  echo "    $(b "👉 브라우저에서 이 주소를 열고 SSO 완료하세요:")"
  echo "    $(b "    $URL")"
  echo
  open "$URL" 2>/dev/null || true
  say "로그인 대기 중... (최대 5분)"
  for i in $(seq 1 60); do
    sleep 5
    if ts status >/dev/null 2>&1 && ! ts status 2>&1 | grep -q "Logged out"; then
      ok "Tailscale 로그인 성공"
      break
    fi
    if [[ $i -eq 60 ]]; then
      fail "5분 안에 SSO 완료되지 않음. 다시 실행하세요: $0"
    fi
  done
  wait "$TSUP_PID" 2>/dev/null || true
elif echo "$STATE" | grep -q "100\."; then
  ok "이미 로그인됨"
else
  warn "예상 못 한 상태: $(echo "$STATE" | head -2)"
fi

# Derive DOMAIN from tailscale status --json (Self.DNSName)
DNS_NAME=$(ts status --json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    name = d.get('Self', {}).get('DNSName', '').rstrip('.')
    print(name)
except Exception as e:
    print('')
" || echo "")
if [[ -z "$DNS_NAME" ]]; then
  fail "MagicDNS 이름을 얻지 못함. tailscale admin console에서 MagicDNS 켜져 있는지 확인."
fi
DOMAIN_URL="https://${DNS_NAME}"
ok "DOMAIN = $DOMAIN_URL"

# ----- step 2: tailscale serve ----------------------------------------------

step "2/5 — Tailscale Serve 활성화"

ts serve reset 2>/dev/null || true
if ts serve --bg --https=443 / http://127.0.0.1:8222 2>&1 | grep -qiE "error|fail"; then
  warn "tailscale serve 명령에서 경고 — 수동 확인 필요"
  ts serve status 2>&1 | head -10
else
  ok "tailscale serve --bg --https=443 / http://127.0.0.1:8222"
fi

# ----- step 3: DOMAIN 갱신 + 재기동 -----------------------------------------

step "3/5 — DOMAIN 갱신 + vault 재기동"

# Rewrite DOMAIN= line in env (preserve perms)
TMP=$(mktemp)
awk -v d="$DOMAIN_URL" '/^DOMAIN=/{print "DOMAIN=" d; next} {print}' "$ENV_FILE" > "$TMP"
mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok ".env DOMAIN 갱신됨"

"$VAULT_ROOT/scripts/down.sh" >/dev/null 2>&1 || true
"$VAULT_ROOT/scripts/up.sh"   >/dev/null
sleep 6
if curl -fsS -m 5 http://127.0.0.1:8222/alive >/dev/null; then
  ok "vault-app /alive 응답 OK (재기동 완료)"
else
  fail "/alive 응답 없음. docker logs -f vault-app 확인"
fi

# ----- step 4: 본인 signup 안내 + 대기 --------------------------------------

step "4/5 — Vaultwarden 본인 signup"

SIGNUP_URL="${DOMAIN_URL}/#/register"

if [[ -f "$MP_FILE" ]]; then
  MP=$(grep -v '^#' "$MP_FILE" | grep -v '^$' | head -1)
  echo
  echo "    $(b "👉 브라우저에서 가입하세요:")"
  echo "    $(b "    $SIGNUP_URL")"
  echo
  echo "    이메일      : $(b "truvia2025@gmail.com") (또는 본인 이메일)"
  echo "    이름        : $(b "realchoice operator")"
  echo "    Master Pwd  : $(b "$MP")"
  echo
  echo "    가입 후 Recovery Code를 $(b "종이에 손글씨 2부") 보관 → 가정 금고 + 은행."
  echo
  open "$SIGNUP_URL" 2>/dev/null || true
fi

# Poll for user creation via admin API
if [[ ! -f "$ADMIN_TOKEN_FILE" ]]; then
  warn "ADMIN_TOKEN_PLAINTEXT 없음 — signup 자동 감지 불가. 수동 확인 후 SIGNUPS_ALLOWED=false 변경."
else
  ADMIN_TOKEN=$(cat "$ADMIN_TOKEN_FILE")
  COOKIE=$(mktemp)
  trap "rm -f $COOKIE" EXIT
  say "signup 감지 폴링 중... (최대 10분, Ctrl+C로 중단 가능)"
  for i in $(seq 1 120); do
    sleep 5
    # Authenticate to admin panel (form post → session cookie)
    curl -fsS -c "$COOKIE" -X POST "http://127.0.0.1:8222/admin" \
         -d "token=${ADMIN_TOKEN}" >/dev/null 2>&1 || true
    # Pull users.json
    USERS=$(curl -fsS -b "$COOKIE" "http://127.0.0.1:8222/admin/users.json" 2>/dev/null || echo "[]")
    COUNT=$(printf '%s' "$USERS" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(len(data) if isinstance(data, list) else 0)
except: print(0)
" 2>/dev/null || echo 0)
    if [[ "$COUNT" -ge 1 ]]; then
      ok "signup 감지 — 사용자 수 = $COUNT"
      break
    fi
    if (( i % 12 == 0 )); then
      say "  ($((i / 12)) 분 대기, 0 users)"
    fi
    if [[ $i -eq 120 ]]; then
      fail "10분 안에 signup 미감지. 재실행하면 이 step부터 폴링 재개."
    fi
  done
fi

# ----- step 5: 잠금 (SIGNUPS_ALLOWED=false) + 평문 폐기 안내 -----------------

step "5/5 — 잠금 + 평문 파일 폐기"

if grep -q "^SIGNUPS_ALLOWED=true" "$ENV_FILE"; then
  TMP=$(mktemp)
  sed 's/^SIGNUPS_ALLOWED=true/SIGNUPS_ALLOWED=false/' "$ENV_FILE" > "$TMP"
  mv "$TMP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "SIGNUPS_ALLOWED=false 로 변경"
  "$VAULT_ROOT/scripts/down.sh" >/dev/null 2>&1
  "$VAULT_ROOT/scripts/up.sh"   >/dev/null
  sleep 4
  curl -fsS -m 5 http://127.0.0.1:8222/alive >/dev/null && ok "재기동 후 /alive OK"
else
  ok "이미 SIGNUPS_ALLOWED=false 상태"
fi

echo
echo "    $(b "최종 사용자 행위 (수동):")"
echo "    1. Master Password를 $(b "손글씨 종이 2부") 작성 → 가정 금고 + 은행 대여금고"
echo "    2. Recovery Code 종이 1부 → 별도 봉투 → 금고"
echo "    3. 위 2가지 완료 후 평문 파일 폐기:"
echo "         shred -u $MP_FILE"
echo "         shred -u $ADMIN_TOKEN_FILE"
echo "    4. (옵션) YubiKey 2개 등록 — Bitwarden 웹 vault → Account → 2FA → WebAuthn"
echo "    5. (옵션) Backblaze B2 가입 → ~/vault/scripts/b2-setup.sh"

step "✅ vault 셋업 마무리 완료"
echo "    web vault : $DOMAIN_URL"
echo "    localhost : http://127.0.0.1:8222 (macmini에서만)"
echo "    health    : ~/vault/scripts/vault-health.sh"
echo "    runbook   : ~/vault/docs/runbook.md"
