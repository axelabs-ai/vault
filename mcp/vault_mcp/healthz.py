"""경량 HTTP 헬스 엔드포인트 — bw 세션 liveness 노출 (인증 면제).

uvicorn ASGI 앱의 **최외곽**에 래핑한다. `GET /healthz`·`/livez` 만 가로채고
나머지 경로는 그대로 위임 → MCP SSE 핸드셰이크·Bearer 토큰 없이 shell 헬스
프로브(vault-health.sh / health-job.sh)가 curl 로 점검 가능.

배경(L5b, 2026-06-13): 컨테이너 liveness(restart:unless-stopped)와 Vaultwarden
/alive 헬스만으로는 vault-mcp 의 **bw 세션** 사망을 못 잡았다. bw 세션이 죽어도
uvicorn 은 200 을 반환하기 때문. 본 엔드포인트는 그 사각지대를 메운다.

노출 정보는 세션 *상태*(unlocked/locked/...) 뿐 — 토큰·비밀번호·아이템 본문은
절대 미반환. 포트는 127.0.0.1:8772 바인드 + 내부 compose 네트워크 한정이므로
인증 면제가 안전하다.

    GET /livez            → 프로세스 liveness (항상 200, uvicorn 살아있음)
    GET /healthz          → bw 세션 status 점검 (가벼움). 200 ok / 503 down
    GET /healthz?deep=1   → 추가로 `bw sync` 서버 도달성까지 검증
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

log = logging.getLogger("vault-mcp.healthz")

_PATHS = ("/healthz", "/livez")


class HealthEndpoint:
    """ASGI 미들웨어 — /healthz·/livez 직접 응답, 그 외는 위임."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") == "http" and scope.get("path") in _PATHS:
            deep = b"deep=1" in (scope.get("query_string") or b"")
            await self._respond(scope.get("path"), deep, send)
            return
        await self.app(scope, receive, send)

    async def _respond(self, path: str, deep: bool, send) -> None:
        if path == "/livez":
            payload, code = {"status": "ok", "check": "livez"}, 200
        else:
            # blocking bw 서브프로세스 → 스레드풀로 오프로드 (이벤트 루프 보호)
            loop = asyncio.get_running_loop()
            payload, code = await loop.run_in_executor(None, self._bw_health, deep)
        body = json.dumps(payload).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": body})

    @staticmethod
    def _bw_health(deep: bool) -> tuple[dict, int]:
        # 지연 import — 모듈 로드 순서/싱글톤 부작용 회피
        from .core.bw import BwClient

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        base = {"ts": ts, "check": "bw_session", "deep": deep}
        try:
            bw = BwClient.get()  # broken 싱글톤이면 여기서 자동 재-boot 시도
        except Exception as e:  # noqa: BLE001 — boot 가 여전히 실패
            # 예외 *메시지* 는 bw stderr·secret 마운트 경로(/run/secrets/...)·서버 URL 을
            # 담을 수 있다. /healthz 는 인증 면제이므로 메시지를 절대 노출하지 않고
            # 클래스명(안전)만 싣는다. 전체 원인은 컨테이너 로그(operator 전용)에서 확인.
            log.warning("healthz: BwClient boot failed — %s", type(e).__name__)
            return ({**base, "status": "down", "ok": False,
                     "bw_status": "boot_failed", "error_type": type(e).__name__}, 503)
        h = bw.health(deep=deep)
        ok = bool(h.get("ok"))
        # h["detail"] 은 raw stderr/예외 텍스트라 인증 면제 응답에 미노출.
        # 안전한 bw_status enum(unlocked/locked/no_session/sync_failed/...)만 싣는다.
        return ({**base, "status": ("ok" if ok else "down"), "ok": ok,
                 "bw_status": h.get("bw_status", "unknown")}, 200 if ok else 503)
