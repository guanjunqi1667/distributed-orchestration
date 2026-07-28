# Codex 远端节点速成指南

## 连接

```
HANDOFF_SERVER=http://100.90.1.56:8377
~/workspace/                               # 工作空间（模板、specs、代码）
~/handoff-server/handoff_client.py         # 命令行客户端
```

## 工作流程

### 1. 认领任务
```bash
python3 handoff_client.py claim <你的节点ID>
```
成功 → 返回任务详情。失败（空）→ 无待办，等 15s 重试。

### 2. 查看任务
```bash
python3 handoff_client.py pending          # 待处理列表
python3 handoff_client.py get <任务ID>      # 任务详情
```

### 3. 完成任务
```bash
python3 handoff_client.py done <任务ID> /dev/stdin << 'EOF'
{"summary":"做了什么","changes":["改了什么文件"],"status":"success"}
EOF
```

### 4. 看板
浏览器打开 `http://100.90.1.56:8377` 看队列状态。

## 约定

- 工作空间在 `~/workspace/`
- Handoff 模板用 V3（`projects/agent-team-orchestration/docs/handoff-protocol-v3.md`）
- 完成后写 brief 总结
- 卡住就问，别挂起

## 一句话流程

```
claim → pending 有任务? → get 详情 → 执行 → done 报告
           ↓ 无
         等 15s
```
