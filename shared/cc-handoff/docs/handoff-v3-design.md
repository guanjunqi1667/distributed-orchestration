# Handoff v3 — Reserve-Before-Execute 分布式工作台

> ⚠️ **已被 [`handoff-final-design.md`](./handoff-final-design.md) 取代**（本档 reserve-before-execute 协议主干被最终设计采纳为「跨机器才需要」的核心设计，残留缺陷——仲裁规则、分区检测、stale 回收——见最终设计 §3.3 / §6 / §3.2）。

> 基于 v2 + CC 评审反馈修订。核心变更：乐观执行 → Reserve-Before-Execute。

## v2 问题回顾

| 问题 | v2 方案 | 问题 |
|------|---------|------|
| 认领竞争 | 乐观执行，输方回滚 | CC 无取消通道，副作用不可回滚 |
| 分区双跑 | CRDT merge 状态 | 仓库文件改动无法 merge |
| 兼容分析 | trigger-cc/notify 改 CRDT | 它们不读写任务存储 |

## v3 核心改动

### 1. Reserve-Before-Execute（替代乐观执行）

```
A 想执行任务 T：
 1. Reserve:  写 CRDT status=reserved, v+1
 2. Settle:   等待 lease 窗口（3s），gossip 收敛
 3. Confirm:  检查本地 CRDT：无人 claim → 改 status=claimed，启动 agent
               有人 claim（higher priority）→ 放弃 reserve，不启动
 4. Execute:  agent 运行
 5. Done:     写 CRDT status=done, v+1
```

reserve 是无副作用的（仅改 status），输方只需放弃 reservation。

### 2. 分区隔离（防双跑）

```
分区期间：节点只能 reserve，不能 claim 和执行
愈合后：gossip 收敛 → 只有胜出节点 claim → 执行
```

### 3. 兼容层正确定位

| 组件 | 实际职责 | 迁移方式 |
|------|---------|---------|
| trigger-cc.sh | 拉起 CC 进程 | 不变（与任务存储正交） |
| notify-openclaw.sh | liveness + push 通知 | 不变 |
| CC prompt + hook | 读 INBOX, mv 认领, 写 DONE | CRDT → 文件投影（单向） |
| SessionStart hook | 扫描 INBOX | 由投影层响应式触发 |

### 4. CRDT 补全

- 状态空间：`pending → reserved → claimed → in_progress → done | cancelled`
- rework = done → pending (version bump)
- node_id：本地随机生成持久化（P0 即有）
- tombstone：task 完成 24h 后自动 GC
- 分区愈合：reserve-only + 愈合后裁决

## 迁移路径

| 阶段 | 内容 |
|------|------|
| P0 | 本地 CRDT + 文件投影（单机，行为不变） |
| P1 | reserve-before-execute + lease 窗口 |
| P2 | 文件同步模式（Syncthing） |
| P3 | Relay 模式 |
| P4 | 节点签名 + P2P |
