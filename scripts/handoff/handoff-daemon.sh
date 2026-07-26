#!/usr/bin/env bash
# ── Handoff Daemon — 对称多节点守护 ──
# 职责：heartbeat + INBOX 扫描 + 自动认领（node=self 或 any）+ DONE/ALERT 通知
# 设计原则：所有节点对称，无中心。通过 LOCAL_NODE 可配，cron 部署到任意节点。
#
# cron 示例（oc-main 节点）：
#   */3 * * * * /path/to/handoff-daemon.sh >> /tmp/handoff-daemon.log 2>&1
# cron 示例（cc-main 节点）：
#   HANDOFF_NODE=cc-main */3 * * * * /path/to/handoff-daemon.sh >> /tmp/handoff-daemon.log 2>&1
set -euo pipefail

WS="${HOME}/.openclaw/workspace"
HD="${WS}/shared/cc-handoff"
STATE_DIR="${HD}/STATE"
INBOX_DIR="${HD}/INBOX"
INPROG_DIR="${HD}/IN_PROGRESS"
DONE_DIR="${HD}/DONE"
ALERT_DIR="${HD}/ALERT"
ARCHIVE_DIR="${HD}/INBOX_ARCHIVE"
FLAG_DIR="${HD}/STATE"
NOTIFY_FLAG="${FLAG_DIR}/notify.flag"
HANDOFF_STATE_DIR="${WS}/.state"

# ── 节点身份（可配，默认 oc-main 向后兼容） ──
LOCAL_NODE="${HANDOFF_NODE:-oc-main}"
HB="${FLAG_DIR}/${LOCAL_NODE}.heartbeat"
DONE_FLAG="${FLAG_DIR}/.${LOCAL_NODE}_done_seen"
ALERT_FLAG="${FLAG_DIR}/.${LOCAL_NODE}_alert_seen"
PENDING_FILE="${HANDOFF_STATE_DIR}/handoff-task-pending-${LOCAL_NODE}.txt"

# files 模式全局锁（扫描持共享读锁，与 dispatch 写入 / CC 认领互斥）
. "${HD}/bin/handoff-lock.sh"
. "${HD}/bin/frontmatter.sh"

mkdir -p "${STATE_DIR}" "${FLAG_DIR}" 2>/dev/null || true
touch "${DONE_FLAG}" "${ALERT_FLAG}" 2>/dev/null || true

now=$(date -Iseconds)
session="${LOCAL_NODE}"

# ── 1. 初始化 ──
working_on=""
claimed=""
MY_PENDING=""  # 待认领任务ID
for_me=""      # INBOX 中定向给我的任务
not_for_me=""  # INBOX 中我投递的、但非定向给我的任务
mkdir -p "${HANDOFF_STATE_DIR}" 2>/dev/null || true


