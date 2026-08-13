#!/usr/bin/env bash
# ============================================================================
# deploy-theme.sh — web/user.vaultwarden.scss.hbs 를 프로덕션 웹볼트에 배포
#
#   호스트(Mac) → SSM → EC2 i-017843dbd97a00b3f (ap-northeast-2)
#     1. 로컬 사전검증 (handlebars 충돌 · 마커/placeholder 존재)
#     2. rev 스탬프 후 base64 청크 전송 → /opt/axe/data/vault/templates/scss/
#        (컨테이너 /data 바인드 마운트. 기존 파일은 .bak-<ts> 로 백업)
#     3. docker restart vaultwarden   (템플릿은 부팅 시 로드 — 수 초 다운)
#     4. Cloudflare 캐시 퍼지 (응답에 max-age=86400 + CF HIT 실측)
#     5. 검증: rev 스탬프 · /alive 200 · 로그인 페이지 200
#
#   ── 검증 설계 (왜 이 두 가지인가) ────────────────────────────────────────
#   · **로컬 SCSS 컴파일을 하지 않는다.** 컴파일 주체는 서버의 grass 이고,
#     실패하면 OIDCWarden 이 load_user_scss=false 로 폴백 재컴파일한다
#     (src/api/web.rs) — 볼트는 죽지 않고 테마만 빠진다. 그 실패는 아래 rev
#     검증이 그대로 잡는다(스탬프가 응답에 없음 = 우리 SCSS 가 안 실림).
#     즉 로컬 sass 는 같은 사실을 다른 컴파일러로 한 번 더 추측하는 것뿐이라,
#     배포 스크립트에 npm 공급망을 끌어들일 이유가 없다. AWS·Cloudflare
#     자격이 살아 있는 프로세스에서 임의 배포판을 받아 실행하는 표면 제거.
#   · **rev 스탬프로 검증한다.** 상수 마커(`--axe-theme`)는 구버전 응답도
#     통과시킨다(캐시 퍼지 실패·구 템플릿 잔존을 성공으로 오보). 그래서 업로드
#     직전 소스 sha256 앞 8자를 `--axe-theme-rev` 에 박고, origin(캐시버스터)과
#     공개 CDN 응답 양쪽에서 **그 값 그대로**를 요구한다.
#
#   사용:  ./deploy-theme.sh            배포 + 검증
#          ./deploy-theme.sh --verify   배포 없이 현재 상태만 검증
#
#   종료코드: 0 = 성공(origin·CDN 둘 다 이번 rev)
#             1 = 실패(전송·재시작·origin rev·헬스체크)
#             3 = 부분성공 — origin 은 반영됐으나 공개 CDN 이 여전히 구버전.
#                 실사용자는 아직 구 CSS 를 받는다 → 퍼지 후 --verify 재확인.
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

PLACEHOLDER="__AXE_THEME_REV__"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/user.vaultwarden.scss.hbs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 이 배포의 리비전. placeholder 를 품은 **소스** 기준이라 --verify 단독 실행도
# 같은 값을 얻는다(스탬프된 업로드본을 기준으로 삼으면 재현이 안 된다).
[ -f "$SRC" ] || { printf '\033[1;31m FAIL\033[0m 소스 없음: %s\n' "$SRC" >&2; exit 1; }
REV="$(shasum -a 256 "$SRC" | cut -c1-8)"

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
  log "검증 (rev ${REV})"

  # 이번 배포의 rev 를 요구한다 — 상수 마커였다면 구버전 응답도 통과한다.
  # grass Compressed 가 `: ` 를 접을 수 있어 공백은 선택으로 둔다.
  local rev_re="--axe-theme-rev: *\"?${REV}\"?"

  # 캐시버스터 — CF 가 URL 단위로 캐시하므로 유니크 쿼리로 origin 강제 조회.
  for n in $(seq 1 20); do
    css_marker="$(curl -fsS "${CSS_URL}?axecheck=$(date +%s)-${n}" 2>/dev/null \
                  | grep -cE -- "$rev_re" || true)"
    [ "${css_marker:-0}" -ge 1 ] && break
    sleep 5
  done
  if [ "${css_marker:-0}" -ge 1 ]; then
    ok "rev ${REV} 확인 (origin, cache-bypass)"
  else
    printf '\033[1;33m  warn\033[0m rev %s 미발견 — SCSS 가 안 실렸을 가능성(서버 grass 컴파일\n' "$REV"
    printf '            실패 시 load_user_scss=false 폴백). 컨테이너 로그:\n'
    python3 - "$WORK/ssm-log.json" <<'PY'
