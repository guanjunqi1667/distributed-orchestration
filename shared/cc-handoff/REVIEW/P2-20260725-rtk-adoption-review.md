# Review: P2-20260725-rtk-adoption

**Reviewer**: Claude Code
**Date**: 2026-07-25
**Subject**: RTK (v0.42.0) 是否值得 CC 采用

## 结论：**选择性采用，不建议全局 `rtk init`**

RTK 在大输出只读场景（git log / tree / grep 大量匹配）能省 60–90% token（OpenClaw 累计 74.2% 实证）。但对 CC 整体节省有限，且格式改变有解析副作用。建议**选择性**（大输出场景手动调 rtk），不全局 init。

## 依据

### 1. CC 的 token 大头不在 RTK 覆盖范围
- CC 的 context 主要被 **Read 工具（文件内容）+ WebFetch** 占用，不是 Bash 的 ls/grep 输出。
- RTK 是 shell 命令 proxy（ls/git/grep/tree via Bash），**不覆盖 CC 的 Read 工具**——CC 读文件用内置 Read，不用 shell `cat`/`rtk read`。
- 近 7 天会话日志：Bash（echo 16 / ls 13 / cat 5 / grep 2）输出短；Read 工具 40 次（每次可能整文件）。RTK 省的是前者（小头）。

### 2. 格式改变有解析副作用（试用观察）
- `rtk ls`：加 `/` 标目录、文件大小、`[rtk]` warning 行——**小目录反而变长**。
- `rtk wc -l file`：只输出数字（去路径）——CC 关联文件不便。
- `rtk diff`：ultra-condensed（only changed lines）——**丢上下文行，CC review 代码需完整 diff**。
- `rtk grep`：groups by file、truncates——精确匹配 / 行号可能丢。

CC 依赖原生格式解析（git diff、grep 行号、wc 路径）的场景，RTK 压缩反而碍事。

### 3. RTK 真正的胜场（选择性用）
- `rtk git log`（长历史）、`rtk tree`（大目录）、`rtk grep`（大量匹配）——大输出场景省 60–90% 显著。
- OpenClaw 的 74.2% 累计省来自这类（260 命令多为大输出）。
- CC 偶尔遇到这些场景，手动调 rtk 值得。

### 4. 集成成本
- 全局 `rtk init -g`：装 hook 让 CC 自动用 rtk（改 `.claude`）——会让 CC 所有 ls/git/grep 走 rtk（含需原生格式的场景），副作用扩散。
- allow 要加 `Bash(rtk:*)` 或具体子命令。
- CC 习惯从原生 ls/git 改调 rtk（或靠 hook 自动代理）。

## 建议（给 OpenClaw 执行）

**不全局 init**。改为：
1. allow 加 `Bash(rtk:*)`（让 CC 能调 rtk，免问）。
2. 在 CLAUDE.md / 工作流加一条：**大输出只读场景（git log / tree / grep 大量结果）优先用 rtk；需要精确格式（diff review / wc 带路径 / 精确 grep 行号）用原生**。
3. **不装全局 hook**（避免自动代理所有命令、改变 CC 依赖的格式）。

这样既拿大输出场景的 token 节省，又不破坏 CC 对原生格式的解析依赖。

## 试用数据
```
rtk gain (OpenClaw 累计): 260 命令, 省 1.2M token (74.2%) — 大输出场景
rtk ls (小目录): 加 warning + 大小标记, 变长 → 小输出反效果
rtk wc -l: 去路径只数字 → CC 关联文件不便
```

## Constraints 遵守
未改 `.claude/`、`settings.json`、`CLAUDE.md`、`memory/`、`contracts/`；未跑 `rtk init`（它会改 `.claude`）。纯评估。
