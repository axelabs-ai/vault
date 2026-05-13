"""vault-mcp item 도구 — list, search, 메타데이터 lookup, rotation_due.

비밀번호 본문은 절대 반환 안 함 (BwClient.strip_secrets 통과).
"""

from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any

from ..core import audit
from ..core.bw import BwClient, strip_secrets


def _gen_password(length: int = 20, symbols: bool = True) -> str:
    alpha = string.ascii_letters + string.digits
    if symbols:
        alpha += "!@#$%^&*()-_=+[]{}"
    return "".join(secrets.choice(alpha) for _ in range(length))


def register(mcp) -> None:

    @mcp.tool()
    def vault_list_items(folder: str = "", item_type: str = "", limit: int = 50) -> dict:
        """vault 항목 목록 — 메타데이터만 반환 (비밀번호 NEVER).

        Args:
            folder: 폴더명 (예: "imported-2026-05"). 빈 문자열이면 전체.
            item_type: "login"|"note"|"card"|"identity"|"" (전체)
            limit: 최대 항목 수 (기본 50, 최대 200)

        Returns:
            {total_matched, returned, items: [{id,name,type,username,uris,...}]}
        """
        limit = min(max(1, int(limit)), 200)
        bw = BwClient.get()
        bw.sync()
        all_items = bw.call_json("list", "items")
        # filter
        type_map = {"login": 1, "note": 2, "card": 3, "identity": 4}
        type_int = type_map.get(item_type) if item_type else None

        folders = {f["id"]: f["name"] for f in bw.call_json("list", "folders")}

        filtered = []
        for it in all_items:
            if type_int and it.get("type") != type_int:
                continue
            if folder:
                fid = it.get("folderId")
                fname = folders.get(fid, "")
                if folder.lower() not in (fname or "").lower():
                    continue
            filtered.append(strip_secrets(it))

        out_items = filtered[:limit]
        # enrich with folder name
        for o in out_items:
            o["folder_name"] = folders.get(o.get("folder_id"))
        result = {
            "total_matched": len(filtered),
            "returned": len(out_items),
            "items": out_items,
        }
        audit.emit(
            "vault_list_items",
            ok=True,
            args_summary={"folder": folder, "type": item_type, "limit": limit},
            result_summary={"matched": len(filtered)},
        )
        return result

    def _client_side_search(items: list, query: str) -> list:
        """bw CLI `--search` flag 가 2026.4.x 에서 일관성 없음 — 자체 필터.

        대소문자 무시 부분일치 매칭 대상:
          name, notes, login.username, login.uris[].uri.
        """
        q = query.lower().strip()
        if not q:
            return []
        out = []
        for it in items:
            haystacks = [
                (it.get("name") or "").lower(),
                (it.get("notes") or "").lower(),
            ]
            login = it.get("login") or {}
            if login.get("username"):
                haystacks.append(login["username"].lower())
            for u in (login.get("uris") or []):
                if u.get("uri"):
                    haystacks.append(u["uri"].lower())
            if any(q in h for h in haystacks):
                out.append(it)
        return out

    @mcp.tool()
    def vault_search(query: str, limit: int = 20) -> dict:
        """이름·URL·username·notes 부분일치 검색 (메타데이터만, 대소문자 무시)."""
        if not query.strip():
            return {"total_matched": 0, "returned": 0, "items": []}
        limit = min(max(1, int(limit)), 100)
        bw = BwClient.get()
        bw.sync()
        all_items = bw.call_json("list", "items")
        matched = _client_side_search(all_items, query)
        meta = [strip_secrets(it) for it in matched[:limit]]
        audit.emit(
            "vault_search",
            ok=True,
            args_summary={"query_len": len(query), "limit": limit},
            result_summary={"matched": len(matched)},
        )
        return {
            "total_matched": len(matched),
            "returned": len(meta),
            "items": meta,
        }

    @mcp.tool()
    def vault_check_known(name: str) -> dict:
        """vault 에 해당 사이트 항목이 이미 있는지 여부 — bool + 매칭 개수."""
        if not name.strip():
            return {"known": False, "matches": 0, "names": []}
        bw = BwClient.get()
        all_items = bw.call_json("list", "items")
        matched = _client_side_search(all_items, name)
        names = [it.get("name") for it in matched[:10]]
        result = {"known": bool(matched), "matches": len(matched), "names": names}
        audit.emit("vault_check_known", ok=True, args_summary={"query": name}, result_summary=result)
        return result

    @mcp.tool()
    def vault_folders() -> dict:
        """folder 인벤토리 — 이름 + 항목 카운트."""
        bw = BwClient.get()
        folders = bw.call_json("list", "folders")
        items = bw.call_json("list", "items")
        counts: dict[str, int] = {}
        for it in items:
            fid = it.get("folderId")
            counts[fid or ""] = counts.get(fid or "", 0) + 1
        out = []
        for f in folders:
            out.append({
                "id": f["id"],
                "name": f["name"],
                "item_count": counts.get(f["id"], 0),
            })
        # unfiled
        unfiled = counts.get("", 0) + counts.get(None, 0)
        if unfiled:
            out.append({"id": None, "name": "(unfiled)", "item_count": unfiled})
        audit.emit("vault_folders", ok=True, result_summary={"count": len(out)})
        return {"folders": out}

    @mcp.tool()
    def vault_rotation_due(days: int = 180, limit: int = 50) -> dict:
        """N일 이상 미회전 login 항목 — 회전 계획용.

        revisionDate 기준. 기본 180일.
        """
        days = max(1, int(days))
        limit = min(max(1, int(limit)), 200)
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        bw = BwClient.get()
        bw.sync()
        all_items = bw.call_json("list", "items")
        due = []
        for it in all_items:
            if it.get("type") != 1:  # login only
                continue
            rev_str = it.get("revisionDate")
            if not rev_str:
                continue
            try:
                rev = datetime.fromisoformat(rev_str.replace("Z", "+00:00"))
            except ValueError:
                continue
            if rev < cutoff:
                due.append({
                    **strip_secrets(it),
                    "days_since_rotation": (datetime.now(timezone.utc) - rev).days,
                })
        due.sort(key=lambda x: x.get("days_since_rotation", 0), reverse=True)
        audit.emit(
            "vault_rotation_due",
            ok=True,
            args_summary={"days": days},
            result_summary={"due_count": len(due)},
        )
        return {
            "cutoff_days": days,
            "total_due": len(due),
            "returned": min(len(due), limit),
            "items": due[:limit],
        }

    @mcp.tool()
    def vault_create_login(
        name: str,
        username: str = "",
        uri: str = "",
        folder_id: str = "",
        notes: str = "",
        length: int = 20,
    ) -> dict:
        """새 login 항목 생성 — 강한 랜덤 비밀번호 자동 발급.

        ⚠ 발급된 비밀번호 본문은 반환 안 됨 — 사람이 Bitwarden 클라이언트(앱·CLI)로
        열어서 확인. LLM 은 id·name·metadata 만 받는다.

        Args:
            name: 항목 이름 (필수)
            username: 로그인 ID
            uri: 사이트 URL
            folder_id: 폴더 ID (선택)
            notes: 메모 (선택)
            length: 비밀번호 길이 16-64 (기본 20)

        Returns:
            {id, name, length, ts, message}
        """
        if not name.strip():
            raise ValueError("name 은 필수")
        length = min(max(16, int(length)), 64)
        password = _gen_password(length=length, symbols=True)
        item_template = {
            "type": 1,
            "name": name,
            "notes": notes or None,
            "favorite": False,
            "folderId": folder_id or None,
            "login": {
                "username": username or None,
                "password": password,
                "uris": [{"match": None, "uri": uri}] if uri else [],
            },
        }
        bw = BwClient.get()
        import base64
        import json as _json
        encoded = base64.b64encode(_json.dumps(item_template).encode("utf-8")).decode("ascii")
        created = bw.call_json("create", "item", encoded)
        bw.sync()
        result = {
            "id": created.get("id"),
            "name": created.get("name"),
            "length": length,
            "created_at": created.get("creationDate"),
            "message": (
                "비밀번호는 LLM 으로 반환되지 않습니다. "
                "Bitwarden 앱·CLI 에서 본 항목을 열어 확인하세요."
            ),
        }
        audit.emit(
            "vault_create_login",
            ok=True,
            args_summary={"name": name, "length": length},
            result_summary={"id": result["id"]},
        )
        return result
