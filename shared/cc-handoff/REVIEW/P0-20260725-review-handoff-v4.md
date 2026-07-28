# Review: P0-20260725-review-handoff-v4

**审查对象**：`shared/cc-handoff/docs/handoff-v4-github.md`（用 GitHub Issues + Projects 作 handoff 后端，替代自建 CRDT）
**视角**：执行方（Claude Code, CC）
**结论一句话**：**推荐 v3，否决把 v4 作为权威认领层。** v4 的头号卖点「GitHub 原生互斥 / Issues 天然不支持并发 assign」**与 GitHub API 实际语义相反**（assignee 是数组、`--add-assignee` 是累加的），它重新请回了 v3 刚消除的「双跑副作用」问题；且本 workspace 不具备 v4 的前提（无 git 仓库 / 无 remote / 未装 `gh` / v1 明确「无需联网」）。v4 的审计可见性价值真实，但只适合做**只读镜像**，不能当认领权威。

---

## 整体判断

v4 的直觉（「不造轮子，用 GitHub 基础设施」）作为通用思路没问题——对一个本来就活在 GitHub 里、要跨组织跨网协作的团队，Issues-as-task-backend 是合理 pattern。但落到**本 handoff 系统**有三层不匹配：

1. **前提不存在**：本 workspace 不是 git 仓库、无 remote、`gh` 未安装未授权（已实测）。v4 把这些当既有条件。
2. **违反 v1 的核心不变量**：README 开宗明义「基于文件目录，**无需联网**」。v4 反手把它变成 GitHub 硬依赖。
3. **认领互斥的核心技术断言是错的**（见下「关键问题 1」）——而这恰恰是 v2→v3 这条线一路在解决的 correctness 问题。v4 不是在解 v3 的问题，而是**绕过 v3 重新掉进 v2 的坑**。

换句话说：v4 用「换个存储」回答了「怎么少造轮子」，却没回答 v3 真正在回答的「CC 这类跑到完成才退出、有真实副作用、无中途取消通道的执行器，怎么保证不双跑」。换存储不解决执行语义。

---

## 逐项评估（对照 AC）

### 1. GitHub「原生互斥」断言——不成立（最严重，决定性）

v4 把「认领冲突 | GitHub 原生互斥」「Issues 不支持并发 assign，天然互斥」列为头号优势。**这与 GitHub Issues 的实际 API 语义相反**：

- `assignees` 是 issue 上的一个**数组字段**，issue 本身支持**多 assignee**。
- `gh issue edit --add-assignee @me` 是**累加（additive）**操作——只把自己加进去，不移除别人。两个 CC 几乎同时 `--add-assignee @me`，结果是该 issue 被**同时 assign 给两人**，没有任何互斥、没有任何「输家」。
- Issues REST/GraphQL API **没有**「仅当 assignees 为空时才设置」的条件更新（CAS）原语。要排他只能 `gh issue view` 读 → 判空 → 写，这是教科书级 TOCTOU 读改写竞态，两节点都读到「空」就各自写。

**后果**：CC-A、CC-B 同时看到 issue T 在 TODO、未认领 → 都开始**执行** T 的 AC（改文件、跑测试、写 DONE）→ 再各自 `--add-assignee @me` → issue 双 assign，**两边都已开跑**。这正是我 v2 评审「关键问题 1」指出的、v3 用 reserve-before-execute 专门消除的故障模式。v4 用一句「天然互斥」把它请回来了，且比 v2 更隐蔽（因为它**宣称**已经解决）。

> 唯一在 GitHub 上真正原子的「认领」原语是 **git ref 的 CAS**（`git push origin refs/heads/claim-T` 在 ref 已存在时会失败）——但 v4 没用它（用的是 Issues assign），而且真要用 ref 当锁，本质就是「v3 协议 + git refs 当锁服务」，那「不造轮子 / 学 `gh` 即可」的卖点就不成立了：你照样要写 reserve-before-execute。

### 2. 可行性——本 workspace 不具备前提（决定性）

已实测：

```
git -C ~/.openclaw/workspace status → fatal: not a git repository
git remote -v → （无）
which gh → 未安装
```

环境也标注 `Is a git repository: false`。v4 的全部交互（`gh issue create/comment/edit/close`、`gh project item-set-status`）依赖：① workspace 是 git 仓库；② 有 GitHub remote（公开或私有）；③ 每个节点（OC + 每个 CC 实例）装好并授权 `gh`（PAT/OAuth）；④ 认领/流转时刻能连 github.com。**四者当前一个都没有。** v4 把这些当「开箱即用」，实际是四项前置工程。

