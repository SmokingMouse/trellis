复核 codex-ingress slice 2「Claude 线程在 Codex 官方 TUI 里显示与交互」（fj-tui-ingress-slice2-6772，产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice2-6772/out/`：result.md（坐席自报 partial，先读其未完成项逐条核实）、冒烟日志与 wire；方案 `.fenjue/archive/fj-tui-ingress-design-cd8e/out/tui-ingress-design.md` §3、§4、§5 slice 2，同前缀）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。分支 feat/codex-ingress（本 worktree）。隔离 daemon，不碰生产。
必做：
1. 官方 `codex --remote` 驱动真实 Sonnet 线程（显式 model，断言 init 帧 model）：`--backend claude` 冒烟六判据连跑 3 次；再逐项核方案 slice 2 判据 agent_message_delta / command_execution_output / user_input_question / unsupported_method_errors（/review、thread/realtime/start 返回 -32601 且 message 前缀 as-ingress:）。
2. 合成一致性：同一 Claude 线程，用 as/1 客户端读 items 与 TUI 侧收到的 native item 逐条对照（类型、顺序、流式 delta 拼接后的文本、fileChange 的 diff、toolCall 的输入输出、reasoning 折叠）；未知类型走 unknown 而非丢失。
3. 治理：readonly Claude 线程经 TUI 发写命令走审批且不落地；四类审批 1:1 且经 broker（approvals 表 decided_by 前缀 codex-tui:）；serviceTier / model guard（fable 被拒）在 TUI 入口生效；`codex_ingress.claude_threads=false` 时 thread/list 无 Claude 线程且 start 选 Claude 模型被明确拒绝。
4. Codex 线程零回归：`--backend codex` 六判据 3/3；slice 1 复核的 41 项反例抽核 10 项。
评级 P0（无审批写 / 事件串线 / 合成丢失导致误导）/ P1 / P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
