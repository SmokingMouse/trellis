目标：codex-ingress slice 2「Claude 线程在 Codex 官方 TUI 里显示与交互」。你是 gpt-6-astra 实现坐席，分支 feat/codex-ingress（本 worktree，slice 1 已两轮复核通过）。
方案（必读，按它做）：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-design-cd8e/out/tui-ingress-design.md` 的 §3（3.1 后端怎么选、3.2 AS Item → native item 映射表、3.3 四类审批 1:1、3.4 slash 命令与交互方法在 Claude 线程上的落点）、§4 治理插入点、§5「slice 2」小节。slice 1 的实现与复核报告在 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice1-{9065,fix-cf4c,review-f08c,review2-d094}/out/`。
交付：
1. 后端选择：`model/list` 注入 Claude 模型（显式 sonnet / opus，禁 fable 由 model guard 兜底），TUI 选到 Claude 模型时 `thread/start` 走 Claude 引擎；TUI 无 backend 概念，规则按 §3.1。
2. 单向合成：AS Item → native item 通知（agentMessage / reasoning / commandExecution / fileChange / toolCall / mcpToolCall / subAgent / webSearch / plan / error / contextCompaction），含流式 delta；映射表按 §3.2，未知类型走显式 unknown 而非丢弃。
3. 审批：Claude 线程的四类反请求 1:1 映射成 native 反请求，决策经 AS broker 回传并 `serverRequest/resolved` 收口（同 slice 1）。
4. slash 命令与交互方法：按 §3.4 落点——能映射的映射（/model、/compact 等），Claude 没有的（/review、realtime、goal、memory 等）返回明确 JSON-RPC 错误，不伪成功；readonly 线程的写路径经只读门。
5. 冒烟：`codex-remote-smoke.py --backend claude`——真实 Claude CLI（显式 `--model sonnet`，脚本断言 init 帧 model），官方 TUI 完成 thread_started / turn_completed / approval_roundtrip / resume_ok / interrupt_ok / resume_fresh_ok 六判据，连跑 3 次全过；Codex 线程冒烟零回归。
6. 单测（合成映射逐类型、错误码）、packages/agent-server 全量测试与 typecheck 绿；协议文档「codex-ingress」章补 Claude 线程一节与不支持方法表。
产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`（含两种后端冒烟证据）。提交到本分支。
