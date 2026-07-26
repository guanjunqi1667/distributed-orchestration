#!/usr/bin/env bash
# ── 节点通知：DONE 写盘 + flag 标记（对称多节点） ──
# 由任何节点在写完 DONE 后调用: notify-openclaw.sh [task-id] [target-node]
#
# 旧名向后兼容。对称版本写 notify.<target>.flag，其他节点扫到即知有新 DONE。
#
# 参数:
#   $1 - task-id（必填，但缺省取 unknown）
#   $2 - target-node（可选，默认 oc-main）
# 环境变量:
#   NOTIFY_TARGET - 同 $2，优先级低于 $2
#
# 设计原则：文件夹是唯一通信层，不依赖 deliver 或模型可用性。
# 写 DONE/ → 写 flag → 退出。目标节点活跃时扫 flag → 捞 DONE/ → 处理。
set -uo pipefail
WS="$HOME/.openclaw/workspace"
TASK="${1:-}"
TARGET="${2:-${NOTIFY_TARGET:-oc-main}}"

# 写 flag（目标节点扫到就知道有新 DONE）
# 单次 echo >> 是 O_APPEND 短写，POSIX 保证原子
NOTIFY_FLAG="$WS/shared/cc-handoff/STATE/notify.${TARGET}.flag"
echo "$(date -Iseconds) ${TASK:-unknown}" >> "$NOTIFY_FLAG"

# 旧格式兼容：cc.notify.flag 是 oc-main 旧守护（handoff-daemon.sh §6）的消费路径——
# 它只在 LOCAL_NODE=oc-main 时被读取/清理。因此过渡期 notify oc-main 时仍写一份，
# 保证未升级到对称守护的 oc 节点也能收到 DONE 通知；全节点升级后可删此分支。
# （定向给其它节点的通知不写 cc.notify.flag：它不是那些节点的消费路径，写了是噪声。）
if [ "$TARGET" = "oc-main" ]; then
    echo "$(date -Iseconds) ${TASK:-unknown}" >> "$WS/shared/cc-handoff/STATE/cc.notify.flag"
fi

echo "[notify] ${TASK:-unknown} → DONE/ + flag(notify.${TARGET}.flag) 已写"
