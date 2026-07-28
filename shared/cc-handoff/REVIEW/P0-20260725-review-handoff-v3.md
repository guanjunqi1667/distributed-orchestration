# Review: P0-20260725-review-handoff-v3

**审查对象**：`shared/cc-handoff/docs/handoff-v3-design.md`（Reserve-Before-Execute 分布式工作台）
**视角**：执行方（Claude Code, CC）
**对照**：`REVIEW/P0-20260725-review-handoff-v2.md`（上次评审指出的 3 个关键问题）
**结论一句话**：**v3 方向对、致命问题（乐观认领）已解、兼容层定位已纠正——P0（单机、行为不变）可启动。** 但 reserve→claim 的**仲裁规则**和**分区检测机制**仍只是断言未落地，分别是进 P1 / P2 前的硬前置；另外 v1 的 **stale/超时回收**在 v3 里消失了，是单机也会暴露的回归风险，须补。

---

## AC 对照：上次 3 个关键问题，v3 解了没？

### 问题 1（致命：乐观认领→执行→回滚对 CC 不可行）——✅ 形状已解，2 处残留

v3 §1 把执行从「乐观」改成 **reserve-before-execute**：reserve 仅改 status（无副作用）→ settle → confirm 赢了才 claim+启动 agent → 输方「只放弃 reservation，不启动执行」。这正是 v2 评审给的建议，「终止+回滚」从「不可行」退化为「不需要」。**核心矛盾消除。**

残留（不挡 P0，挡 P1）：
- **reserve→claim 的仲裁规则未定义。** settle 收敛后，若多个节点都 reserved，谁有权 flip 到 claimed？文档只说「无人 claim → 改 claimed；有人 claim(higher priority) → 放弃」。但同优先级（绝大多数任务的常态）下靠什么 tiebreak？v2 已点名 claim 排序别用脆弱的 wall-clock、改 node_id/HLC——这条在 v3 的 reserved→claimed 转换上**没有兑现**。**进 P1 前必须写死这条规则**（建议 node_id 为主键）。
- **「settle 等 3s」并不检测分区**（见问题 3 的分区项），所以「confirm 赢了」在分区下可能是假收敛。

### 问题 2（兼容层认错了脚本职责）——✅ 已纠正（已用代码验证）

v3 §3 把 `trigger-cc.sh`/`notify-openclaw.sh` 标为「与任务存储正交、不变」，把真正的兼容面指为 **CC 的 `ls INBOX`/`mv 认领`/写 DONE + SessionStart 扫描 hook → 由 CRDT→文件投影单向驱动**。我复核了两个脚本（`bin/`）：
- `trigger-cc.sh`：只读 `STATE/cc.heartbeat`，`exec claude -p` 拉进程——不碰任务文件。
- `notify-openclaw.sh`：只读 `STATE/openclaw.heartbeat`、追加 `STATE/cc.notify.flag`、调 agent——不碰任务文件。

与 v3 描述一致。**定位正确。** 且 v3 不再把它包装成「透明只读、旧脚本零改」，而是坦诚承认 CC 的 mv 行为要改成 CRDT-write（v2 点名的「这是改 CC 工作流」现在被摊开说了，不再是隐含假设）——这是进步。

残留（须在实施时钉死）：投影层的文件搬运必须**幂等**，且 CC **不能再 mv**（否则 CRDT 与文件双写竞态）。新的 CC 协议（写 CRDT reserve 而非 mv）文档只列了一行，实施前要展开。

### 问题 3（CRDT 规则/迁移/分区愈合欠定义）——🟡 部分解

| 子项 | v2 要求 | v3 状态 |
|------|---------|---------|
| 回退/重开语义 | 明确走 version bump | ✅ `rework = done→pending (version bump)` 已写明 |
| node_id 来源 | P0 即有 | ✅ `本地随机生成持久化（P0 即有）` |
| tombstone/GC | CRDT 无界增长需 tombstone | ✅ `完成 24h 自动 GC`（但谁跑 GC、tombstone 自身如何 CRDT-gossip+回收，未细说，次要） |
| **stale/超时回收** | （v1 有 ALERT/stale 防卡死） | ❌ **缺失，见下「最该补」** |
| **reserve→claim 仲裁** | 别用 wall-clock | ❌ 未定义（同问题 1 残留） |
| **分区愈合机制** | 承认 CRDT 合并不掉副作用，靠 reserve-only+愈合裁决 | 🟡 **政策对，但无检测机制，见下** |
| Syncthing×CRDT 双层冲突 | P1 须防 `.sync-conflict-*` | ❌ 仍未提（P2 前置） |
| CRDT 库选型 / task schema | P0 实施前须定 | ❌ 仍未指定（P0 实施前置） |

---

## 仍有问题的部分（按严重度）

