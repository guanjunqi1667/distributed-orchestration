# Handoff Server — 多 Agent 跨节点协作工作台

> ⚠️ **已归并入 [`handoff-final-design.md`](./handoff-final-design.md)**（中心服务器路线作为最终设计 §4「可插拔传输层」的一个选项保留：其 mutex 白送的优势与单点/联网的代价并列权衡，未被钦定也未被否决）。


## 目标

将当前 OC↔CC 本地文件 handoff 升级为通用多 Agent 协作平台：
- 支持 **N 个 Agent**（CC / Codex / Hemes / 自定义）
- 支持 **跨节点**（本地、云端、混合）
- Agent 可随时加入/离开
- 队列持久化，不丢任务

## 架构

```
                    ┌──────────────────────┐
                    │   Handoff Server     │
                    │  REST API + WebSocket │
                    │  SQLite + File Store │
                    └──────┬───────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     ┌────▼────┐     ┌────▼────┐      ┌────▼────┐
     │   OC    │     │   CC    │      │  Codex  │
     │ main    │     │ CLI     │      │ cloud   │
     │ local   │     │ local   │      │ remote  │
     └─────────┘     └─────────┘      └─────────┘
```

## 核心模型

### Agent 注册

```json
POST /api/agents

{
  "id": "cc-local-1",
  "name": "Claude Code (Workstation)",
  "type": "cc",                    // cc | codex | hemes | custom
  "transport": "local",            // local | remote
  "endpoint": "http://localhost:8377/callback",
  "capabilities": ["code", "review", "refactor"],
  "status": "idle",                // idle | busy | offline
  "heartbeat_ttl": 300             // seconds, 0=no heartbeat
}
```

### 任务生命周期

```
CREATED → QUEUED → CLAIMED → IN_PROGRESS → DONE
                     ↓                     ↓
                  (timeout)            REVIEW → REWORK (→ QUEUED)
                     ↓
                  STALE → ALERT
```

```json
POST /api/tasks

{
  "id": "P1-20260725-optimize-memory",
  "title": "优化记忆架构",
  "objective": "审查并优化记忆架构...",
  "priority": "P0|P1|P2",
  "acceptance_criteria": ["..."],
  "constraints": {},
  "required_capabilities": ["code"],
  "target_agent": null,              // null=any
  "artifacts": {
    "files": ["path/to/file1", "path/to/file2"],
    "context": "base64-encoded-context"
  },
  "created_at": "2026-07-25T18:00Z",
  "status": "queued"
}
```

### 认领与执行

```json
POST /api/tasks/claim

{"agent_id": "cc-local-1"}
→ 返回最高优先级未分配任务

POST /api/tasks/{id}/heartbeat

{"agent_id": "cc-local-1", "status": "in_progress", "progress": "60%"}

POST /api/tasks/{id}/done

{
  "agent_id": "cc-local-1",
  "summary": "完成了...",
  "changes": ["file1.md", "file2.py"],
  "tokens_used": 45000,
  "artifacts": {"output.json": "base64..."},
  "status": "success"  // success | failed | partial
}
```

### 双向通知（WebSocket）

```
Agent 连接:  ws://handoff-server/ws?agent_id=cc-local-1

Server → Agent:
  {"type": "new_task", "task_id": "P1-xxx", "priority": "P1"}
  {"type": "cancel", "task_id": "P1-xxx"}
  {"type": "heartbeat_ack"}

Agent → Server:
  {"type": "heartbeat", "status": "busy", "progress": "30%"}
  {"type": "log", "level": "info", "message": "正在编译..."}
```

### 对于无 WebSocket 的 Agent（如 bash 脚本）

```bash
# 轮询模式（兼容当前 trigger-cc.sh）
while true; do
  TASK=$(curl -s http://handoff/api/tasks/claim -d '{"agent_id":"cc-1"}')
  [ -z "$TASK" ] && break
  # 执行任务...
  curl -X POST http://handoff/api/tasks/$ID/done -d '{"agent_id":"cc-1","summary":"..."}'
done
```

## API 设计（REST）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/agents` | GET | 列出所有在线 Agent |
| `/api/agents` | POST | 注册 Agent |
| `/api/agents/:id` | GET | Agent 详情 |
| `/api/agents/:id` | DELETE | 注销 Agent |
| `/api/agents/:id/heartbeat` | POST | Agent 心跳 |
| `/api/tasks` | GET | 查询任务（filter=status,agent） |
| `/api/tasks` | POST | 创建任务 |
| `/api/tasks/:id` | GET | 任务详情 |
| `/api/tasks/:id` | PATCH | 更新任务（priority,status） |
| `/api/tasks/claim` | POST | 认领一个任务 |
| `/api/tasks/:id/done` | POST | 完成任务 |
| `/api/tasks/:id/rework` | POST | 标记返工 |
| `/api/board` | GET | 看板数据（兼容当前 dashboard） |
| `/ws` | WebSocket | 实时通道 |

## 存储设计

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  transport TEXT,
  endpoint TEXT,
  capabilities TEXT,       -- JSON array
  status TEXT DEFAULT 'offline',
  last_heartbeat TEXT,
  registered_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT,
  objective TEXT,
  priority TEXT,
  status TEXT DEFAULT 'queued',  -- queued|claimed|in_progress|done|rework|cancelled
  claimed_by TEXT REFERENCES agents(id),
  acceptance_criteria TEXT,      -- JSON array
  constraints TEXT,              -- JSON
  required_capabilities TEXT,    -- JSON array
  artifacts TEXT,                -- JSON
  result TEXT,                   -- JSON (summary, changes, tokens)
  created_at TEXT,
  claimed_at TEXT,
  done_at TEXT
);

CREATE TABLE task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  agent_id TEXT REFERENCES agents(id),
  level TEXT,
  message TEXT,
  ts TEXT
);
```

## 安全

- 本地模式：loopback only（同当前）
- 远程模式：Bearer Token + 可选 mTLS
- Agent 注册需管理员确认（或白名单）
- 任务 payload 加密传输（HTTPS）

## 兼容层（当前文件 handoff）

升级期间，文件 handoff 仍可工作：
- `INBOX/` `DONE/` 目录同步写入（兼容现有脚本）
- `server.py` 同时读文件 + SQLite
- CC 现有的 `trigger-cc.sh` / `notify-openclaw.sh` 只需改 API endpoint

## 路线图

| 阶段 | 内容 | 影响 |
|------|------|------|
| **P0** | SQLite 存储 + REST API（替换文件 INBOX/DONE） | 核心替换 |
| **P1** | Agent 注册/心跳/状态管理 | 多 Agent 基础 |
| **P2** | WebSocket 实时推送 | 低延迟通知 |
| **P3** | dashboard 对接新 API | UI 升级 |
| **P4** | 远程 Agent 支持（Codex/Hemes） | 跨节点 |
| **P5** | OAuth/mTLS 安全层 | 生产就绪 |
