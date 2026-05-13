"""vault-mcp — Vaultwarden 메타데이터·CRUD MCP 통합 서버.

단일 FastMCP 인스턴스 `mcp` 에 도구 등록. prefix `vault_*`.

운영 env:
    VAULT_MCP_TRANSPORT=stdio|sse        (default sse)
    VAULT_MCP_HTTP_HOST=0.0.0.0          (sse only)
    VAULT_MCP_HTTP_PORT=8772
    VAULT_MCP_AUTH_TOKEN=<bearer>        (raw ASGI middleware)
    VAULT_OWNER_EMAIL=team@realchoice.co.kr
    VAULT_OWNER_PASSWORD_FILE=/run/secrets/vault_master_password  # pragma: allowlist secret
    BW_SERVER_URL=http://vault-app:80
    VAULT_LOG_DIR=/app/logs
    VAULT_ADMIN_TOKEN_PLAINTEXT=<optional, /admin/users.json 도구 활성>
"""

from __future__ import annotations

import logging
import os
import sys

from mcp.server.fastmcp import FastMCP


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("vault-mcp")


_HTTP_HOST = os.environ.get("VAULT_MCP_HTTP_HOST", "0.0.0.0")
try:
    _HTTP_PORT = int(os.environ.get("VAULT_MCP_HTTP_PORT", "8772"))
except ValueError:
    _HTTP_PORT = 8772
_TRANSPORT = os.environ.get("VAULT_MCP_TRANSPORT", "sse").lower()

mcp = FastMCP("vault", host=_HTTP_HOST, port=_HTTP_PORT)


def _register_all() -> None:
    from .tools import admin, health, inventory, items

    for name, mod in (
        ("health", health),
        ("items", items),
        ("admin", admin),
        ("inventory", inventory),
    ):
        try:
            mod.register(mcp)
            print(f"[vault-mcp] registered {name}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[vault-mcp] FAILED {name}: {e!r}", file=sys.stderr)

    total = len(mcp._tool_manager._tools)  # type: ignore[attr-defined]
    print(f"[vault-mcp] total tools: {total}", file=sys.stderr)


_register_all()


def _run_sse_with_auth() -> None:
    """SSE + Bearer ASGI middleware — nemotron 패턴."""
    import uvicorn

    from .auth import BearerAuthMiddleware, get_token

    token = get_token()
    if not token:
        log.warning(
            "VAULT_MCP_AUTH_TOKEN 미설정 — 인증 OFF. 외부 노출 시 반드시 설정"
        )
    else:
        log.info("Bearer token 인증 ON (%d chars)", len(token))

    inner_app = mcp.sse_app()
    app = BearerAuthMiddleware(inner_app, token=token)
    log.info("listening on http://%s:%d (transport=sse)", _HTTP_HOST, _HTTP_PORT)
    uvicorn.run(app, host=_HTTP_HOST, port=_HTTP_PORT, log_level="info")


def main() -> None:
    if _TRANSPORT == "sse":
        _run_sse_with_auth()
    elif _TRANSPORT == "stdio":
        mcp.run(transport="stdio")
    else:
        raise SystemExit(
            f"unsupported VAULT_MCP_TRANSPORT={_TRANSPORT!r} — expected 'stdio' or 'sse'"
        )


if __name__ == "__main__":
    main()
