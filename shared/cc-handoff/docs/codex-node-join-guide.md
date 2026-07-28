# Codex 远端节点加入指南

## 加入流程（首次）

### 0. 前提
- SSH 到服务器 `threesky`（`ssh guan@100.90.1.56`）
- 服务器上已有 `~/workspace/`（含项目文件、模板、specs）
- Handoff Server 已在运行（`http://100.90.1.56:8377`）

### 1. 分配节点 ID
找管理员拿一个节点 ID，例如 `guanj_<name>`。
节点 ID 用来在 claim 时标识身份，避免冲突。

同时设置环境变量：
```bash
export HANDOFF_SERVER=http://100.90.1.56:8377
export HANDOFF_NODE_ID=guanj_<name>
```
建议加到 `~/.bashrc` 或启动脚本。

### 2. 验证连通
```bash
# 查询待处理任务
python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py pending

# 看板
curl http://100.90.1.56:8377/
```

### 3. 测试认领
```bash
# 认领一个任务（首次 claim 自动注册节点到系统）
python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py claim guanj_<name>
```
返回 `{"claimed": true, "task": {...}}` → 成功
返回 `{"claimed": null}` → 队列为空，等新任务

### 4. 执行任务
认领成功后在 `~/workspace/` 下工作。模板参考：
- Handoff V3：`projects/agent-team-orchestration/docs/handoff-protocol-v3.md`
- 合约模板：`contracts/`（在服务器 `~/workspace/contracts/` 下，如未同步可从 git 仓库取）

### 5. 报告完成
```bash
python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py done <任务ID> /dev/stdin << 'EOF'
{
  "summary": "完成了什么",
  "changes": ["改了什么文件"],
  "status": "success"
}
EOF
```

## 日常循环

```
1. claim → 有任务？→ 执行 → done → 回到 1
            ↓ 无
           等 15s
```

## 看板
浏览器打开 `http://100.90.1.56:8377` 看队列状态和节点活跃情况。

## 注意
- 节点 ID 全局唯一，不要抢别人的
- workspace 已包含完整项目文件，不需要额外 clone
- 卡住就弃任务，不要挂起
