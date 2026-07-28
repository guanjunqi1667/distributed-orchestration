# Review: P1-20260725-optimize-memory-architecture

**Reviewer**: Claude Code
**Date**: 2026-07-25
**Subject**: OpenClaw 自建记忆架构审查
**Scope**: 三层架构边界 / 增强层检索 / token 开销 / truth↔wiki 同步 / 资源

---

## 核心结论：任务 Context 已过时，增强层已自然收敛

任务 Context 描述的「3 套并行方案（QMD / memory-core / local-memory-adapter）+ embedding worker 530MB + QMD 2.8G cache + 505 .md」**与当前实际严重不符**。勘察实证：

| 任务 Context（旧） | 当前实际 |
|---|---|
| memory-core embedding worker PID 43164，530MB 常驻 | **进程已死**；plugin 目录不存在；脚本无引用 → **彻底下线** |
| QMD 2.8G cache | 已清；`~/.openclaw/qmd/` 4K；数据只剩 `agents/main/qmd/` 8.8M |
| 505 个 .md | 实际 **838** 个（workspace/memory/） |
| local-memory-recall extension | `.openclaw/extensions/local-memory-recall/` **已移除** |
| 3 套并行检索冗余 | 实际是 **`recall/pipeline.py` 单管道编排多后端**（见下） |

**「3 套冗余」这个原始命题已不成立**——memory-core 早已下线。真正的当前问题不一样（见第 4 节）。

---

## 1. 三层架构边界（仍清晰，但文档落后于实现）

- **Truth**（`memory/*.md`、`projects/`、`decisions/`）：边界清晰，838 md，是主档。
- **Knowledge**（`memory/wiki/`）：骨架在（index.md + log.md + kb-to-wiki-map.json），但**内容严重不全**——`entities/` 0 个、`synthesis/` 仅 2 个；只有 `topics/`(51) 和 `sources/`(62) 在用。INTERFACE.md 规范了 entities/synthesis 但实际没填充。
- **Augmentation**（检索管道）：从「3 套并行」收敛为 `recall/pipeline.py` 单管道（下节）。

边界本身没问题；问题是**文档（decisions 2026-03-12、INTERFACE）描述的增强层已和实现脱节**。

## 2. 检索实际链路：`recall/pipeline.py`（单管道，多后端）

`scripts/recall/pipeline.py` 是当前主检索，多阶段 + 时间预算（总 3600ms / hard cut 3600ms）：

```
cache_check(5ms) → fastpath(200ms, recall-fastpath.py) → rule_index(100ms)
→ collect_hits(200ms) → verify(150ms, recall-verify.py) → fallback(800ms: QMD+ontology)
→ agentmemory(250ms) → rag_anything(400ms)
```

- **QMD**：在 `fallback` 阶段（注释 "reliable QMD/ontology"），数据在 `agents/main/qmd/`(8.8M)。
- **memory-core**：**不在 stages 里**（下线确认）。
- **agentmemory / rag_anything**：两个独立后端（agent DB sqlite / 一个 RAG）。

所以真实检索后端是：**fastpath + rule_index + QMD-fallback + agentmemory + rag_anything**（5 个），不是任务说的 3 个。

## 3. 原命题「3 套冗余」复核

| 方案 | 状态 | 结论 |
|---|---|---|
| **memory-core** | plugin 不在、worker 死、无引用 | ✅ 已下线，无冗余 |
| **local-memory-adapter** | project 还在，`mock-service/` 仍是 mock | ⚠️ 未投产也未正式下线（僵死状态） |
| **QMD** | 在 recall/pipeline 的 fallback 阶段，agents/main/qmd 8.8M | ✅ 在用（作为 fallback） |

→ 3 套里 1 套下线、1 套在用、1 套 mock 僵死。**冗余已基本消除**，剩 adapter 的 mock 僵死要决策。

## 4. 当前真问题（任务没提到的）