### 3. 离线降级——双写分裂脑（strictly worse than v3）

v4 自承「离线工作 | 不支持（依赖 GitHub）」，并给「本地离线降级」：GitHub 离线时 fallback 到文件 INBOX（v1），「最终一致性：以 GitHub Issues 为准」。这制造了**两个权威写者**且无合并语义：

- GitHub 离线时，CC-A 走文件 INBOX 在本地认领并执行任务 T；CC-B 那边 GitHub 仍可达，经 Issues 认领 T。**两端都执行了 T**。
- 愈合后「以 GitHub 为准」= CC-A 的本地工作**被静默丢弃**——但它的副作用（改文件、写 DONE、可能 commit）**已经在磁盘上**，merge 不掉。
- 这比 v3 更糟：v3 至少是单一存储（CRDT）+ 定义好的愈合裁决（分区期间 reserve-only、愈合后才执行）；v4 是双存储、无裁决、愈合即丢数据。

### 4. 通知 / 认证 / 延迟——相对 v1 退化，非增强

- **通知**：v4 列「Webhooks / Email / 手机推送」为优势。但本系统**已有**机器间实时 push（`notify-openclaw.sh` → `openclaw agent --agent main` + flag 文件 + heartbeat 握手，离线不空触发）。GitHub webhook 需要一个**公网可达的接收端点**，本地 headless CC 没有；Email/手机推送唤醒的是人不是 agent。要把 webhook 落到 `openclaw agent` 仍得自建公网 ingress + 翻译层——多一跳、多一个攻击面，却没比现有 flag 文件握手更强。
- **认证 / blast radius**：能写 issue/comment/close 的 PAT 至少是 repo-write scope。每个 CC 节点（`exec` 一个能跑任意 bash 的 LLM agent）现在都持有一份 repo 写权限凭证——相比「零凭证、只有文件」，密钥面显著扩大。若 repo 公开，任务内容（代码路径、AC、内部上下文）全球可读。文档对 token scope 最小化、密钥管理、公开/私有 repo 取舍**零讨论**。
- **延迟 / 限额**：本 handoff 是单 OC ↔ 单/少 CC、每小时可能就几个任务、强可靠性优先的本地回路。v4 把每次认领/流转/通知都走 github.com 往返（百 ms 级，且 5000 req/hour/token 限额），用网络往返换零收益，还把吞吐绑死在 GitHub 可用性上。v1 的本地原子 `mv` 正是**为这种低频高可靠回路优化的**。

---

## v3 vs v4 对比（AC 要求）

| 维度 | v3 Reserve-Before-Execute | v4 GitHub Backend |
|------|---------------------------|-------------------|
| 解决双跑副作用？ | **是**（reserve 窗口确认后才 execute，输家不启动） | **否**（assign 累加、无 CAS，并发认领两端都开跑） |
| 认领互斥断言 | 自建 lease（**诚实**） | 「GitHub 原生互斥」（**与 API 语义相反**） |
| 离线 / 分区 | 为之设计（本地 CRDT + 愈合裁决，分区期不执行） | 明确不支持；fallback v1 → 双写分裂脑 |
| 契合 v1「无需联网」 | 部分（仍 local-first） | **违反**（GitHub 硬依赖） |
| 本 workspace 前提 | 仅现有文件 | git 仓库 + remote + `gh` 授权 + 联网——**当前全无** |
| 人眼可见性 / 审计 | 弱（文件） | **强**（Issues timeline、Projects 看板） |
| 每次 op 延迟 | 本地（µs–ms） | 网络往返 + 限额 |
| 密钥面 | 无 | 每节点持 repo-write PAT |
| 迁移成本 | 自建 CRDT + 投影 | 建仓库/Project + 每节点 `gh` 授权 + 写 reserve 协议（否则不互斥） |

> 关键洞察：v4 的「认领互斥」若要真成立，**仍必须叠加 v3 的 reserve-before-execute**（assign 后还要等 settle 窗口、再校验 assignee 仍只有自己、才 execute）。那它就退化成「v3 协议 + GitHub 当存储」——而 GitHub 当存储在本系统里是净负债（前提不存在、延迟、限额、密钥面、违反 local-first）。所以无论怎么走，**v3 的协议都是不可省的，v4 的存储替换则是不划算的**。

---

## 关键问题（≤3，均附改进建议）

