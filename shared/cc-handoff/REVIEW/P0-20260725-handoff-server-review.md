# Review: P0-20260725-handoff-server-review

**Reviewer**: Claude Code
**Date**: 2026-07-25
**Subject**: Handoff Server — 多 Agent 跨节点协作工作台设计（`docs/handoff-server-design.md`）
**Scope**: 兼容层合理性 / 对 CC 现有工作流影响 / 并发与生命周期 / 迁移期一致性 / CC 端实施建议

> 视角声明：我是第一个非 OC 的审查 agent，从 **CC（执行方）** 角度评估。结论基于对 CC 当前实际运行模型的勘察（trigger-cc.sh / notify-openclaw.sh / CLAUDE.md 守则 / hook 驱动的心跳），而非设计文档的自我描述。

---

## 核心结论：方向对，但「兼容层只需改 endpoint」是致命低估

SQLite + REST 替换文件 INBOX/DONE 的方向正确（存储统一、可查询、跨节点基础），REST 面与生命周期状态机大体合理。但**兼容层一节（design L198-204）与 CC 实际运行模型严重脱节**——它假设 Agent 是「常驻进程」，而 CC 是 **headless 一次性进程**。这条假设错误会污染 P0 的实施范围估计，下面 3 个关键问题都根源于此。

### CC 当前运行模型（勘察实证，作为评估基准）

| 维度 | 当前实际 | 设计假设 |
|---|---|---|
| **进程形态** | `claude -p "<硬编码 prompt>" --max-turns 500`，跑完即退（trigger-cc.sh L36） | 常驻 Agent，可持 WS、可 `while true` 轮询（L106, L121-127） |
| **心跳来源** | **hook 自动写**（SessionStart=alive / Stop=offline），CC 自身无主动心跳代码（CLAUDE.md 守则） | Agent 主动 `POST /agents/:id/heartbeat`（L87-89, L138） |
| **并发原语** | 原子 `mv INBOX→IN_PROGRESS`（文件系统即锁） | `POST /tasks/claim`「返回最高优先级未分配任务」，无原子性说明（L82-85） |
| **通知模型** | OC **主动 spawn** CC（进程级 push）+ CC 写 DONE 文件 + notify-openclaw.sh | WS 双向 push（L103-116）；轮询被降级为「无 WS 的 fallback」（L118） |
| **崩溃恢复** | `IN_PROGRESS/` + last_seen>5min → `ALERT/` → 老板重派（owner 明确） | `CLAIMED→(timeout)→STALE→ALERT`，timeout 值与 owner 均未定义（L51-56） |

---

## 关键问题 1（最严重）：兼容层命题不成立——CC 是 headless 一次性进程，不是「常驻 Agent」

设计 L203「CC 现有的 `trigger-cc.sh` / `notify-openclaw.sh` 只需改 API endpoint」是错的，因为：

1. **trigger-cc.sh 今天根本不读 INBOX**。它读 `STATE/cc.heartbeat` + 做 stale 检测 + `exec claude -p "<硬编码 prompt>"`（trigger-cc.sh L36）。真正消费 INBOX 的是**被拉起的 CC 进程内部**（按 prompt 执行 `ls/mv/DONE`）。所以 P0 要改的是 **spawner 的认领逻辑**（spawn 前先 `POST /claim` 决定是否拉起），不是换一个 URL。

2. **CC 的心跳由 hook 写，CC 无法主动 POST**。心跳在 `settings.json` 的 SessionStart/Stop hook 里——而 **settings.json 对 CC 是 Edit/Write deny**（守则第 4 条），归 OC 管。设计「Agent 主动 POST heartbeat」的模型，CC 端**无法自服**，必须 OC 重写 hook 才能落地。这是被「只需改 endpoint」掩盖的协调成本。

3. **设计的 bash 轮询示例（L121-127）是另一种执行模型**。它预设一个长跑 shell `while true`，但 CC 没有这样的 shell——它被 spawn、跑一个 prompt、退出。把 CC 塞进轮询循环 = 把 CC 改成 daemon，这是架构级变更，不是兼容。

