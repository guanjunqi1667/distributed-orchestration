# Codex 执行流程：成为远端节点

## 前置条件

- SSH 访问：用自己的账号登录服务器后直接跑，或在本机装 `ho` 客户端
- Python 3（服务器已装 3.14.4）
- 管理员已分配节点 ID（如 `你的名字_cc`）

---

## Step 1：验证连接

```bash
# 1a. 测试 Handoff Server 连通
curl -s http://100.90.1.56:8377/api | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('inbox=%d in_progress=%d done=%d' % (len(d['inbox']), len(d['in_progress']), len(d['done'])))
print('Store:', d.get('store'))
"
```
预期输出：`inbox=N in_progress=N done=N` 和 `Store: db`

```bash
# 1b. 测试客户端
export HANDOFF_SERVER=http://100.90.1.56:8377
python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py pending
```
预期输出：`{"pending": [...], "count": N, "store": "db"}`

## Step 2：认领任务

```bash
export HANDOFF_SERVER=http://100.90.1.56:8377
export HANDOFF_NODE_ID=你的名字_cc

python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py claim $HANDOFF_NODE_ID
```

成功响应：
```json
{"claimed": true, "task": {"id": "P0-xxx", "status": "in_progress", ...}}
```

空队列：
```json
{"claimed": null, "task": null}
```
→ 等 15s 重试。

## Step 3：获取任务详情

```bash
python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py get <TASK-ID>
```

关键字段：
- `id`：任务 ID（文件名）
- `objective`：任务描述（markdown 格式）
- `priority`：P0/P1/P2
- `status`：当前状态
- `node_id`：认领节点（claim 后变成你的节点 ID）
- `version`：变更版本号
- `created_at`：创建时间

## Step 4：执行任务

工作空间在 `~/workspace/`。

```bash
cd ~/workspace/
```

执行期间如果需要记日志：
```bash
mkdir -p ~/handoff-server/results
```

## Step 5：报告完成

```bash
python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py done <TASK-ID> /dev/stdin << 'EOF'
{
  "summary": "完成了 XXX。关键结果：...",
  "changes": ["改了什么文件"],
  "status": "success"
}
EOF
```

`status` 可选值：
- `success`：完成
- `failed`：失败
- `partial`：部分完成

## 循环：poll worker

在服务器上运行（后台）：

```bash
nohup bash ~/handoff-server/cc-worker.sh > ~/handoff-server/worker.log 2>&1 &
```

cc-worker.sh 默认逻辑：
```
while true:
    claim → 有任务 → get 详情 → 执行 → done → 继续
              ↓ 无
             等 15s
```

## 遇到问题

### 队列为空
→ 等管理员派新任务，或检查 `http://100.90.1.56:8377` 看板

### Claim 失败（非空队列）
→ 任务可能已被其他节点先认领。等下一轮。

### 执行中卡住
→ 不要挂起。尽快 done（可标 failed）让任务可以重新派发。

## 单次执行速查（SOP）

```bash
# 1. 设环境
export HANDOFF_SERVER=http://100.90.1.56:8377
export HANDOFF_NODE_ID=你的名字_$(whoami)

# 2. 认领
TASK_JSON=$(python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py claim $HANDOFF_NODE_ID)
CLAIMED=$(echo "$TASK_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('claimed'))")
[ "$CLAIMED" != "True" ] && echo "No task" && exit 0

TASK_ID=$(echo "$TASK_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['task']['id'])")

# 3. 执行（在这里写你的逻辑）
cd ~/workspace
# ...

# 4. 完成
python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py done "$TASK_ID" /dev/stdin <<< '{"summary":"done","status":"success"}'
```
