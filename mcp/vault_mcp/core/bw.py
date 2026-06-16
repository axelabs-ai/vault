"""Bitwarden CLI 래퍼 — 컨테이너 내부 `bw` 자식 프로세스 호출.

부팅 시 1회 `bw config server` + `bw login` + `bw unlock` 으로 BW_SESSION 토큰
획득 후 메모리에 보관. 모든 후속 호출은 `--session $BW_SESSION` 동반.

비밀번호 본문은 절대 LLM 으로 반환되지 않음 — `get_item_password` 는 정의 X.
오직 메타데이터 (name·login.username·login.uris·folderId·revisionDate) 만 노출.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

log = logging.getLogger("vault-mcp.bw")


class BwError(RuntimeError):
    pass


class BwClient:
    """싱글톤 — 부팅 시 unlock, in-memory session 보관."""

    _instance: "BwClient | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._session: str | None = None
        self._email: str | None = None
        self._password_file: str | None = None
        self._server_url: str | None = None

    # -- public ---------------------------------------------------------
    @classmethod
    def get(cls) -> "BwClient":
        """싱글톤 접근자 — 세션이 살아있으면 캐시 반환, 아니면 재-boot 시도.

        boot 실패 시 broken 인스턴스를 **캐시하지 않는다**: 다음 호출이 다시
        boot 를 시도하도록 한다. (2026-06-13 BW_SERVER_URL config drift 로
        boot 가 실패했는데 broken 싱글톤이 캐시돼 ~한 달간 모든 메타데이터
        도구가 'bw session not initialised' 로 먹통이던 사고 재발 방지. L5b.)
        """
        with cls._lock:
            inst = cls._instance
            if inst is not None and inst._session:
                return inst
            # 미부팅 또는 broken — fresh 인스턴스로 재시도. boot 실패 시 raise
            # 되고 _instance 는 갱신되지 않아 다음 호출이 다시 시도한다.
            fresh = cls()
            fresh.boot()
            cls._instance = fresh
            return fresh

    def boot(self) -> None:
        self._server_url = os.environ.get("BW_SERVER_URL", "https://vault-caddy:443")
        self._email = os.environ.get("VAULT_OWNER_EMAIL", "team@realchoice.co.kr")
        pw_file_src = os.environ.get(
            "VAULT_OWNER_PASSWORD_FILE",
            "/run/secrets/vault_master_password",
        )
        if not Path(pw_file_src).exists():
            raise BwError(
                f"VAULT_OWNER_PASSWORD_FILE not present at {pw_file_src} — "
                "compose volume mount 필요"
            )

        # Source 파일 첫 줄은 주석일 수 있음 — 첫 비주석 비공백 줄 추출 후
        # tmpfs 의 임시 파일에 저장 (bw --passwordfile 은 첫 줄을 그대로 PW 로 본다).
        pw_clean = "/tmp/.vault_mp"
        with open(pw_file_src, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped and not stripped.startswith("#"):
                    Path(pw_clean).write_text(stripped + "\n", encoding="utf-8")
                    os.chmod(pw_clean, 0o600)
                    break
            else:
                raise BwError(f"no passphrase line found in {pw_file_src}")
        self._password_file = pw_clean

        self._configure_server()
        self._login_and_unlock()
        log.info("BwClient ready — server=%s email=%s", self._server_url, self._email)

    def call(self, *args: str, timeout: int = 30) -> str:
        """bw CLI 호출 — stdout 반환 (text)."""
        if not self._session:
            raise BwError("bw session not initialised")
        cmd = ["bw", "--session", self._session, *args]
        return self._run(cmd, timeout=timeout)

    def call_json(self, *args: str, timeout: int = 30) -> Any:
        out = self.call(*args, timeout=timeout)
        return json.loads(out)

    def sync(self) -> None:
        self.call("sync")

    def health(self, *, deep: bool = False, timeout: int = 15) -> dict[str, Any]:
        """bw 세션 liveness 스냅샷 — **절대 raise 하지 않는다**.

        헬스 프로브가 분류(classification)할 수 있도록 모든 실패를 ok=False 로
        환원한다. uvicorn 이 200 을 돌려줘도 bw 세션이 죽었으면 잡아낸다.

        Returns:
            {"ok": bool, "bw_status": str, "detail": str}

            bw_status ∈ {unlocked(정상), locked, unauthenticated,
                         no_session, error, sync_failed, unknown}

            ⚠️ "detail" 은 raw bw stderr·예외 텍스트를 담을 수 있다(secret 마운트
            경로·서버 URL 등). **인증된 내부 호출 전용** — 인증 면제 경로(/healthz)에
            그대로 노출 금지. healthz 는 안전한 bw_status enum 만 싣는다.

        Args:
            deep: True 면 `bw status` 에 더해 `bw sync` 로 **서버 도달성**까지
                  검증. in-memory 세션이 unlock 상태로 남아 server URL drift 를
                  마스킹하는 경우(L5b 사고의 본질)를 포착한다.
        """
        if not self._session:
            return {"ok": False, "bw_status": "no_session",
                    "detail": "session not initialised (boot 실패 추정)"}
        try:
            out = self._run(
                ["bw", "--session", self._session, "status"],
                allow_fail=True, timeout=timeout,
            )
            st = str(json.loads(out).get("status", "unknown"))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "bw_status": "error",
                    "detail": f"{type(e).__name__}: {e}"[:200]}
        if st != "unlocked":
            return {"ok": False, "bw_status": st, "detail": f"bw status={st}"}
        if deep:
            try:
                self._run(["bw", "--session", self._session, "sync"], timeout=timeout)
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "bw_status": "sync_failed",
                        "detail": f"{type(e).__name__}: {e}"[:200]}
        return {"ok": True, "bw_status": st, "detail": "unlocked"}

    # -- internal -------------------------------------------------------
    def _configure_server(self) -> None:
        # idempotent
        self._run(["bw", "config", "server", self._server_url or ""])

    def _login_and_unlock(self) -> None:
        # check status first
        try:
            status = self._run(["bw", "status"], allow_fail=True)
        except Exception:
            status = ""
        already_logged_in = '"status":"locked"' in status or '"status":"unlocked"' in status

        if not already_logged_in:
            # bw login --passwordfile <file> --raw <email>
            self._run([
                "bw", "login",
                self._email or "",
                "--passwordfile", self._password_file or "",
                "--raw",
            ])

        # bw unlock --passwordfile <file> --raw → session token
        sess = self._run([
            "bw", "unlock",
            "--passwordfile", self._password_file or "",
            "--raw",
        ])
        self._session = sess.strip()
        if not self._session:
            raise BwError("bw unlock returned empty session")

    @staticmethod
    def _run(cmd: list[str], *, timeout: int = 60, allow_fail: bool = False) -> str:
        env = os.environ.copy()
        # accept self-signed (Caddy tls internal)
        env.setdefault("NODE_TLS_REJECT_UNAUTHORIZED", "0")
        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                env=env,
                timeout=timeout,
                check=not allow_fail,
            )
        except subprocess.CalledProcessError as e:
            log.error(
                "bw cmd failed: %s | rc=%s | stderr=%s",
                " ".join(cmd[:2]), e.returncode, (e.stderr or "")[:200],
            )
            raise BwError(f"bw failed (rc={e.returncode}): {(e.stderr or '')[:200]}") from e
        except subprocess.TimeoutExpired:
            raise BwError(f"bw timeout after {timeout}s")
        return res.stdout


# ----------- 메타데이터 변환 헬퍼 (비밀번호 stripping) ---------------------

def strip_secrets(item: dict) -> dict:
    """bw list items 한 항목 → MCP-safe 메타데이터.

    NEVER 포함: login.password, login.totp, card.code, card.number, identity.ssn,
                identity.passportNumber, fields(hidden), notes(>40 chars).
    """
    out: dict[str, Any] = {
        "id": item.get("id"),
        "name": item.get("name"),
        "type": _type_name(item.get("type")),
        "folder_id": item.get("folderId"),
        "favorite": bool(item.get("favorite")),
        "revision_date": item.get("revisionDate"),
        "creation_date": item.get("creationDate"),
    }
    login = item.get("login") or {}
    if login:
        out["username"] = login.get("username")
        uris = login.get("uris") or []
        out["uris"] = [u.get("uri") for u in uris if u.get("uri")]
        out["has_password"] = bool(login.get("password"))
        out["has_totp"] = bool(login.get("totp"))
    notes = item.get("notes")
    if notes:
        out["notes_preview"] = notes[:40] + ("..." if len(notes) > 40 else "")
    return out


def _type_name(t: int | None) -> str:
    return {1: "login", 2: "note", 3: "card", 4: "identity"}.get(t or 0, "unknown")
