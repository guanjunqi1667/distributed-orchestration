#!/usr/bin/env bash
# ── cc-heartbeat.sh — CC 刷新自己的心跳 ──
# 用法: cc-heartbeat.sh [working-on-task-id]
#
# 为什么需要：cc.heartbeat 由 SessionStart hook 写一次（alive），但长会话
# （排队排空多个任务）持续数分钟→数十分钟，last_seen 会过期被判 STALE，
# 导致 trigger-cc.sh 误以为 CC 离线而重复 spawn。CC 在排空循环每轮调一次本脚本，
# 把 last_seen 推到当下，保持「alive 且新鲜」。
#
# 不用锁：CC 是自己 heartbeat 的唯一写者（会话内）；temp+rename 保证读者只见
# 旧值或新值、不见半写。Stop hook 在 CC 退出后写 offline（时序不冲突）。
set -uo pipefail
WS="$HOME/.openclaw/workspace"
HB="$WS/shared/cc-handoff/STATE/cc.heartbeat"
WORKING="${1:-}"
SESSION="${CC_SESSION:-guanj_cc}"
TMP="$HB.tmp.$$"

printf '{"status":"alive","working_on":"%s","last_seen":"%s","session":"%s"}\n' \
  "$WORKING" "$(date -Iseconds)" "$SESSION" > "$TMP" \
  && mv -f "$TMP" "$HB" \
  || { rm -f "$TMP"; echo "[cc-heartbeat] ⚠ 写心跳失败" >&2; exit 1; }
