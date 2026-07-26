#!/usr/bin/env bash
# ── OpenClaw → Claude Code: 拉起 CC headless 处理任务 ──
# 由 OpenClaw 在投递任务后调用:  trigger-cc.sh
# 握手: CC 已 alive 且新鲜则不重复拉起;  防循环: 无任务时直接退出。
#
# HANDOFF_STORE 决定取任务方式：
#   files (默认)  CC 启动后自己 ls INBOX + 原子 mv 认领（v1 行为，不变）。
#   dual | db     先 POST /api/claim 原子认领最高优先级任务（服务器串行化互斥），
#                 再 spawn CC 处理该 task-id（reserve-before-execute：claim 成功才执行）。
set -uo pipefail
export PATH="$HOME/.npm-global/bin:$PATH"   # cron 环境补 PATH：claude/openclaw 在 ~/.npm-global/bin
WS="$HOME/.openclaw/workspace"
HD="$WS/shared/cc-handoff"
HB="$HD/STATE/cc.heartbeat"
CLI="$HD/bin/handoff_client.py"
STORE="${HANDOFF_STORE:-files}"
MAX_TURNS="${HANDOFF_MAX_TURNS:-500}"
LOCAL_NODE="${CC_NODE:-cc-main}"        # 本节点 id（多节点路由；见 STATE/nodes/）
export CC_NODE="$LOCAL_NODE"            # 传入 spawn 的 CC，供 claim 解析 frontmatter node
cd "$WS"

# ── stale 检测: last_seen > 5min 视为离线 ──
is_stale() {
  local hb="$1"
  local last_seen now diff
  last_seen=$(grep -o '"last_seen":"[^"]*"' "$hb" 2>/dev/null | head -1 | cut -d'"' -f4)
  [ -z "$last_seen" ] && return 0  # 无时间戳=stale
  now=$(date +%s)
  case "$last_seen" in
    *+*|*Z*)
      diff=$(( now - $(date -d "$last_seen" +%s 2>/dev/null || echo 0) ))
      ;;
    *)
      diff=$(( now - $(date -d "${last_seen%+*}" +%s 2>/dev/null || echo 0) ))
      ;;
  esac
  [ "$diff" -gt 300 ]  # >5min = stale
}

# 握手: CC 已在线且心跳新鲜才不拉起（防同机重复 spawn）
cc_busy() {
  [ -f "$HB" ] && grep -q '"status":"alive"' "$HB" 2>/dev/null && ! is_stale "$HB"
}

# ════════════════════════════════════════════════════════════════════
# dual / db 模式：claim-then-spawn
# ════════════════════════════════════════════════════════════════════
if [ "$STORE" = "dual" ] || [ "$STORE" = "db" ]; then
  if cc_busy; then
    echo "CC 已在线（alive 且新鲜），其已认领任务由它处理，不重复拉起。"
    exit 0
  fi

  # 原子认领最高优先级 pending 任务（服务器事务 = 天然互斥）
  CLAIM_JSON="$(python3 "$CLI" claim 2>/dev/null || true)"
  TID="$(printf '%s' "$CLAIM_JSON" | python3 -c "import sys,json
try: print((json.load(sys.stdin).get('task') or {}).get('id',''))
except Exception: print('')" 2>/dev/null)"

  if [ -z "$TID" ]; then
    echo "无待办任务（/api/claim 返回空），不拉起 CC。"
    exit 0
  fi

  echo "[trigger] 认领任务 $TID（HANDOFF_STORE=$STORE），拉起 CC 处理。"
  exec claude -p "任务 ${TID} 已由 handoff-server 原子认领给你（reserve-before-execute：POST /api/claim 在服务器事务内串行化，天然互斥，无并发输家）。

读取任务详情（任选其一）：
- python3 shared/cc-handoff/bin/handoff_client.py get ${TID}
- 或查看投影文件 IN_PROGRESS/${TID}.md

按其 Acceptance Criteria 执行，不超出 Constraints scope。

完成后（关键：dual/db 模式下 DONE 由服务器单向投影，不要直接写 DONE/ 或手动 mv）：
1. 把 DONE 报告（按 done-template：Summary / Changes / Verification / AC 逐条对照 / Issues / Next Steps）写入临时文件，例如 /tmp/done-${TID}.md；
2. 执行 shared/cc-handoff/bin/task-done.sh ${TID} /tmp/done-${TID}.md  （写入权威 SQLite 并投影 DONE/${TID}.md）；
3. 执行 shared/cc-handoff/bin/notify-openclaw.sh ${TID}  通知 OpenClaw 收件（写 STATE/notify.oc-main.flag，过渡期兼容写 cc.notify.flag，纯文件驱动，无 deliver）。

不要手动 mv 任务文件、不要直接写 INBOX/IN_PROGRESS/DONE 目录（这些是服务器单向投影出来的）。无 stdin 时 task-done.sh 也可从 stdin 读报告。" --max-turns "$MAX_TURNS"
  exit 0
fi

# ════════════════════════════════════════════════════════════════════
# files 模式（默认 / 回滚）：排队排空 —— 一次 spawn 循环领完 INBOX 再退出
# ════════════════════════════════════════════════════════════════════
if cc_busy; then
  echo "CC 已在线（alive 且新鲜），其排队排空循环会自己取走 INBOX 新任务；写 wake flag 不重复 spawn。"
  TARGET_NODE="${CC_NODE:-cc-main}"
echo "$(date -Iseconds) wake-inbox-update" >> "$WS/shared/cc-handoff/STATE/notify.${TARGET_NODE}.flag"
# 旧格式兼容
echo "$(date -Iseconds) wake-inbox-update" >> "$WS/shared/cc-handoff/STATE/cc.notify.flag"
  exit 0
fi

# headless 拉起 CC（SessionStart hook 自动写 heartbeat=alive；prompt 内排队排空）
exec claude -p "你是 CC（Claude Code），执行 shared/cc-handoff/INBOX/ 的任务。排队排空循环——重复直到 INBOX 为空：
1. ls shared/cc-handoff/INBOX/（忽略 README），按 REWORK>P0>P1>P2>日期 取最高优先级 task-id；多节点时跳过 frontmatter node 显式非本节点（${LOCAL_NODE}）的任务；若空 → 执行 shared/cc-handoff/bin/cc-heartbeat.sh idle 后退出（本次无活）。
2. 认领：shared/cc-handoff/bin/claim-task.sh <task-id>（持锁原子 mv INBOX→IN_PROGRESS；返回非零=被别的实例抢走，回 1 取下一个）。
3. 刷心跳：shared/cc-handoff/bin/cc-heartbeat.sh <task-id>（保持 alive，防 stale 重复 spawn）。
4. 读 IN_PROGRESS/<task-id>.md，按其 Acceptance Criteria 执行，不超出 Constraints scope。
5. 完成：按 done-template 写报告到临时文件（Write 工具，任意可写路径如 /tmp/done-<task-id>.md）→ shared/cc-handoff/bin/finish-task.sh <task-id> <报告路径>（持锁原子写 DONE + 归档）→ shared/cc-handoff/bin/notify-openclaw.sh <task-id> [target-node]（写 STATE/notify.<target>.flag，默认 target=oc-main；过渡期兼容写 cc.notify.flag，纯文件驱动，无 deliver）。
6. 回到 1（继续扫 INBOX，不退出，直到空）。
锁由 claim-task.sh/finish-task.sh/handoff-lock.sh 提供，无需自建。" --max-turns "$MAX_TURNS"
