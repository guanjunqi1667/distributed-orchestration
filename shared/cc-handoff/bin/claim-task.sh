#!/usr/bin/env bash
# ── claim-task.sh — files 模式原子认领（INBOX → IN_PROGRESS）──
# 用法: claim-task.sh <task-id>
# 持独占锁 mv：获取锁 → mv → 释放锁。
# mv 失败（任务不在 INBOX，已被别人认领）返回非零，调用方据此放弃。
#
# 注：单机下单个 CC 时 mv 本身已是原子互斥（docs/handoff-final-design.md §3）；
#     此处的锁是 belt-and-suspenders，覆盖「读到→再 mv」的 TOCTOU 与多 CC 抢占。
set -uo pipefail
WS="$HOME/.openclaw/workspace"; HD="$WS/shared/cc-handoff"
. "$HD/bin/handoff-lock.sh"

TID="${1:-}"
[ -z "$TID" ] && { echo "usage: claim-task.sh <task-id>" >&2; exit 1; }

src="$HD/INBOX/$TID.md"; dst="$HD/IN_PROGRESS/$TID.md"

claim() {
  if [ ! -f "$src" ]; then
    echo "[claim] ⚠ $TID 不在 INBOX/（已被认领或不存在）" >&2; return 1
  fi
  mv "$src" "$dst" || { echo "[claim] ⚠ mv 失败" >&2; return 1; }
  echo "[claim] $TID: INBOX → IN_PROGRESS"
  # 多节点：在 frontmatter 记录认领节点/时间/状态（best-effort；仅当文件带 frontmatter，
  # 旧文件无 frontmatter → 跳过，认领仍有效）。全程在锁内，文件已独占于 IN_PROGRESS/。
  if [ -f "$dst" ] && head -1 "$dst" 2>/dev/null | grep -q '^---[[:space:]]*$'; then
    local node="${CC_NODE:-guanj_cc}" now
    now=$(date -Iseconds)
    sed -i "s#^claimed_by:.*#claimed_by: ${node}#; s#^claimed_at:.*#claimed_at: ${now}#; s#^status:.*#status: in_progress#" "$dst" 2>/dev/null || true
  fi
}
with_handoff_lock x claim
