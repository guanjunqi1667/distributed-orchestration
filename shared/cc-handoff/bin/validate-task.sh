#!/usr/bin/env bash
# ── validate-task.sh — Handoff 任务入站格式验证 ──
#
# 职责：检查 INBOX/ 中每个 .md 文件是否遵守任务/消息模板格式。
#       不通过的任务不进入认领流程，退回发送方。
#
# 验证规则：
#   - 所有任务必须有 frontmatter（以 --- 开头和结尾）
#   - type=task：必须有 id / priority / created_by / created_at / node / title
#     + Objective / Acceptance Criteria
#   - type=note：必须有 id / type=note / created_by / created_at / node
#   - status 必须在白名单内
#   - node 必须为已知节点或 any
#
# 用法：
#   validate-task.sh <INBOX_DIR> [--strict]
#   validate-task.sh <file.md>   (单文件)
#
# 集成：
#   claim-task.sh 在 mv INBOX→IN_PROGRESS 前调用本脚本
#   handoff-watch.py 发现新任务时先跑验证
#   注：不用 set -e。validate_file 靠显式累加 errors/return 报错；
#       set -e 会让“提取缺失字段(grep 无匹配)”直接 abort、丢失全部诊断，
#       且被 claim-task.sh source 时会把 -e 泄漏给调用方。故仅 set -uo pipefail。
set -uo pipefail

VALID_TYPES="task|note|alert|question|ack"
VALID_STATUS="pending|in_progress|done|blocked|alert|NEW|REWORK"
VALID_NODES="any|oc-main|cc-main|threesky|codex_cherry_mac|guanj_oc|guanj_cc"

RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; NC='\033[0m'

errors=0
warnings=0

validate_file() {
  local f="$1"
  local bn
  bn=$(basename "$f")
  local fe=0
  local fw=0
  local msg=""

  # 读取 frontmatter
  local fm=""
  fm=$(sed -n '/^---$/,/^---$/p' "$f" 2>/dev/null || true)
  if [ -z "$fm" ]; then
    echo -e "${RED}❌ $bn: 缺少 frontmatter（--- 包围的元数据块）${NC}"
    return 1
  fi

  # 提取字段
  local id type status priority created_by node
  id=$(echo "$fm" | grep -E "^id:" | head -1 | sed 's/^id:[[:space:]]*//; s/[[:space:]]*#.*//')
  type=$(echo "$fm" | grep -E "^type:" | head -1 | sed 's/^type:[[:space:]]*//; s/[[:space:]]*#.*//')
  status=$(echo "$fm" | grep -E "^status:" | head -1 | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*//')
  priority=$(echo "$fm" | grep -E "^priority:" | head -1 | sed 's/^priority:[[:space:]]*//; s/[[:space:]]*#.*//')
  created_by=$(echo "$fm" | grep -E "^created_by:" | head -1 | sed 's/^created_by:[[:space:]]*//; s/[[:space:]]*#.*//')
  node=$(echo "$fm" | grep -E "^node:" | head -1 | sed 's/^node:[[:space:]]*//; s/[[:space:]]*#.*//')
  created_at=$(echo "$fm" | grep -E "^created_at:" | head -1 | sed 's/^created_at:[[:space:]]*//; s/[[:space:]]*#.*//')

  # ── 通用必填字段 ──
  [ -z "$id" ] && { echo -e "${RED}❌ $bn: 缺少 id${NC}"; fe=$((fe+1)); }
  [ -z "$type" ] && { echo -e "${RED}❌ $bn: 缺少 type（允许: $VALID_TYPES）${NC}"; fe=$((fe+1)); }
  [ -z "$created_by" ] && { echo -e "${RED}❌ $bn: 缺少 created_by${NC}"; fe=$((fe+1)); }
  [ -z "$created_at" ] && { echo -e "${RED}❌ $bn: 缺少 created_at${NC}"; fe=$((fe+1)); }
  [ -z "$node" ] && { echo -e "${RED}❌ $bn: 缺少 node（允许: $VALID_NODES）${NC}"; fe=$((fe+1)); }

  # ── status 校验 ──
  if [ -n "$status" ]; then
    echo "$VALID_STATUS" | grep -qw "$status" || {
      echo -e "${YEL}⚠️  $bn: status='$status' 不在白名单（$VALID_STATUS）${NC}"; fw=$((fw+1));
    }
  fi

  # ── type=task 额外校验：必须有 Objective + AC ──
  if [ "$type" = "task" ]; then
    if ! grep -q "^## Objective" "$f" 2>/dev/null; then
      echo -e "${RED}❌ $bn: type=task 但缺少 ## Objective${NC}"; fe=$((fe+1));
    fi
    if ! grep -q "^## Acceptance Criteria" "$f" 2>/dev/null; then
      echo -e "${RED}❌ $bn: type=task 但缺少 ## Acceptance Criteria${NC}"; fe=$((fe+1));
    fi
    [ -z "$priority" ] && { echo -e "${YEL}⚠️  $bn: type=task 建议设置 priority（P0|P1|P2）${NC}"; fw=$((fw+1)); }
  fi

  # ── type=note 校验 ──
  if [ "$type" = "note" ]; then
    if [ -z "$priority" ]; then
      priority="P2"  # note 默认 P2
    fi
  fi

  # ── node 校验 ──
  if [ -n "$node" ]; then
    echo "$VALID_NODES" | grep -qw "$node" || {
      echo -e "${YEL}⚠️  $bn: node='$node' 未知（白名单: $VALID_NODES）${NC}"; fw=$((fw+1));
    }
  fi

  errors=$((errors + fe))
  warnings=$((warnings + fw))

  if [ "$fe" -gt 0 ]; then
    return 1
  fi
  return 0
}

# ── 入口（仅直接执行时运行；被 claim-task.sh source 时跳过，避免把调用方 $1 当文件路径而 exit）──
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
if [ $# -eq 0 ]; then
  echo "用法: validate-task.sh <文件.md> | <INBOX目录>"
  exit 1
fi

TARGET="$1"

if [ -f "$TARGET" ]; then
  # 单文件验证
  validate_file "$TARGET"
  rc=$?
  echo ""
  echo -e "${GRN}=== 结果: $errors 错误, $warnings 警告 ===${NC}"
  exit $rc

elif [ -d "$TARGET" ]; then
  # 目录批量验证
  passed=0
  failed=0
  for f in "$TARGET"/*.md; do
    [ -f "$f" ] || continue
    bn=$(basename "$f" .md)
    [ "$bn" = "README" ] && continue
    if validate_file "$f"; then
      passed=$((passed+1))
    else
      failed=$((failed+1))
    fi
  done

  echo ""
  echo -e "${GRN}=== 验证完成: $passed 通过, $failed 失败, $warnings 警告 ===${NC}"
  [ "$failed" -gt 0 ] && exit 1
  exit 0

else
  echo "路径不存在: $TARGET"
  exit 1
fi
fi  # end: 仅直接执行时运行入口（BASH_SOURCE guard）
