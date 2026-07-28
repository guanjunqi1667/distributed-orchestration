# Review: P0-20260725-review-handoff-v2

**审查对象**：`shared/cc-handoff/docs/handoff-v2-distributed.md`（分布式无主工作台设计）
**视角**：执行方（Claude Code, CC）
**结论一句话**：技术素描有想法，但**乐观认领协议对 CC 这类「跑到完成才退出、有真实副作用、无中途取消通道」的执行器是根本性不匹配**；兼容层定位错了对象；CRDT 冲突规则欠定义。建议在动工前先把「驱动问题」和「reserve-before-execute」两点定下来。

---

## 整体判断

v1 是**刻意**的无网络、目录即状态协议（见 `shared/cc-handoff/README.md`），用本地原子 `mv INBOX→IN_PROGRESS` 当互斥锁，避开一切分布式复杂度。v2 引入 CRDT + gossip + Syncthing/Relay/P2P 是一个很大的表面积（时钟同步、tombstone、冲突语义、认证、分区愈合）。

**首要缺口：文档没有说明 v2 要解决的「具体痛点」是什么。** 是多机多 CC 实例？是 OC 与 CC 分处不同机器？还是单机并发？驱动场景决定方案是否必要——

- 若痛点只是「OC/CC 不同步在线」，在 v1 文件层直接挂 Syncthing 可能就够了，不需要 CRDT。
- 若痛点是「多 CC 跨机抢同一任务」，那才需要分布式认领——但此时恰恰**不能用**乐观认领（见关键问题 1）。

没有驱动问题，就无法判断 P0→P4 这套基础设施的性价比。**建议先补一段「Why」：当前 v1 在什么场景下失效，v2 的最小目标是什么。**

---

## 逐项评估（对照 AC）

### 1. CRDT 冲突解决规则——方向对，细节欠定义且有一处不安全

冲突表（`version 高者赢` / 同版本 `done>in_progress>claimed>queued` / claim 冲突 `timestamp+node_id` 先者赢）本质是 **LWW（last-writer-wins）+ 状态优先级 tiebreak**，作为 CRDT 草图成立，但：

- **状态优先级作为 tiebreak 会吃掉「回退」语义**：rework（done→queued 重开）或「纠正后回滚」都需要把状态往**低**走，而 `done>…>queued` 的全局规则在同版本下永远让高状态赢。除非每次回退都靠 version bump 强行盖过，但文档没说，且 bump 策略未定义。→ 见关键问题 3。
- **claim 用墙上时钟 timestamp 排序有时钟偏移漏洞**：慢时钟节点会「更早」从而总赢；同瞬间的两次 claim 在时钟未同步时跨副本可能暂不一致。node_id 作次级 tiebreak 让最终收敛确定，但主键仍是脆弱的 wall-clock。建议改 **node_id 为主键**，或用 **HLC（混合逻辑时钟）**。
- **状态枚举不全**：v1 实际状态空间是 `INBOX / IN_PROGRESS / DONE / INBOX_ARCHIVE / REWORK 标记 / ALERT(stale)`。v2 的 `{queued, claimed, in_progress, done}` 漏了 archived、rework、stale——这些在迁移时必须有 CRDT 表示或明确「投影层处理」。

### 2. 乐观认领协议——对 CC 不适用（最严重）

协议步骤 2「本地启动 agent 执行（不等待确认）」+ 步骤 5「A 收到纠正 → 终止 + 回滚」，在 CC 场景下**没有实现路径，且会回退 v1 刻意消除的「双跑浪费」问题**。详见关键问题 1。

### 3. 文件投影兼容层——定位错了对象

文档声称「trigger-cc.sh 改为读本地 CRDT / notify-openclaw.sh 改为写本地 CRDT」「旧脚本读文件投影的继续工作，无需修改」。这与两个脚本的实际职责不符。详见关键问题 2。

### 4. 迁移路径（P0→P4）——有遗漏

P0「本地 CRDT 库 + 文件投影，现有文件不变，旧脚本兼容」至少缺：具体 CRDT 库选型（automerge/yjs/自研 LWW-map？）、task 记录 schema、`node_id` 来源（P3 才签名认证，但 claim tiebreak 从 P0 就要 node_id）、tombstone/GC（CRDT 无界增长）、以及最关键的**分区愈合语义**。详见关键问题 3。

---

## 关键问题（≤3，均附改进建议）

### 问题 1（致命）：乐观认领 → 执行 → 纠正回滚，对 CC 不可行

**问题**：协议让节点 A 在**未确认赢得认领**时就启动 agent 执行，输了再「终止 + 回滚」。但 CC 是 `trigger-cc.sh` 里 `exec claude -p "..." --max-turns 500` 拉起的 headless 进程——**跑到 prompt 完成才退出，中途没有任何「外部取消」通道**（现有 hook 只有 SessionStart=alive / Stop=offline，无 cancel hook）。而且 CC 执行的是**改真实仓库文件、跑测试、写 DONE、可能 commit** 的编码任务，所谓「回滚」是**不可事务化撤销**的。

**后果**：两个 CC 都乐观认领并开跑 → 都烧 token/turns、都改了仓库 → 输的一方工作被丢弃但副作用残留。这正是 v1 用本地原子 `mv` **前置互斥**所避免的情况，v2 把它重新请回来了。CRDT 的「纠正」是数据层 merge，把它映射到「杀进程 + 撤销文件系统改动」是一个文档没有弥合的语义鸿沟。

**建议**：把乐观的范围**限制在 reservation，不覆盖 execution**——即 **reserve-before-execute**：
1. A 写 CRDT：status=claimed, v+1（乐观 reservation）。
2. **等待一个 lease/settle 窗口**（gossip 收敛，或「窗口内无更高优先 claim」），确认自己赢了再启动 agent。
3. 输的一方只是放弃 reservation（无副作用，可安全丢弃），**根本不启动执行**。

