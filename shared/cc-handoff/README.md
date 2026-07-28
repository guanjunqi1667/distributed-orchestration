# Handoff 系统 — 架构、协议、部署全文档

> 单机智能体协作 → 跨机多节点任务分发。包含模板、服务器、客户端、节点接入四层。

---

## 一、架构总览

```
┌─────────────────┐     REST API      ┌──────────────────────┐
│  OpenClaw (本机) │ ◄──────────────► │  Handoff Server      │
│  dispatch-cc.sh  │    :8377         │  threesky:100.90.1.56│
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

## 二、Handoff 协议 V3

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
| 服务器 | `threesky`（`100.90.1.56`） |
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
export HANDOFF_SERVER=http://100.90.1.56:8377
python3 ~/handoff-server/handoff_client.py pending
python3 ~/handoff-server/handoff_client.py claim <node-id>
python3 ~/handoff-server/handoff_client.py get <task-id>
python3 ~/handoff-server/handoff_client.py done <task-id> /dev/stdin <<< '{"summary":"..."}'
```

---

## 四、节点加入

### 新节点流程

```
1. 分配节点 ID（如 `<你的名字>_cc`）         ← 管理员
2. SSH 到服务器                         ← 节点自己
3. 设环境变量                           ← 节点自己
4. 验证连通（pending + 看板）           ← 节点自己
5. 首次 claim（自动注册到系统）          ← 节点自己
6. 执行任务 → done                      ← 节点自己
```

### SSH 连接

```bash
从服务器上跑，或在本机装 `ho` 客户端
```

### 环境变量

```bash
export HANDOFF_SERVER=http://100.90.1.56:8377
export HANDOFF_NODE_ID=<你的名字>_cc
# 推荐加到 ~/.bashrc
```

### 工作空间

```bash
~/workspace/
├── projects/agent-team-orchestration/   # 模板、specs、artifacts
├── shared/cc-handoff/                   # handoff 协议文档
├── scripts/handoff/                     # dispatch、daemon 脚本
├── skills/                              # skill 定义
└── plugins/harness-hooks/               # hooks 源码
```

### 日常循环

```bash
while true; do
  python3 ~/workspace/shared/cc-handoff/bin/handoff_client.py claim $HANDOFF_NODE_ID
  # 有任务则执行 → done
  sleep 15
done
```

### 看板

浏览器打开 `http://100.90.1.56:8377`

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
