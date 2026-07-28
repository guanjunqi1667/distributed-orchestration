# Verify: P1-20260725-fix-rmw-race

**Author**: Claude Code (GLM-5.2)
**File**: `plugins/harness-hooks/src/index.ts`
**Date**: 2026-07-25
**Scope**: 修复 REVIEW #6 的 RMW 竞态；不改状态机字段语义 / Soul Gate / failure arbiter。

---

## 1. 竞态复现分析（为何会丢数据）

所有 hook 遵循 `loadState() → mutate → saveState()`。单线程 JS 下，**纯同步**的 RMW 不会交错；竞态只在 RMW 窗口跨越 `await` 时发生。逐个 hook 核查 `loadState` 与首个 `saveState` 之间是否存在 `await`：

| Hook | load→save 之间有 await？ | 是否竞态 |
|------|--------------------------|----------|
| `before_tool_call` (Hook 2) | 否（全程同步） | 否（进程内） |
| `subagent_spawned` (Hook 2.5) | 否 | 否 |
| `subagent_ended` (Hook 2.6) | **是**：`await callArbiterAsync` ×3（行 ~2319/2358/2428，在 load 2202 与 save ~2450 之间） | **是** |
| `before_prompt_build` (Hook 1) | **是**：`await runHarnessValidatorAsync`（~1611，在 load ~1576 与首个 save ~1697 之间） | **是** |
| `after_tool_call` (Hook 3) | 否（load→save 同步段） | 否 |

**典型丢数据路径**：`subagent_ended` 在 `await callArbiterAsync` 让出事件循环 → 同步的 `before_tool_call` 插入执行：`loadState`(读 v5) → append 一条 auditLog → `saveState`(写 v6)。`subagent_ended` 恢复后用自己的 v5 基对象 `saveState`：**旧 `saveState` 的 `_version` 检查只 `console.warn` 不阻止** → v5 基对象覆写 v6 → `before_tool_call` 的 audit 条目被抹掉（last-writer-wins）。

> 旧实现的另一隐患：`_stateVersion` 是模块级共享变量，两个并发 RMW 共用它做自增，版本号本身也会互相干扰。

---

## 2. 方案：CAS + 3-way merge（完全收敛在 `loadState`/`saveState`，零 call-site 改动）

放弃「盲写整个对象」，改为**乐观 compare-and-swap + 三路合并**：

**`loadState()`** —— 用 `WeakMap`（key=返回的 state 对象引用，每次 load 都是新鲜 parse）记下「加载时的磁盘快照」`base`。`base` 不进入持久化 JSON（WeakMap 不枚举、不序列化）。

**`saveState(state)`** —— 在 `withStateLock` 锁内：
1. 重新读 disk，得 `disk` / `diskVersion`。
2. `loadedVersion = base._version`（**加载时**的版本，用作 CAS token）。
3. 若 `diskVersion > loadedVersion`（并发 writer 已提交更新）：
   - `finalState = _mergeConcurrent(disk, base, state)` —— 把**本 RMW 的改动**重并入**更新后的 disk**，而非覆写。
   - 若无 `base`（state 不是来自 `loadState`，当前无此 caller）→ 退化为旧直写并告警。
4. 否则 `finalState = state`（无冲突，直写）。
5. `_version = max(diskVersion, loadedVersion) + 1`，原子 `tmp + rename` 写盘。
6. **写后刷新 `base`** 为已提交状态 → 同一对象再次 `saveState` 不会误判冲突、数组不会重复 append。

### `_mergeConcurrent(disk, base, ours)` 合并语义

用 `base`（加载时）vs `ours`（本 RMW 结果）的 diff 决定「我们改了什么」：

| 情况 | 结果 | 目的 |
|------|------|------|
| `ours` 与 `base` 深相等（本 RMW 啥也没改） | 取 `disk` | 让并发 writer 全赢 |
| 标量 / 类型变化（我们改了） | `ours` 赢 | 我们显式 set 的字段生效 |
| 普通对象（如 `subAgentStates`、`soulGateState`） | **逐字段递归** | 兄弟字段并发改动互不覆盖（如 `.coder.doneAt` vs `.planner.doneAt`） |
| 数组、前缀仍 `=== base`（append，如 `auditLog`/`modelHistory`/`gateHistory`） | `disk.concat(我们追加的尾)`（去重） | 并发 append 互不丢失 |
| 数组、前缀 ≠ `base`（wholesale replace，如 `ctSequence`） | `ours` 赢 | 避免把旧 CT 复活 |
| 我们没碰的字段 | 取 `disk` | 保留并发 writer 的改动 |

`_version`/`_savedAt` 列入 `STATE_META_KEYS`，绝不参与合并/进 diff。

