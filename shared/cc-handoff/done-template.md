---
id: {task-id}
priority: P0
status: done
created_by: oc-main
created_at: {YYYY-MM-DDTHH:mm+TZ}
claimed_by: cc-main
claimed_at: {YYYY-MM-DDTHH:mm+TZ}
done_at: {YYYY-MM-DDTHH:mm+TZ}
node: cc-main
---

# Done: {task-id}

**From**: Claude Code
**To**: OpenClaw (小熊2号)
**Completed**: {YYYY-MM-DDTHH:mm+TZ}
**Tokens**: {本次任务 token 消耗，如 12345 或 ~12k；无法确定写 unknown}
<!-- Tokens 来源：~/.claude/projects/<proj>/ 下最近修改的 *.jsonl，对各 message.usage 的 input+cache_read+cache_creation+output 求和（约值即可） -->
**Status**: DONE               <!-- DONE / BLOCKED / PARTIAL -->
<!-- 认领协议（reserve-before-execute）：下列改动等副作用，仅在任务被认领
     （mv INBOX→IN_PROGRESS）之后产生；完成顺序为先写 DONE 再归档。
     单机下认领即一次原子 mv；详见 ../README.md §任务认领、../docs/handoff-final-design.md §3。 -->

## Summary

{一两句话 — 做了什么}

## Changes

- `path/to/file` — {改了什么}
- `path/to/file2` — {改了什么}

## Verification / Test Results

```
{测试命令 + 关键输出}
```

## Acceptance Criteria

- [x] / [ ] {逐条对照原 task 的 AC}

## Issues / Notes

{遇到的问题、偏离 scope 的地方、需要 OpenClaw 知道的}

## Next Steps for OpenClaw

{是否需要 OpenClaw 后续动作 — 审查、合并、部署、通知老板、返工等。无需则填「无」。}
