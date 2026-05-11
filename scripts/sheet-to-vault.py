#!/usr/bin/env python3
"""
sheet-to-vault.py — Google Sheets CSV → Bitwarden(=Vaultwarden) JSON 임포트 변환기

입력 CSV (Google Sheets에서 "파일 → 다운로드 → 쉼표로 구분된 값(.csv)"으로 내보냄):
    필수 컬럼 (한글 헤더):
        사이트, URL, ID, PW, 메모
    유연 매핑:
        - PW 컬럼이 비어있거나 없으면 password 빈칸으로 둠 (수동 입력용)
        - 메모 컬럼은 notes 필드로
        - URL 비어있으면 uri 생략

출력 JSON: Bitwarden encrypted-export 형식 v1 (unencrypted).
참고: https://bitwarden.com/help/condition-bitwarden-import/
Bitwarden CLI / 웹 UI에서 "Bitwarden (json)" 형식으로 임포트 가능.

⚠️ 보안 주의:
    - 본 스크립트는 비번을 평문으로 JSON에 기록한다. 임포트 직후 JSON 즉시 삭제.
    - **임포트 완료 후 입력 CSV는 즉시 안전 삭제**:
          shred -u <csv>          (Linux)
          rm -P <csv>             (macOS, 옵션)
          또는 srm -z <csv>
    - 비밀번호는 로그/콘솔에 절대 출력하지 않음.

사용 예:
    ./sheet-to-vault.py --input ~/Downloads/accounts.csv \\
                        --output ~/vault/migration/import-from-sheet.json \\
                        --folder imported-2026-05
"""

import argparse
import csv
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


# 한글 헤더 → 영문 키 매핑 (유연하게 인식)
HEADER_ALIASES = {
    "사이트": "name",
    "이름": "name",
    "name": "name",
    "url": "url",
    "URL": "url",
    "주소": "url",
    "id": "username",
    "ID": "username",
    "아이디": "username",
    "username": "username",
    "사용자명": "username",
    "pw": "password",
    "PW": "password",
    "비번": "password",
    "비밀번호": "password",
    "password": "password",
    "메모": "notes",
    "memo": "notes",
    "notes": "notes",
    "설명": "notes",
}


def normalize_headers(fieldnames):
    """한글/영문 헤더를 표준 키로 매핑."""
    mapping = {}
    for raw in fieldnames:
        if raw is None:
            continue
        key = raw.strip()
        std = HEADER_ALIASES.get(key, HEADER_ALIASES.get(key.lower(), None))
        mapping[raw] = std  # std=None이면 무시 필드
    return mapping


def build_login_item(row, header_map, folder_id):
    """한 행 → Bitwarden item dict."""
    record = {std: "" for std in {"name", "url", "username", "password", "notes"}}
    for raw, std in header_map.items():
        if std is None:
            continue
        val = (row.get(raw) or "").strip()
        record[std] = val

    if not record["name"]:
        return None  # 사이트명 없으면 스킵

    uris = []
    if record["url"]:
        uris.append({"match": None, "uri": record["url"]})

    item = {
        "id": str(uuid.uuid4()),
        "organizationId": None,
        "folderId": folder_id,
        "type": 1,  # login
        "reprompt": 0,
        "name": record["name"],
        "notes": record["notes"] or None,
        "favorite": False,
        "login": {
            "uris": uris,
            "username": record["username"] or None,
            "password": record["password"] or None,
            "totp": None,
        },
        "collectionIds": None,
    }
    return item


def main():
    parser = argparse.ArgumentParser(
        description="Google Sheets CSV → Bitwarden JSON 임포트 변환기",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="임포트 후 즉시 입력 CSV를 안전 삭제하라: shred -u <csv>",
    )
    parser.add_argument("--input", required=True, help="입력 CSV 경로")
    parser.add_argument("--output", required=True, help="출력 JSON 경로")
    parser.add_argument(
        "--folder",
        default=f"imported-{datetime.now().strftime('%Y-%m')}",
        help="Bitwarden 폴더명 (기본: imported-YYYY-MM)",
    )
    args = parser.parse_args()

    in_path = Path(args.input).expanduser()
    out_path = Path(args.output).expanduser()

    if not in_path.is_file():
        print(f"Error: 입력 파일 없음 — {in_path}", file=sys.stderr)
        sys.exit(1)

    folder_id = str(uuid.uuid4())
    folders = [{"id": folder_id, "name": args.folder}]

    items = []
    skipped = 0
    no_password = 0

    with in_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            print("Error: CSV에 헤더가 없음", file=sys.stderr)
            sys.exit(2)
        header_map = normalize_headers(reader.fieldnames)

        # 필수 헤더 확인
        std_keys = set(v for v in header_map.values() if v)
        if "name" not in std_keys:
            print(
                "Error: '사이트' 또는 'name' 컬럼이 필요합니다. 헤더 확인.",
                file=sys.stderr,
            )
            sys.exit(3)

        for row in reader:
            item = build_login_item(row, header_map, folder_id)
            if item is None:
                skipped += 1
                continue
            if not item["login"]["password"]:
                no_password += 1
            items.append(item)

    export = {
        "encrypted": False,
        "folders": folders,
        "items": items,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, indent=2)
    out_path.chmod(0o600)  # 평문 비번 포함 — 본인만 읽기

    # 비번 절대 출력하지 않음 — 카운트만
    print(f"✓ 변환 완료: {out_path}")
    print(f"  - 폴더: {args.folder}")
    print(f"  - 항목 수: {len(items)}")
    print(f"  - 비번 빈칸(수동 입력 필요): {no_password}")
    print(f"  - 스킵(이름 없음): {skipped}")
    print()
    print("⚠ 임포트 완료 후 즉시 입력 CSV를 안전 삭제하라:")
    print(f"    shred -u {in_path}    # Linux")
    print(f"    rm -P {in_path}       # macOS")


if __name__ == "__main__":
    main()
