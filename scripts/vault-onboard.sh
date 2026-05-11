#!/usr/bin/env bash
# vault-onboard.sh — macOS Bitwarden 클라이언트 설치 + 셀프호스트 서버 URL 사전 설정
# 대상: 본인(소유자) 및 Mac을 쓰는 가족
set -euo pipefail

ENV_FILE="${HOME}/.config/vault/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} 가 없습니다. 먼저 vault 부트스트랩을 끝내세요." >&2
  exit 1
fi

# DOMAIN 값 추출 (값에 = 가 있어도 안전하게)
DOMAIN="$(grep -E '^DOMAIN=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)"

if [[ -z "${DOMAIN}" ]] || [[ "${DOMAIN}" == *"CHANGE-ME"* ]]; then
  echo "DOMAIN 이 아직 설정되지 않았습니다. Run scripts/tailscale-setup.sh first." >&2
  exit 1
fi

echo "[1/5] Bitwarden 데스크톱 앱 확인..."
if brew list --cask bitwarden >/dev/null 2>&1; then
  echo "      이미 설치되어 있습니다. 건너뜁니다."
else
  brew install --cask bitwarden
fi

echo "[2/5] Bitwarden CLI 확인..."
if brew list bitwarden-cli >/dev/null 2>&1; then
  echo "      이미 설치되어 있습니다. 건너뜁니다."
else
  brew install bitwarden-cli
fi

echo "[3/5] CLI 서버 URL 사전 설정: ${DOMAIN}"
bw config server "${DOMAIN}" >/dev/null

echo "[4/5] 브라우저 확장 페이지를 엽니다..."
open "https://chrome.google.com/webstore/detail/bitwarden-free-password-m/nngceckbapebfimnlniiiahkandclblb" || true
open "https://apps.apple.com/app/bitwarden/id1352778147" || true

echo "[5/5] 서버 URL 을 클립보드에 복사합니다."
printf "%s" "${DOMAIN}" | pbcopy

echo ""
echo "Open Bitwarden.app → 톱니바퀴 → Self-hosted → server URL already in clipboard"
