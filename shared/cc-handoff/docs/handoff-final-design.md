# Handoff 最终设计（综合 v2 / v3 / v4 评审）

> 本文档综合三份 CC 评审（`REVIEW/P0-20260725-review-handoff-v2.md`、`-v3.md`、`-v4.md`）、当前 v1 实现（`README.md` + `bin/`）及 `docs/handoff-server-design.md`，给出一版收敛的优化方案。
>
> **它不钦定任何单一方案**（CRDT / GitHub / Server / 文件同步）。三份评审的共同结论是：**认领互斥的正确性来自执行语义层（reserve-before-execute / 本地原子 reserve），与存储、传输无关**；存储只是可替换的载体。而对**当前单机单 CC 场景，v1 已正确实现了这一协议，分布式存储尚无必要**。本设计据此决定「何时、以什么代价」跨入分布式。

---

## 0. 一句话结论（先读这句）

> **v1 文件层是当前单机场景的权威与基线，保留不变；reserve-before-execute 是「跨机器才需要」的协议主干，传输层可插拔（文件同步 / 中继服务器 / P2P）；GitHub 仅作单向只读镜像，供人眼可见性，绝不参与认领裁决。是否启动分布式改造，由「是否真的跨机器」这一场景门决定，而非默认推进。**

---

## 1. Why —— v1 在什么场景下不够用

### 1.1 v1 干对了什么（先肯定，避免为改而改）

v1 是**刻意**的：基于本地文件目录、**无需联网**、用**本地原子 `mv INBOX→IN_PROGRESS` 当前置互斥锁**（见 `README.md` §任务认领）。对「单 OC ↔ 单/少 CC、同机、低频、高可靠、抗占用」这一回路，它是**构造性正确**的——原子 `mv` 在同一本地文件系统上是真互斥，无需任何分布式机制。三份评审没有任何一份说 v1 在这种场景下错了（v3 评审明确判定「单机无并发，安全是构造性的」）。

### 1.2 v1 失效的具体场景（三份评审一直要求补的「驱动问题 / Why」）

v1 的互斥保证**只在「单一本地文件系统」上成立**。一旦下列任一为真，本地原子 `mv` 的互斥性就崩，**分布式认领才真正必要**：

| 场景 | v1 为何失效 | 当前是否已发生 |
|------|------------|--------------|
| **OC 与 CC 分处不同机器、靠同步盘共享 handoff 目录** | 跨机 `mv` 不是原子的；两台机的同步层都可能在各自副本里「看到文件还在 INBOX」→ 各自认领（v3 评审点 E） | 否（实测同机） |
| **多 CC 实例跨机抢同一任务** | 同上；并发认领竞态 | 否（当前单 CC） |
| **CC 崩溃后任务卡在 IN_PROGRESS 无人接管** | v1 **有** stale 回收（30min→ALERT→老板重派），非失效；但任何新状态机不能丢这条边（v3 评审点 A） | 边缘风险，单机也存在 |

**实测背景**：当前 workspace `Is a git repository: false`、无 remote、未装 `gh`/`syncthing`、OC/CC 同机——**驱动问题尚未出现**。因此本设计基调是：**分布式协议「设计就绪、按需启用」，而非「立即建造」。**

### 1.3 三份评审共同指出、与场景无关的设计缺陷（无论是否上分布式都必须修）

1. **乐观认领→执行→回滚对 CC 不可行**（v2 关键问题1）：CC 跑到 prompt 完成才退出、无中途取消通道、副作用不可事务化撤销。→ 任何方案都必须 **reserve-before-execute**。
2. **兼容层曾认错对象**（v2 关键问题2，v3 已纠正）：`trigger-cc.sh`/`notify-openclaw.sh` 不读写任务存储，是 liveness+push；真正的兼容面是 CC 的 `ls INBOX`/`mv`/写 DONE + SessionStart hook。
3. **认领仲裁别用墙上时钟**（v2 关键问题3、v3 残留）：wall-clock 有偏移漏洞（慢时钟节点总赢）；同版本「状态优先级」tiebreak 会吃掉回退语义。→ 改 **node_id 为主键 + 每次 status 变更必 version bump**。
4. **stale/超时回收不能丢**（v3 点 A）：reserved/claimed/in_progress 必须有 lease TTL→reclaim，单机也咬人（CC 会崩）。
5. **分区愈合合并不掉已发生的副作用**（v2 关键问题3、v3 点 B）：CRDT 只 merge 状态，merge 不掉已在磁盘的仓库改动。→ 分区期必须 **reserve-only**，且 confirm 需 quorum/peer-ack 强制门，愈合后才执行。

