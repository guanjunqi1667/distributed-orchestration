# Review: P2-20260725-cc-skills-handoff

**Reviewer**: Claude Code (GLM-5.2)
**Date**: 2026-07-25
**Subject**: 8 个 OpenClaw skill 是否值得纳入 CC 工作流

## 总结论：**8 选 2 落地，其余引用/已覆盖**

我的全局 `~/.claude/CLAUDE.md` 已经覆盖了这批 skill 里多数的*精神*（§1 Think Before Coding / §2 Simplicity / §3 Surgical / §4 Goal-Driven / §5 Plan / §6 Verify / §8 Bias-to-Action）。所以采纳要克制——只把**我现有守则里没有、且可操作**的机制合并进去，避免和已有规则重复制造噪音。

**采纳（合并成 1 条守则写入项目 `.claude/CLAUDE.md`）**：doubt-driven-development（对抗式 fresh-context 审查）+ triage（排障：复现→核对全部症状）+ grill-me（三层快检）。
**不采纳（已覆盖）**：ponytail、writing-plans。
**仅引用（场景化/OpenClaw 耦合，不当常驻守则）**：improve-codebase-architecture、grill-with-docs、source-deep-dive。

## 逐个判定

| # | Skill | 对 CC 价值 | 判定 | 理由 |
|---|---|---|---|---|
| 1 | doubt-driven-development | 高 | **采纳（机制）** | 「非平凡决策→开 fresh-context 子 agent 对抗式审查（找问题不盖章），只传 artifact+contract 不传结论」是我现有守则没有的可操作机制，且我有 Agent 工具能真做。现有 §1 只说「surface tradeoffs/push back」，没有「spawn 独立 fresh-context reviewer 去证伪」。 |
| 2 | writing-plans | 中 | **不采纳** | 重型 plan 文档（docs/plans/、worktree、TDD 分步、subagent-driven 执行）面向 greenfield 功能开发；与本 handoff 的 task-driven 节奏冲突，也会和我的 §8（Bias-to-Action）打架。我的 §5「先发简短 plan+假设，然后继续」更合身。 |
| 3 | ponytail | — | **不采纳（已覆盖）** | YAGNI ladder（要存在?→复用?→stdlib?→平台?→已有依赖?→一行?→最小）≈ 我的 §2 Simplicity + §3 Surgical。「deletion over addition / no unrequested abstraction」几乎是 §2 原文。重复写入只增噪音。 |
| 4 | improve-codebase-architecture | 中（场景化） | **仅引用** | deep vs shallow module、deletion test、seam 是好的架构分析透镜，但它是个*专项审查工具*（产出 HTML 报告 + blind review），且耦合 OpenClaw artifact（memory/kb/templates/adr、CONTEXT.md）。架构审查任务时再调，不当常驻守则。 |
| 5 | grill-me | 中 | **采纳（精简）** | 三层追问（数据支撑 / 更简单替代 / 二阶效应）是个紧凑的 pre-flight 清单，比我的 §1「ask if unclear」更结构化。采纳为「接非平凡任务前自检」，但去掉角色化输出格式（不适合 CC 日常）。 |
| 6 | grill-with-docs | 中（场景化） | **仅引用** | grill-me 的文档约束版（CONTEXT/ADR/ARCHITECTURE_MAP）。耦合 memory/decisions、memory/kb 路径，且只在「方案触碰已有架构边界」时有意义。触及时再调。 |
| 7 | source-deep-dive | 中（场景化） | **仅引用** | 深读 repo/论文的方法论。有用 nuggets（inventory-before-judgment、Adopt/Reject/Defer、planner gate），但整体是 OpenClaw 耦合的重型研究管线（memory/wiki/sources 持久化、git clone 流程）。读陌生代码库时参考其原则，不当常驻守则。 |
| 8 | triage | 高 | **采纳（流程）** | 系统化排障：复现(≤3min)→定位(含已知模式扫描)→根因验证清单→分级修复→**分步验证（主症状+全部症状覆盖+边界）**。这是我最常做的事（修 bug），而我的 §6 只说「跑测试」，没有「核对*全部*症状 + 边界」、没有「先扫已知模式」。采纳*流程*，不采纳 OpenClaw 耦合的 artifact 路径（memory/lessons/triage-patterns.md、validator、_meta.json 等不归我写）。 |

## 落地：拟写入 `.claude/CLAUDE.md` 的合并守则（⚠ 被权限拦截，未写入）

把 1/5/8 三个采纳项合并成**一条**（遵循 Constraints「不要一个 skill 一段」）。但 `.claude/CLAUDE.md` 被 harness 标为 sensitive file，Edit 调用被拒（未重试）。**拟新增内容如下，供 OpenClaw 直接落地**（插在「工作守则」第 7 条后）：

```
8. **非平凡决策/排障：先证伪再相信**（合并自 doubt-driven / triage / grill）
   - **非平凡决策**（分支逻辑 / 跨边界 / 不可逆动作）落地前，开一个 fresh-context 子 agent 做**对抗式审查**——让它找问题、不要盖章，只传 artifact+contract、不传你的结论。
   - **修 bug**：先**复现**拿到真实错误再改；改完不只验主症状，要核对**全部症状 + 边界**是否都被消除；先扫已知模式再深挖。
   - **接非平凡任务前**三层快检：数据有支撑吗 / 有更简单的做法吗 / 二阶效应会打破什么。
   - 注：YAGNI/最小改动（ponytail）已被全局守则覆盖、重型 plan 文档（writing-plans）与本 handoff 节奏不合身，均不单列——依据见本 REVIEW。
```

未采纳项（ponytail / writing-plans / improve-codebase-architecture / grill-with-docs / source-deep-dive）的理由留在本 REVIEW，不在 CLAUDE.md 占位。

## Changes

- `shared/cc-handoff/REVIEW/P2-20260725-cc-skills-handoff-review.md` — 本评估报告（新建）。
- `.claude/CLAUDE.md` — ⚠ **未改**（sensitive-file 权限拦截）。拟加内容见上「落地」节，原文已给出，OpenClaw 可直接应用或重新授权 CC 写入。

## Constraints 遵守

- 只读评估了 8 个 skill 文件，未改任何 OpenClaw 核心 skill。
- 未改 `memory/`、`contracts/`、`settings.json`（env/hooks/core）。
- `.claude/CLAUDE.md` **尝试改但被 sensitive-file 权限拦截，最终未改**；拟加内容（合并单条、风格统一）原文已列在「落地」节。

## Next Steps for OpenClaw

- 若希望 CC 在排障时把根因模式沉淀到 `memory/lessons/triage-patterns.md`，需确认该文件 CC 可写（目前 memory/ 对 CC 只读）；否则 CC 只在 DONE/REVIEW 里记录根因。
- improve-codebase-architecture / source-deep-dive 的 OpenClaw 耦合 artifact（adr-template、wiki/sources 路径）若要给 CC 用，建议另出「CC-friendly 精简版」任务。