# 扫描任务目录（共享读锁：与 dispatch 写入 / CC 认领互斥，保证快照一致）
{
  flock -s -w "${HANDOFF_LOCK_WAIT}" 200 || { echo "[${LOCAL_NODE}-daemon] ⚠ 读锁超时(${HANDOFF_LOCK_WAIT}s)" >&2; exit 124; }

# --- INBOX 扫描（对称路由） ---
# 每个节点独立扫描，认领 node=自己 或 node=any 的任务
if [ -d "$INBOX_DIR" ]; then
    for f in "$INBOX_DIR"/*.md; do
        [ -f "$f" ] || continue
        task_name=$(basename "$f" .md)
        [ "$task_name" = "README" ] && continue
        tn=$(fm_field "$f" node)
        cb=$(fm_field "$f" created_by)

        # 路由优先按 node 字段判断：
        #   node=空/any/LOCAL_NODE → 归我
        #   node=其他 → 跳过（留给对应节点）
        # 无 node 字段时回退到 created_by 检测（旧文件兼容）
        if [ -z "$tn" ] || [ "$tn" = "any" ] || [ "$tn" = "$LOCAL_NODE" ]; then
            for_me="$for_me $task_name"
        elif [ "$tn" = "oc" ] && [ "$LOCAL_NODE" = "oc-main" ]; then
            # 旧名兼容：oc = oc-main
            for_me="$for_me $task_name"
        elif [ "$tn" = "cc" ] && [ "$LOCAL_NODE" = "cc-main" ]; then
            # 旧名兼容：cc = cc-main
            for_me="$for_me $task_name"
        else
            # node 指向别人 → 不认领，但记录我投递的（通知用）
            case "$cb" in
              "$LOCAL_NODE"|openclaw|OpenClaw)
                not_for_me="$not_for_me $task_name" ;;
              *)
                if grep -q "${LOCAL_NODE}\|小熊2号" "$f" 2>/dev/null; then
                    not_for_me="$not_for_me $task_name"
                fi ;;
            esac
        fi
    done
fi

# ── 2. 扫描 DONE/ ──
new_done=""
if [ -d "${DONE_DIR}" ]; then
    for f in "${DONE_DIR}"/*.md; do
        [ -f "$f" ] || continue
        task_id=$(basename "$f" .md)
        if ! grep -qFx "${task_id}" "${DONE_FLAG}" 2>/dev/null; then
            new_done="${new_done} ${task_id}"
        fi
    done
fi

# ── 3. 扫描 ALERT/ ──
new_alerts=""
if [ -d "${ALERT_DIR}" ]; then
    for f in "${ALERT_DIR}"/*.md; do
        [ -f "$f" ] || continue
        alert_id=$(basename "$f" .md)
        [ "$alert_id" = "README" ] && continue
        if ! grep -qFx "${alert_id}" "${ALERT_FLAG}" 2>/dev/null; then
            new_alerts="${new_alerts} ${alert_id}"
        fi
    done
fi

} 200>"$HANDOFF_LOCK"   # 释放共享读锁（FD 关闭即解锁）

# ── 自动认领（独占锁 mv INBOX→IN_PROGRESS） ──
if [ -n "${for_me# }" ]; then
    for t in $for_me; do
        src="$INBOX_DIR/$t.md"
        [ -f "$src" ] || continue
        dst="$INPROG_DIR/$t.md"
        # 如果 DONE 已存在 → 清理残留
        if [ -f "$DONE_DIR/$t.md" ]; then
            with_handoff_lock x mv "$src" "$ARCHIVE_DIR/$t.md" 2>/dev/null || true
            echo "[${LOCAL_NODE}-daemon] 🗑  清理过期 INBOX 残留: $t（已存在于 DONE）"
            continue
        fi
        # 如果已在 IN_PROGRESS → 跳过
        [ -f "$dst" ] && continue
        # 独占锁认领
        if with_handoff_lock x sh -c "mv \"$src\" \"$dst\"" 2>/dev/null; then
            claimed="$claimed $t"
            MY_PENDING="$MY_PENDING $t"
        else
            echo "[${LOCAL_NODE}-daemon] ⚠ 认领失败（锁超时/冲突）: $t" >&2
        fi
    done
fi

# ── 状态标记 ──
if [ -n "${MY_PENDING# }" ]; then
    echo "${now}  pending:${MY_PENDING}" > "${PENDING_FILE}"
    working_on="handoff:${MY_PENDING}"
elif [ -f "${PENDING_FILE}" ]; then
    rm -f "${PENDING_FILE}"
fi

# ── stale 检测 ──
is_stale() {
  local hb="$1"
  local last_seen now diff
  last_seen=$(grep -o '"last_seen":"[^"]*"' "$hb" 2>/dev/null | head -1 | cut -d'"' -f4)
  [ -z "$last_seen" ] && return 0
  now=$(date +%s)
  case "$last_seen" in
    *+*|*Z*) diff=$(( now - $(date -d "$last_seen" +%s 2>/dev/null || echo 0) )) ;;
    *)       diff=$(( now - $(date -d "${last_seen%+*}" +%s 2>/dev/null || echo 0) )) ;;
  esac
  [ "$diff" -gt 300 ]
}

# ── 4. 更新 heartbeat ──
cat > "${HB}" <<HEOF
{"status":"alive","working_on":"${working_on}","last_seen":"${now}","session":"${session}"}
HEOF

# ── 5. 输出摘要 ──
# 显示所有已知节点的 heartbeat 摘要（动态扫描）
node_summary=""
for hb_file in "$STATE_DIR"/*.heartbeat; do
    [ -f "$hb_file" ] || continue
    nid=$(basename "$hb_file" .heartbeat)
    st=$(grep -o '"status":"[^"]*"' "$hb_file" 2>/dev/null | head -1 | cut -d'"' -f4)
    if [ "$st" = "alive" ] && is_stale "$hb_file"; then
        st="STALE"
    fi
    node_summary="${node_summary} ${nid}=${st}"
done

echo "[${LOCAL_NODE}-daemon] $(date +%H:%M:%S) nodes:${node_summary}"

if [ -n "${claimed# }" ]; then
    echo "[${LOCAL_NODE}-daemon] 🤖 已自动认领:${claimed}"
fi

if [ -n "${not_for_me}" ]; then
    echo "[${LOCAL_NODE}-daemon] 📥 未认领（我投递/定向他人）:${not_for_me}"
    echo "NOT_FOR_ME${not_for_me}" >> "${NOTIFY_FLAG}"
fi

if [ -n "${new_done}" ]; then
    echo "[${LOCAL_NODE}-daemon] 📬 新 DONE:${new_done}"
    for tid in ${new_done}; do
        echo "${tid}" >> "${DONE_FLAG}"
    done
    echo "NEW_DONE${new_done}" >> "${NOTIFY_FLAG}"
fi

if [ -n "${new_alerts}" ]; then
    echo "[${LOCAL_NODE}-daemon] 🚨 新 ALERT:${new_alerts}"
    for aid in ${new_alerts}; do
        echo "${aid}" >> "${ALERT_FLAG}"
        echo "NEW_ALERT${new_alerts}" >> "${NOTIFY_FLAG}"
    done
fi

# ── 6. 消费通知标记（对称：扫描所有 notify.<self>.flag 来源） ──
for nf in "${STATE_DIR}"/notify."${LOCAL_NODE}".flag; do
    [ -f "$nf" ] || continue
    echo "[${LOCAL_NODE}-daemon] 📩 收到通知: $(basename "$nf")"
    rm -f "$nf"
done
# 也消费旧格式（向后兼容）
if [ -f "${STATE_DIR}/cc.notify.flag" ] && [ "${LOCAL_NODE}" = "oc-main" ]; then
    echo "[${LOCAL_NODE}-daemon] CC 旧格式通知标记存在"
    rm -f "${STATE_DIR}/cc.notify.flag"
fi

exit 0
