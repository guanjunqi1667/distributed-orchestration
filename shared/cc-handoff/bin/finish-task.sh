#!/usr/bin/env bash
# ── finish-task.sh — files 模式原子完成（写 DONE + 归档）──
# 用法:
#   finish-task.sh <task-id> <report-file>    # 从文件读 DONE 报告
#   finish-task.sh <task-id>                  # 从 stdin 读报告
# 持独占锁：原子写 DONE/{id}.md（temp + rename，防 OC daemon 读到半写文件）
#           → mv IN_PROGRESS/{id}.md INBOX_ARCHIVE/。
# 顺序：先 DONE 后归档（保证「有 DONE = 已完成」幂等）。
set -uo pipefail
WS="$HOME/.openclaw/workspace"; HD="$WS/shared/cc-handoff"
. "$HD/bin/handoff-lock.sh"

TID="${1:-}"; REPORT="${2:-}"
[ -z "$TID" ] && { echo "usage: finish-task.sh <task-id> [report-file]" >&2; exit 1; }

DONE_DIR="$HD/DONE"; ARCHIVE="$HD/INBOX_ARCHIVE"; INPROG="$HD/IN_PROGRESS"

finish() {
  local tmp="$DONE_DIR/.${TID}.tmp.$$"
  if [ -n "$REPORT" ]; then
    cp "$REPORT" "$tmp" || { echo "[finish] ⚠ 读报告失败: $REPORT" >&2; rm -f "$tmp"; return 1; }
  else
    cat > "$tmp" || { echo "[finish] ⚠ stdin 读失败" >&2; rm -f "$tmp"; return 1; }
  fi
  mv -f "$tmp" "$DONE_DIR/$TID.md" || { echo "[finish] ⚠ 写 DONE/$TID.md 失败" >&2; rm -f "$tmp"; return 1; }
  echo "[finish] DONE/$TID.md 已写"
  if [ -f "$INPROG/$TID.md" ]; then
    mv "$INPROG/$TID.md" "$ARCHIVE/$TID.md" && echo "[finish] IN_PROGRESS/$TID → INBOX_ARCHIVE/"
  else
    echo "[finish] ⚠ IN_PROGRESS/$TID.md 不存在，跳过归档（任务可能不在 IN_PROGRESS）" >&2
  fi
}
with_handoff_lock x finish
