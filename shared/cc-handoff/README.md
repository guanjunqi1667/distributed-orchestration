# Handoff 系统 — 架构、协议、部署全文档

> 单机智能体协作 → 跨机多节点任务分发。包含模板、服务器、客户端、节点接入四层。

---

## 一、架构总览

```
┌─────────────────┐     REST API      ┌──────────────────────┐
│  OpenClaw (本机) │ ◄──────────────► │  Handoff Server      │
│  dispatch-cc.sh  │    :8377         │  threesky:<server-ip>│
│  handoff_client  │                  │  SQLite 权威存储      │
│  创建任务         │                  │  + 看板 (HTML/JSON)   │
└─────────────────┘                  └──────────┬───────────┘
                                                │ REST API
                                   ┌────────────┼────────────┐
                                   ▼            ▼            ▼
                              ┌─────────┐ ┌─────────┐ ┌─────────┐
                              │ CC-1    │ │ CC-2    │ │ Codex   │
                              │ threesky│ │ cooper  │ │ remote  │
                              └─────────┘ └─────────┘ └─────────┘
```

## 二、模板规范（所有节点必须遵守）

所有投递到 INBOX 的任务/消息必须使用以下模板格式，否则会被验证器拒绝认领。

### 可用模板

| 模板 | 文件 | 用途 | 必填字段 |
|------|------|------|---------|
| **完整任务** | `task-template.md` | 详细任务分配，含 Objective + 验收条件 | id, priority, status, created_by, created_at, node, ## Objective, ## Acceptance Criteria |
| **短消息** | `note-template.md` | 快速通知/提问/确认，无需 DONE 回执 | id, type=note, created_by, created_at, node |
| **完成报告** | `done-template.md` | 任务执行完毕的结果回传 | id, status=done, Summary, Changes, Verification, Acceptance Criteria |

### 必填 frontmatter 字段（所有类型）

```
---
id: {唯一ID}              # 命名规则: {PRIORITY}-{DATE}-{DESC} 或 NOTE-{DATE}-{DESC}
type: task|note            # task=完整任务  note=短消息
status: pending            # pending|in_progress|done|blocked|alert
created_by: {节点标识}     # 发送方：guanj_oc / guanj_cc / threesky
created_at: {ISO时间戳}    # 如 2026-07-29T20:55+02:00
node: any                  # 目标节点：any / oc-main / cc-main / threesky
---
```

### 查看模板

```bash
# 查看所有模板
cat shared/cc-handoff/*.md | grep '^# '

# 复制任务模板开始
cp shared/cc-handoff/task-template.md INBOX/my-task.md
```

## 三、Handoff 协议 V3

两种模式，参考 LC 合约格式。

### Short Handoff（≤ 2 CTs / 单轮执行）

```markdown
# Handoff: <任务标题>

## 任务
一句话说明。

## 目的
为什么做。

## 参考
- 合约：`contracts/<project>/LC-xxx.md`
- 代码：`path/to/file.py#L42`

## Scope
- In：改了哪些文件
- Out：不覆盖的范围

## 变更
| 文件 | 改动 |
|------|------|

## 验证
命令 + 预期结果

## 产出
文件路径

## Next
下一角色 + 下一动作
```

### Long Handoff（≥ 3 CTs / 跨多轮 / 含决策）

```markdown
# Handoff: <任务标题>

## 1) 触发 & 目的
- 触发：
- 目的：
- 依赖：

## 2) Scope
### In
### Out
### 决策记录
| 决策 | 方案 | 否决方案 | 理由 |

## 3) 参考
- 合约：
- 文件/证据：

## 4) 变更清单
| 文件 | CT | 改动摘要 | 行数 |

## 5) 验收映射
| 验收目标 | 完成证据 | 证据路径 | CT |

## 6) 约束合规
| 约束 | 是否满足 | 说明 |

## 7) 验证结果
N passed / 0 failed

## 8) 未完成 / 已知风险

## 9) 不可达 / 需要上游决策