---

## 2. 目标状态

**一句话**：见 §0。

**展开**：把「认领互斥」从「绑定某个存储」解耦为「协议 + 可插拔传输」；v1 作为单机权威与永久 fallback；reserve-before-execute 作为跨机器协议主干；GitHub 作只读镜像；以场景门控制何时引入分布式复杂度。

---

## 3. 核心设计

### 3.1 认领协议（主干，传输无关）—— Reserve-Before-Execute

吸收 v2/v3 结论，把「终止+回滚」从「不可行」降为「不需要」：

```
节点要执行任务 T：
 1. Reserve：  写状态 status=reserved, v+1（纯状态变更，无副作用）
 2. Settle：   等 lease 窗口，让并发 reserve 收敛
 3. Confirm：  收敛后裁决自己是否唯一/最高优先 reserve
              → 是：status=claimed，启动执行
              → 否：放弃 reservation（无副作用，安全丢弃）
 4. Execute：  agent 运行（此时才产生副作用）
 5. Done：     status=done, v+1
```

**关键不变量**：副作用（改仓库、跑测试、写 DONE、commit）**只在 step 4 之后**才发生；reserve/settle/confirm 阶段输家只丢一条无副作用的 reservation。

**单机退化形式 = v1**：当只有一个 CC 且共享单一本地 FS 时，「reserve+settle+confirm」坍缩为一次本地原子 `mv`——`mv` 本身就是「reserve 且立即 confirm」。**所以 v1 不是过时实现，而是本协议在单机退化下的最优实例。** 这是本设计既不偏袒分布式、也不否定 v1 的根据。

### 3.2 状态机（补齐 v1 全状态 + v3 漏掉的 lease 回收边）

v3 的 `{pending→reserved→claimed→in_progress→done}` 漏了 v1 实际有的 archived / rework / stale。完整状态：

```
            lease TTL 超时 / 输掉裁决
   ┌─────────────────────────────────────────────────────────┐
   ▼                                                         │
 pending ──reserve──▶ reserved ──confirm(赢)──▶ claimed ──start──▶ in_progress ──done──▶ done
                                │                                                          │
                          (输/超时 → 回 pending)                                     rework(v bump)
                                                                                           │
                                                                                           ▼
                                                                                        pending

 reserved/claimed/in_progress 心跳超时 ──▶ stale ──▶ ALERT（老板：等 / 中断 / 重派）
 done 24h ──▶ archived（tombstone，GC 回收）
 任意态 ──▶ cancelled（老板 / 重派触发）
```

- **每个 status 变更必 version bump**：解决 v2「同版本状态优先级吃掉回退」——rework = done→pending 靠 bump 盖过，不依赖 tiebreak 往低走。
- **reserved/claimed/in_progress 各带 lease TTL**（v3 点 A）：超时 → 回 pending，他人可 re-reserve。单机也生效（防 CC 崩溃卡死）。
- **stale→ALERT 保留 v1 的 30min→老板介入 路径**，作兜底：lease 是机器自动回收，ALERT 是人介入。
- **投影层兼容**：claimed/in_progress 映回 `IN_PROGRESS/` 目录，使现有 stale-hook 继续生效（见 §5）。

### 3.3 冲突解决 / 认领仲裁（钉死，不再用 wall-clock）

| 场景 | 裁决规则 | 来源 |
|------|---------|------|
| 同字段 version 不同 | **version 高者赢** | LWW 基本规则 |
| 认领冲突（并发 reserved/claimed） | **node_id 字典序小者赢**（主键），不再用 wall-clock | v2 关键问题3、v3 残留 |
| 回退/重开 | **version bump 强行盖过**，不依赖「状态优先级往低走」 | v2 关键问题3 |
| 分区愈合 | **分区期只 reserve 不执行**；愈合后 gossip 收敛 → 唯一胜者才 claim+execute | v2 关键问题3、v3 点 B |

- **node_id 来源**：本地随机生成 + 持久化（P0 即有，可复用为 CRDT 副本 id），不等签名认证（那是 P3+ 的事）。
- **为什么是 node_id 不是 timestamp**：node_id 稳定、确定、无偏移；wall-clock 在时钟未同步时会暂不一致、且慢时钟节点总占便宜。同瞬间的并发 claim 用 node_id 收敛是确定的。

