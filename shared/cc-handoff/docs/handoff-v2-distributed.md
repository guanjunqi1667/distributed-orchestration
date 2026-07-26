handoff v2 design

> ⚠️ **已被 [`handoff-final-design.md`](./handoff-final-design.md) 取代**（本档为历史提案，其分布式 CRDT 思路经 v2/v3/v4 评审收敛后归入最终设计的「可插拔传输层」，权威结论以最终设计为准）。

> 没有一个节点是主机，谁都可以随时离开，任务不丢不重。

## 核心思想

任务系统 = CRDT 状态库 + 增量同步网络
- 每个节点持有完整任务集合的本地副本
- 没有中心服务器，没有主节点选举
- 任何节点可随时离开，重连后自动收敛

## 冲突解决

| 冲突场景 | 胜出方 |
|----------|--------|
| 同字段 version 不同 | version 高者赢 |
| version 相同 | done > in_progress > claimed > queued |
| 认领冲突 | 先 claim 者赢（timestamp + node_id） |

## 认领协议（无锁）

1. 节点 A 本地写 CRDT: status=claimed, version+1
2. 本地启动 agent 执行（不等待确认）
3. 通过 gossip 将变更扩散到其他节点
4. 其他节点 merge 冲突时纠正 A
5. A 收到纠正 → 终止 + 回滚

## 同步层

| 模式 | 适用场景 | 基础设施 |
|------|---------|---------|
| 文件同步 | 同局域网 | Syncthing，零额外服务 |
| Relay | 公网多节点 | 轻量 HTTP 转发 |
| P2P | 跨直连 | libp2p / WebRTC |

## 迁移路径

| 阶段 | 内容 | 关键点 |
|------|------|--------|
| P0 | 本地 CRDT 库 + 文件投影 | 现有文件不变，旧脚本兼容 |
| P1 | 文件同步 + gossip 协议 | 多节点基础 |
| P2 | Relay 模式 | 公网跨节点 |
| P3 | 节点签名 + 认证 | 安全 |
| P4 | P2P 直连 | 去中心化 |

## 兼容设计

- 现有 INBOX/DONE 文件：CRDT 库的只读投影
- 旧脚本读文件投影的继续工作，无需修改
- dashboard API 不变
- trigger-cc.sh 改为读本地 CRDT
- notify-openclaw.sh 改为写本地 CRDT
