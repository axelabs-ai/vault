#!/usr/bin/env bash
# vault-onboard-family.sh — 가족 한 명용 환영 페이지 생성 + Mac 클라이언트 설치
set -euo pipefail

NAME="${1:-가족분}"
ENV_FILE="${HOME}/.config/vault/.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} 가 없습니다." >&2
  exit 1
fi

DOMAIN="$(grep -E '^DOMAIN=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)"

if [[ -z "${DOMAIN}" ]] || [[ "${DOMAIN}" == *"CHANGE-ME"* ]]; then
  echo "DOMAIN 이 아직 설정되지 않았습니다. Run scripts/tailscale-setup.sh first." >&2
  exit 1
fi

# 1) Mac 클라이언트 설치 + CLI 서버 URL 설정 (래퍼)
bash "${SCRIPT_DIR}/vault-onboard.sh"

# 2) 환영 페이지 HTML 생성
SAFE_NAME="$(printf "%s" "${NAME}" | tr -d '<>&"')"
SAFE_DOMAIN="$(printf "%s" "${DOMAIN}" | tr -d '<>&"')"
OUT="/tmp/vault-welcome-${SAFE_NAME}.html"

cat > "${OUT}" <<HTML
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${SAFE_NAME} 님, 비밀번호 금고에 오신 걸 환영합니다</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
         max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1d1d1f; }
  h1 { font-size: 28px; }
  h2 { font-size: 20px; margin-top: 32px; color: #0071e3; }
  .url { display: inline-block; background: #f5f5f7; padding: 10px 16px; border-radius: 8px;
         font-family: ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all; }
  ol li { margin-bottom: 16px; }
  .tip { background: #fffbe6; border-left: 4px solid #ffcc00; padding: 12px 16px; border-radius: 4px; margin: 20px 0; }
  a { color: #0071e3; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>${SAFE_NAME} 님, 환영합니다!</h1>
  <p>리얼초이스 가족 비밀번호 금고(Bitwarden 셀프호스트)에 접속하시는 방법을 안내드립니다.</p>

  <h2>서버 주소</h2>
  <p><a class="url" href="${SAFE_DOMAIN}" target="_blank">${SAFE_DOMAIN}</a></p>
  <p class="tip">이 주소는 Tailscale 네트워크 안에서만 열립니다. Tailscale 에 먼저 로그인해야 보입니다.</p>

  <h2>다음 4단계만 하시면 끝납니다</h2>
  <ol>
    <li>
      <strong>1. Tailscale 설치 + SSO 로그인</strong><br>
      App Store / Play 스토어에서 <em>Tailscale</em> 검색 → 설치 → Google 계정으로 로그인.
      (관리자가 미리 가족 계정으로 초대장을 보냈을 거예요.)
    </li>
    <li>
      <strong>2. Bitwarden 앱 설치</strong><br>
      App Store / Play 스토어에서 <em>Bitwarden</em> 검색 → 설치.
      Mac 이라면 이 스크립트가 이미 설치해 드렸습니다.
    </li>
    <li>
      <strong>3. 서버 URL 입력</strong><br>
      Bitwarden 앱을 열고 로그인 화면에서 <strong>톱니바퀴(설정)</strong> 아이콘 →
      <strong>Self-hosted</strong> → <strong>Server URL</strong> 에 위 서버 주소를 붙여넣기.
      <br>
      <span class="tip">Mac 에서는 이미 클립보드에 복사돼 있어요. ⌘+V 만 하시면 됩니다.</span>
    </li>
    <li>
      <strong>4. 자동완성 켜기</strong><br>
      iOS: 설정 → 일반 → 자동완성 → Bitwarden 켜기.<br>
      Android: 설정 → 시스템 → 언어 및 입력 → 자동완성 → Bitwarden 선택.<br>
      Mac/Chrome: 확장프로그램 설치 후 자동완성 자동 활성화.
    </li>
  </ol>

  <h2>문제가 생기면</h2>
  <p>관리자(소유자)에게 문자/카카오톡으로 연락주세요. 비밀번호나 마스터 패스워드는 절대 메시지로 보내지 마세요.</p>
</body>
</html>
HTML

echo ""
echo "환영 페이지를 만들었습니다: ${OUT}"
open "${OUT}"
