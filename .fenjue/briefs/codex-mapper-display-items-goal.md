目标：agent-server 的 Codex 引擎映射补齐钉住的 0.153.4 schema 里全部 ThreadItem 类型，`sleep` 等已知类型不再被降级成 error item。

## 事实（已核实）

- `packages/agent-server/src/engines/codex-mapper.ts` 的 `mapCodexItem` 只映射 userMessage / agentMessage / reasoning / commandExecution / fileChange / functionCallOutput / dynamicToolCall / mcpToolCall / collabAgentToolCall / subAgentActivity / webSearch / imageGeneration / plan / contextCompaction；`default` 抛 `Unknown Codex item type`，上层（同文件约 150 行）捕获后降级为 `type: "error", status: "failed"` 的 item 并发一条 error 通知（线程不死）。
- 钉住的 schema `docs/agent-server/codex-schema/0.153.4/codex_app_server_protocol.schemas.json` 的 `*ThreadItemType` 枚举里还有 5 种没映射：`sleep`（"Display item emitted by the interruptible `clock.sleep` tool"）、`enteredReviewMode`、`exitedReviewMode`、`hookPrompt`、`imageView`。
- 真机复现：fj 坐席（codex-tui runner，官方 TUI 显示端）在 codex 里把长命令放后台终端并等待时，TUI 出现两条红条「■ Unknown Codex item type: sleep」；turn 没被杀（fallback 生效），但每次 sleep 都成了 error item，AS 日志、Trellis 会话、TUI 都当错误显示。

## 要求

1. 为这 5 种类型加映射，**不改 AS 协议的 item 类型集合**（`ItemPayloadSchemas` 不加新类型）：`sleep` → `toolCall`（name `clock.sleep`，input 取 schema 字段如 duration/reason，完成时 output 写结果或状态）；`imageView` → `toolCall`（name `image.view`，input 含 path）；`hookPrompt` → `toolCall`（name `hook.prompt`，字段按 schema）；`enteredReviewMode` / `exitedReviewMode` → `toolCall`（name `review.enter` / `review.exit`，input 含 schema 里的请求/结果摘要）。字段名以 schema 里对应 `*ThreadItem` 定义为准，先读 schema 再写；status 沿用 `status(d.status, completed)`，schema 无 status 的显示项按 completed 处理。
2. 保留 `default` fallback（未来新增类型仍降级为 error item、不杀线程）。
3. 单测：5 种类型各覆盖 item/started 与 item/completed（样例字段按 schema 造），断言映射结果通过 `ItemPayloadSchemas` 校验且 status 正确。再加一条「schema 全覆盖」测试：从 `docs/agent-server/codex-schema/<钉住版本>/codex_app_server_protocol.schemas.json` 抽取全部 `*ThreadItemType` 枚举值，逐一喂最小样例给 `mapCodexItem`，断言没有任何一个落到 Unknown 分支（将来升级 schema 时这条先红）。版本号从 `docs/agent-server/codex-schema-version.txt` 读，不写死。
4. codex-ingress 的 native 投影对 `toolCall` 已有处理；用真实 codex 线程验证：`packages/agent-server/scripts/codex-remote-smoke.py --backend codex` 跑一次全绿，另起一个真实 codex 线程（显式 model，full 权限）发提示「先在后台终端执行 sleep 5 并等待它结束，再回答 done」，截 pty 证明 TUI 不再出现 Unknown 红条、sleep 以工具调用形式显示。用 `docs/agent-server/codex-tui-quickstart.md` 的起法，token `~/.agent-server/token`，常驻 daemon 的 ingress 地址见 `~/.sm-toolkit/agent-server.sock.endpoint.json`。**不要碰 daemon 上别的线程**，自己起的线程结束后 close。
5. `bun run typecheck`、`packages/agent-server` 下 `bun test` 全绿；提交到本 worktree 分支 `feat/codex-mapper-display-items`，工作树干净。**不 push、不 PR、不部署、不重启 daemon**（主控推送与合并）。
6. `out/result.md`：改动清单、每条命令与 exit、pty 证据路径、schema 全覆盖测试的类型清单。