## 10) 下一步
```

### 协议设计原则
- **可裁剪**：Short 模式只保留必要字段
- **可验证**：验收映射明确到证据路径
- **Scope 显式**：In / Out 明确边界
- **与 LC 合约对齐**：触发/约束/否决/验收映射复用合约格式

---

## 三、Handoff Server

### 部署信息

| 项目 | 值 |
|------|-----|
| 服务器 | `threesky`（`<server-ip>`） |
| 服务端口 | `8377` |
| 存储模式 | `db`（SQLite 权威） |
| 绑定地址 | `0.0.0.0`（接受远程连接） |
| 进程管理 | `~/handoff-server/handoff-server-start.sh` |
| 数据目录 | `~/handoff-server/data/` |
| 日志 | `~/handoff-server/server.log` |

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 看板 HTML |
| `/api` | GET | 看板 JSON（inbox/in_progress/done） |
| `/api/tasks/pending` | GET | 待处理任务列表 |
| `/api/tasks/<id>` | GET | 任务详情 |
| `/api/tasks` | POST | 创建任务 |
| `/api/tasks/import` | POST | 从 markdown 导入任务 |
| `/api/claim` | POST | 原子认领任务 |
| `/api/tasks/<id>/done` | POST | 完成任务 |

### 认领互斥

SQLite `BEGIN IMMEDIATE` 事务串行化，保证并发 claim 不重复分配。

```
节点 A claim → BEGIN IMMEDIATE → SELECT 最高优先级 pending → UPDATE → COMMIT → 成功
节点 B claim → BEGIN IMMEDIATE → 等 A COMMIT → 拿下一个 pending → COMMIT → 成功
```

### 运行命令

```bash
# 手动启动
cd ~/handoff-server
bash handoff-server-start.sh              # 前台
bash handoff-server-start.sh --daemon     # 后台
bash handoff-server-start.sh --status     # 状态
bash handoff-server-start.sh --stop       # 停止

# 客户端
export HANDOFF_SERVER=$HANDOFF_SERVER
python3 ~/handoff-server/handoff_client.py pending
python3 ~/handoff-server/handoff_client.py claim <node-id>
python3 ~/handoff-server/handoff_client.py get <task-id>
python3 ~/handoff-server/handoff_client.py done <task-id> /dev/stdin <<< '{"summary":"..."}'
```

---

## 四、节点加入

### 节点注册表

所有节点在 `shared/cc-handoff/nodes.json` 中注册，格式如下：

```json
{
  "nodes": [
    {"id": "节点ID", "display": "展示名", "aliases": ["别名1"], "type": "类型", "location": "本地|远程"}
  ]
}
```

| 字段 | 说明 |
|------|------|
| `id` | 节点唯一标识，也是心跳文件名 |
| `display` | 看板展示名称 |
| `aliases` | 旧名/别名，消息中 node 字段可用 |
| `type` | openclaw / claude-code / server / codex |
| `location` | local / remote |

### 新节点接入流程

```
1. 管理员在 nodes.json 注册节点（ID + 展示名 + 别名）
2. 节点获取 nodes.json（scp 或 API GET /api/nodes）
3. 节点建立心跳：STATE/{节点ID}.heartbeat
4. 节点通过 API 或 SSH 通信
5. 看板自动识别新节点
```

### 通信方式

**方式 A：API（推荐）**
```bash
# 查看节点列表
curl http://threesky:8377/api/nodes

# 创建任务/消息
curl -X POST http://threesky:8377/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"id":"NOTE-{DATE}-{DESC}","priority":"P2","title":"标题","objective":"内容","node":"目标节点"}'
```

**方式 B：SSH 直连（fallback）**
```bash
# 投递文件到 INBOX
scp 任务.md guan@100.90.1.56:/home/guan/.openclaw/workspace/shared/cc-handoff/INBOX/

# 写 notify flag
echo "任务ID" >> /home/guan/.openclaw/workspace/shared/cc-handoff/STATE/notify.目标节点.flag
```

### 消息模板

- **完整任务**：`type: task`，需 Objective + Acceptance Criteria，完成后写 DONE 报告
- **短消息**：`type: note`，1-3 行正文，无需 DONE 回执
- **node 字段**：可直接写目标节点 ID 或别名（如 `oc-main` / `guanj_oc` 均可达 OpenClaw）

### 看板

浏览器打开 `http://threesky:8377/`（或本地 `http://localhost:8377/`）

看板显示所有已注册节点的在线状态（🟢 alive / 🟡 STALE / 🔴 offline）。

---

## 五、文件索引

| 文件 | 说明 |
|------|------|
| `shared/cc-handoff/docs/handoff-protocol-v3.md` | Handoff 完整模板（Short + Long） |
| `shared/cc-handoff/docs/handoff-protocol-v3-README.md` | V3 协议 README |
| `shared/cc-handoff/docs/codex-node-join-guide.md` | Codex 节点加入指南 |
| `shared/cc-handoff/docs/handoff-final-design.md` | 分布式最终设计方案 |
| `shared/cc-handoff/docs/handoff-server-design.md` | 服务器设计方案 |
| `shared/cc-handoff/handoff-server.py` | 服务器（运行在 threesky） |
| `shared/cc-handoff/bin/handoff_client.py` | 客户端 CLI |
| `shared/cc-handoff/deploy/handoff-server.service` | systemd 服务单元 |
| `shared/cc-handoff/deploy/handoff-server-start.sh` | 启动脚本 |
| `shared/cc-handoff/deploy/cc-worker.sh` | 远端轮询 worker |
| `shared/cc-handoff/dashboard/index.html` | 看板模板 |
| `skills/agent-team-orchestration/SKILL.md` | 多 agent 协作 skill |
| `projects/agent-team-orchestration/docs/multi-agent-handoff-template.md` | 旧版 V2 模板（兼容） |
