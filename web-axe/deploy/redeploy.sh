#!/bin/bash
# web-axe 재배포 — 빌드 → gzip 사전압축 → S3 스테이징 → SSM 전개 → 컨테이너 reload.
#
# 최초 배포(2026-08-14)에서 실제로 돌린 순서를 그대로 담았다. 여기 인코딩된 두 함정
# (macOS AppleDouble, 디렉터리 mv 로 인한 bind-mount inode 고착)은 둘 다 조용히 깨지는
# 종류라 손으로 재현하면 다시 밟는다. 상세 = ../DEPLOY.md 6절.
#
# 사용법:  cd web-axe && ./deploy/redeploy.sh
# 전제:    aws 자격증명(axe-deployer) + vault 세션은 불요(이 스크립트는 비밀을 안 만짐).

set -euo pipefail

REGION=ap-northeast-2
INSTANCE=i-017843dbd97a00b3f
BUCKET=axelabs-axe-backup-offsite-6051
KEY=_deploy-staging/vault-web-axe/web-axe-deploy.tgz
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
cd "$ROOT"

echo "==> 1/6 게이트 (드리프트 + 크립토 KAT + 서버 계약)"
npm run axe-ui:check
npm test

echo "==> 2/6 빌드 (base=/ 기본값 — 2026-08-14 루트 컷오버 이후)"
rm -rf dist
npm run build
grep -q 'src="/assets/' dist/index.html || { echo "!! 자산 경로가 /assets/ 가 아니다"; exit 1; }
# 컷오버가 만든 계약: 루트에 앱, SSO 콜백은 classic 으로 넘긴다. 심이 빠지면 SSO 가 죽는다.
grep -q 'vault-classic.axelabs.ai' dist/assets/*.js || { echo "!! SSO 심이 번들에 없다"; exit 1; }
# 배포 산출물에 인라인 <script> 가 있으면 prod CSP('unsafe-inline' 없음)가 거짓이 된다.
if grep -o '<script[^>]*>' dist/index.html | grep -qv 'src='; then
  echo "!! dist/index.html 에 인라인 <script> 발견 — CSP 전제가 깨진다"; exit 1
fi

echo "==> 3/6 gzip 사전압축 (woff2 는 이미 압축돼 있어 제외, brotli 는 쓰지 않는다)"
find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.wasm' -o -name '*.html' \) \
  -exec gzip -9 -k -f {} +

echo "==> 4/6 스테이징 + tar"
STAGE=$(mktemp -d)
TGZ="$STAGE.tgz"
trap 'rm -rf "$STAGE" "$TGZ"' EXIT
mkdir -p "$STAGE/web-axe-dist" "$STAGE/web-axe-nginx"
cp -R dist/. "$STAGE/web-axe-dist/"
cp -R "$HERE/nginx/." "$STAGE/web-axe-nginx/"
find "$STAGE" -type d -exec chmod 755 {} + ; find "$STAGE" -type f -exec chmod 644 {} +
xattr -rc "$STAGE" 2>/dev/null || true
# ⚠️ COPYFILE_DISABLE 없이 tar 하면 xattr 가 ._* 로 딸려가고, conf.d/._default.conf 가
#    nginx 의 include conf.d/*.conf 에 걸려 기동이 깨진다.
COPYFILE_DISABLE=1 tar czf "$TGZ" -C "$STAGE" .
[ "$(tar tzf "$TGZ" | grep -c '\._' || true)" = "0" ] || { echo "!! AppleDouble 혼입"; exit 1; }

MANIFEST=$(cd "$STAGE/web-axe-dist" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
COUNT=$(cd "$STAGE/web-axe-dist" && find . -type f | wc -l | tr -d ' ')
SHA=$(shasum -a 256 "$TGZ" | cut -d' ' -f1)
echo "    manifest=$MANIFEST files=$COUNT tgz=$SHA"

echo "==> 5/6 S3 업로드 (SSE)"
aws s3 cp "$TGZ" "s3://$BUCKET/$KEY" --sse AES256 --region "$REGION" --only-show-errors

echo "==> 6/6 SSM 전개"
python3 - "$SHA" "$MANIFEST" "$COUNT" <<'PY'
import json, os, subprocess, sys, time
sha, manifest, count = sys.argv[1], sys.argv[2], sys.argv[3]
region, instance = "ap-northeast-2", "i-017843dbd97a00b3f"
bucket, key = "axelabs-axe-backup-offsite-6051", "_deploy-staging/vault-web-axe/web-axe-deploy.tgz"
script = f"""set -euo pipefail
TGZ=/tmp/web-axe-deploy.tgz
aws s3 cp s3://{bucket}/{key} "$TGZ" --region {region} --only-show-errors
echo "{sha}  $TGZ" | sha256sum -c -
STAGE=$(mktemp -d /tmp/web-axe-stage.XXXXXX)
tar xzf "$TGZ" -C "$STAGE"
mkdir -p /opt/axe/vault/web-axe-dist /opt/axe/vault/web-axe-nginx
# 디렉터리 자체를 mv 하면 bind mount 가 옛 inode 에 고착된다 → 내용만 교체.
rsync -a --delete "$STAGE/web-axe-dist/" /opt/axe/vault/web-axe-dist/
rsync -a --delete "$STAGE/web-axe-nginx/" /opt/axe/vault/web-axe-nginx/
chown -R root:root /opt/axe/vault/web-axe-dist /opt/axe/vault/web-axe-nginx
GOT=$(cd /opt/axe/vault/web-axe-dist && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)
[ "$GOT" = "{manifest}" ] || {{ echo "!! 매니페스트 불일치 got=$GOT"; exit 1; }}
[ "$(cd /opt/axe/vault/web-axe-dist && find . -type f | wc -l)" = "{count}" ] || {{ echo "!! 파일 수 불일치"; exit 1; }}
# conf 가 바뀌었을 수 있으니 reload. ⚠️ 서비스명 없는 compose up 은 cloudflared 를
# 재생성해 10개 네트워크를 잃게 만든다 — 절대 금지.
docker exec web-axe nginx -t
docker exec web-axe nginx -s reload
rm -rf "$STAGE" "$TGZ"
echo "OK manifest=$GOT"
"""
params = {"commands": script.split("\n")}
pf = "/tmp/.web-axe-ssm-params.json"
open(pf, "w").write(json.dumps(params))
env = dict(os.environ, AWS_PAGER="")
cid = subprocess.run(["aws", "ssm", "send-command", "--region", region,
    "--instance-ids", instance, "--document-name", "AWS-RunShellScript",
    "--parameters", "file://" + pf, "--query", "Command.CommandId", "--output", "text"],
    capture_output=True, text=True, env=env, check=True).stdout.strip()
for _ in range(100):
    time.sleep(3)
    r = subprocess.run(["aws", "ssm", "get-command-invocation", "--region", region,
        "--command-id", cid, "--instance-id", instance, "--output", "json"],
        capture_output=True, text=True, env=env)
    if r.returncode:
        continue
    inv = json.loads(r.stdout)
    if inv["Status"] in ("Success", "Failed", "Cancelled", "TimedOut"):
        print(inv.get("StandardOutputContent", ""))
        if inv["Status"] != "Success":
            print(inv.get("StandardErrorContent", ""), file=sys.stderr)
            sys.exit(f"SSM {inv['Status']}")
        break
else:
    sys.exit("SSM 폴링 타임아웃")
PY

echo "==> 검증 (공개 URL)"
curl -sSI https://vault.axelabs.ai/ | grep -iE '^(HTTP/|content-security-policy|cache-control):'
echo "-- 서버 경로 계약이 그대로인지 (하나라도 깨지면 클라이언트가 죽는다) --"
for p in /api/config /alive /css/vaultwarden.css /sso-connector.html; do
  printf '   %-28s ' "$p"
  curl -sS -o /dev/null -w '%{http_code}\n' "https://vault.axelabs.ai$p"
done
echo "완료. 스톡 볼트: https://vault-classic.axelabs.ai/"
