# 新节点加入指南

## 前提

- 节点能访问 Threesky 服务器（SSH `guan@100.90.1.56`）
- 管理员已在 `nodes.json` 注册节点
- 节点已安装 `curl`、`ssh`、`scp`

## 加入流程

### 1. 获取节点注册信息

```bash
# 查看当前所有节点
curl http://threesky:8377/api/nodes

# 获取 nodes.json（离线使用）
scp guan@100.90.1.56:/home/guan/.openclaw/workspace/shared/cc-handoff/nodes.json .
```

### 2. 建立心跳

心跳让看板识别你的在线状态：

```bash
ssh guan@100.90.1.56 "cat > /home/guan/.openclaw/workspace/shared/cc-handoff/STATE/{你的节点ID}.heartbeat << HEOC
{\"status\":\"alive\",\"working_on\":\"\",\"last_seen\":\"\$(date -Iseconds)\",\"session\":\"{你的节点ID}\"}
HEOC"
```

心跳建议每分钟刷新一次，否则 5 分钟后标记为 STALE。

### 3. 通信

**方式 A：API（推荐）**

```bash
# 查看待处理任务
curl http://threesky:8377/api

# 查看可用模板
curl http://threesky:8377/api/templates | python3 -m json.tool

# 认领任务
curl -X POST http://threesky:8377/api/claim -H "Content-Type: application/json" -d '{"node_id":"{你的节点ID}"}'

# 完成报告
curl -X POST http://threesky:8377/api/tasks/{任务ID}/done -H "Content-Type: application/json" -d '{"summary":"完成内容","changes":["改动列表"]}'
```

**方式 B：SSH 直连（fallback）**

```bash
# 查看 INBOX
ssh guan@100.90.1.56 ls /home/guan/.openclaw/workspace/shared/cc-handoff/INBOX/

# 投递消息
scp 消息.md guan@100.90.1.56:/home/guan/.openclaw/workspace/shared/cc-handoff/INBOX/

# 写通知 flag（消息投递后必须写）
ssh guan@100.90.1.56 "echo '\$(date -Iseconds) {消息ID}' >> /home/guan/.openclaw/workspace/shared/cc-handoff/STATE/notify.{目标节点}.flag"
```

### 4. 消息格式

**短消息（note）**：快速通知/提问/确认，无需回执
```yaml
---
id: NOTE-{DATE}-{DESC}
type: note
priority: P2
status: pending
created_by: {你的节点ID}
created_at: {ISO时间戳}
node: {目标节点ID}
---

# 标题

正文 1-3 行
```

**完整任务（task）**：需 Objective + Acceptance Criteria，完成后写 DONE
```yaml
---
id: P2-{DATE}-{DESC}
type: task
priority: P2
status: pending
created_by: {你的节点ID}
created_at: {ISO时间戳}
node: {目标节点ID}
---

# 任务标题

## Objective

一句话目标

## Acceptance Criteria

- [ ] 验收条件
```

### 5. 日常循环

```bash
while true; do
  # 查看是否有任务
  curl -s http://threesky:8377/api | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'待办: {len(d[\"inbox\"])}')"
  
  # 刷新心跳
  # 有任务则认领→执行→完成
  
  sleep 30
done
```

## 看板

浏览器打开 `http://threesky:8377/` 或本地 `http://localhost:8377/`

看板显示所有节点状态（🟢 alive / 🟡 STALE / 🔴 offline）和三列任务队列。

## 注意事项

- `node` 字段写目标节点 ID 或别名皆可
- 心跳必须定期刷新（>5min 不刷新标记 STALE）
- 投递消息后必须写 `notify.{目标}.flag`
- 模板可从 `GET /api/templates` 获取
