"""vault-mcp 자가 인벤토리 도구 — 등록된 도구 목록 (stream 패턴)."""

from __future__ import annotations


def register(mcp) -> None:

    @mcp.tool()
    def vault_unified_inventory() -> dict:
        """본 vault-mcp 서버 등록 도구 인벤토리.

        Returns:
            {total, tools: [...], by_prefix: {...}}
        """
        tools: dict = mcp._tool_manager._tools  # type: ignore[attr-defined]
        by_prefix: dict[str, list[str]] = {}
        for name in sorted(tools.keys()):
            parts = name.split("_", 2)
            prefix = (
                f"{parts[0]}_{parts[1]}"
                if len(parts) >= 3 and parts[0] == "vault"
                else "_other"
            )
            by_prefix.setdefault(prefix, []).append(name)
        return {
            "total": len(tools),
            "by_prefix": by_prefix,
            "tools": sorted(tools.keys()),
            "service": "vault-mcp",
            "port_default": 8772,
        }