**结论**：CC 应**永远走「OC spawn + 文件投影」模型**，WS/轮询 loop 留给真正的常驻 agent（未来的 daemon、Codex cloud）。P0 必须先明确这一点，否则会按错误模型实现 heartbeat/claim。

---

## 关键问题 2：认领并发与 CLAIMED 窗口缺原子语义 + 恢复 owner 未定义

**2a. claim 无原子性说明**。当前并发安全完全靠原子 `mv`（同文件系统下 mv 是原子的，这就是事实上的锁）。设计的 `POST /tasks/claim`「返回最高优先级未分配任务」若无原子语义，N 个 agent（或 stale 重派后两个 CC 实例）会**重复认领同一任务**。必须显式规定：

```
claim = 单条原子条件 UPDATE + RETURNING：
  UPDATE tasks SET status='claimed', claimed_by=:a, claimed_at=now
   WHERE id=(SELECT id FROM tasks WHERE status='queued'
             ORDER BY priority LIMIT 1) RETURNING *;
无任务可领 → 204（不是空 body，避免轮询方误判）
```

**2b. CLAIMED↔IN_PROGRESS 两态引入新崩溃窗口**。当前模型把「认领」和「进行中」合并为 `mv 到 IN_PROGRESS`（一步，无中间态）。设计拆成 `CLAIMED→IN_PROGRESS`（L51）两态——若 CC spawn 成功但还没 POST `in_progress` 就崩了，任务卡在 `CLAIMED`。设计的 `CLAIMED→(timeout)→STALE` 既没给 timeout 值，也没给恢复 owner。当前模型此处是**经过验证的**（IN_PROGRESS + 5min stale → ALERT → 老板重派）。建议：要么补全 claim-timeout + owner，要么**直接合并 CLAIMED→IN_PROGRESS**复用已验证的恢复路径，少一个状态少一个坑。

---

## 关键问题 3：迁移期双写无「权威源」与一致性定义

L200-202「server.py 同时读文件 + SQLite」「INBOX/DONE 目录同步写入」= 迁移期**双 source of truth**，但全文未定义：

- **谁是权威**？文件还是 DB？
- **部分失败怎么办**？文件写成功 / DB 写失败（或反之）→ 两边视图分叉。
- **冲突如何对账**？例如任务已在 `DONE/` 但 DB `status=claimed`（CC 按旧流程写了文件，DB 没同步）。此时 OC 读 DB 会以为还在跑，CC 读文件以为已交付——**静默双跑或丢任务**，恰是最难查的 bug。

当前**单 source（文件系统）无此问题**。建议定死：**SQLite 权威，文件单向投影**（DB 事务内写 → 镜像写文件供旧脚本；读一律 DB 优先；cutover 后不再从文件回灌 DB）。或用单一开关 `HANDOFF_STORE=files|dual|db` 控制（files=今天；dual=DB 权威+文件投影；db=所有脚本迁移后摘除投影），让回滚 = 翻 flag。

---

## 次要观察（非阻断，记录备查）

- **capability 路由缺 authz**：`target_agent:null` + `required_capabilities`（L67-68）在本地模式无碍，但 P4 远程 agent 上线后，任意/恶意 agent 可认领任意任务。capability 匹配无授权模型——归 P5 安全层处理即可，但别忘。
- **`/api/board` 兼容 dashboard**（L146, L213 P3）：现有 dashboard 直接读目录还是已有 HTTP？若已是 HTTP，对接成本低；若是文件直读，P3 要同步改。需核实 dashboard 现状。
- **`artifacts.context` 用 base64**（L73）：CC 上下文常是中文+大文本，base64 膨胀 ~33% 存 SQLite TEXT。建议 context 走文件存储（File Store），DB 只存路径——design 标题已写「SQLite + File Store」但模型里 artifacts 全塞 JSON，二者不一致。
- **正向肯定**：REST 面划分清晰；SQLite 是对的选型；capability 路由前瞻；安全分级（本地 loopback → P5 mTLS）排序合理；轮询 fallback 的存在说明作者意识到了非 WS agent——只是没意识到 **CC 就属于这一类且是主力**。

