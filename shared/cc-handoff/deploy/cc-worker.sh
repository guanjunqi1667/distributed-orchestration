#!/usr/bin/env bash
# ── cc-worker.sh — 远端 CC 轮询执行 Handoff Server 任务 ──
# 部署位置：~/handoff-server/cc-worker.sh
# 用法：bash cc-worker.sh           # 前台运行
#       nohup bash cc-worker.sh &   # 后台运行
# ─────────────────────────────────────────────────────────────

set -euo pipefail

export HANDOFF_SERVER="http://100.90.1.56:8377"
export HANDOFF_NODE_ID="${HANDOFF_NODE_ID:-guanj_threesky}"
CLIENT="$HOME/handoff-server/handoff_client.py"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
LOG="$HOME/handoff-server/worker.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "Worker started (node=$HANDOFF_NODE_ID, poll=${POLL_INTERVAL}s)"

while true; do
  # 1. Claim 任务（原子操作）
  TASK_JSON=$(python3 "$CLIENT" claim "$HANDOFF_NODE_ID" 2>>"$LOG" || echo '{}')
  CLAIMED=$(echo "$TASK_JSON" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('claimed', False))
except: print(False)
" 2>/dev/null)

  if [ "$CLAIMED" != "True" ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  TASK_ID=$(echo "$TASK_JSON" | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['task']['id'])
except: print('unknown')
" 2>/dev/null)

  log "CLAIMED: $TASK_ID"

  # 2. 获取任务详情
  TASK_DETAIL=$(python3 "$CLIENT" get "$TASK_ID" 2>>"$LOG" || echo '{}')
  OBJECTIVE=$(echo "$TASK_DETAIL" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('task',{}).get('objective',''))
except: print('')
" 2>/dev/null)

  log "TASK: $TASK_ID | $OBJECTIVE"

  # 3. ✅ 安全模式：只输出任务信息，不做自动完成
  #    如需启用自动执行，设置 AUTO_EXECUTE=true
  AUTO_EXECUTE="${AUTO_EXECUTE:-false}"

  log "TASK: $TASK_ID | $OBJECTIVE"
  log "INFO: Worker claimed task $TASK_ID but AUTO_EXECUTE=false"
  log "INFO: Task left in_progress. Operator should check and complete manually:"
  log "INFO:   python3 $CLIENT get $TASK_ID"
  log "INFO:   python3 $CLIENT done $TASK_ID /dev/stdin <<< '{\"summary\":\"...\",\"status\":\"success\"}'"

  if [ "$AUTO_EXECUTE" != "true" ]; then
    log "SAFE: Task $TASK_ID claimed but not auto-completed (AUTO_EXECUTE=false)"
    continue
  fi

  # ── 自动执行模式（需要设置 AUTO_EXECUTE=true）──
  RESULT_STATUS="success"
  RESULT_SUMMARY="Task $TASK_ID completed"
  CHANGES="[]"

  # 默认：创建结果 markdown 文件
  mkdir -p "$HOME/handoff-server/results"
  echo "# Result: $TASK_ID
Completed: $(date -Iseconds)
Node: $HANDOFF_NODE_ID
" > "$HOME/handoff-server/results/$TASK_ID.md"

  # 4. 报告完成
  python3 "$CLIENT" done "$TASK_ID" /dev/stdin << EOF > /dev/null 2>>"$LOG"
{"summary":"$RESULT_SUMMARY","changes":$CHANGES,"status":"$RESULT_STATUS","artifacts":{"report":"results/$TASK_ID.md"}}
EOF

  log "DONE: $TASK_ID ($RESULT_STATUS)"
done
