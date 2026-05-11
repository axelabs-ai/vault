#!/usr/bin/env bash
# ~/vault/scripts/migrate-status.sh
# 계정 마이그레이션 상태 추적 — accounts.yaml + state/ touch-files
#
# 사용법:
#   migrate-status.sh                # 상태 테이블 (default)
#   migrate-status.sh status         # 동일
#   migrate-status.sh mark-done <id> # 해당 계정 완료 마킹
#   migrate-status.sh next           # 다음 마이그레이션 대상 1개 출력
#   migrate-status.sh progress       # tier별 진행률 %

set -euo pipefail

VAULT_DIR="${VAULT_DIR:-$HOME/vault}"
YAML="$VAULT_DIR/migration/accounts.yaml"
STATE_DIR="$VAULT_DIR/migration/state"

mkdir -p "$STATE_DIR"

if [[ ! -f "$YAML" ]]; then
  echo "Error: $YAML 없음" >&2
  exit 1
fi

# ─────────────────────────────────────────────
# YAML 파싱 — python3+yaml 우선, 없으면 grep fallback
# 출력 형식: <tier>\t<id>\t<name>
# ─────────────────────────────────────────────
parse_accounts() {
  if command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" >/dev/null 2>&1; then
    python3 - "$YAML" <<'PY'
import sys, yaml
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)
for block in data.get("migrations", []):
    tier = block.get("tier", "?")
    for a in block.get("accounts", []):
        print(f"{tier}\t{a['id']}\t{a.get('name','')}")
PY
  else
    # Fallback: grep 기반 (정확도 낮지만 동작은 함)
    awk '
      /^[[:space:]]*-[[:space:]]*tier:/ { tier=$NF; next }
      /^[[:space:]]*-[[:space:]]*id:/   { id=$NF; name=""; next }
      /^[[:space:]]*name:/              { sub(/^[[:space:]]*name:[[:space:]]*/,""); name=$0;
                                          if (id != "") { printf "%s\t%s\t%s\n", tier, id, name; id=""; } }
    ' "$YAML"
  fi
}

is_done() {
  [[ -f "$STATE_DIR/$1.done" ]]
}

last_touched() {
  local f="$STATE_DIR/$1.done"
  if [[ -f "$f" ]]; then
    # macOS·linux 호환 mtime
    if stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$f" >/dev/null 2>&1; then
      stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$f"
    else
      stat -c "%y" "$f" | cut -d. -f1
    fi
  else
    echo "-"
  fi
}

cmd_status() {
  printf "%-6s %-24s %-8s %s\n" "TIER" "ACCOUNT" "STATUS" "LAST"
  printf "%-6s %-24s %-8s %s\n" "----" "-------" "------" "----"
  while IFS=$'\t' read -r tier id name; do
    if is_done "$id"; then
      status="✓"
    else
      status="⏳"
    fi
    printf "%-6s %-24s %-8s %s\n" "$tier" "$id" "$status" "$(last_touched "$id")"
  done < <(parse_accounts)
}

cmd_mark_done() {
  local id="${1:-}"
  if [[ -z "$id" ]]; then
    echo "Usage: migrate-status.sh mark-done <account-id>" >&2
    exit 2
  fi
  # accounts.yaml에 실제 존재하는 id인지 확인
  if ! parse_accounts | awk -F'\t' -v target="$id" '$2==target {found=1} END {exit !found}'; then
    echo "Error: '$id'는 accounts.yaml에 없음" >&2
    exit 3
  fi
  touch "$STATE_DIR/$id.done"
  echo "✓ marked done: $id ($(last_touched "$id"))"
}

cmd_next() {
  # P0 → P1 → P1.5 → P2 우선순위, YAML 등장 순서
  while IFS=$'\t' read -r tier id name; do
    if ! is_done "$id"; then
      echo "next: $tier  $id  ($name)"
      return 0
    fi
  done < <(parse_accounts)
  echo "🎉 모든 계정 완료"
}

cmd_progress() {
  # macOS bash 3.2 호환 — 연관배열 없이 awk로 집계
  parse_accounts | while IFS=$'\t' read -r tier id name; do
    if is_done "$id"; then
      printf "%s\tdone\n" "$tier"
    else
      printf "%s\ttodo\n" "$tier"
    fi
  done | awk -F'\t' '
    { total[$1]++; if ($2=="done") done[$1]++ }
    END {
      printf "%-6s %-6s %-6s %s\n", "TIER", "DONE", "TOTAL", "PCT"
      printf "%-6s %-6s %-6s %s\n", "----", "----", "-----", "---"
      grand_total=0; grand_done=0
      n = split("p0 p1 p1.5 p2", order, " ")
      for (i=1; i<=n; i++) {
        t = order[i]
        if (total[t] > 0) {
          d = done[t]+0
          pct = int(d * 100 / total[t])
          printf "%-6s %-6s %-6s %d%%\n", t, d, total[t], pct
          grand_total += total[t]; grand_done += d
        }
      }
      if (grand_total > 0) {
        gpct = int(grand_done * 100 / grand_total)
        printf "%-6s %-6s %-6s %d%%\n", "ALL", grand_done, grand_total, gpct
      }
    }
  '
}

# ─────────────────────────────────────────────
# Dispatch
# ─────────────────────────────────────────────
sub="${1:-status}"
case "$sub" in
  status|"")     cmd_status ;;
  mark-done)     shift; cmd_mark_done "${1:-}" ;;
  next)          cmd_next ;;
  progress)      cmd_progress ;;
  -h|--help|help)
    sed -n '1,15p' "$0"
    ;;
  *)
    echo "Unknown subcommand: $sub" >&2
    echo "Try: status | mark-done <id> | next | progress" >&2
    exit 2
    ;;
esac
