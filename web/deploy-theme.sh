#!/usr/bin/env bash
# ============================================================================
# deploy-theme.sh — web/user.vaultwarden.scss.hbs 를 프로덕션 웹볼트에 배포
#
#   호스트(Mac) → SSM → EC2 i-017843dbd97a00b3f (ap-northeast-2)
#     1. 로컬 사전검증 (handlebars 충돌 · SCSS 컴파일 · 마커 존재)
#     2. base64 청크 전송 → /opt/axe/data/vault/templates/scss/
#        (컨테이너 /data 바인드 마운트. 기존 파일은 .bak-<ts> 로 백업)
#     3. docker restart vaultwarden   (템플릿은 부팅 시 로드 — 수 초 다운)
#     4. Cloudflare 캐시 퍼지 (응답에 max-age=86400 + CF HIT 실측)
#     5. 검증: 마커 · /alive 200 · 로그인 페이지 200
#
#   안전망: SCSS 컴파일이 실패하면 OIDCWarden 이 load_user_scss=false 로
#   폴백 재컴파일한다(src/api/web.rs) — 볼트는 죽지 않고 테마만 빠진다.
#   그래서 "마커 없음" = 컴파일 실패 신호이며, 스크립트가 컨테이너 로그의
#   경고를 같이 떠 준다.
#
#   사용:  ./deploy-theme.sh            배포 + 검증
#          ./deploy-theme.sh --verify   배포 없이 현재 상태만 검증
# ============================================================================
set -euo pipefail

INSTANCE="i-017843dbd97a00b3f"
REGION="ap-northeast-2"
CONTAINER="vaultwarden"
DEST_DIR="/opt/axe/data/vault/templates/scss"
DEST="${DEST_DIR}/user.vaultwarden.scss.hbs"
CSS_URL="https://vault.axelabs.ai/css/vaultwarden.css"
BASE_URL="https://vault.axelabs.ai"
MARKER="axe-theme"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/user.vaultwarden.scss.hbs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m FAIL\033[0m %s\n' "$*" >&2; exit 1; }

# --- SSM 헬퍼 -------------------------------------------------------------
# SSM 다줄 명령은 개행 축약형이 아니라 python 으로 {"commands":[...]} JSON 을
# 만들어 --parameters file:// 로 넘긴다 (인용부호/개행 파손 방지).
run_ssm() {
  local params_file="$1" desc="$2" cid status
  cid="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
      --document-name AWS-RunShellScript --parameters "file://${params_file}" \
      --query 'Command.CommandId' --output text)"
  status=Pending
  for _ in $(seq 1 60); do
    sleep 3
    status="$(aws ssm get-command-invocation --region "$REGION" \
        --command-id "$cid" --instance-id "$INSTANCE" \
        --query 'Status' --output text 2>/dev/null || echo Pending)"
    case "$status" in
      Success|Failed|Cancelled|TimedOut) break ;;
    esac
  done
  SSM_OUT="$(aws ssm get-command-invocation --region "$REGION" \
      --command-id "$cid" --instance-id "$INSTANCE" \
      --query 'StandardOutputContent' --output text 2>/dev/null || true)"
  SSM_ERR="$(aws ssm get-command-invocation --region "$REGION" \
      --command-id "$cid" --instance-id "$INSTANCE" \
      --query 'StandardErrorContent' --output text 2>/dev/null || true)"
  [ "$status" = Success ] || fail "SSM ${desc} → ${status}
stdout: ${SSM_OUT}
stderr: ${SSM_ERR}"
}

# --- 검증 -----------------------------------------------------------------
verify() {
  local n=0 code css_marker
  log "검증"

  # 캐시버스터 — CF 가 URL 단위로 캐시하므로 유니크 쿼리로 origin 강제 조회.
  for n in $(seq 1 20); do
    css_marker="$(curl -fsS "${CSS_URL}?axecheck=$(date +%s)-${n}" 2>/dev/null \
                  | grep -c "$MARKER" || true)"
    [ "${css_marker:-0}" -ge 1 ] && break
    sleep 5
  done
  if [ "${css_marker:-0}" -ge 1 ]; then
    ok "CSS 마커 '${MARKER}' 발견 (origin, cache-bypass) — ${css_marker} 건"
  else
    printf '\033[1;33m  warn\033[0m 마커 미발견 — SCSS 컴파일 실패 가능. 로그 확인:\n'
    python3 - "$WORK/ssm-log.json" <<'PY'
import json,sys
json.dump({"commands":["docker logs --tail 40 vaultwarden 2>&1 | grep -iE 'scss|css|warn' | tail -20"]}, open(sys.argv[1],'w'))
PY
    run_ssm "$WORK/ssm-log.json" "log-tail" || true
    printf '%s\n' "$SSM_OUT"
    fail "마커 검증 실패"
  fi

  # 공개 캐시 경로(퍼지 반영)도 확인 — 실사용자가 받는 응답.
  css_marker="$(curl -fsS "$CSS_URL" 2>/dev/null | grep -c "$MARKER" || true)"
  if [ "${css_marker:-0}" -ge 1 ]; then
    ok "CSS 마커 — CDN 캐시 경로도 반영됨"
  else
    printf '\033[1;33m  warn\033[0m CDN 캐시에 아직 구버전 (max-age=86400). `axe cf purge %s` 재시도 필요.\n' "$CSS_URL"
  fi

  code="$(curl -fsS -o /dev/null -w '%{http_code}' "${BASE_URL}/alive" || echo 000)"
  [ "$code" = 200 ] && ok "/alive ${code}" || fail "/alive ${code}"

  # 로그인 화면은 SPA 라우트(#/login)라 서버 응답은 루트 index.html 이다.
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "${BASE_URL}/" || echo 000)"
  [ "$code" = 200 ] && ok "로그인 페이지(SPA 루트) ${code}" || fail "로그인 페이지 ${code}"
}

