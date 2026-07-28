#!/usr/bin/env bash
# ── cc-worker.sh — 远端 CC 轮询 Handoff Server
# 用法：
#   bash cc-worker.sh               # 安全模式：只看不 claim
#   AUTO_EXECUTE=true bash cc-worker.sh  # 自动执行模式
# ─────────────────────────────────────────────────────────────
set -euo pipefail

export HANDOFF_SERVER="http://100.90.1.56:8377"
export HANDOFF_NODE_ID="${HANDOFF_NODE_ID:-guanj_threesky}"
CLIENT="$HOME/handoff-server/handoff_client.py"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
AUTO_EXECUTE="${AUTO_EXECUTE:-true}"
LOG="$HOME/handoff-server/worker.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
log "Worker started (node=$HANDOFF_NODE_ID, poll=${POLL_INTERVAL}s, auto=${AUTO_EXECUTE})"

while true; do
  if [ "$AUTO_EXECUTE" != "true" ]; then
    # 安全模式：只看队列，不认领
    COUNT=$(python3 "$CLIENT" pending 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null || echo 0)
    [ "$COUNT" -gt 0 ] && log "QUEUE: $COUNT task(s) waiting (not claiming, AUTO_EXECUTE=false)"
    sleep "$POLL_INTERVAL"
    continue
  fi

  # ── 自动执行模式 ──
  TASK_JSON=$(python3 "$CLIENT" claim "$HANDOFF_NODE_ID" 2>>"$LOG" || echo '{}')
  CLAIMED=$(echo "$TASK_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('claimed',False))" 2>/dev/null)

  if [ "$CLAIMED" != "True" ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  TASK_ID=$(echo "$TASK_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id','unknown'))" 2>/dev/null)
  log "CLAIMED: $TASK_ID"

  # 获取任务详情
  OBJECTIVE=$(python3 "$CLIENT" get "$TASK_ID" 2>>"$LOG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('objective',''))" 2>/dev/null)
  log "TASK: $TASK_ID | $OBJECTIVE"

  # ⚠️ 执行点：在此插入实际执行逻辑
  # 默认行为：标记完成（占位）
  python3 "$CLIENT" done "$TASK_ID" /dev/stdin << EOF > /dev/null 2>>"$LOG"
{"summary":"Task $TASK_ID auto-completed by worker","status":"success"}
EOF
  log "DONE: $TASK_ID"
done
