"""감사 로그 — 모든 vault-mcp 도구 호출을 JSONL 로 append.

위치: /app/logs/vault-mcp-audit.jsonl
공통 schema: {ts, tool, args_summary, result_summary, ok}
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOG_DIR = Path(os.environ.get("VAULT_LOG_DIR", "/app/logs"))
AUDIT_FILE = LOG_DIR / "vault-mcp-audit.jsonl"
_lock = threading.Lock()
log = logging.getLogger("vault-mcp.audit")


def emit(tool: str, ok: bool, *, args_summary: dict | None = None, result_summary: Any = None) -> None:
    line = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tool": tool,
        "ok": ok,
        "args": args_summary or {},
        "result": result_summary,
    }
    try:
        AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            with AUDIT_FILE.open("a") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
    except Exception as e:  # noqa: BLE001
        log.error("audit emit failed: %s", e)
