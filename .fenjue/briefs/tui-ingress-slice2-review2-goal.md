复核 codex-ingress slice 2 返工 fj-tui-ingress-slice2-fix-d5b8（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice2-fix-d5b8/out/`；上一轮复核 `.fenjue/archive/fj-tui-ingress-slice2-review-39e3/out/review.md` 的 P1-1 与 P2×3；leader 三条裁决在 `progress/decisions.md`「codex-ingress 对 Claude 专属语义的三条投影裁决」，同前缀）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。分支 feat/codex-ingress（本 worktree，交付后 `git status --short` 应为空）。隔离 daemon，不碰生产。
必做：
1. P1-1：在干净 checkout（mktemp `git worktree add`）下原样跑契约冒烟 `--backend claude` 六判据 3/3、`--backend codex` 3/3；`codex_ingress.claude_threads` 默认 false 时 thread/list 无 Claude 线程且 start 选 Claude 模型被明确拒绝，开闸后正常。
2. 裁决①真机：官方 TUI 驱动真实 sonnet（显式 model）触发一次 Read 或 MCP 工具的通用审批，TUI 侧出现「权限请求：<toolName>」问题卡，选 allow / deny 各一次，AS approvals 表有对应决策且经 broker；deny 后工具未执行。
3. 裁决②③：live effort 改动返回明确错误且 message 含「新建时生效」语义；multiSelect 问题投影为自由作答带编号选项提示，逗号分隔回答解析回 answers 数组（单测 + 真机一次）。
4. 方案 slice 2 判据 agent_message_delta / command_execution_output / user_input_question / unsupported_method_errors 的实现与证据；P2×3 处理核实。
5. Codex 线程零回归（41 项反例抽 10）；全量测试与 typecheck。
评级 P0/P1/P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
