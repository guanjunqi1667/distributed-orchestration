#!/usr/bin/env bash
# ── handoff-lock.sh — files 模式全局互斥锁（被其它脚本 source） ──
#
# 为什么需要锁：dual/db 模式靠 SQLite BEGIN IMMEDIATE 做认领互斥；
# files 模式（v1）只有裸 mv / cp，任务创建/扫描与 CC 认领可能并发：
#   - dispatch 写 INBOX 时 CC 读到半写文件
#   - daemon 扫目录时 CC 正在 mv 文件
#   - 多个 CC 抢同一任务（mv 本身原子，但「读到→再 mv」之间有 TOCTOU）
#
# 设计（与 docs/handoff-final-design.md §3 一致，mv 仍是单机互斥的根）：
#   - 全局单锁 STATE/handoff.lock（简单 > per-task 锁的复杂度，handoff 吞吐低）
#   - 独占(x)：任务状态变更（创建/认领/完成/归档）
#   - 共享(s)：只读扫描（handoff-daemon），不阻塞其它读、与写互斥
#   - 超时 HANDOFF_LOCK_WAIT(默认 30s)：超时返回 124 并报错（不静默继续）
#   - 释放：flock 绑定 FD 200，进程退出/被杀即自动释放（崩溃不留死锁）
#
# 用法（写，子壳——注意子壳变量不回传）：
#   with_handoff_lock x put_inbox
# 用法（读，需要变量回传——用内联 brace-group，见 handoff-daemon.sh）：
#   { flock -s -w "$HANDOFF_LOCK_WAIT" 200 || exit 124; ...; } 200>"$HANDOFF_LOCK"

# 锁路径：调用脚本应先设 HD（handoff 根）；否则回退默认。
: "${HD:=$HOME/.openclaw/workspace/shared/cc-handoff}"
HANDOFF_LOCK="${HANDOFF_LOCK:-$HD/STATE/handoff.lock}"
HANDOFF_LOCK_WAIT="${HANDOFF_LOCK_WAIT:-30}"
export HANDOFF_LOCK HANDOFF_LOCK_WAIT

# with_handoff_lock <x|s> <cmd...>
# 在持锁子壳里执行 cmd；返回 cmd 的退出码（锁超时返回 124）。
with_handoff_lock() {
  local mode="$1"; shift
  case "$mode" in x|s) ;; *) echo "[handoff-lock] ⚠ 未知锁模式 '$mode'（应为 x|s）" >&2; return 2 ;; esac
  (
    flock "-${mode}" -w "${HANDOFF_LOCK_WAIT}" 200 \
      || { echo "[handoff-lock] ⚠ 获取 ${mode} 锁超时(${HANDOFF_LOCK_WAIT}s)，放弃" >&2; exit 124; }
    "$@"
  ) 200>"$HANDOFF_LOCK"
}
