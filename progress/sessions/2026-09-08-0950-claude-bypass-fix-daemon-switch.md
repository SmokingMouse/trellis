# S154 · 2026-09-08 09:20–09:50 · 阶段 2 首单暴露 daemon 权限映射 P0 → 修复 → dogfood 合入 → 试点 daemon 切到集成分支

## 发现与根因

- 阶段 2 第一个 Claude 坐席（as-doc-audit，sonnet，`--permission readonly`）每条 Bash 弹审批卡；leader 用 `herdr pane send-keys <pane> s` + `enter` 走通人工审批（卡片「已由 agent-tui 处理」），但下一条命令又弹；改 `--permission full` 重派仍弹。
- `ps` 看 daemon 起的 claude：`claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --settings '{"permissions":{"ask":["*"]}}' --model sonnet …`——**全模式注入 ask:["*"]**，bypassPermissions 只是 thread 标签，进程根本没拿到 bypass。codex 后端不受影响，阶段 1 未暴露。
- 中止路径也顺手验证：卡片按 `a` 中止 → thread idle → `fj task close --verdict aborted` 关 AS 与 pane。

## 修复与集成

- as-claude-bypass-fix（codex，agent-tui runner）：保留 stdio 审批通道，bypass 线程 daemon 自动放行并以 engineEvent 留痕；readonly 映射原生 plan 模式；五种模式 argv 单测；真 Sonnet 冒烟：bypass 线程 ls/echo 零 pendingRequests，default 线程一条 Bash 产生审批（对照）。验收通过。
- TUI 终审 tui-router-review：通过（8 条反例重打、216 格穿透矩阵零违例）；settle 因同 worktree 并行单的脏树误判越界 → base_commit 改到新 HEAD 后 `settle --force` 通过并归档。TUI 线全部收口。
- as-integrate3：feat/dogfood（fjContext、TUI 参数/ready、launchd 模板）合入 feat/agent-server（merge 387ff69），typecheck、TUI 174、协议对齐、dist daemon 的 fjContext 启动/重启恢复全过。
- **daemon 切换**：SIGTERM 旧 daemon（16133，feat-dogfood dist）→ 新 daemon pid 78404 从 `feat-agent-server/packages/agent-server/dist/daemon/cli.js` 起（pane w4:pJ，同 socket/token）；policy `agent_tui_bin` 改指 feat-agent-server 的 bin。`herdr pane send-keys … ctrl-c` 报 invalid_key，停 daemon 用 kill -TERM。
- 阶段 2 首单第三次起位（as-doc-audit-5dfd，sonnet，full）：已在读文件，无审批卡。

## 阶段 2 计数

| # | 单 | 起位 | 结果 |
|---|---|---|---|
| 1 | as-doc-audit（只读审计，sonnet） | 3 次（前两次因 daemon P0 中止，计基础设施失败） | 在跑 |

## Next

- audit 结论 → 文档修正单（可 writable，sonnet）；阶段 2 累计 10 单。
- backlog：只读命令免审名单（READONLY_AUTO_ALLOW 下沉）。
- 用户待决：Herdr 桥合并上线、影子模式与第二步合并、agent-server 合 main 与发包、daemon 常驻（launchd）。
