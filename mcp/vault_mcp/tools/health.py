"""vault-mcp health 도구 — 컨테이너·alive·backup·디스크 + 통계."""

from __future__ import annotations

import os
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from ..core import audit
from ..core.bw import BwClient


def register(mcp) -> None:

    @mcp.tool()
    def vault_health() -> dict:
        """vault 스택 헬스 — alive · backup 신선도 · 디스크 free.

        Returns:
            {
                "ts": ISO-8601 UTC,
                "status": "ok" | "degraded" | "down",
                "checks": {alive, backup_fresh, disk_free, mcp_session},
                "summary": str,
            }
        """
        checks: dict[str, str] = {}

        # 1. /alive — vault-app via container network
        try:
            r = httpx.get("http://vault-app:80/alive", timeout=5)
            if r.status_code == 200:
                checks["alive"] = "ok"
            else:
                checks["alive"] = f"degraded:http_{r.status_code}"
        except Exception as e:  # noqa: BLE001
            checks["alive"] = f"fail:{type(e).__name__}"

        # 2. backup freshness — /backups 마운트 검사
        backups = sorted(Path("/backups").glob("*.tar.gpg"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not backups:
            checks["backup_fresh"] = "fail:no_files"
        else:
            age = (datetime.now().timestamp() - backups[0].stat().st_mtime)
            if age < 26 * 3600:
                checks["backup_fresh"] = f"ok:age_{int(age)}s"
            else:
                checks["backup_fresh"] = f"fail:stale_{int(age)}s"

        # 3. disk free
        try:
            stat = os.statvfs("/backups")
            free_b = stat.f_bavail * stat.f_frsize
            if free_b > 1024 * 1024 * 1024:
                checks["disk_free"] = f"ok:free_{free_b}b"
            else:
                checks["disk_free"] = f"fail:low_{free_b}b"
        except Exception as e:  # noqa: BLE001
            checks["disk_free"] = f"fail:{type(e).__name__}"

        # 4. bw session alive
        try:
            BwClient.get().call("status", timeout=5)
            checks["mcp_session"] = "ok"
        except Exception as e:  # noqa: BLE001
            checks["mcp_session"] = f"fail:{type(e).__name__}"

        failed = [k for k, v in checks.items() if v.startswith("fail")]
        degraded = [k for k, v in checks.items() if v.startswith("degraded")]
        if failed:
            status = "down"
        elif degraded:
            status = "degraded"
        else:
            status = "ok"
        summary = ("all checks passing" if status == "ok"
                   else (f"degraded: {','.join(degraded)}" if status == "degraded"
                         else f"failing: {','.join(failed)}"))

        result = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "status": status,
            "checks": checks,
            "summary": summary,
        }
        audit.emit("vault_health", ok=(status == "ok"), result_summary=status)
        return result

    @mcp.tool()
    def vault_stats() -> dict:
        """전체 통계 — items 개수, login/note/card 분포, latest revision."""
        bw = BwClient.get()
        bw.sync()
        items = bw.call_json("list", "items")
        by_type: dict[str, int] = {"login": 0, "note": 0, "card": 0, "identity": 0, "unknown": 0}
        latest_rev: str | None = None
        with_pw = 0
        with_totp = 0
        with_uri = 0
        for it in items:
            t = {1: "login", 2: "note", 3: "card", 4: "identity"}.get(it.get("type"), "unknown")
            by_type[t] += 1
            rev = it.get("revisionDate") or ""
            if latest_rev is None or rev > latest_rev:
                latest_rev = rev
            login = it.get("login") or {}
            if login.get("password"):
                with_pw += 1
            if login.get("totp"):
                with_totp += 1
            if login.get("uris"):
                with_uri += 1
        result = {
            "total": len(items),
            "by_type": by_type,
            "with_password": with_pw,
            "with_totp": with_totp,
            "with_uri": with_uri,
            "latest_revision": latest_rev,
        }
        audit.emit("vault_stats", ok=True, result_summary={"total": len(items)})
        return result
