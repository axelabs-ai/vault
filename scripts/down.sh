#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${VAULT_ENV_FILE:-$HOME/.config/vault/.env}"
export VAULT_ENV_FILE="$ENV_FILE"
docker compose down
echo "[vault] down."
