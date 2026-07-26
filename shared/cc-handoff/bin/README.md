# bin/ — 双向 CLI 触发层

文件状态层（`INBOX/` `DONE/` `STATE/` …）是**被动持久层**；这两个脚本是**主动触发层**，让双方不必纯靠轮询就能推进。**文件夹是唯一通信层：无 deliver、无 `openclaw agent`、无模型 / 网关依赖。**

## trigger-cc.sh（OpenClaw → CC）

OpenClaw 投递任务到 INBOX 后调用：

```bash
~/.openclaw/workspace/shared/cc-handoff/bin/trigger-cc.sh
```

- **握手**：若 CC 已 `alive`（读 `STATE/cc.heartbeat`）则不重复拉起。
- **拉起**：`claude -p "取 INBOX 最高优先级任务执行 …"`（headless；SessionStart hook 自动写 heartbeat）。
- **防循环**：CC 无任务时直接退出。

## notify-openclaw.sh（CC → OpenClaw）

CC 写完 DONE 后调用（纯文件驱动，**无 deliver / 无 `openclaw agent` / 无模型依赖**）：

```bash
shared/cc-handoff/bin/notify-openclaw.sh [task-id]
```

- **动作**：向 `STATE/cc.notify.flag` 追加一行 `<ISO 时间戳> <task-id>`，然后退出。不查 heartbeat、不碰任务文件。
- **握手**：无条件写 flag。OpenClaw 活跃时（收到用户消息 / cron heartbeat）扫到 flag 即捞 `DONE/`；离线则 flag 留盘等它回来。

## 双向闭环

```
OC 投任务 → trigger-cc.sh → CC 取任务执行 → 写 DONE → notify-openclaw.sh → OC 收 DONE
        ↑                                                                              │
        └─────────────────── (有新任务才) 继续循环 ──────────────────────────────────┘
```

队列空即停，不空转。`trigger-cc.sh` 在 CC 离线时不重复拉起；`notify-openclaw.sh` 无条件写 flag。任务留盘排队。

## 运行注意事项（实测）

1. **`trigger-cc.sh` 必须异步调用**。CC headless 处理一个任务可能要数分钟（初始化 + 多轮 API 调用）。OpenClaw 应**后台**调用，别同步等，否则会阻塞 / 超时：
   ```bash
   nohup ~/.openclaw/workspace/shared/cc-handoff/bin/trigger-cc.sh >/tmp/trigger-cc.log 2>&1 &
   ```
2. **强杀会留下孤儿 heartbeat**。CC 进程被 `timeout` / SIGTERM 强杀时，Stop hook 不保证执行，`cc.heartbeat` 可能残留 `alive`。靠 `STATE/` 的 **stale 检测兜底**——`last_seen` 超时即判离线（SessionStart hook 会处理）。
3. **崩溃恢复**。CC 认领任务（移到 `IN_PROGRESS/`）后若中断，任务留在 `IN_PROGRESS/`，下次 SessionStart 检测超时 → 写 `ALERT/`，由老板决定重派。

## 文件锁（files 模式互斥）

`files` 模式（v1）下任务状态是裸文件操作（mv/cp/写）。为防并发踩踏（dispatch 写 INBOX 时 CC 读、daemon 扫目录时 CC 在 mv、多 CC 抢同一任务），引入全局 `flock` 锁；`dual/db` 模式的互斥仍由 SQLite `BEGIN IMMEDIATE` 提供，不受影响。

| 组件 | 机制 |
|------|------|
| `handoff-lock.sh` | 锁原语库（被 source）。全局锁 `STATE/handoff.lock`，FD 200 绑定 `flock`，超时 `HANDOFF_LOCK_WAIT`(默认 30s) → 返回 124 报错；进程退出/被杀即解锁（无死锁）。独占 `x`=写、共享 `s`=读。 |
| `claim-task.sh <id>` | CC 认领：持独占锁 `mv INBOX→IN_PROGRESS`。输家（任务已被抢）返回非零。 |
| `finish-task.sh <id> [report]` | CC 完成：持独占锁原子写 `DONE/<id>.md`（temp+rename）+ `mv IN_PROGRESS→INBOX_ARCHIVE`。 |
| `dispatch-cc.sh` | 任务创建：持独占锁 temp+rename 写 `INBOX/<id>.md`（防 CC 读到半写文件）。 |
| `handoff-daemon.sh` | 目录扫描：持**共享读锁**取一致快照，与写互斥、与其它读兼容。 |
| `notify-openclaw.sh` | flag 追加：单次 `echo >>`（O_APPEND 短写）本身原子，**无需额外锁**。 |

> 设计注：单机单 CC 时 `mv` 本身已是原子互斥（`docs/handoff-final-design.md §3`）；`flock` 是 belt-and-suspenders，覆盖「读到→再 mv」的 TOCTOU 与多 CC 抢占，对单机无害。

## CC heartbeat 守护 + 排队排空

CC（`claude -p`）是一次性进程，不能常驻 idle。改为两层实现「heartbeat 驱动、谁活跃谁捞」：

- **`scripts/handoff/cc-daemon.sh`**（cron 驱动，镜像 `handoff-daemon.sh`）：每 tick 共享读锁扫 handoff 全貌（INBOX/IN_PROGRESS/DONE/ALERT）；若 INBOX 有待办且 CC 离线（offline/stale）→ 异步 `trigger-cc.sh` 拉起。**不写 cc.heartbeat**（避免伪造 alive 导致永不拉起）。idle 由 cron 间隔承担（建议 30-60s），不忙循环。
- **CC 排队排空**（`trigger-cc.sh` files 模式 spawn prompt）：一次 spawn 内循环——领最高优先级 → `claim-task.sh` → `cc-heartbeat.sh` 刷新心跳 → 执行 → `finish-task.sh` + `notify-openclaw.sh` → 回头继续，直到 INBOX 空才退出。
- **`bin/cc-heartbeat.sh [working-on]`**：CC 长会话内定期刷新 `STATE/cc.heartbeat`（temp+rename 原子），防 last_seen 过期被误判 STALE → 防重复 spawn。
- **trigger 忙时只写 flag**：CC 已 alive 且新鲜时，`trigger-cc.sh` 仅向 `cc.notify.flag` 追加 wake 行，不重复 spawn（排队循环会自己取走新任务）。

> 自纠错：若 CC 会话中心跳偶发过期（如单个长任务期间无暇刷新），cc-daemon 可能多 spawn 一个 CC；但该 CC 发现 INBOX 空（任务已在 IN_PROGRESS）→ 立即退出，无副作用（仅一次浪费 spawn）。
>
> 注：cron 注册由 OC/运维配置，脚本不自注册。示例：`* * * * * ~/.openclaw/workspace/scripts/handoff/cc-daemon.sh >> /tmp/cc-daemon.log 2>&1`
