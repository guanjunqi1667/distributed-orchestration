#!/usr/bin/env bash
# ── frontmatter.sh — 任务文件 YAML frontmatter 字段读取（被 daemon/dispatch source）──
#
# 为什么：新规范（P0-20260725-directory-schema-restructure）要求任务文件带 YAML
# frontmatter（id/priority/status/created_by/claimed_by/.../node）。daemon/dispatch
# 需要无侵入地读出这些字段（多节点路由、优先级、认领节点），同时兼容旧文件（无
# frontmatter → 返回空，调用方回退到旧解析）。
#
# 仅支持扁平 `key: value`（任务 frontmatter 全是扁平字段）；不支持嵌套/数组。
# 无 frontmatter（首行非 `---`）或无该 key → 打印空串、返回 0。
#
# 用法（source 后）:
#   . "$HD/bin/frontmatter.sh"
#   val=$(fm_field "$file" node)        # 读 node；旧文件 → 空
fm_field() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -v k="$key" '
    NR==1 && $0 !~ /^---[[:space:]]*$/ { exit }     # 首行非 --- = 无 frontmatter，直接退出
    /^---[[:space:]]*$/            { c++; next }    # 开/闭标记：c==1 进入，c==2 结束
    c==1 && index($0, ":") {                         # 仅在 frontmatter 内、且有冒号
      p = index($0, ":"); fk = substr($0, 1, p-1); gsub(/[[:space:]]/, "", fk)
      if (fk == k) {
        v = substr($0, p+1); sub(/^[[:space:]]*/, "", v); sub(/[[:space:]]*$/, "", v)
        if (v ~ /^".*"$/) { sub(/^"/, "", v); sub(/"$/, "", v) }   # 去掉成对双引号
        print v; exit
      }
    }
  ' "$file" 2>/dev/null
}
