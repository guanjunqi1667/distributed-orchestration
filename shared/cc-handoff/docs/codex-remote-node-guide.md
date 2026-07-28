# Codex 跨机节点连接指南 — Handoff Server

> CC / Codex agent 在远端服务器上连接 Handoff Server，认领并执行任务。

## 架构

```
┌──────────────────┐    REST API      ┌────────────────────┐
│  OpenClaw (本机)  │ ◄──────────────► │  Handoff Server    │
│  dispatch-cc.sh   │   :8377         │  threesky:8377     │
│                    │                 │  SQLite 权威存储   │
└──────────────────┘                  └────────┬───────────┘
                                               │ REST API
                                        ┌──────▼──────────┐
                                        │  CC / Codex     │
                                        │  (远端服务器)    │
                                        │  handoff_client  │
                                        └─────────────────┘
```

## 连接信息

| 项目 | 值 |
|------|-----|
| Handoff Server 地址 | `http://100.90.1.56:8377` |
| 本节点 ID | `guanj_threesky`（在环境变量 `HANDOFF_NODE_ID` 中设置）|
| 客户端脚本 | `~/handoff-server/handoff_client.py` |
| 存储模式 | `db`（SQLite 权威） |

## 任务生命周期

```
OC 创建 → pending → claim → in_progress → done
                       ↓                      ↓
                   (lease 超时)         失败 → rework
                       ↓
                   stale → 可回收
```

## API 客户端命令

全部命令通过 `handoff_client.py` 执行。需设置环境变量：

```bash
export HANDOFF_SERVER=http://100.90.1.56:8377
export HANDOFF_NODE_ID=guanj_threesky
```

### 1. 查看待处理任务

```bash
python3 ~/handoff-server/handoff_client.py pending
```

返回 JSON，包含 `pending` 数组和 `count`。每条任务含 `name`（ID）、`desc`（描述）、`priority`（优先级 P0/P1/P2）。

### 2. 认领任务

```bash
python3 ~/handoff-server/handoff_client.py claim guanj_threesky
```

- 成功：`{"claimed": true, "task": {...}}`
- 队列空：`{"claimed": null}`
- 认领 = 原子操作（SQLite `BEGIN IMMEDIATE` 事务串行化），只有一个节点能拿到

### 3. 获取任务详情

```bash
python3 ~/handoff-server/handoff_client.py get <TASK-ID>
```

返回完整任务信息，包括 `objective`（目标）、`context`（上下文）、`ac`（验收标准）等。

### 4. 完成任务

```bash
python3 ~/handoff-server/handoff_client.py done <TASK-ID> /dev/stdin << 'EOF'
{
  "summary": "完成了 XXX",
  "changes": ["path/to/file1", "path/to/file2"],
  "status": "success"
}
EOF
```

`status` 可选值：`success` / `failed` / `partial`
`changes` 列出修改的文件路径。

## Poll Worker 脚本

远端节点运行轮询循环自动处理任务：

```bash
#!/usr/bin/env bash
# ── cc-worker.sh — 远端 CC 轮询执行任务 ──
export HANDOFF_SERVER=http://100.90.1.56:8377
export HANDOFF_NODE_ID=guanj_threesky
CLIENT=~/handoff-server/handoff_client.py

while true; do
  # 1. 认领
  TASK_JSON=$($CLIENT claim "$HANDOFF_NODE_ID" 2>/dev/null)
  CLAIMED=$(echo "$TASK_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('claimed'))" 2>/dev/null)

  if [ "$CLAIMED" != "True" ]; then
    echo "No tasks, sleeping 30s..."
    sleep 30
    continue
  fi

  # 2. 获取任务信息
  TASK_ID=$(echo "$TASK_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['task']['id'])")
  echo "Claimed: $TASK_ID"

  # 3. 执行任务（由 CC/Codex 处理）
  # 实际执行逻辑在此插入

  # 4. 报告完成
  $CLIENT done "$TASK_ID" /dev/stdin <<< '{"summary":"Task completed","status":"success"}'
  echo "Done: $TASK_ID"
done
```

## 安全说明

- Server 绑定 `0.0.0.0:8377`，当前无认证
- 建议后续加 Bearer Token 或 ufw 限制来源 IP
- 本机 IP 已知 `100.90.1.56`，确保网络可达
