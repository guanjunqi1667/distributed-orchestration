#!/usr/bin/env bash
# ── OpenClaw → CC: 投递任务 + 自动拉起 ──
# 用法:
#   dispatch-cc.sh <task-file.md>     把已有任务文件写入 INBOX 并触发 CC
#   dispatch-cc.sh --id <task-id> --content <文件路径>   从内容文件写入
#
# HANDOFF_STORE:
#   files (默认)  cp 任务文件到 INBOX/（v1 行为，不变）。
#   dual | db     POST /api/tasks/import 注册到 SQLite 权威 + 投影 INBOX/
#                 （不反向回灌：创建是内容进入权威的唯一入口）。
set -euo pipefail
WS="$HOME/.openclaw/workspace"
HD="$WS/shared/cc-handoff"
INBOX="$HD/INBOX"
TRIGGER="$HD/bin/trigger-cc.sh"
CLI="$HD/bin/handoff_client.py"
STORE="${HANDOFF_STORE:-files}"

# files 模式全局锁（任务创建持独占锁、原子写）
. "$HD/bin/handoff-lock.sh"
. "$HD/bin/frontmatter.sh"              # fm_field：读 frontmatter priority/node（新规范；旧文件→空）

mkdir -p "$INBOX"

# 原子写 INBOX/<id>.md：temp + rename（防 CC 读到半写文件），全程持独占锁
put_inbox() {
  local tmp="$INBOX/.${TASK_ID}.tmp.$$"
  cp "$CONTENT_FILE" "$tmp" && mv -f "$tmp" "$INBOX/$TASK_ID.md"
}

if [ $# -lt 1 ]; then
  echo "用法: dispatch-cc.sh <task-file.md>"
  echo "       dispatch-cc.sh --id <task-id> --content <content-file>"
  exit 1
fi

# ── 解析参数 ──
if [ "$1" = "--id" ]; then
  TASK_ID="$2"
  CONTENT_FILE="$4"
else
  TASK_FILE="$1"
  TASK_ID=$(basename "$TASK_FILE" .md)
  CONTENT_FILE="$TASK_FILE"
fi

# 优先级：frontmatter priority 优先（新规范），回退文件名前缀（旧规范），再回退 P2
FP=$(fm_field "$CONTENT_FILE" priority)
case "${FP:-}" in
  P0|P1|P2) PRIO="$FP" ;;
  *) case "$TASK_ID" in
       P0*) PRIO=P0 ;; P1*) PRIO=P1 ;; P2*) PRIO=P2 ;; *) PRIO=P2 ;;
     esac ;;
esac
DN=$(fm_field "$CONTENT_FILE" node)
echo "[dispatch] task=$TASK_ID prio=$PRIO node=${DN:-<unspecified>}"

if [ "$STORE" = "dual" ] || [ "$STORE" = "db" ]; then
  echo "[dispatch] $TASK_ID → SQLite (HANDOFF_STORE=$STORE, POST /api/tasks/import)"
  if python3 "$CLI" import "$TASK_ID" "$CONTENT_FILE" "$PRIO" >/dev/null 2>&1; then
    echo "[dispatch] 已注册到权威存储"
  else
    echo "[dispatch] ⚠ import 失败，回退原子写 INBOX/（服务器未运行？）"
    with_handoff_lock x put_inbox || { echo "[dispatch] ⚠ 回退写入失败/锁超时" >&2; exit 1; }
  fi
else
  with_handoff_lock x put_inbox || { echo "[dispatch] ⚠ 写入 INBOX 失败/锁超时" >&2; exit 1; }
  echo "[dispatch] $TASK_ID → INBOX/ (files, 原子+锁)"
fi

# ── 握手检查 ──
cc_status="offline"
HB="$HD/STATE/cc.heartbeat"
if [ -f "$HB" ]; then
  cc_status=$(grep -o '"status":"[^"]*"' "$HB" 2>/dev/null | head -1 | cut -d'"' -f4 || echo "offline")
fi
echo "[dispatch] CC status: $cc_status"

# ── 异步触发 CC（不阻塞 OpenClaw）──
if [ -x "$TRIGGER" ]; then
  echo "[dispatch] 后台拉起 CC..."
  nohup "$TRIGGER" >/tmp/trigger-cc.log 2>&1 &
  echo "[dispatch] 已触发 (pid $!), 日志: /tmp/trigger-cc.log"
else
  echo "[dispatch] trigger-cc.sh 不可用，任务留 INBOX 等 CC 下次启动取"
fi

echo "[dispatch] done"
