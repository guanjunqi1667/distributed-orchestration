# Verify: P1-20260725-split-hook1

**Author**: Claude Code
**File**: `plugins/harness-hooks/src/index.ts`
**Date**: 2026-07-25

## 目标
拆 `before_prompt_build`（Hook 1，~475 行 god-function）为可维护 pure helper，不改状态机流。

## 抽取的 4 个 pure helper（顶层，1673–1706）
1. `isResumeRetryCommand(text)` — verify / integration 的"继续/重试"指令检测（消除 Hook 内 2 处重复正则）
2. `parseReviewVerdict(reportFile)` — 读 code-reviewer `review-report.md` 头部，解析 ACCEPT/REVISE/BLOCKED（读文件+正则抽出；state 应用留 Hook）
3. `buildLongTaskGrillInject()` — LONG task → grill-first 路由注入串（大段常量抽出）
4. `isStaleSubagent(info, now, staleMs)` — trace 对账的 stale 判定

## Hook 1 内 5 处替换（等价行为）
| 位置 | 原 | 新 |
|---|---|---|
| LONG task 路由 | 内联 13 行注入数组 | `buildLongTaskGrillInject().join("\n")` |
| Gap2A review 解析 | `existsSync`+`try`+`readFileSync`+3 正则 | `parseReviewVerdict(reportFile)` + 应用逻辑 |
| verify 重试判定 | 内联正则 | `isResumeRetryCommand(userText)` |
| integration 重试判定 | 内联正则 | `isResumeRetryCommand(userText)` |
| trace stale 判定 | 内联复合条件 | `isStaleSubagent(info, now, SIXTY_SEC)` |

## 等价性
- 4 helper 均为 **pure**（无 state mutation、无控制流副作用）。
- 调用点行为与原内联**逐字等价**（正则 / 条件 / 返回值不变）。
- **未改**：状态机（`saveState`/`loadState`/`advanceCTState`/`transitionState` 调用未动）、Soul Gate、failure arbiter、tool handler 签名。
- Gap2A 的 state 应用逻辑（SPEC_REVIEW / QUALITY_REVIEW 的 if 块）**原样保留**，仅解析层抽出。

## 验证
```
cp src/index.ts src/index.ts.bak.<ts>          # 改前备份 ✅
tsc -p tsconfig.json        # exit 2（45 预存类型错，自 :521 起，与本次无关；noEmitOnError=false → emit 正常）
node --check dist/index.js  # → PASS ✅
# Hook 内残留内联 retry 正则：0（全替换）
# helper 调用：isResumeRetryCommand×2 / parseReviewVerdict×1 / buildLongTaskGrillInject×1 / isStaleSubagent×1
```

## 行数
2762 → 2779（+17）：helper 函数样板净增，内联删减；拆分不为加代码，增幅可控。

## 留意
- 1976 `SUSPECTED_STUCK` 的恢复正则（`recover|proceed`）**未抽**——与 retry 正则不同、仅 1 处，抽取消益低。
- 预存类型错（45 处，自 `:521`）建议 OpenClaw 后续单独处理（放宽 SDK 事件类型 / CI 区分 lint vs emit）——与 P1-harness-hooks REVIEW 同一建议。
