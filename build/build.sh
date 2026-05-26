#!/usr/bin/env bash
# axelabs-ai/vault — patched Timshel image build orchestrator.
#
# Clones Timshel at a pinned commit, applies build/patches/*.patch, then
# invokes `docker buildx build` against the patched source tree using
# Timshel's own Dockerfile. Avoids duplicating Timshel's multi-stage build.
#
# Env vars (with defaults):
#   TIMSHEL_REPO    — https://github.com/Timshel/vaultwarden.git
#   TIMSHEL_REF     — pinned commit SHA (must match `patches/` series)
#   DB              — sqlite (only feature we use; minimizes build memory)
#   CARGO_PROFILE   — release-low (thin LTO, parallel codegen)
#   IMAGE_TAG       — full ghcr image:tag to push (CI provides this)
#   PLATFORMS       — comma-separated target platforms for buildx
#   PUSH            — "true" to push to registry, otherwise local load only
#
# CI usage (set in workflow):
#   IMAGE_TAG=ghcr.io/axelabs-ai/vault:1.34.1-6-axe.2
#   PLATFORMS=linux/amd64,linux/arm64
#   PUSH=true
#   ./build/build.sh
#
# Local usage:
#   IMAGE_TAG=axelabs-ai/vault:dev ./build/build.sh

set -euo pipefail

# ---------------- defaults ----------------
TIMSHEL_REPO="${TIMSHEL_REPO:-https://github.com/Timshel/vaultwarden.git}"
TIMSHEL_REF="${TIMSHEL_REF:-80439605b9d93973edc283e245ab841c710b1085}"
DB="${DB:-sqlite}"
CARGO_PROFILE="${CARGO_PROFILE:-release-low}"
IMAGE_TAG="${IMAGE_TAG:-axelabs-ai/vault:dev}"
PLATFORMS="${PLATFORMS:-}"
PUSH="${PUSH:-false}"

# ---------------- paths ----------------
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH_DIR="${HERE}/patches"
WORK_DIR="${WORK_DIR:-${HERE}/.work}"

echo "==> Build config"
echo "    TIMSHEL_REPO  = ${TIMSHEL_REPO}"
echo "    TIMSHEL_REF   = ${TIMSHEL_REF}"
echo "    DB            = ${DB}"
echo "    CARGO_PROFILE = ${CARGO_PROFILE}"
echo "    IMAGE_TAG     = ${IMAGE_TAG}"
echo "    PLATFORMS     = ${PLATFORMS:-<host default>}"
echo "    PUSH          = ${PUSH}"

# ---------------- fetch + patch ----------------
echo
echo "==> Preparing source at ${WORK_DIR}/timshel-vaultwarden"
rm -rf "${WORK_DIR}/timshel-vaultwarden"
mkdir -p "${WORK_DIR}"
git clone "${TIMSHEL_REPO}" "${WORK_DIR}/timshel-vaultwarden"

pushd "${WORK_DIR}/timshel-vaultwarden" >/dev/null
git checkout "${TIMSHEL_REF}"

echo
echo "==> Applying patches in ${PATCH_DIR}"
shopt -s nullglob
patches=( "${PATCH_DIR}"/*.patch )
shopt -u nullglob
if [[ ${#patches[@]} -eq 0 ]]; then
    echo "    (no patches found)"
else
    for p in "${patches[@]}"; do
        echo "    applying $(basename "$p")"
        git apply --whitespace=nowarn "$p"
    done
    git -c user.email=ci@axelabs.ai -c user.name=axe-ci commit -am "axe patches" --quiet
    echo "    diff vs ${TIMSHEL_REF}:"
    git diff --stat "${TIMSHEL_REF}" HEAD | sed 's/^/      /'
fi

# ---------------- build ----------------
echo
echo "==> docker buildx build"

BUILDX_ARGS=(
    --build-arg "DB=${DB}"
    --build-arg "CARGO_PROFILE=${CARGO_PROFILE}"
    --tag "${IMAGE_TAG}"
    --file Dockerfile
)

if [[ -n "${PLATFORMS}" ]]; then
    BUILDX_ARGS+=( --platform "${PLATFORMS}" )
fi

if [[ "${PUSH}" == "true" ]]; then
    BUILDX_ARGS+=( --push )
else
    BUILDX_ARGS+=( --load )
fi

docker buildx build "${BUILDX_ARGS[@]}" .

popd >/dev/null

echo
echo "==> Build complete: ${IMAGE_TAG}"
