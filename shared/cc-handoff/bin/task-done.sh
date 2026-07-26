#!/usr/bin/env bash
# ── CC → Handoff Server: 报告任务完成（dual/db 模式）──
# CC 在 SQLite 权威模式下不再直接写 DONE/（DONE 由服务器单向投影）。
# 改为：把 DONE 报告（按 done-template：改动+验证+AC 对照）交给本脚本，
# 由它 POST /api/tasks/{id}/done 写入权威存储并投影 DONE/{id}.md。
#
# 用法:
#   task-done.sh <task-id> <report-file>     # 从文件读报告
#   task-done.sh <task-id>                   # 从 stdin 读报告
#               （例: task-done.sh P0-... <<'EOF' ... EOF）
#
# files 模式下不应使用本脚本（CC 仍直接写 DONE/ + mv 归档）。
set -uo pipefail
WS="$HOME/.openclaw/workspace"
CLI="$WS/shared/cc-handoff/bin/handoff_client.py"

TID="${1:-}"
if [ -z "$TID" ]; then
  echo "usage: task-done.sh <task-id> [report-file]" >&2
  exit 1
fi

REPORT_FILE="${2:-}"
if [ -n "$REPORT_FILE" ]; then
  python3 "$CLI" done "$TID" "$REPORT_FILE"
else
  python3 "$CLI" done "$TID"            # client 从 stdin 读
fi
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "⚠ task-done: 服务器写入失败（rc=$RC）。报告内容请见 stdin/文件，需重试或回退 files 模式。" >&2
fi
exit "$RC"
