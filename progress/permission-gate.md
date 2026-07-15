# 权限确认（Permission Gate，P0）

> 背景：由 botmux（tmux attach 模式）对照讨论引出。拆解结论：权限确认不需要终端，
> stream-json control protocol 是结构化正解；终端逃生舱（tmux + web terminal）为 P1，
> 等真实场景绊到再做。决策见 decisions.md 2026-07-15。

## 语义

- **`Session.requireApproval`**（DB `sessions.require_approval`，默认 0）：true = 该 session 的
  workspace/project 轮次里，可变更工具（Bash/Write/Edit/MultiEdit/NotebookEdit）执行前暂停，
  弹权限卡等用户「允许 / 本轮总是允许 / 拒绝(+理由)」。
- **创建时锁定**（同 mode/workspacePath）。仅 claude 系 + 非 chat 可开——chat 无文件工具、
  增强 chat 定义即 YOLO、codex 无 stdio 协议（服务端 route 钳制 + UI 隐藏开关，双保险）。
- **只读工具不问**：Read/Glob/Grep 走 claude 自身免审规则，零打扰。
- **「本轮总是允许」**：工具名记入 RunState.approvedTools，仅存活当次 spawn；下一轮（新进程）
  重置。MCP 等未列入 ask 名单的工具走 claude 默认审批，未 allowlist 的同样进卡。

## 机制（全链）

```
创建: ModePicker 🛡️开关 → store.draftRequireApproval → POST /api/chat(root) → 钳制 → sessions 行
spawn: chat route 读 session.requireApproval → StreamRequest.requireApproval
       → sdk-adapter: permission "default" + askTools=[5 mutators]（仅 onCanUseTool 在场时）
       → SDK ClaudeBackend: --permission-mode default
         + --settings '{"permissions":{"ask":[...]}}'   ← 关键：压过本机全局 allowlist（实测硬前提）
         + --permission-prompt-tool stdio + initialize 握手（既有交互模式）
暂停: can_use_tool → run-bus dispatcher（requireApproval 时不再 auto-allow）
       → PendingInteraction（持久化+broadcast+catchup，复用 A路② 原管道）
决议: 权限卡（InteractionForm 新 generic 分支）→ POST /api/nodes/[id]/respond
       {behavior, updatedInput=原样回显, alwaysAllowTool?} → resolveInteraction → control_response
```

改动面：SDK `RunOptions.askTools`（+claude.ts 注入）；trellis migration + repo + chat route +
run-bus（dispatcher 分支 + approvedTools + resolveInteraction opts）+ respond route + store
（draft + respond 透传）+ ModePicker 开关 + InteractionForm PermissionForm + ModeBadge 🛡️。
A路② 原有 AskUserQuestion/ExitPlanMode 行为零变化；YOLO 会话零变化。

## 验证（Session 56，全过）

- 协议探针（真 claude 2.1.207）：ask 规则压过全局 `Bash` allowlist（不注入则 can_use_tool
  永不触发——本机实测）；allow 执行 / deny 不执行且理由回给模型。
- HTTP e2e（隔离 :3123 + 临时 DB + 真 claude haiku）四场景：allow（卡→允许→文件创建）/
  deny（卡→拒绝→文件不创建、模型收到理由、轮次正常 done）/ always（两条 Bash 只弹一卡）/
  yolo 回归（零卡直执行）。mid-pause catchup 带 pendingInteraction（刷新恢复卡片）✓。
- 浏览器（agent-browser）：ModePicker YOLO↔需确认切换、权限卡渲染（Bash chip + 命令等宽块 +
  三按钮）、点允许→执行→答案正确、Header ModeBadge 🛡️ 角标 ✓。
- tsc ✓ / `make build` ✓；prod 已 kickstart（login 200 / api 401 闸正常）。

## 边界 / 后续

- 权限决议不落审计日志（deny 理由在 tool_result 里可见）；要审计再加。
- abort 时 pending 卡 deny 收尾（run-bus 原有路径，未新增测试）。
- P1（未做，等被绊到）：终端逃生舱 = tmux 包 `claude --resume` + ttyd Web 终端 + 回程走
  CLI sync watcher；需求 C（workspace shell）是其副产品。见对话记录 2026-07-15。