---

## 4. 同步层（可插拔传输，不绑定实现）

**核心原则**：传输只是「让 reserve/settle 窗口里的状态在节点间可见」的管道。协议主干（§3）不变，传输按场景换。任何传输都必须满足 **confirm 的强制门**（quorum ≥ ⌊N/2⌋+1 可见 peer，或全员 ack）——否则分区下的「假收敛」会让 reserve-only 失效（v3 点 B）。

| 传输 | 适用 | 提供的「可见性」保证 | 代价 / 坑 |
|------|------|---------------------|---------|
| **v1 文件层（无传输）** | 单机单 CC | 本地原子 `mv` 即互斥，无需收敛 | 仅限单一本地 FS |
| **文件同步（如 Syncthing）** | 同局域网 / 跨机共享盘 | eventual consistency | ① 跨机 `mv` 非原子 → **必须**叠 reserve-before-execute；② Syncthing 自身生成 `.sync-conflict-*`，CRDT 再叠一层 merge 会双层打架（v2/v3 点 D）→ 载体宜用「单 DB 文件」并压制冲突文件 |
| **中继 / 中心服务器（REST+WS，见 server-design）** | 公网多节点、多 Agent | **服务器串行化 claim 即天然互斥**（`POST /tasks/claim` 返回唯一任务）→ 此时 reserve-before-execute 可简化 | 服务器是单点 + 联网依赖；但 mutex 是「白送的」，不必自建 lease——这是 server 路线相对 CRDT 的**真实**正确性优势 |
| **P2P（libp2p / WebRTC）** | 去中心化、抗审查 | 全连通 gossip | 表面积最大（节点发现、NAT、认证），P3+ 才考虑 |

> **客观权衡（不偏袒）**：CRDT 路线（v2/v3）去中心化，但要把 mutex 重新造一遍（lease + 仲裁 + 分区门）；server 路线 mutex 白送，却引入单点与联网；GitHub（v4）连 mutex 都没有（assign 累加、无 CAS）。三者在「正确性」上的排序：**server ≈ CRDT(配齐门) > 文件同步(配齐门) > GitHub(无门)**；在「local-first / 无联网」上：**文件同步 ≈ CRDT > server > GitHub**。选哪个，取决于你更怕「联网依赖」还是「自建复杂度」——这正是「不钦定」的体现。

---

## 5. 兼容层（v2 认错对象，v3 已纠正；这里钉死）

| 组件 | 实际职责（已读代码核实） | 迁移处理 |
|------|----------------------|---------|
| `bin/trigger-cc.sh` | 读 `STATE/cc.heartbeat`，`exec claude -p` 拉进程。**不碰任务文件。** | **不变**（与任务存储正交） |
| `bin/notify-openclaw.sh` | 向 `STATE/cc.notify.flag` 追加一行 `<时间戳> <task-id>`。**不读 heartbeat、不调 `openclaw agent`、不 deliver、不碰任务文件。** | 已简化为纯 flag（去掉 `openclaw agent --deliver`，文件夹是唯一通信层） |
| CC prompt + SessionStart hook | `ls INBOX` 取任务、`mv INBOX→IN_PROGRESS` 认领、写 DONE、`mv→INBOX_ARCHIVE`、扫 INBOX / 写 heartbeat | 真正的兼容面：**仅当上分布式时**，`mv` 改为「写 reserve(CRDT)」，由投影层单向、幂等地搬文件；CC 不再直接 `mv`（否则 CRDT 与文件双写竞态） |
| 投影层（CRDT→文件） | 把 CRDT 状态映射回 INBOX / IN_PROGRESS / DONE / ARCHIVE 目录 | 必须：① 单向权威；② 幂等；③ 保留 stale 路径（claimed/in_progress→`IN_PROGRESS/`，让现有 stale-hook 继续生效）；④ 证明其认领互斥不弱于 v1 本地原子 `mv`（否则投影同步层会重新引入认领竞态） |

> **无感过渡策略**：当前单机、CC 仍用 `mv`、脚本不变——分布式改造可对 OC 与老板**完全无感**，他们看到的仍是 INBOX / DONE 文件。只有真正跨机器时，才需在 CC 侧把 `mv` 换成 reserve-write，而那一步可由「投影层 + 一个薄 reserve 脚本」承接，prompt 与 hook 文案几乎不动。

