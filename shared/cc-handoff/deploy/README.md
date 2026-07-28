# Handoff Server 远程部署

## 架构

```
┌─────────────────┐     REST API      ┌──────────────────┐
│  OpenClaw (本地) │ ◄──────────────► │  Handoff Server  │
│  dispatch-cc.sh  │   :8377          │  (远端服务器)     │
│  handoff_client  │                   │  SQLite 权威存储  │
└─────────────────┘                   └────────┬─────────┘
                                               │ REST API
                                        ┌──────▼──────┐
                                        │  CC (远端)   │
                                        │  handoff_cli │
                                        └─────────────┘
```

## 部署步骤

### 1. 服务器端

```bash
# 创建数据目录
mkdir -p /opt/handoff/data

# 复制 server 文件
scp handoff-server.py user@server:/opt/handoff/
# 或直接 git clone workspace

# 启动（手动测试）
HANDOFF_STORE=db \
HANDOFF_DIR=/opt/handoff/data \
PORT=8377 \
python3 /opt/handoff/handoff-server.py
```

### 2. 服务化（systemd）

将 `handoff-server.service` 复制到 `/etc/systemd/system/`：

```bash
sudo cp handoff-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable handoff-server
sudo systemctl start handoff-server
sudo systemctl status handoff-server
```

### 3. 防火墙

```bash
sudo ufw allow 8377/tcp
# 或 iptables
sudo iptables -A INPUT -p tcp --dport 8377 -j ACCEPT
```

### 4. 本地 OC 配置

```bash
# 在 OpenClaw 机器上
export HANDOFF_SERVER=http://<server-ip>:8377
export HANDOFF_STORE=db
# 加到 ~/.bashrc 或启动脚本
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HANDOFF_STORE` | `files` | `db` = SQLite 权威，`dual` = SQLite+文件 |
| `HANDOFF_DIR` | `~/.openclaw/...` | 数据目录（含 SQLite DB） |
| `HANDOFF_DB` | `<DIR>/handoff.db` | SQLite 数据库路径 |
| `PORT` | `8377` | 监听端口 |
| `HANDOFF_SERVER` | `http://127.0.0.1:8377` | 客户端连接地址 |

## 当前 v1 兼容

- 本地 OC 脚本已支持 `HANDOFF_SERVER` 环境变量
- `dispatch-cc.sh` 和 `trigger-cc.sh` 读环境变量自动切换远端
- 本地文件 INBOX/DONE 目录在 `db` 模式下不再使用，以 SQLite 为准
