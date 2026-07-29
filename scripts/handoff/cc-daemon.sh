#!/usr/bin/env bash
# ── cc-daemon.sh — CC 侧 heartbeat 守护（cron 驱动，镜像 handoff-daemon.sh） ──
#
# 为什么：CC（claude -p）是一次性进程，不能常驻 idle。本守护由 cron 定期触发，
# 承担「定期扫描 + 必要时拉起 CC」，让 CC 像 OC 一样「谁活跃谁捞」、不必 OC 手动 trigger。
#
# 职责（每 tick 做一次即退，idle 由 cron 间隔承担，建议 30-60s）：
#   1. 共享读锁扫 handoff 全貌（INBOX/IN_PROGRESS/DONE/ALERT）——一眼知状态。
#   2. 读 cc.heartbeat 判 CC 是否在跑（alive 且新鲜 <5min）。
#   3. 若 INBOX 有待办 且 CC 不在跑（offline/stale/无心跳）→ 异步 trigger-cc.sh 拉起
#      （CC 的 spawn prompt 会排队排空整个 INBOX 再退出）。
#   4. 不写 cc.heartbeat：心跳由 CC 会话内 cc-heartbeat.sh 刷新、退出由 Stop hook 写 offline；
#      本守护若伪造 alive 会让 trigger 误判「CC 在跑」而永不拉起。
#
# cron 示例（OC/运维侧配置，本脚本不自行注册）：
#   * * * * * /home/guanj/.openclaw/workspace/scripts/handoff/cc-daemon.sh >> /tmp/cc-daemon.log 2>&1
set -uo pipefail
WS="$HOME/.openclaw/workspace"; HD="$WS/shared/cc-handoff"
STATE="$HD/STATE"; HB="$STATE/cc.heartbeat"; INBOX="$HD/INBOX"
HANDOFF_SERVER="${HANDOFF_SERVER:-http://100.90.1.56:8377}"   # dual: server 端(db)
TRIGGER="$HD/bin/trigger-cc.sh"
LOCAL_NODE="${CC_NODE:-cc-main}"          # 本节点 id（多节点路由用；见 STATE/nodes/）
. "$HD/bin/handoff-lock.sh"
. "$HD/bin/frontmatter.sh"                # fm_field：读 frontmatter node（旧文件→空，兼容）

# ── stale 检测（与 trigger-cc.sh / handoff-daemon.sh 一致）──
is_stale() {
  local last_seen now diff
  last_seen=$(grep -o '"last_seen":"[^"]*"' "$HB" 2>/dev/null | head -1 | cut -d'"' -f4)
  [ -z "$last_seen" ] && return 0  # 无时间戳 = stale
  now=$(date +%s)
  case "$last_seen" in
    *+*|*Z*) diff=$(( now - $(date -d "$last_seen" +%s 2>/dev/null || echo 0) )) ;;
    *)       diff=$(( now - $(date -d "${last_seen%+*}" +%s 2>/dev/null || echo 0) )) ;;
  esac
  [ "$diff" -gt 300 ]  # >5min = stale
}

cc_busy() {
  [ -f "$HB" ] && grep -q '"status":"alive"' "$HB" 2>/dev/null && ! is_stale "$HB"
}

# ── 共享读锁扫全貌（与 dispatch 写入 / CC 认领互斥，快照一致）──
inbox_n=0; inprog_n=0; done_n=0; alert_n=0; inbox_ids=""
{
  flock -s -w "${HANDOFF_LOCK_WAIT}" 200 || { echo "[cc-daemon] ⚠ 读锁超时(${HANDOFF_LOCK_WAIT}s)" >&2; exit 124; }
  for f in "$INBOX"/*.md; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .md); [ "$id" = "README" ] && continue
    # 多节点路由：frontmatter 显式指定 node 且非本节点 → 留给目标节点，不计数/不拉起
    # 旧文件无 frontmatter（node 空）→ 视为本节点待办（向后兼容）
    tn=$(fm_field "$f" node)
    if [ -n "$tn" ] && [ "$tn" != "any" ] && [ "$tn" != "$LOCAL_NODE" ]; then
      echo "[cc-daemon] 跳过 $id（node=$tn：定向给别的节点，非 any 广播）"
      continue
    fi
    inbox_n=$((inbox_n+1)); inbox_ids="$inbox_ids $id"
  done
  for d in IN_PROGRESS DONE ALERT; do
    n=0
    for f in "$HD/$d"/*.md; do
      [ -f "$f" ] || continue; [ "$(basename "$f" .md)" = "README" ] && continue; n=$((n+1))
    done
    case "$d" in IN_PROGRESS) inprog_n=$n ;; DONE) done_n=$n ;; ALERT) alert_n=$n ;; esac
  done
} 200>"$HANDOFF_LOCK"

cc_hb="offline"
cc_busy_now=false
if cc_busy; then cc_hb="alive"; cc_busy_now=true; fi

echo "[cc-daemon] $(date +%H:%M:%S)  inbox=${inbox_n} inprog=${inprog_n} done=${done_n} alert=${alert_n}  CC=${cc_hb}"
[ -n "${inbox_ids# }" ] && echo "[cc-daemon] 待办:${inbox_ids}"

# ── dual: server 端 pending 检查(db)──
SERVER_N=0
if [ -n "${HANDOFF_SERVER:-}" ]; then
  SERVER_N=$(python3 -c "import urllib.request,json; r=urllib.request.urlopen('${HANDOFF_SERVER}/api/tasks/pending',timeout=5); print(json.loads(r.read()).get('count',0))" 2>/dev/null || echo 0)
  [ "$SERVER_N" -gt 0 ] && echo "[cc-daemon] server pending: ${SERVER_N}"
fi

# ── 有活(本地 OR server)且 CC 不在跑 → 异步拉起（dual: trigger 走 STORE=dual claim 两端）──
if { [ "$inbox_n" -gt 0 ] || [ "$SERVER_N" -gt 0 ]; } && [ "$cc_busy_now" = false ]; then
  if [ -x "$TRIGGER" ]; then
    echo "[cc-daemon] 待办(本地 ${inbox_n} + server ${SERVER_N})且 CC 离线，异步拉起..."
    HANDOFF_STORE="${HANDOFF_STORE:-dual}" nohup "$TRIGGER" >/tmp/cc-daemon-trigger.log 2>&1 &
  else
    echo "[cc-daemon] ⚠ trigger-cc.sh 不可用，任务留 INBOX 等下次" >&2
  fi
else
  echo "[cc-daemon] 无需拉起（待办 ${inbox_n} / CC ${cc_hb}）"
fi

# ── 消费通知标记（对称：扫描 notify.<self>.flag，镜像 handoff-daemon.sh §6） ──
# 其他节点投递/唤醒时写 notify.<LOCAL_NODE>.flag；扫到即知有新活或 wake 提示，清掉避免堆积。
# cc-main 的实际取活由上面的 INBOX 扫描 + trigger 兜底，flag 在此为「收到通知」留痕 + 清理。
for nf in "$STATE"/notify."${LOCAL_NODE}".flag; do
  [ -f "$nf" ] || continue
  echo "[cc-daemon] 📩 收到通知: $(basename "$nf")"
  rm -f "$nf"
done
# 注：旧格式 cc.notify.flag 是 oc-main 旧守护的消费路径（handoff-daemon.sh §6 仅在
# LOCAL_NODE=oc-main 时读取/清理）。cc-main 不抢——否则会偷走发给 oc-main 的 DONE 通知；
# cc-main 历史上无独立的旧格式 notify flag（取活靠 INBOX 扫描）。
exit 0