1. **`recall/pipeline.py` 的 5 后端可能有新重叠**：fastpath / rule_index / QMD-fallback / agentmemory / rag_anything —— 哪些命中重叠？这才是当前冗余点（任务说的 3 套已收敛，但 pipeline 多后端未审）。
2. **local-memory-adapter 僵死**：mock 状态最差——占项目空间、文档维护，但不服役。要么投产要么标记废弃。
3. **wiki 知识层半空**：INTERFACE 规范 entities/synthesis，但 entities 0、synthesis 2。规范与实现脱节。
4. **QMD 数据位置不统一**：`agents/main/qmd/`(8.8M) 有数据，`workspace/memory/qmd/` 空，`skills/qmd/` 24K。三处，规范位置不明。
5. **文档全面过时**：decisions/2026-03-12（提 local-memory-recall extension，已移除）、任务 Context 本身、部分 lessons——描述的增强层已不存在，新读者会被误导。
6. **agent DB 646MB**（main 258M、code-reviewer 133M、coder-tester 134M、requirements-planner 124M）——4 个独立 DB，是否需要归档/清理旧记录？（触及 agent 核心，谨慎）

## 5. Token / 上下文开销

- `recall/pipeline.py` 注释明确「Recall 注入 compact observation cards，不默认 summary」+ progressive disclosure——**设计上已克制**（符合架构决策）。
- harness-hooks 的 `MEMORY_ROUTING_INJECT`（QMD 优先路由串）是常量注入，短。
- 未发现过度注入的明显证据。但 5 后端各自的注入格式未统一审（建议 follow-up 测一次 recall 的实际 token 输出）。

## 6. truth ↔ wiki 同步

- `wiki/index.md` + `log.md` + `kb-to-wiki-map.json` 都在（同步骨架完整）。
- `memory/kb/` 19 文件（INTERFACE 说 legacy 只读）——仍在，未清理（低优先）。
- **同步内容不全**：entities/synthesis 空壳（见问题 3）。

---

## 建议（按价值排序）

### 建议 1（最高）：更新过时架构文档 ⭐
`decisions/2026-03-12-memory-architecture.md` + 任务 Context + 相关 lessons 仍描述 memory-core/3 套并行/local-memory-recall extension——这些已不存在。**改写为当前实际**（recall/pipeline 多后端 + memory-core 已下线 + adapter mock）。否则下一个审查者/CC 又被误导（本任务就是受害者——基于过时 Context 卡了）。这是「文档债」。

### 建议 2：审 `recall/pipeline.py` 的 5 后端重叠
这才是当前真冗余点。fastpath/rule_index/QMD-fallback/agentmemory/rag_anything 各自命中率 + 重叠？跑一次 recall 看各 stage 命中分布，收敛低命中后端。单开任务。

### 建议 3：决策 local-memory-adapter
mock 僵死 = 维护成本无产出。**投产 or 标记废弃**（二选一）。若废弃，移除 project + 清引用；若投产，完成 mock→real。现状最差。

### 建议 4：统一 QMD 数据位置
QMD 数据在 `agents/main/qmd/`(8.8M)，但 `workspace/memory/qmd/` 空、`skills/qmd/` 24K。明确规范位置（建议 `agents/main/qmd/` 统一），其余清/软链。

### 建议 5：wiki 知识层对齐
entities/synthesis 空壳。**要么填充，要么从 INTERFACE.md 降级**（承认知识层只用 topics/sources）。别留规范与实现脱节。

### 建议 6（低）：agent DB 归档
646MB / 4 DB，main 258M。评估归档旧记录（触及 agent 核心，需 OpenClaw 决策）。

---

## 安全修复（Constraints 受限）

Constraints 禁止改 `memory/*.md` truth / Gateway 核心 / tool 行为。能改的「配置/文件」空间很小。**本审查未做直接改动**——以上 6 条建议中：
- 建议 1（更新文档）：改的是 `memory/decisions/*.md`（truth layer）→ **Constraints 不允许**，留给 OpenClaw。
- 建议 3/4（adapter/QMD）：涉及 project/agent 数据 → 谨慎，建议 OpenClaw 执行。
- 其余均为审查/建议。

> 即「安全修 1-2 个」这条 AC 在当前 Constraints 下**几乎无空间**——可改的都被 Constraints 挡了。如实说明，建议 OpenClaw 放宽 Constraints 后由 CC 执行建议 1（文档更新，低风险高价值）。

## 方法 / 验证
- 勘察：`du`/`find`/`ls` memory 结构 + 3 套检索位置 + agent DB + QMD cache；读架构决策 + INTERFACE + recall/pipeline.py。
- 关键实证：memory-core plugin/worker/引用三查全无；recall/pipeline stages 无 memory-core；.md 实际 838。
- 未改任何 memory/核心/tool 文件（Constraints 遵守）。