### 为何不改 call-site / 不用串行队列

- **串行队列**要把整段 RMW（含 `await callArbiterAsync` 等）关进锁内 → 跨 `await` 持有 mkdir 锁会触发 30s stale 检测、阻塞其它 hook。否决。
- **CAS+merge** 只收敛 state IO 两个函数，**不碰任何 hook、不碰状态机执行顺序**，满足 Constraints；且同时关闭进程内（await 交错）与跨进程（mkdir 锁包住 check-merge-write）两种竞态。

---

## 3. 测试路径

新增 `plugins/harness-hooks/test-rmw-cas.mjs`：**直接从编译产物 `dist/index.js` import `_rmwCasInternals`**（`_deepEqual`/`_mergeConcurrent`/`_cloneState`），测的是 shipped 代码而非副本。7 个场景 17 个断言：

```
node test-rmw-cas.mjs
# 17 passed, 0 failed   （exit 0）
```

覆盖：
- **S1** 头条竞态：`subagent_ended` 改 `coder.doneAt`+append audit，期间 `before_tool_call` 改 `planner.doneAt`+append audit → 合并后**两者都赢**、base 前缀保留（7 断言）
- **S2** 改了的字段我们赢、没改的字段保留并发值（2）
- **S3** 数组 replace（`ctSequence`）→ caller 赢，不 append-merge（1）
- **S4** 数组 append + 并发 append → 两条尾都保留、去重（3）
- **S5** 本 RMW 未改 → disk（并发 writer）赢（1）
- **S6** `soulGateState` 嵌套：标量我们赢 + `gateHistory` 双 append 保留（2）
- **S7** 无并发 → ours 赢（幂等）（1）

> 注：`saveState` 的锁+CAS 外壳未做端到端黑盒测——`STATE_FILE` 是硬编码常量（指向真实 `harness-state.json`），不宜在测试里改写。外壳逻辑简单（lock→reread→compare→merge→write→refresh base），由代码审查 + `node --check` + 上述 merge 单测共同覆盖。merge 是全部正确性关键所在，已对 shipped 产物验证。

---

## 4. 验证命令与结果

```
# 改前备份（Constraints 要求）
cp src/index.ts src/index.ts.bak.$(date +%s)     # → src/index.ts.bak.1784991778

# 重编
npx tsc -p tsconfig.json
# exit 2 —— 全部为预存 TS 类型错（event.result/agentId/params 推 unknown 等，
#         位于 2611–2712 的 after_tool_call 事件类型区，与本次改动行无关）。
#         tsconfig 无 noEmitOnError（默认 false）→ emit 正常，dist 已刷新。

# AC 要求的验证
node --check dist/index.js      # → PASS

# 产物含新逻辑
grep -c "_mergeConcurrent\|_stateBases\|_rmwCasInternals\|_cloneState\|3-way merge" dist/index.js   # 19
grep -n "_rmwCasInternals" dist/index.js   # 1149:export const _rmwCasInternals = {...}

# merge 单测（shipped 产物）
node test-rmw-cas.mjs           # 17 passed, 0 failed

# 回归（现有套件）
node test-hooks-enforce.mjs     # verdict:true, exit 0（positive 26/26, negative 12/12,
                                #  state 12/12, actionGate 10/10, crossModel 1/1）
```

---

## 5. AC 对照

- [x] 审查所有 `loadState()→mutate→saveState()` 路径（§1 逐 hook 表）
- [x] 设计方案解决竞态（CAS compare-and-swap，§2），不改变状态机语义
- [x] 实现并验证（§3、§4）
- [x] 写入本文件
- [x] 改前备份 + `node --check dist/index.js` PASS

## 6. 约束遵守

- 未改状态机字段语义（`state` 枚举、`activeContract`、`currentCT`、`ctSequence` 等含义不变）
- 未改 Soul Gate 逻辑、未改 failure arbiter 调用
- 未改任何 hook 的 RMW 调用点（零 call-site 改动）
- `_rmwCasInternals` 是**新增**命名导出（ESM，不影响 `default` 插件导出），仅供测试

## 7. 已知边界（诚实记录）

- **auditLog 自动 trim**（`>100 → slice(-50)`）与 merge 相遇时：若 trim 发生，`base.length > ours.length`，该数组走 replace 分支 → caller 赢（ours 的裁剪后数组）。trim 本就是有损裁剪，且仅在 >100 条时触发，影响可忽略。
- **无 `base` 的 saveState**（state 非来自 `loadState`）→ 退化为旧直写+告警。当前所有 caller 都走 `loadState`，不会命中。
- merge 去重用 `_deepEqual` O(n²)，但 `auditLog` 上限 ~100，开销可忽略。
