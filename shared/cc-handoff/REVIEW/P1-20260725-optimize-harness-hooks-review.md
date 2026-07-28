# Review: P1-20260725-optimize-harness-hooks

**Reviewer**: Claude Code (GLM-5.2)
**File**: `plugins/harness-hooks/src/index.ts` (2653 行, baseline V1)
**Date**: 2026-07-25
**Scope**: 可维护性 / 性能 / 潜在 bug 三类问题；只做安全 change，不碰状态机核心 / Soul Gate / failure arbiter。

---

## 方法

全文 2653 行逐段读完（Hook 1 `before_prompt_build`、Hook 2 `before_tool_call`、Hook 2.5/2.6 `subagent_spawned/ended`、Hook 3 `after_tool_call`、以及 intent/action/soul-gate/model-routing/state/verify/trace 各模块）。结合 `grep` 验证死代码与重复串。改动前 `cp src/index.ts src/index.ts.bak.p1-optimize-20260725` 备份；改后 `tsc` 重编 + `node --check dist/index.js` 验证。

---

## 问题清单（按 影响 排序）

影响分级：**critical**（数据丢失/崩溃/安全）· **major**（明显性能/可维护性/正确性）· **minor**（局部）。

| # | 类别 | 影响 | 问题 | 处置 |
|---|------|------|------|------|
| 6 | 潜在 bug | major | **RMW 竞态**：每个 hook `loadState()→mutate→saveState()`，两个并发 hook（如 `subagent_ended`+`before_tool_call`）会 last-writer-wins 丢失对方的 mutation；`saveState` 的 `_version` 检查只 warn 不阻止 | 留（架构级，需 CAS/锁包裹全 RMW，属状态机核心） |
| 7 | 可维护性 | major | **Hook 1 是 ~480 行 god-function**，混了 intent parse / risk gate / LC 检测 / gap2a / auto-advance / verify gate / integration verify / trace 对账 / spawn 触发 / context 注入 | 留（拆分触动编排+状态机流，超 scope） |
| 10 | 性能 | major | **异步 hook 里仍有同步阻塞调用**：`runPreflightCheck`(execFileSync 30s)、`runContractVerify`(execFileSync 循环 30s/条)、`runIntegrationVerify`(60s/条)、reviewer Telegram 推送(execFileSync python3 10s)。已有 async 版（preflight/validator/arbiter/telegram）但没接进 `checkRestartPreflightGate`(同步) 与 verify 路径 | 留（verify/preflight 结果用于 gating 决策，不能机械换 async，需逐处设计） |
| 5 | 性能 | major→已修 | **node --check gate 用 `execFileSync`**：每次 critical write/edit 阻塞事件循环最多 5s | ✅ 已修（改非阻塞 `execFile`，仅诊断日志） |
| 16 | 潜在 bug | minor | `subagent_ended/spawned` 直接访问 `state.subAgentStates[agentType].<field>`，若 config schema 缺该 type（如 reviewer/verify）→ TypeError → 异步 hook unhandled rejection | 留（建议加 `if(!sas[t]) sas[t]={}` 防御，follow-up） |
| 4 | 潜在 bug | minor→已修 | **轨迹退化检测阈值不一致**：触发用 `maxRepeat>=8`，但命名违规工具用 `find(t=>count>=5)`，可能指错工具且报错次数对不上 | ✅ 已修（`=== maxRepeat`，锁定真正违规工具） |
| 8 | 可维护性 | minor | `extractVerifyCommands` / `extractIntegrationVerifyCommands` 近乎重复（仅 regex 字面量不同） | 留（喂 verify gate，状态机邻接，风险/收益低） |
| 11 | 性能 | minor | `getModelDeadPatterns()` 每次 `detectModelFailure` 都重新 `new RegExp(...)`，未按 config mtime 缓存 | 留 |
| 12 | 性能 | minor | `findLatestLC` 对 CONTRACTS_DIR 每个 LC `readFileSync` 整文件再 `.split().slice(0,25)` 查头部状态 | 留（大 LC 多时浪费；可读有界 head） |
| 13 | 潜在 bug | minor | `Math.max(...Object.values(toolCounts))` 空集返回 `-Infinity`（现被 `>=8` 挡住，但脆） | 留（与 #4 同区，已部分加固） |
| 14 | 可维护性 | minor | magic number：audit trim `>100→slice(-50)`、`recentToolCalls>20`、stuck `30*60*1000`、action-gate `blocks>3` | 留 |
| 15 | 可维护性 | minor | sync/async 双轨：`USE_ASYNC_*` 全 true，sync fallback（`callArbiter`/`runHarnessValidator`/`runPreflightCheck`/`sendTelegramAlert`）实际走不到但保留 | 设计如此，仅记录 |
| 1 | 性能 | minor→已修 | `withStateLock` 每 50ms spin 新建 `SharedArrayBuffer`+`Int32Array`（忙等期间反复分配） | ✅ 已修（提到循环外） |
| 2 | 可维护性 | minor→已修 | 死变量 `_inferAgentTypeCache`（声明后全文件无引用） | ✅ 已删 |
| 3 | 可维护性 | minor→已修 | QMD `MEMORY_ROUTING` 注入串在 contract / 非 contract 两路逐字重复 | ✅ 已抽常量（DRY） |

