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
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
                cls._instance.boot()
            return cls._instance

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
