#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${VAULT_ENV_FILE:-$HOME/.config/vault/.env}"
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