> ≥3 个具体问题 ✅；每个都给了影响分级 ✅；安全修复 5 个（≥2）✅。

---

## 已应用的 5 个安全修复（详情）

### Fix 1 — `withStateLock`：提升 sleep buffer 分配（性能）
忙等循环里 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)` 每次 spin 都新建 4 字节 SAB + 视图。提到循环外（`waitBuf`），buffer 恒为 0，`Atomics.wait(buf,0,0,50)` 每次 timeout 行为完全一致。锁语义（mkdir 原子锁 / 30s 超时 / stale 检测）一字未动。

### Fix 2 — 删除死变量 `_inferAgentTypeCache`（可维护性）
`grep` 确认声明后全文件无读写。`inferAgentTypeFromConfig` 本就没做缓存。

### Fix 3 — 抽取 `MEMORY_ROUTING_INJECT` 常量（DRY）
原 contract 路径与非 contract 路径各有一份 5 行的 QMD 路由串。合并为模块级 `MEMORY_ROUTING_INJECT`，两处改引用。原 `if(memoryRoutingInject){…}` 守卫恒真，删除等价。

### Fix 4 — 轨迹退化检测指错工具（正确性）
原：触发阈值 `maxRepeat>=8`，但 `Object.keys(toolCounts).find(t=>toolCounts[t]>=5)` 可能返回 count 5–7 的另一个工具，导致告警「工具名 vs 次数」对不上。改为 `find(t=>toolCounts[t]===maxRepeat)` 锁定真正达到 max 的工具；同步修正注释（原注释写「5+」与代码 8 不符）。

### Fix 5 — node --check gate 改非阻塞（性能）
`after_tool_call` 里对 critical `.js/.mjs` 文件做 `execFileSync("node",["--check",p],{timeout:5000})`，每次 write/edit 阻塞最多 5s，且该检查**只日志、不 gating**。改为 `execFile(...,cb)`（`execFile` 已 import），cb 内失败才 log。行为（失败记日志）保留，不再阻塞 hook。JSON.parse 校验那路保持同步（进程内、快）。

---

## 留给后续的优化项（按优先级）

1. **#6 RMW 竞态（major）** — 最高价值。建议：`withStateLock` 内做 compare-and-swap（读 disk `_version` → 写前比对 → 不符则 re-merge），或把所有 state mutation 串行化进一个队列。属状态机核心，需单开任务。
2. **#10 同步阻塞调用（major）** — verify/preflight 接 async 版；注意 verify 结果参与 gating，需把「跑验证→拿结果→决策」改成 await 链，逐处评估。
3. **#16 subAgentStates 缺键防御（minor）** — 一行守卫即可消掉潜在 TypeError。
4. **#7 Hook 1 拆分（major，可维护性）** — 抽 pure helper（gap2a review-report 扫描、model-routing ctx 已半独立），但需在不改状态流前提下做，建议配合回归测试。
5. **#11/#12/#14** — 缓存 deadPattern regex、有界读 LC 头、命名 magic number。低风险，可顺手清。

---

## 关于 TypeScript 类型（重要背景，非本次引入）

`src/index.ts` 对当前 openclaw SDK 类型**并不能干净通过类型检查**：约 50 处 `TS2339/TS2769`（`event.result`/`agentId`/`taskName`/`handoffPath` 不在 `PluginHook*Event`、`params` 推为 `unknown` 等）。这些**全部是预存的**，与本次改动无关——本次改动的行（`waitBuf`/`MEMORY_ROUTING_INJECT`/`=== maxRepeat`/`execFile` 回调）未新增任何类型错误（同区的 `p:unknown`/`toolCounts:unknown` 错误在改动前的 `execFileSync`/`Math.max` 行就已存在）。

`tsconfig` 未设 `noEmitOnError`（默认 false），故 `tsc` **即使报类型错也会 emit** `dist/index.js`——这正是 dist 一直存在的原因。`node --check dist/index.js` PASS 证明产物是合法 JS。建议后续要么放宽 SDK 事件类型（加 index signature / `[k:string]:any`），要么在 CI 里显式区分「类型 lint」与「emit」。

---

## 验证

```
# 改动前备份
cp src/index.ts src/index.ts.bak.p1-optimize-20260725

# 重编（类型错为预存，见上节；emit 正常）
tsc -p tsconfig.json   # exit 2 (预存类型错), dist 已刷新

# AC 要求的验证
node --check dist/index.js   # → PASS

# 产物含全部 5 处改动，且 QMD 串从 2 处降到 1 处（DRY 生效）
grep -c waitBuf dist/index.js            # 2
grep -c MEMORY_ROUTING_INJECT dist/index.js  # 3
grep -c "=== maxRepeat" dist/index.js    # 1
grep -c "QMD 优先路由规则" dist/index.js # 1 (原 2)
```

> 未跑 `test-hooks-enforce.mjs`：该测试**自行重实现** intentParser/actionGate（不 import dist），本次未改这些逻辑，跑它无法回归本次改动；`node --check` 已覆盖产物合法性。