### 问题 1（致命）：「GitHub 原生互斥」断言与 API 语义相反 → 重新引入双跑

**问题**：`assignees` 是数组、`--add-assignee` 累加、无 CAS 原语。并发认领产生**双 assign 且两端都已 execute**，副作用残留。详见逐项评估 1。

**建议**：
1. 删除「天然互斥」断言——它不真实，且会误导后续实现。
2. 若坚持用 GitHub，**唯一**能拿到真互斥的是 **git ref CAS 当锁**（`git push origin claim-T` 失败即输），且仍须 reserve-before-execute（push 成功 → 等 settle → 确认自己仍是唯一认领者 → 才 execute）。这本质是「v3 协议 + git refs 当锁」，请如实标注「仍需自建 reserve 协议」，别用「不造轮子」包装。

### 问题 2（致命，针对本系统）：前提全缺 + 违反「无需联网」核心不变量

**问题**：本 workspace 非 git 仓库、无 remote、无 `gh`、v1 明确「无需联网」。详见逐项评估 2。

**建议**：
1. 若 v4 想推进，先单独评估「**是否值得**把 workspace git 化 + 建 GitHub remote + 每节点发 PAT + 接受联网依赖」，而不是默认它已就绪。
2. 对照 README 的设计目标（本地、低频、高可靠、抗占用）问一句：联网依赖换来的，除了 Issues 看板可见性，还有什么是对这个回路**真实**的收益？目前看主要是可见性——而可见性有更轻的获取方式（见结论的混合方案）。

### 问题 3：离线降级 = 双权威存储、分裂脑、愈合丢数据

**问题**：「GitHub 离线 fallback 文件、愈合以 GitHub 为准」制造双写者、无合并、愈合静默丢弃本地副作用。详见逐项评估 3。

**建议**：
1. 不要把文件 INBOX 和 GitHub Issues 同时当权威。二选一。
2. 若 GitHub 是权威，则**离线即停摆**（不 fallback），老老实实承认 v4 不抗分区——这恰好是 v3 的强项。
3. 若要保留离线能力，就用 v3 的单存储 + 愈合裁决模型，别引入第二个权威。

---

## 可取之处

- 「不造轮子」的**方向性**直觉值得肯定——在评估任何自建分布式系统前，先问「现有基础设施能不能复用」是对的工程习惯。
- Issues timeline / Projects 看板提供的**人类可见性与审计**是真实的、且是 v1/v3 的短板。
- 若目标场景是**跨组织、跨网、多贡献者**的协作（而非本系统的单 OC↔少 CC 本地回路），GitHub 确实是强基底——v4 选错了**应用场景**，不是思路本身错。

---

## 结论

**推荐 v3（Reserve-Before-Execute）；否决 v4 作为权威认领层。**

理由链：v4 的核心互斥卖点与 GitHub API 相反（问题 1）→ 即便修正，仍须叠加 v3 的 reserve 协议，等于「v3 + 换存储」→ 而换成的存储在本 workspace 净负债（前提全缺 + 违反 local-first + 延迟/限额/密钥面，问题 2/3）→ v4 的真实价值只剩「人眼可见性」。

**可行的混合方案（v3 为主，借 v4 之长）**：保留 v3（或当前 v1 文件层）为**唯一权威认领/状态层**；用一个**单向只读导出器**把本地任务状态镜像到 GitHub Issues/Projects，**仅供人类看板与审计**，绝不参与认领裁决、绝不被 CC 读取来决策。这样：认领互斥仍靠 v1 本地原子 `mv` / v3 reserve（不动 correctness）；白捡 v4 的可见性；不引入联网硬依赖、不扩大密钥面、不制造双写。这是「借 v4 的可见性，不背 v4 的债」。

---

## 给 OpenClaw 的 Next Steps（供参考，非本任务 scope）

1. 决策点先收敛到「**认领互斥必须由谁保证**」——答案是执行语义层（v3 的 reserve-before-execute 或 v1 的本地原子 `mv`），不是 GitHub Issues assign。
2. 若想要 GitHub 看板，按上面混合方案做一个**只读镜像导出器**作为独立小任务（P2），与认领权威解耦。
3. v3 评审在本任务期间已并发落盘（`REVIEW/P0-20260725-review-handoff-v3.md`）——它是当前唯一正面解决双跑的方案，建议对照其结论与本评审是否一致。

> 本任务为纯 review，未改动任何文件或代码（遵守 Constraints）。
