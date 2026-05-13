# vault-mcp — Vaultwarden 메타데이터·CRUD MCP (라운드 11, 2026-05-13)
#
# 부트스트랩 §1.2·§8.1 에서 vault MCP 미노출을 명시적으로 결정했으나, 운영
# 통일성 요구로 본 MCP 가 그 결정을 우회. 단 보안 가드:
#   - 비밀번호 본문 절대 미반환 (bw get password 미노출)
#   - 메타데이터만 read 도구로 노출 (name, uri, folder, revisionDate)
#   - 생성 도구는 강한 랜덤 자동 발급 + id 만 반환 (사람이 Bitwarden 앱으로 조회)
#   - 전 호출 audit log
#   - Bearer 토큰 인증 (raw ASGI middleware)
#
# stream/nemotron 패턴 답습 — python:3.12-slim + FastMCP + bitwarden-cli.

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        locales \
        unzip \
    && rm -rf /var/lib/apt/lists/*

RUN sed -i '/ko_KR.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    && echo "LANG=ko_KR.UTF-8" > /etc/default/locale
ENV LANG=ko_KR.UTF-8 \
    LC_ALL=ko_KR.UTF-8 \
    TZ=Asia/Seoul

# --- bitwarden-cli (alpine 위에선 native, debian 에선 zip 받기) -----------
ARG BW_VERSION=2026.4.1
RUN ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
        amd64) BW_ARCH="linux";; \
        arm64) BW_ARCH="linux-arm64";; \
        *) echo "unsupported arch: $ARCH" >&2; exit 1;; \
    esac; \
    curl -fsSL "https://github.com/bitwarden/clients/releases/download/cli-v${BW_VERSION}/bw-${BW_ARCH}-${BW_VERSION}.zip" \
        -o /tmp/bw.zip && \
    unzip -q /tmp/bw.zip -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/bw && \
    rm /tmp/bw.zip && \
    /usr/local/bin/bw --version

# --- python deps ---------------------------------------------------------
WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# --- source -------------------------------------------------------------
COPY vault_mcp/ /app/vault_mcp/
COPY pyproject.toml /app/

RUN pip install --no-cache-dir -e .

RUN mkdir -p /app/logs /app/data && chmod -R 755 /app

# --- runtime env --------------------------------------------------------
ENV VAULT_MCP_TRANSPORT=sse \
    VAULT_MCP_HTTP_HOST=0.0.0.0 \
    VAULT_MCP_HTTP_PORT=8772 \
    BW_SERVER_URL=http://vault-app:80 \
    NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 8772

CMD ["python", "-m", "vault_mcp.server"]
