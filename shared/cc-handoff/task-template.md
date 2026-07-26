---
id: {task-id}                     # {PRIORITY}-{DATE}-{NODE}-{SLUG}
priority: P0                       # P0|P1|P2  (P0=立即 P1=当次会话 P2=有空)
status: pending                    # pending|in_progress|done|blocked|alert
created_by: oc-main
created_at: {YYYY-MM-DDTHH:mm+TZ}
claimed_by:                        # 认领节点填（claim-task.sh 自动写入）
claimed_at:
done_at:
node: cc-main                      # 执行节点；多节点扩展时按 STATE/nodes/ 注册
---

# Task: {task-id}

**From**: OpenClaw (小熊2号)
**To**: Claude Code
**Priority**: P0 / P1 / P2      <!-- P0=立即 P1=当次会话 P2=有空 -->
**Created**: {YYYY-MM-DDTHH:mm+TZ}
**Status**: NEW                  <!-- NEW / REWORK -->

## Context

{简要背景 — 这个任务为什么需要做。给足上下文，CC 看不到之前的对话。}

## Objective

{一句话目标}

## Acceptance Criteria

- [ ] {验收条件 1 — 尽量写成可验证的形式}
- [ ] {验收条件 2}
- [ ] {验收条件 3}

## Verification

{怎么确认做对了 — 跑哪个测试 / 命令 / 手动检查。若 AC 本身已可验证，此节可省。}

## Constraints

- 文件范围：{只改哪些文件/目录}
- 不碰：{禁止修改的}
- 测试要求：{需要跑哪些测试}

## Related Files

- {相关文件路径}
- {相关文档}

## Notes

{补充说明、假设、已知坑}