---

## 6. 迁移路径（场景门控，每阶段前置条件）

> 设计改动：在三份评审的 P0→Px 之前**插入「场景门 P-1」**——先回答「是否真的需要分布式」。这是 v2/v3 反复要求补的「Why」落到流程上。

| 阶段 | 内容 | 前置条件 / 何时进 |
|------|------|------------------|
| **P-1（场景门，决策非建造）** | 明确驱动场景：是否会出现「OC/CC 异机共享盘」或「多 CC 跨机抢同一任务」？ | **总是先做**。若两者皆否 → **停在 v1，本文档作「待启用设计」存档**，不进 P0。 |
| **P0（单机，行为不变；行动项见下）** | ① 写死认领仲裁规则（node_id 主键 + 每次 transition bump），即便单机也作为 spec 存档；② 定义 task 记录 schema；③ 确认 v1 stale 回收健在并在新状态机里保留（防 v3 点 A 回归）；④ 旧设计文档加导流链接；⑤ 若选 CRDT 路线，定库选型 + node_id 持久化 + tombstone/GC | P-1 判定「未来会跨机器」时进入。单机无并发，安全构造性。 |
| **P1（reserve-before-execute + lease）** | 实装 reserve/settle/confirm + lease TTL 回收 + 仲裁裁决；CC 的 `mv` 切到 reserve-write（投影层承接） | 必须先完成 P0 的仲裁规则、schema、stale/lease 回收（v3 点 A、问题1 残留）。 |
| **P2（文件同步 / Syncthing）** | 跨机共享盘 + CRDT；处理 Syncthing `.sync-conflict-*`；定义分区检测强制门（quorum/peer-ack） | 必须先定 **分区检测机制**（v3 点 B）+ **Syncthing 冲突文件压制**（点 D）+ CRDT 载体形态（单 DB vs 每任务一文件）。 |
| **P3（中继 / 中心服务器 或 节点签名）** | 二选一：server 路线（mutex 白送、引入联网）或 CRDT + 签名认证路线 | 取决于 P-1/P2 对「联网依赖 vs 自建复杂度」的偏好。 |
| **P4（P2P 直连）** | libp2p / WebRTC 去中心化 | 仅当明确要抗审查 / 无中心时。 |

### P0 可执行行动项（打勾即完成）

> **状态（2026-07-25，MVP `P0-20260725-mvp-implement` 后）**：MVP 已落地两件事——① `dashboard/server.py` 升级为 Handoff Server（`POST /api/tasks` 写 INBOX、`GET /api/tasks/pending` 读 INBOX、后台 SQLite 仅作任务日志、`/` 与 `/api` 不变）；② reserve-before-execute 已写入 `README.md §任务认领` 与 `done-template.md`（CC 侧不改）。文件协议与认领权威不变。下方逐条标注**当前已验证状态**。

- [ ] **A1**：把 §3.3 仲裁规则（node_id 主键、每次 transition version bump、删 wall-clock tiebreak）作为 `docs/handoff-claim-rules.md` 落档（spec，单机也成立）。
  - **状态：未完成**（超出本 MVP「两件事」scope）。MVP 已在 README 文档化 reserve-before-execute 协议主干，但 §3.3 完整仲裁规则（node_id 主键 / version bump）尚未落独立 spec 档。留作后续专项。
- [ ] **A2**：定义 task 记录 schema（id / priority / status / version / node_id / lease_until / artifacts…）写入同档，给未来投影 / CRDT 当目标。
  - **状态：部分**。Handoff Server 的 `task_log` 已给出一份 SQLite schema（见 `dashboard/server.py` `init_db`），但那是**日志** schema，非 A2 所指的权威 task-record schema；权威 schema 待随 A1 一并落档。
- [ ] **A3**：审计 v1 stale 回收：实测 `INBOX/`/`IN_PROGRESS/` 超 30min 是否真触发 SessionStart hook 写 `ALERT/{id}.stale.md`；在新状态机（§3.2）的 reserved/claimed/in_progress 上明确 lease TTL→reclaim，并保证投影把 claimed/in_progress 映回 `IN_PROGRESS/` 让现有 stale-hook 继续生效（防 v3 点 A 回归）。
  - **状态：未完成**（需实测 hook，超出本 MVP scope）。MVP 未触碰 stale 回收路径，v1 行为保持不变；lease TTL→reclaim 仍待 P1 实装。
