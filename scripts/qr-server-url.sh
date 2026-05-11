#!/usr/bin/env bash
# qr-server-url.sh — 모바일(iOS/Android) 온보딩용 서버 URL QR 코드 생성
set -euo pipefail

ENV_FILE="${HOME}/.config/vault/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} 가 없습니다." >&2
  exit 1
fi

DOMAIN="$(grep -E '^DOMAIN=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)"

if [[ -z "${DOMAIN}" ]] || [[ "${DOMAIN}" == *"CHANGE-ME"* ]]; then
  echo "DOMAIN 이 아직 설정되지 않았습니다. Run scripts/tailscale-setup.sh first." >&2
  exit 1
fi

echo "서버 URL: ${DOMAIN}"
echo ""

if ! command -v qrencode >/dev/null 2>&1; then
  echo "qrencode 가 설치되어 있지 않습니다."
  echo "설치하려면:  brew install qrencode"
  echo "(설치 후 다시 이 스크립트를 실행하세요.)"
  exit 0
fi

OUT="/tmp/vault-server-url.png"
qrencode -o "${OUT}" -s 10 -m 4 -- "${DOMAIN}"

echo "QR 코드를 만들었습니다: ${OUT}"
echo "가족분 휴대폰 카메라로 화면을 스캔 → 텍스트로 인식된 URL 을 복사 →"
echo "  Bitwarden 앱 로그인 화면 → 톱니바퀴 → Self-hosted → Server URL 에 붙여넣기"
open "${OUT}"
