"""vault-mcp admin 도구 — Vaultwarden 어드민 패널 + 업스트림 CVE."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ..core import audit


def register(mcp) -> None:

    @mcp.tool()
    def vault_releases() -> dict:
        """Vaultwarden 업스트림 최신 릴리스 + 90일 이내 HIGH/CRITICAL advisories."""
        result: dict[str, Any] = {}
        try:
            r = httpx.get(
                "https://api.github.com/repos/dani-garcia/vaultwarden/releases/latest",
                timeout=15,
            )
            r.raise_for_status()
            data = r.json()
            result["latest_tag"] = data.get("tag_name")
            result["latest_html_url"] = data.get("html_url")
            result["published_at"] = data.get("published_at")
        except Exception as e:  # noqa: BLE001
            result["latest_error"] = f"{type(e).__name__}: {e}"

        cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        try:
            r = httpx.get(
                "https://api.github.com/repos/dani-garcia/vaultwarden/security-advisories",
                timeout=15,
            )
            adv = r.json() if r.status_code == 200 else []
            high = [
                {
                    "severity": a.get("severity"),
                    "summary": a.get("summary"),
                    "html_url": a.get("html_url"),
                    "published_at": a.get("published_at"),
                }
                for a in (adv if isinstance(adv, list) else [])
                if a.get("severity") in ("high", "critical")
                and (a.get("published_at") or "") >= cutoff
            ]
            result["advisories_90d_high_or_critical"] = high
        except Exception as e:  # noqa: BLE001
            result["advisories_error"] = f"{type(e).__name__}: {e}"

        audit.emit("vault_releases", ok=True, result_summary={
            "latest_tag": result.get("latest_tag"),
            "advisory_count": len(result.get("advisories_90d_high_or_critical", []) or []),
        })
        return result

    @mcp.tool()
    def vault_admin_users() -> dict:
        """Vaultwarden /admin/users.json — vault user 인벤토리 (admin 인증 필요)."""
        admin_token = os.environ.get("VAULT_ADMIN_TOKEN_PLAINTEXT", "").strip()
        if not admin_token:
            return {"error": "VAULT_ADMIN_TOKEN_PLAINTEXT 미설정 — 본 도구 비활성화"}
        base = "http://vault-app:80"
        with httpx.Client(base_url=base, timeout=10, follow_redirects=True) as c:
            try:
                c.post("/admin", data={"token": admin_token})
                r = c.get("/admin/users.json")
                if r.status_code != 200:
                    return {"error": f"http_{r.status_code}"}
                data = r.json()
            except Exception as e:  # noqa: BLE001
                return {"error": f"{type(e).__name__}: {e}"}
        out = []
        for u in data if isinstance(data, list) else []:
            out.append({
                "email": u.get("Email") or u.get("email"),
                "name": u.get("Name") or u.get("name"),
                "id": u.get("Id") or u.get("id"),
                "created_at": u.get("CreatedAt") or u.get("createdAt"),
                "last_active": u.get("LastActive") or u.get("lastActive"),
            })
        audit.emit("vault_admin_users", ok=True, result_summary={"count": len(out)})
        return {"users": out, "count": len(out)}
