# 多 Spawn 回复抑制修复

## 问题
用户每发一条消息，收到多条 assistant 回复刷屏。

## 修复了什么

### 1. 禁用 Codex 插件
```bash
openclaw plugins disable codex
openclaw gateway restart
```
禁用后 spawn 从 9+ 锐减到 1~，说明 Codex 是主要来源。
**注意**：OpenClaw 升级后检查是否被重新启用。

### 2. Harness Hooks 拦截 spawned session 回复
在 `plugins/harness-hooks/dist/index.js` 加了 `message_sending` hook：
- `subagent_spawned`：记录 spawned session key
- `message_sending`：匹配到 spawned session 时 `{ cancel: true }`
- 子会话静默执行（仍然写文件、跑命令），但回复不送到 Telegram
- 子会话结果通过 completion event 返给主会话

## 教训

### ❌ 手动改 openclaw.json 是错的
- 删 `codex` 从 plugins.entries → schema 验证不过
- 改成 dict 格式 → schema 也不认
- 正确做法：`openclaw plugins disable codex`

### ❌ 改 dist 文件方向不对
- 最初 patch `run-attempt-CXZNKJ6y.js` 的 `rebuildCodexPromptBuildFromCurrentProjection`
- 那是 prompt 重建逻辑，跟 spawn 机制无关
- 修之前先确认代码链

### ❌ 读错 channel 代码
- 查了 Tlon(Urbit) 的 `channel.runtime` → 跟 Telegram/WebChat 无关
- 应该直接查 Telegram channel 代码

## 当前状态
- Codex 禁用 ✅
- 回复抑制已部署 ✅
- 用户每轮 1 条回复 ✅

## 后续
- OpenClaw 升级后确认 `openclaw plugins disable codex` 是否保留
- 需要子会话发回复（如测试报告）时，在 `message_sending` hook 加白名单
