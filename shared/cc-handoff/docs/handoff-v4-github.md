# Handoff v4 — GitHub as Handoff Backend

> ⚠️ **已被 [`handoff-final-design.md`](./handoff-final-design.md) 取代**（GitHub 不作权威认领层——assign 累加无 CAS、违反 local-first；其可见性价值降级为最终设计 §8 的单向只读镜像）。

> 不造轮子。GitHub Issues + Projects + API = 开箱即用的分布式任务系统。

## 核心思路

用 GitHub 的基础设施替代自建 CRDT + 文件投影：

| 你的需求 | GitHub 提供 |
|---------|------------|
| 任务队列 | Issues（label=handoff） |
| 看板 | Projects（Todo / In Progress / Done） |
| 认领 | Assign yourself |
| 状态流转 | Project column 切换 |
| 多节点 | 任意机器开浏览器或调 API |
| 跨网络 | GitHub 本身就是全球分布 |
| 审计 | Issue timeline + comments |
| 通知 | Webhooks / Email / 手机推送 |
| 认证 | GitHub OAuth / PAT |
| 持久化 | GitHub 服务器，不丢数据 |
| 冲突解决 | Issues 不支持并发 assign，天然互斥 |

## 工作流

```
1. OC 创建 Issue → label:handoff, project:TODO
2. OC 写 comment 描述任务（objective、AC、相关文件）
3. CC 或任何 agent 认领 → Assign self → 移到 In Progress
4. Agent 执行任务
5. Agent 写 comment 报告结果 → 移到 Done → Close issue
```

## 文件映射到 GitHub

```
INBOX       → GitHub Project "TODO" column
IN_PROGRESS → GitHub Project "In Progress" column
DONE        → GitHub Project "Done" column
CC heartbeat → GitHub API: issue comment / last activity
REVIEW      → PR review / issue comment
ALERT       → Issue stale label (no activity >24h)
```

## OC 与 CC 的交互

```
OC 操作：
  gh issue create --label handoff --project "Handoff"
  gh issue comment <id> --body "任务描述"
  gh api ... 查看项目看板

CC 操作：
  gh issue list --label handoff --state open
  gh issue comment <id> --body "已认领"
  gh issue edit <id> --add-assignee "@me"
  gh project item-set-status <id> "In Progress"
  # 执行...
  gh issue close <id>
  gh project item-set-status <id> "Done"
```

## 对比 v3（自建 CRDT）

| 维度 | v3 Reserve-Before-Execute | v4 GitHub Backend |
|------|--------------------------|-------------------|
| 认领冲突 | 自己实现 lease | GitHub 原生互斥 |
| 分区愈合 | 自己实现 | GitHub 服务器保证 |
| 节点发现 | Syncthing / Relay / P2P | 已有 GitHub 账户 |
| 通知 | WebSocket / relay | GitHub 推送/邮件 |
| 认证 | 自建 P3 P4 | GitHub PAT / OAuth |
| 持久化 | SQLite + 文件 | GitHub 服务器 |
| 迁移成本 | 全自建 | 学 `gh` CLI 即可 |
| 离线工作 | 支持（本地 CRDT） | 不支持（依赖 GitHub） |

## 迁移路径

| 阶段 | 内容 |
|------|------|
| P0 | 搭建 GitHub Issue + Project 模板 |
| P1 | trigger-cc.sh 改调 `gh issue` 拉任务 |
| P2 | CC hook 配合 GitHub 状态同步 |
| P3 | 自动化（GitHub Actions 自动列隊） |
| P4 | dashboard 对接 GitHub API |

## 本地离线降级

GitHub 不可用时，fallback 到文件 INBOX（兼容 v1）：
- GitHub 在线 → 用 Issues
- GitHub 离线 → 用文件（等待重连后同步）
- 最终一致性：以 GitHub Issues 为准
