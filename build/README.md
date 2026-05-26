# build/ — patched Timshel image pipeline

이 디렉터리는 `axelabs-ai/vault` 컨테이너 이미지를 생성합니다.
모든 tenant (realchoice·axe·미래 고객)가 동일한 이미지를 ghcr에서 pull.

## 구성

```
build/
├── build.sh             # 클론 + 패치 + buildx 빌드 오케스트레이션
├── Dockerfile           # placeholder (실제 빌드는 Timshel 자체 Dockerfile 사용)
├── patches/             # *.patch — Timshel 위에 순차 적용
│   ├── 0001-axe-alias-accounts-prelogin-password-to-accounts-pre.patch   # axe.2
│   ├── 0002-axe-backport-AccountKeys-MasterPasswordUnlock-to-tok.patch  # axe.2
│   ├── 0003-axe-remove-access_all-skip-on-collection-user-save-3.patch  # axe.3
│   └── 0004-axe-backport-cipher.permissions-field-to-to_json-del.patch  # axe.3
└── README.md            # 본 문서
```

빌드 흐름:

1. Timshel upstream을 `TIMSHEL_REF` (고정 commit) 으로 clone
2. `patches/*.patch`를 순서대로 `git apply`
3. 패치된 Timshel 소스에서 `docker buildx build` (Timshel 본인의 `Dockerfile.debian` 사용)
4. `ghcr.io/axelabs-ai/vault:<tag>` 로 푸시

## CI (GitHub Actions)

`.github/workflows/build.yml` 가 트리거:
- `main` push (build/ 변경 시): rolling tag `main-<sha7>` 푸시
- `workflow_dispatch`: 임의 태그 (예 `1.34.1-6-axe.2`) 푸시

빌드: ubuntu-latest + QEMU 로 arm64 cross-compile, linux/amd64 + linux/arm64 multi-arch 이미지.

## 로컬 빌드 (테스트용)

```sh
cd ~/vault
IMAGE_TAG=axelabs-ai/vault:dev ./build/build.sh
```

기본값: linux/<host_arch> 빌드 후 로컬 docker 데몬에 load.

## 패치 추가 절차

새 backport·fix 필요 시:

```sh
# 1. 우리 fork에서 패치 작성
cd ~/vault/.fork/timshel-vaultwarden  # 또는 새로 clone
git checkout 80439605b9d93973edc283e245ab841c710b1085
git checkout -b axe/new-fix
# ... 코드 수정 ...
git commit -am "axe: 설명"

# 2. patch 파일로 추출
git format-patch -1 -o ~/vault/build/patches/

# 3. commit + push to axelabs-ai/vault
cd ~/vault
git add build/patches/00XX-*.patch
git commit -m "build: add patch 00XX (설명)"
git push

# 4. GHA가 자동 빌드 → ghcr 푸시
# 5. workflow_dispatch로 정식 태그 (1.34.1-6-axe.3 등) 발행
# 6. tenant compose.yaml 의 image: 라인 업데이트
```

## Timshel upstream 추적

새 Timshel release 나오면:

```sh
# 1. TIMSHEL_REF를 새 commit SHA로 업데이트
# 2. 패치가 새 base에 깨끗하게 적용되는지 dry-run
WORK_DIR=/tmp/timshel-rebase ./build/build.sh
# 3. 충돌 시 패치 수정 또는 새 base에 맞게 재작성
# 4. 성공 시 commit + push
```

## Tenant 측 운영

각 tenant macmini의 `~/vault/compose.yaml`:

```yaml
services:
  vaultwarden:
    image: ghcr.io/axelabs-ai/vault:1.34.1-6-axe.2
    ...
```

private 레지스트리 인증:

```sh
# ghcr.io read:packages 권한 PAT 발급 (https://github.com/settings/tokens)
echo $GHCR_PAT | docker login ghcr.io -u <github_user> --password-stdin
```

업데이트:

```sh
cd ~/vault
docker compose pull vaultwarden
docker compose up -d vaultwarden
```