### A（最该补，单机也会犯）：stale / 超时回收消失了 —— v1 回归

v1 有明确的防卡死机制：任务在 `INBOX`/`IN_PROGRESS` 超 30min → SessionStart hook 写 `ALERT/{id}.stale.md` → 老板决定等/中断/回收重派（见 `README.md` §占用策略）。v3 的状态机 `pending→reserved→claimed→in_progress→done|cancelled` **没有 lease 超时→reclaim 这条边**：一个 CC reserve→claim→execute 中途崩了，任务永久卡在 `claimed/in_progress`，无人接管。`cancelled` 是个状态，但「谁、何时、凭何触发」没写。

这在**单机 P0/P1 就会咬人**（CC 随时可能崩），不是分布式才有的问题。**建议**：给 reserved/claimed 加 lease TTL，超时→他人可 re-reserve/re-claim；或明确投影层必须保留 v1 的 stale-hook 路径（投影把 `claimed/in_progress` 映回 `IN_PROGRESS/` 目录，让现有 stale-hook 继续生效）。**进 P1 前必须落定。**

### B（P2 前置）：分区检测机制缺位，「reserve-only」目前是断言不是保证

v3 §2 称「分区期间：节点只能 reserve，不能 claim 和执行；愈合后只有胜出节点 claim」。但 §1 的 confirm 步骤是「等 lease 3s → 检查本地 CRDT 无人 claim → claim」——**3s 等待不要求 peer 可见性**。于是分区中的孤立节点会以为收敛了，照常 confirm→claim→execute；对岸另一孤立节点同理 → 愈合时两次执行都已落盘，CRDT 只能 merge 出一个 status 赢家，**副作用合并不掉**（正是 v2 问题 3(c) 点名的 executor-with-side-effects 难点）。

「reserve-only」要成立，confirm 必须有**强制门**：要么 claim 需 quorum（可见 ≥ ⌊N/2⌋+1 peers），要么 lease 需所有已知 peer 的 ack。文档两者都没给。**建议**：进 P2 前写明 quorum/peer-ack 规则，并据此重算 lease 窗口（3s 是拍脑袋，多机收敛未必够）。P0/P1 单机无分区，不挡启动。

### C（实施前置，非设计缺陷）：CRDT 库选型 + task schema 未定

P0 = 「本地 CRDT + 文件投影」，但没说用 automerge / yjs / 自研 LWW-map，也没给 task 记录 schema。不影响设计审批，但动工前要定。node_id 已确定本地随机持久化，可复用为 CRDT 副本 id。

### D（P2 前置）：Syncthing × CRDT 双层冲突仍只字未提

Syncthing 自身会生成 `.sync-conflict-*`；CRDT 再叠一层 merge，两者交互是真实集成坑（v2 已提）。P2 前须说明 CRDT 载体是单 DB 文件还是每任务一文件，以及如何压制 Syncthing 冲突文件。

### E（元，建议补）：仍缺「Why / 驱动场景」

v2 评审的首要缺口——「v2 到底要解什么痛点」——v3 依旧没有。现在协议形状更稳，这个缺口没那么致命了，但仍建议补一段：是多机多 CC？OC/CC 异机？这决定 P0→P4 是否值得、还是 Syncthing-on-v1 即可（注意：若 OC/CC 异机共享文件，v1 的本地原子 mv 保证会失效，那时分布式认领**确实**必要——这一点值得在「Why」里讲清，反过来支撑这套机制的必要性）。

---

## 结论：P0 可启动

| 阶段 | 判定 | 前置条件 |
|------|------|---------|
| **P0**（本地 CRDT+投影，单机行为不变） | **✅ 可启动** | 动工前定 CRDT 库选型 + task schema（C）；确保投影保留 v1 stale 路径或定义 lease TTL（A）。单机无并发，安全是构造性的。 |
| **P1**（reserve-before-execute + lease） | 🟡 待补 | 必须先定 **reserve→claim 仲裁规则**（node_id 主键）+ **stale/lease 超时回收**（A、问题1残留）。 |
| **P2**（Syncthing） | 🟡 待补 | 必须先定 **分区检测机制**（quorum/peer-ack，B）+ **Syncthing 冲突文件处理**（D）。 |
| P3/P4 | — | 顺理，本次不评估。 |

**为何是「可启动」而非「仍需修改」**：v2 的致命问题（乐观认领对 CC 不可行）已在 v3 用 reserve-before-execute 根本性解决；兼容层定位已纠正（代码已验证）；CRDT 补全做对了 rework/node_id/tombstone 三项。剩余项是 **P1/P2 的并发前置**与**实施细节**，不影响 P0 在单机、行为不变、无并发的前提下安全启动。设计方向予以通过。

> 本任务为纯 review，未改动任何设计文档或代码（遵守 Constraints）。仅写入本评审文件。
