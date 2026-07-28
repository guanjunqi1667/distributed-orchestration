# Review: P0-20260725-optimize-handoff

**Reviewer**: Claude Code
**Date**: 2026-07-25
**Subject**: OpenClaw ↔ CC handoff 协议审查（执行方视角）

## 概述

作为这套 handoff 协议的第一批用户，审查了 README、task/done template、workspace `.claude/CLAUDE.md` 与 `.claude/settings.json`。发现 **7 处会让链路实际跑不通的断点**：6 处已直接修复，1 处用更简洁机制替代。另提 4 条设计性建议供决策。

## 一、链路断点（已修复）

### 1. `INBOX_ARCHIVE/` 目录不存在 ❌→✅
README 与 CLAUDE.md 都要求完成后「移到 INBOX_ARCHIVE」，但目录从未创建——归档步骤必失败。
**修复**：已创建 `INBOX_ARCHIVE/`（含说明）。

### 2. `handoff.md` 状态文件被引用但不存在 ❌→✅(机制替代)
README 写「状态在 handoff.md 维护」，但无此文件、也无方负责更新——状态必然丢失。
**修复**：移除 handoff.md，改为「状态 = 文件所在目录」(INBOX/DONE/INBOX_ARCHIVE)，零维护、单一事实来源。返工用 INBOX 内标题标 `REWORK`。

### 3. permission 用非标准空格语法 `Bash(cmd *)` ⚠️→✅
原 `Bash(git diff *)`（空格+星号）在「无参数命令」（如裸 `git diff`）时不匹配 → 偶发弹窗。官方标准是前缀语法 `Bash(git diff:*)`。
**修复**：全部改 `:*`，并补 show/branch/fetch 等只读 git 命令。

### 4. deny 只挡 Edit，Write 可绕过 🔴→✅
原 deny 仅 `Edit(./memory/**)` / `Edit(./contracts/**)`。CC 的 **Write 是独立工具**——只 deny Edit 意味着 CC 仍可用 Write 覆盖这两个目录，保护形同虚设。
**修复**：补 `Write(./memory/**)` / `Write(./contracts/**)`。

### 5. 归档所需 `mv` 未授权 ❌→✅
协议要求 CC 移动文件归档，allow 却没有 mv——每次归档都弹确认，易被打断后遗漏。
**修复**：allow 补 `mv` / `mkdir` / `touch`。

### 6. `REVIEW/` 目录角色矛盾 ❌→✅
README 把 REVIEW 定义为「OpenClaw 写、CC 读」(返工指令)，但本任务 AC 又要求 CC 把审查写进 REVIEW/——同目录两种互斥角色。
**修复**：REVIEW/ 重定义为「任一方可写的审查/分析报告」；返工改走「重写任务回 INBOX + 标 REWORK」闭环。

### 7. 无新任务通知机制 ⚠️→✅(文档化)
协议没说 CC 如何得知有新任务，CC 不会自动后台轮询。
**修复**：README 明确两种触发（人工提示 / 可选 SessionStart hook），见建议 A。

## 二、设计性建议（需决策，未擅自实现）

### A. SessionStart hook 自动提示 INBOX（推荐）
workspace `.claude/settings.json` 加：
```json
"hooks": {
  "SessionStart": [{
    "matcher": "",
    "hooks": [{"type":"command","command":"ls ~/.openclaw/workspace/shared/cc-handoff/INBOX/ 2>/dev/null | sed 's/^/INBOX: /'"}]
  }]
}
```
会话启动即把待办列表注入上下文。**未直接加**：会改变 workspace settings 结构（现无 hooks），且含硬编码绝对路径，留给 OpenClaw 决定。

### B. 多任务并发与排队
INBOX/ 有多任务时的顺序未约定。建议：REWORK 优先 → P0>P1>P2 → 日期；或约定一次只取一个。

### C. DONE 验证强制化
约定 DONE 的 Verification 节必须贴实际命令输出（done-template 已标注），OpenClaw 把「无验证输出」视为不通过。

### D. 幂等与重试
CC 中途崩溃时 INBOX 任务仍在（未归档），下次重做可能重复。建议顺序：**先写 DONE，再归档 INBOX**，保证「有 DONE = 已完成」幂等（已写入 CLAUDE.md 工作守则）。

## 三、permission 语法说明

- `Bash(git status:*)` 前缀匹配：`git status` 及任意参数（推荐）。
- `Bash(git status)` 精确匹配：仅无参。
- `Bash(git status *)` 空格星号：需至少一个参数，裸命令不匹配（不推荐）。
- 优先级：deny > allow > 默认 ask，故 `Read(**)` 与 `Read(**/.env)` 共存安全。

## 四、链路验证

- INBOX → DONE → ARCHIVE 物理路径：✅ 四目录均存在。
- 归档 mv 权限：✅ 已 allow。
- memory/contracts 保护：✅ Edit + Write 双 deny。
- 本任务作为首个端到端样本：本 REVIEW + DONE + INBOX 归档，完整走通一轮。

## 五、未决 / 后续

- SessionStart hook（建议 A）— 待 OpenClaw 决定。
- 并发排队（建议 B）— 待约定。
- 是否需要显式状态索引文件（已用目录位置替代）— 若想要可另行约定。