import json,sys
json.dump({"commands":["docker logs --tail 40 vaultwarden 2>&1 | grep -iE 'scss|css|warn' | tail -20"]}, open(sys.argv[1],'w'))
PY
    run_ssm "$WORK/ssm-log.json" "log-tail" || true
    printf '%s\n' "$SSM_OUT"
    fail "rev 검증 실패 (origin)"
  fi

  # 공개 캐시 경로(퍼지 반영)도 확인 — 실사용자가 받는 응답. 여기도 rev 정확
  # 일치를 요구해야 퍼지 실패가 성공으로 오보되지 않는다.
  local cdn_stale=1
  for n in $(seq 1 3); do
    css_marker="$(curl -fsS "$CSS_URL" 2>/dev/null | grep -cE -- "$rev_re" || true)"
    if [ "${css_marker:-0}" -ge 1 ]; then cdn_stale=0; break; fi
    # `[ … ] && sleep` 는 마지막 반복에서 1 을 남겨 `set -e` 가 여기서 스크립트를
    # 죽인다(아래 exit 3 에 도달 못 함). if 로 둘 것.
    if [ "$n" -lt 3 ]; then sleep 10; fi
  done
  if [ "$cdn_stale" = 0 ]; then
    ok "rev ${REV} — CDN 캐시 경로도 반영됨"
  fi

  code="$(curl -fsS -o /dev/null -w '%{http_code}' "${BASE_URL}/alive" || echo 000)"
  [ "$code" = 200 ] && ok "/alive ${code}" || fail "/alive ${code}"

  # 로그인 화면은 SPA 라우트(#/login)라 서버 응답은 루트 index.html 이다.
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "${BASE_URL}/" || echo 000)"
  [ "$code" = 200 ] && ok "로그인 페이지(SPA 루트) ${code}" || fail "로그인 페이지 ${code}"

  # 부분성공은 성공이 아니다. origin 은 새 rev 인데 실사용자는 아직 구버전을
  # 받는 상태 — 경고만 찍고 0 으로 끝내면 CI·운영자가 완료로 읽는다.
  if [ "$cdn_stale" != 0 ]; then
    printf '\033[1;31m FAIL\033[0m 부분성공(exit 3): origin 은 rev %s 인데 공개 CDN 은 3회(20초) 재시도 후에도 구버전.\n' "$REV" >&2
    printf '        배포 완료 아님 — 캐시 퍼지 후 재검증할 것: axe cf purge %s && %s --verify\n' \
           "$CSS_URL" "${BASH_SOURCE[0]}" >&2
    exit 3
  fi
}

if [ "${1:-}" = "--verify" ]; then verify; exit 0; fi

# --- 1. 로컬 사전검증 ------------------------------------------------------
log "로컬 사전검증"
[ -f "$SRC" ] || fail "소스 없음: $SRC"
if grep -q '{{' "$SRC"; then
  fail "handlebars 충돌: 소스에 '{{' 존재 (partial 로 include 되므로 금지)"
fi
grep -q "$MARKER" "$SRC" || fail "소스에 마커 '${MARKER}' 없음"
grep -q "$PLACEHOLDER" "$SRC" || fail "소스에 rev placeholder '${PLACEHOLDER}' 없음 (검증 불능)"
ok "handlebars 충돌 없음 · 마커 · rev placeholder 존재"

# 로컬 SCSS 컴파일 검증은 의도적으로 없다 — 위 헤더 "검증 설계" 참조.
# 요약: 컴파일 주체는 서버 grass 이고 실패는 rev 검증이 잡는다. 배포 자격이
# 살아 있는 프로세스에 npm 임의 배포판을 끌어들이는 대가가 그 중복 확인보다 크다.

# --- 2. rev 스탬프 + 전송 --------------------------------------------------
log "rev 스탬프 ${REV} → 전송 → ${DEST}"
UPLOAD="$WORK/stamped.scss.hbs"
sed "s/${PLACEHOLDER}/${REV}/g" "$SRC" > "$UPLOAD"
grep -q "$REV" "$UPLOAD" || fail "rev 스탬프 실패 (${PLACEHOLDER} 치환 안 됨)"
base64 < "$UPLOAD" | tr -d '\n' > "$WORK/b64.txt"
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
# 전송 무결성은 **업로드본**(스탬프 후) 기준이다. 소스 기준으로 비교하면 항상 어긋난다.
LOCAL_SHA="$(shasum -a 256 "$UPLOAD" | cut -c1-16)"
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
