"""Bearer 토큰 인증 — raw ASGI middleware (SSE streaming 호환).

`BaseHTTPMiddleware`는 응답 body 를 buffer 해서 SSE EventSource 와 호환 안 됨.
본 모듈은 raw ASGI `__call__` 패턴 — nemotron-personas/server/auth.py 답습.

토큰 env: `VAULT_MCP_AUTH_TOKEN`. 미설정 시 인증 비활성화 + 경고.
"""

from __future__ import annotations

import json
import logging
import os
import secrets

log = logging.getLogger("vault-mcp.auth")


class BearerAuthMiddleware:
    """ASGI middleware — request 진입 시 인증, 통과 시 그대로 위임."""

    def __init__(self, app, *, token: str | None) -> None:
        self.app = app
        self._token = token

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or self._token is None:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        auth_raw = headers.get(b"authorization", b"")
        auth = auth_raw.decode("latin-1", errors="ignore")

        if not auth.lower().startswith("bearer "):
            await self._send_error(send, 401, "missing Authorization: Bearer <token>")
            return
        provided = auth[7:].strip()
        if not secrets.compare_digest(provided, self._token):
            await self._send_error(send, 403, "invalid token")
            return

        await self.app(scope, receive, send)

    @staticmethod
    async def _send_error(send, status: int, msg: str) -> None:
        body = json.dumps({"error": msg}).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": body})


def get_token() -> str | None:
    tok = os.environ.get("VAULT_MCP_AUTH_TOKEN", "").strip()
    return tok or None