if [ "${1:-}" = "--verify" ]; then verify; exit 0; fi

# --- 1. 로컬 사전검증 ------------------------------------------------------
log "로컬 사전검증"
[ -f "$SRC" ] || fail "소스 없음: $SRC"
if grep -q '{{' "$SRC"; then
  fail "handlebars 충돌: 소스에 '{{' 존재 (partial 로 include 되므로 금지)"
fi
grep -q "$MARKER" "$SRC" || fail "소스에 마커 '${MARKER}' 없음"
ok "handlebars 충돌 없음 · 마커 존재"

if command -v npx >/dev/null 2>&1; then
  cp "$SRC" "$WORK/t.scss"
  if npx --yes sass@1 --no-source-map --style=compressed "$WORK/t.scss" "$WORK/t.css" >/dev/null 2>&1; then
    grep -q "$MARKER" "$WORK/t.css" \
      && ok "SCSS 컴파일 통과 ($(wc -c <"$WORK/t.css" | tr -d ' ') bytes, 마커 유지)" \
      || fail "컴파일 산출물에 마커 없음 (Compressed 가 지웠는지 확인)"
  else
    fail "SCSS 컴파일 실패 — 배포 중단"
  fi
else
  printf '\033[1;33m  warn\033[0m npx 없음 — 로컬 SCSS 컴파일 검증 생략\n'
fi

# --- 2. 전송 --------------------------------------------------------------
log "EC2 전송 → ${DEST}"
base64 < "$SRC" | tr -d '\n' > "$WORK/b64.txt"
python3 - "$WORK/b64.txt" "$WORK/ssm-put.json" "$DEST_DIR" "$DEST" <<'PY'
import json, sys
b64 = open(sys.argv[1]).read().strip()
out, dest_dir, dest = sys.argv[2], sys.argv[3], sys.argv[4]
tmp = dest + ".incoming"
cmds = [
    "set -e",
    f"mkdir -p {dest_dir}",
    f"rm -f {tmp}.b64",
]
# 4000자 청크로 append — 단일 초대형 인자로 인한 SSM/셸 한계 회피
CH = 4000
for i in range(0, len(b64), CH):
    cmds.append(f"printf '%s' '{b64[i:i+CH]}' >> {tmp}.b64")
cmds += [
    f"base64 -d {tmp}.b64 > {tmp}",
    f"rm -f {tmp}.b64",
    f"test -s {tmp}",
    # 기존 파일이 있으면 타임스탬프 백업
    f"if [ -f {dest} ]; then cp -p {dest} {dest}.bak-$(date +%Y%m%d-%H%M%S); fi",
    f"chmod 644 {tmp}",
    f"mv {tmp} {dest}",
    f"echo BYTES=$(wc -c < {dest})",
    f"echo SHA=$(sha256sum {dest} | cut -c1-16)",
]
json.dump({"commands": cmds}, open(out, "w"))
PY
run_ssm "$WORK/ssm-put.json" "put-template"
printf '%s\n' "$SSM_OUT" | sed 's/^/  /'
LOCAL_SHA="$(shasum -a 256 "$SRC" | cut -c1-16)"
printf '%s' "$SSM_OUT" | grep -q "SHA=${LOCAL_SHA}" \
  && ok "원격 sha256 일치 (${LOCAL_SHA})" \
  || fail "원격 sha256 불일치 — 전송 파손"

# --- 3. 재시작 ------------------------------------------------------------
log "docker restart ${CONTAINER} (템플릿은 부팅 시 로드)"
python3 - "$WORK/ssm-restart.json" "$CONTAINER" <<'PY'
import json, sys
out, c = sys.argv[1], sys.argv[2]
json.dump({"commands": [
    "set -e",
    f"docker restart {c}",
    "sleep 8",
    f"docker inspect -f '{{{{.State.Status}}}} {{{{.State.Health.Status}}}}' {c}",
]}, open(out, "w"))
PY
run_ssm "$WORK/ssm-restart.json" "restart"
printf '%s\n' "$SSM_OUT" | sed 's/^/  /'
ok "재시작 완료"

# --- 4. CDN 퍼지 ----------------------------------------------------------
log "Cloudflare 캐시 퍼지"
if command -v axe >/dev/null 2>&1 && axe cf purge "$CSS_URL" >/dev/null 2>&1; then
  ok "axe cf purge ${CSS_URL}"
else
  printf '\033[1;33m  warn\033[0m 퍼지 실패/불가 — CDN 이 최대 24h 구버전을 서빙할 수 있음.\n'
  printf '            수동: axe cf purge %s\n' "$CSS_URL"
fi

# --- 5. 검증 --------------------------------------------------------------
verify
log "완료"
