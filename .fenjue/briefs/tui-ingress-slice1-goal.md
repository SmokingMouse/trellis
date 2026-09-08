目标：codex-ingress slice 1「Codex 线程端到端」。你是 gpt-6-astra 实现坐席，分支 feat/codex-ingress（基于 feat/agent-server，含只读门收口 b45cc7c），worktree 无 node_modules，先 `bun install`。
方案（必读，按它做，偏离要在 result.md 写明理由）：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-design-cd8e/out/tui-ingress-design.md` 的 §0 一页结论、§1 入口形态、§2 进程模型、§3.3 审批四类 1:1、§4 治理插入点、§5「slice 1」小节、§7 风险表。协议事实与 PoC：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-codex-native-tui-spike-23ce/out/`（报告 §2–§5 与 proto/ 里 18 行代理、probe 脚本）。
交付（对照方案 slice 1）：
1. `packages/agent-server/src/ingress/codex/{listener.ts, session.ts, router.ts, control-process.ts}`：ws listener（bearer 经 HTTP upgrade、仅 loopback、128 MiB 帧上限）；native `initialize` / `initialized` 握手；每连接一个 `connectInProcess()` AS client（一个 TUI 连接 = 一个 AS Connection）。
2. control 进程（ingress 自有、不绑 thread 的 `codex app-server`）+ 方案里 A 桶只读方法转发，覆盖 TUI 冷启动需要的方法。
3. thread↔进程路由表（方案 §2.5 无状态 ID 规则）；`thread/start` / `turn/start` / `turn/interrupt` / `thread/resume` 映射到 as/1。
4. Codex 线程 native 通知回流：订阅 `thread/engineEvent`（需 engineEvents:true），把 payload 里的原始帧原样发给 TUI。
5. 审批：AS 四类反请求 → native 反请求，决策经 AS broker 回传并以 `serverRequest/resolved` 收口；approvals 表 decided_by.label 带 `codex-tui:` 前缀。
6. 回退开关：daemon config `codex_ingress.enabled`（默认 false，进 ConfigSchema）；关掉后 AS 行为与现在逐字节相同。
7. 冒烟脚本 `packages/agent-server/scripts/codex-remote-smoke.py`：PTY 驱动**真实**官方 `codex --remote ws://…`（本机 0.153.4），应答终端能力查询，按判据退出；`--expect thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok` 全过 exit 0，并落 wire.ndjson。用隔离 daemon（mktemp 下的 HOME/socket/DB，端口随机），不碰生产 daemon 与 `~/.agent-server`。
8. 单测 `packages/agent-server/src/ingress/`：握手、路由、ID 规则、决策枚举桥；`packages/agent-server` 全量测试绿；typecheck 绿；协议文档章节新增「codex-ingress」。
约束：不 fork Codex；不做 Claude 线程（slice 2）；不做 unix://（slice 4）；serviceTier 只允许 default、model guard、allowed_roots 在 native 入口照旧生效。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`（含冒烟证据：thread id、wire 摘要、approvals 行）。提交到本分支（可多 commit）。
