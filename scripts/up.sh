#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 기본값은 compose 기본값(./env.local)과 일치시킨다. 과거 $HOME/.config/vault/.env
# 를 가리켰으나 그 파일의 DOMAIN 에 /vault 서브패스가 누락(stale)돼, up.sh 로 띄우면
# vault-app 이 잘못된 DOMAIN 으로 재생성되며 /vault/alive 404 → unhealthy 가 됐다
# (2026-06-15 L5b 에서 실제 발생). ./env.local 이 /vault DOMAIN 을 가진 SoT.
ENV_FILE="${VAULT_ENV_FILE:-./env.local}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[vault] env file not found: $ENV_FILE" >&2
  exit 1
fi

# Only the env_file path is interpolated by compose.
# Container env (ADMIN_TOKEN etc.) is injected via service-level env_file
# directive — compose does NOT interpolate its contents.
export VAULT_ENV_FILE="$ENV_FILE"
docker compose up -d
echo "[vault] up. tail logs: docker logs -f vault-app"
