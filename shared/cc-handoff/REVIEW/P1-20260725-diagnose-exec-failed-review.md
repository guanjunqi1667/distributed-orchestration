# Review: P1-20260725-diagnose-exec-failed

**Reviewer**: OpenClaw (小熊2号)
**Date**: 2026-07-25T20:10+02:00
**Status**: REVIEW

## Summary

自检日志 + 715 sessions + gateway journal 全面排查。结论：**Exec failed 有两个独立根因，一个高频噪音，一个偶发。** 高频的是 preflight 安全拦截（~150次/天），偶发的是 LLM timeout 导致的 agent 崩溃回（~4-16次/天）。Session 内部的 exec failed（13次/715个文件）极低。

## 数据总览

| 来源 | 频率 | 说明 |
|------|------|------|
| **Preflight 拦截** | **~150次/天** | gateway `tools.exec` 安全策略拒绝复杂命令行 |
| **LLM timeout (Embedded agent failed)** | **1-16次/天** | DeepSeek V4 偶发超时 → failover 全部失败 → agent 崩溃 |
| **Session 内 exec failed** | **13次/715文件** | 全部在 session `347dd2d7`，仅 7/25 |
| **exec-approvals 拒绝** | **0次** | 无 deny/reject 记录 |

---

## 根因 1：Preflight 拦截（高频≠严重）

### 日志证据
```
[tools] exec failed: exec preflight: complex interpreter invocation detected;
refusing to run without script preflight validation.
Use a direct `python <file>.py` or `node <file>.js` command.
```

### 日分布（7/19–7/25）
```
07-19: 138  07-20: 178  07-21: 154
07-22: 144  07-23: 157  07-24: 125
07-25: 70
```

### 根因分析
所有 preflight 拒绝 100% 来自 **heartbeat cron 任务**（agent:cron:*）。heartbeat 任务周期性跑 `bash scripts/heartbeat-*.sh`，但 gateway 的安全 preflight 规则不允许含 `bash` 或 `|` 等复杂解释器调用的组合命令。这些命令没写错，只是安全规则比实际使用场景更严格。

### 影响评估
**低**（噪音级别）：
- Heartbeat 任务失败会自动重试，不影响用户交互
- 但会在 gateway log 产生 ~150条/天 的错误日志
- 如果某个 heartbeat 的核心功能（例如 `heartbeat-sync.sh`）走的就是这种路径且无兜底，可能会丢失心跳更新

---

## 根因 2：LLM Timeout → Agent 崩溃（偶发但影响大）

### 日志证据
```
Embedded agent failed before reply: LLM request timed out.
FailoverError: LLM request timed out.
model_fallback decision: decision=candidate_not_found
```
触发时序：DeepSeek V4 超时 → failover 尝试相同模型（无 fallback 模型配置）→ 再次超时 → 全部 failover 耗尽 → `surface_error`

### 日分布（7/19–7/25）
```
07-20: 1   07-21: 2   07-24: 16   07-25: 4（截至检测时）
```
7/24 爆发 16 次——当天 DeepSeek API 可能有压力。

### 影响评估
**高**（用户可见）：
- Agent 整个回复被打断，直接报错到用户
- 无 fallback 模型可切（当前只有 deepseek-v4-flash 一个配置）
- 触发 auth profile 冷却窗口（~5s），导致后续请求也有一定概率被截

---

## 根因 3：Session 内 exec failed（极低）

715 个 session 文件中只找到 13 条 `status=failed` 的 exec：
- 8 次 SIGTERM（全部在 session `347dd2d7`，7/25 下午密集出现，间隔 4-25ms → 是 LLM 超时后 gateway 清理进程树时发的，不算真实的命令执行失败）
- 4 次 command not found（exit=127 → 模型写了不存在的命令）
- 1 次 timeout（6.4s → 超时阈值太低）

**影响：无**（被 LLM timeout 的连锁反应覆盖，不是独立问题）。

---

## 修复方案

### 短期缓解（可立即执行）

**① Preflight 噪音降低** — 检查哪些 heartbeat cron 命令触发 preflight，改为白名单内安全形式
- 在 `openclaw.json` 中加 `tools.exec.preflightWhitelist` 条目，或调整 cron 脚本避免复杂命令行
- 预计减少 ~150条/天 log 噪音
- 风险：低

**② 加 LLM fallback 模型** — 当前 timeout 时 failover 全失败因为没有备选
- 在 `openclaw.json` 加 fallback provider（例如 `zai/glm-5.1` 或 `openai/gpt-4.1-nano`）
- 预计捕获 100% 的 timeout failover → 至少降级回复而非崩溃
- 风险：低（fallback 已有代码实现，只缺配置）

### 长期根本

**③ 智能超时重试** — 网关层区分瞬态 API 故障和持续不可用
- 当前策略：timeout → fallback same model → no next → surface_error
- 改进：timeout → wait 1-2s → retry same model once → fallback model → surface_error（如果全部失败）
- 预计减少 ~80% 的 LLM timeout 崩溃

**④ 监控告警** — gateway journal 已记录所有 exec failed，但无主动通知
- 阈值告警：preflight >200次/天 或 LLM timeout >5次/30min 时推通知到老板

---

## 没发现的问题

- 无权限拒绝（exec-approvals deny/reject = 0）
- 无子进程 OOM/crash
- 无系统资源瓶颈（内存/CPU 正常）
- preflight 以外的 security policy 拦截 = 0

## AC 对照

- [x] 统计频率/触发场景 — 见数据总览表
- [x] 分类根因 — 3 类：preflight 噪音 / LLM timeout / session 内微乎
- [x] 提出修复方案 — 短期 2 条 + 长期 2 条
- [x] 写入 REVIEW
- [ ] （可选）直接修 1-2 个 — **建议修 ① preflight 白名单 + ② fallback 模型配置**

## Conclusion

老板反馈的「经常 Exec failed」根因是高频噪音（150次/天 preflight 拦截 + 少量 LLM timeout）。实际功能层面：session 内 exec 失败 715 个文件仅 13 条。两个短期修复（preflight 白名单 + LLM fallback 模型）可显著降低指标。需不要我直接修这两个配置？