- [x] **A4**：在 `docs/` 旧设计文档顶部加「已被最终设计取代」导流链接，消除概要冲突（**已完成**）。
- [ ] **A5（仅当选 CRDT 路线）**：定库选型 + node_id 持久化方案 + tombstone/GC 责任方（谁跑 GC）。
  - **状态：N/A**。P-1 场景门尚未判定要走 CRDT；当前停在 v1，A5 不触发。

> A1–A4 是**场景无关、低成本、高价值**的，无论最终走不走分布式都该做。A5 仅在 P-1 判定要上 CRDT 时才做。本 MVP 已兑现「P0 可启动」评审结论中与 **server + 协议文档化** 相关的部分；A1/A2（spec 落档）、A3（stale 实测）建议作为紧随的独立小任务推进。

---

## 7. 不纳入范围（明确说不）

1. **GitHub 不作为权威认领 / 状态层。** `assignees` 是数组、`--add-assignee` 累加、无 CAS 原语 → 并发认领双 assign 且两端都已执行，副作用残留（v4 关键问题1）；且当前 workspace 非 git 仓库、无 remote、无 `gh`、违反 v1「无需联网」核心不变量（v4 关键问题2）。GitHub 仅可作 §8 的只读镜像。
2. **不做乐观执行。** CC 无中途取消通道、副作用不可事务化回滚（v2 关键问题1）；任何方案都必须 reserve-before-execute。
3. **不用墙上时钟作认领主键。** 时钟偏移漏洞（v2 关键问题3、v3 残留）；统一 node_id 主键。
4. **不引入第二个权威存储 / 不做双写 fallback。** 「GitHub 离线 fallback 文件、愈合以 GitHub 为准」制造双权威、分裂脑、愈合静默丢数据（v4 关键问题3）；权威存储只有一个。
5. **不为「可能跨机器」预先建造 CRDT / Syncthing / server。** 由 P-1 场景门决定；当前场景未出现 → 停在 v1，分布式按需启用。
6. **不删 v1。** v1 是本协议的单机最优退化形式，也是永久的离线 fallback。

---

## 8. 借 GitHub 之长，不背 GitHub 之债（吸收 v4 的只读镜像建议）

v4 唯一真实的价值是**人眼可见性 / 审计**（Issues timeline、Projects 看板），这正是 v1/v3 的短板。按 v4 评审结论的混合方案：

- **保留 v1（或 v3）为唯一权威认领 / 状态层**，互斥仍靠本地原子 `mv` / reserve-before-execute。
- 加一个**单向、只读、尽力而为**的导出器：本地任务状态 → GitHub Issues / Projects。
- **绝不参与认领裁决，绝不被 CC 读取来决策。** 导出失败不影响 handoff 正确性。

定位：独立小任务（P2 级），与认领权威解耦。前提仍是「workspace git 化 + remote + `gh` 授权」——这是可见性的成本，不是正确性的必需。

---

## 9. 三份评审整合对照（AC 自检）

| 评审关键意见 | 本设计如何处置 | 章节 |
|-------------|--------------|------|
| **v2 关键问题1**：乐观认领→执行→回滚对 CC 不可行 | 采纳：reserve-before-execute，副作用只在 confirm 后 | §3.1、§7.2 |
| **v2 关键问题2**：兼容层认错脚本职责 | 采纳：trigger/notify 不变，真兼容面 = CC 的 ls/mv/DONE + hook | §5 |
| **v2 关键问题3**：CRDT 规则 / 迁移 / 分区愈合欠定义 | 采纳：仲裁改 node_id、回退走 version bump、补分区愈合一节 | §3.3、§6(P2)、§7.3 |
| **v3 判决**：P0 可启动；残留 = 仲裁规则未定、分区检测缺位、stale 回收回归、缺 Why | 全部吸收：钉死仲裁、加分区强制门、补 lease 回收、加 P-1 场景门 = Why | §3.2、§3.3、§4、§6 |
| **v4 判决**：否决 GitHub 作权威；建议只读镜像 | 采纳：GitHub 只读镜像，不入权威层 | §7.1、§8 |
| **客观中立**：不偏袒单一方案 | 传输层并列 server / CRDT / 文件同步，列出各自「正确性 vs local-first」权衡 | §4 |

---

> 本文档为设计综合，不改任何代码或核心配置。落地行动项见 §6 P0 checklist。