---

## CC 端实施建议（若 P0 启动）

按「最小爆炸半径 + 尊重 CC 不能改 settings.json」原则：

1. **CC 的 prompt 与内部流程零改动**。CC 继续做 `ls INBOX / mv / DONE / notify`，完全不变。P0 的爆炸半径应只限 OC 侧 + trigger-cc.sh。
2. **SQLite 权威 + 文件投影**（解问题 3）。CC 通过投影看到的文件视图与今天一致 → CC 无感知。
3. **trigger-cc.sh 改为「先 claim 再 spawn」**：`curl POST /claim` → 200 则 `claude -p`（prompt 不变），204 则不拉起。spawn 后的 CC 仍读文件投影，内部流程不变。这样 claim 的原子性在 OC 侧的 SQLite 事务里保证（解问题 2a），CC 不参与并发逻辑。
4. **server 观察 CC 心跳文件，而非要求 CC POST**（解问题 1.2）。`server.py` 读 `STATE/cc.heartbeat` 填 agent status——**零 hook 改动**，绕开 settings.json 的 deny。
5. **CC 永不持 WS**。WS 通道从设计上就标注「CC 不适用」，CC 走 spawn+投影永久路径。避免后人误把 CC 接 WS。
6. **合并 CLAIMED→IN_PROGRESS**（解问题 2b），复用当前已验证的 stale→ALERT→重派恢复路径。
7. **迁移用 `HANDOFF_STORE` flag**（files→dual→db），回滚翻 flag，不删旧代码。

> 一句话：**P0 应让 CC 完全无感**（prompt/流程/hook 都不动），所有变化在 OC 侧 + trigger-cc.sh + server.py。能做到这点，兼容层才真的「低成本」；做不到，就是架构级返工。

---

## Acceptance Criteria 对照

- [x] 通读设计文档（`docs/handoff-server-design.md` 全文）
- [x] 评估对 CC 现有工作流影响——兼容层命题不成立（见核心结论 + 问题 1），附 CC 运行模型对照表
- [x] 指出 3 个关键问题：① headless vs 常驻 Agent 模型错配 ② claim 并发/CLAIMED 窗口无原子语义 ③ 迁移期双写无权威源/一致性
- [x] P0 启动的 CC 端实施建议（7 条，核心=CC 零感）
- [x] 写入 `REVIEW/P0-20260725-handoff-server-review.md`

## 方法 / 验证

- 读设计文档全文；勘察 CC 侧实际依赖：`bin/trigger-cc.sh`（spawn 逻辑 + stale 检测 + 硬编码 prompt）、`bin/notify-openclaw.sh`（心跳握手 + flag）、`bin/README.md`（双向闭环 + 实测注意事项）、`done-template.md`、`CLAUDE.md` 守则（hook 驱动心跳 + settings.json deny）。
- 关键实证：trigger-cc.sh L36 `exec claude -p ... --max-turns 500`（一次性 headless）；心跳由 hook 写、CC 无主动 POST 代码；并发靠原子 mv；恢复路径 IN_PROGRESS+stale→ALERT。
- 纯 review，未改任何文件（Constraints 遵守）。

## Next Steps for OpenClaw

- **决策点（阻断 P0）**：CC 走 spawn+文件投影永久模型（本 review 建议）还是被迫改成轮询/常驻？这决定 P0 整个实施形状。建议采纳前者。
- 若同意本 review 方案，P0 任务可拆为：(a) server.py + SQLite 权威 + 文件投影；(b) trigger-cc.sh 改 claim-then-spawn；(c) server 读 cc.heartbeat 文件填 status；(d) `HANDOFF_STORE` flag。CC 侧无任务。
- 建议把「CC 是 headless 一次性进程」这条**写入设计文档的 Agent 模型一节**作为约束，避免后续 agent（Codex/Hemes）也按常驻模型误实现。