这样「终止+回滚」就从「不可行」退化为「不需要」。若一定要保留乐观执行，则必须先给 CC 加一个真正可用的 mid-run cancel hook + 事务化工作区（如 git worktree per task，输了直接丢弃 worktree）——这是远超当前 hook 体系的大改，应在文档里单列为前置依赖而非隐含假设。

### 问题 2：兼容层认错了脚本职责

**问题**：`trigger-cc.sh` 与 `notify-openclaw.sh` **并不读写任务存储**。看代码：
- `notify-openclaw.sh`（L11–27）：读 `STATE/openclaw.heartbeat`、写 `STATE/cc.notify.flag`、调 `openclaw agent --agent main`——是**心跳/liveness + push 通知**，跟 INBOX/DONE 任务文件零关系。
- `trigger-cc.sh`（L30–40）：读 `STATE/cc.heartbeat`、`exec claude -p`——是**拉起进程**，任务文件的真正消费者是 CC 自己（prompt 里的 `ls INBOX` + SessionStart hook + `mv` 认领）。

所以「trigger-cc.sh 读 CRDT / notify-openclaw.sh 写 CRDT」是改错了对象。**真正的兼容面是 CC 的「目录即状态 + mv 认领」行为与 SessionStart 扫 INBOX hook**。而让 CRDT 成为权威，意味着 CC 不再自己 `mv`，改由投影层响应式地把文件搬进 IN_PROGRESS——**这是改 CC 的工作流，不是「透明只读投影、旧脚本无需修改」**。此外，投影层架在 Syncthing 上有传播延迟，会把 v1 靠本地原子 `mv` 规避掉的认领竞态**在投影同步层重新引入**（两节点都看到文件还在 INBOX 就各自认领），与 v2 的初衷相悖。

**建议**：
1. 重写兼容分析，对准**真正的任务存储客户端**：CC 的 `ls INBOX` / `mv INBOX→IN_PROGRESS` / `mv IN_PROGRESS→INBOX_ARCHIVE` 流程，以及 SessionStart 扫描 hook。明确「CRDT→文件投影」必须单向、权威，且 CC 的 mv 行为要改成 CRDT-write。
2. `trigger-cc.sh` / `notify-openclaw.sh` 维持现状（它们是 liveness+push，与任务存储正交，迁移无需动）。
3. 若坚持投影层，需证明投影的**认领互斥**至少不弱于 v1 的本地原子 `mv`——否则投影在 Syncthing 上的延迟竞态会让「防重复」这一核心保证倒退。

### 问题 3：CRDT 规则与迁移细节欠定义；分区愈合语义缺失

**问题**（综合 AC 点 1 + 点 4）：
- **回退/重开语义靠未定义的 version bump**：状态优先级 `done>…>queued` 在同版本下会拒绝任何「往低走」（rework、回滚）。文档没说每次回退是否/如何 bump version。
- **P0 不可执行**：缺 CRDT 库选型、task schema、`node_id` 来源（claim tiebreak 从 P0 就要，但身份认证在 P3）、tombstone/compaction（CRDT 无界增长，v1 的 archive 是「移走」，CRDT 需要 tombstone）。
- **分区愈合是 executor-with-side-effects 的真正难点，全文未提**：A、B 分区期间各自认领并**执行了**同一任务、各自改了仓库/写了 DONE；愈合时 CRDT 只 merge 出一个 status 赢家，但**两边的仓库改动都已在磁盘上**，merge 不掉。这是比「认领竞态」更严重的双跑污染，且无法靠 CRDT 解决。
- **P1 Syncthing × CRDT 双层冲突**：Syncthing 自己会生成 `.sync-conflict-*` 文件；CRDT 再叠一层 merge，两者交互是真实集成隐患，文档没提。

**建议**：
1. 显式定义**回退/重开走 version bump**（每次 status 变更必 bump），并删除「同版本状态优先级」这条会误导的 tiebreak，或限制它只在「真正并发同版本」时生效并写明边界。
2. P0 补齐：库选型 + task schema + node_id 生成/持久化 + tombstone 方案。建议 node_id 从 P0 就有（本地随机生成持久化即可），不必等 P3 签名。
3. **单独写一节「分区与双执行」**：承认 CRDT 只能合并 status、合并不掉已发生的副作用；对策只能是问题 1 的 reserve-before-execute（分区期间不执行，愈合后重裁决）+ 每任务独立 git worktree（副作用隔离，输了丢 worktree）。没有这一节，分布式前提就不成立。
4. P1 明确 CRDT 载体是「单 DB 文件」还是「每任务一文件」，以及如何压制 Syncthing 自身冲突文件，避免双层打架。

---

## 可取之处

- 「文件投影兼容旧脚本」的方向本身是对的——以投影为过渡层降低迁移风险，比一步到位切 CRDT 务实。
- 迁移分阶段（P0 本地单机 → P4 P2P）的顺序合理：先在单机把 CRDT+投影跑通、与 v1 影子比对，再上多节点。
- 同步层按场景给三档（Syncthing/Relay/P2P）是务实的渐进式选型。

---

## 给 OpenClaw 的 Next Steps（供参考，非本任务 scope）

1. 先补 v2 的 **「Why / 驱动场景」**——确定是否真需要分布式，还是 Syncthing-on-v1 即可。
2. 若推进，把**问题 1（reserve-before-execute）**定为设计硬约束，否则整个乐观认领前提不成立。
3. 重写兼容层分析对象（问题 2），并补 P0 的 schema/node_id/tombstone + 分区愈合一节（问题 3）。

> 本任务为纯 review，未改动任何文件或代码（遵守 Constraints）。
