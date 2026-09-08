目标：codex-ingress slice 2 返工。你是 gpt-6-astra 实现坐席，分支 feat/codex-ingress（本 worktree）。**先 `git stash list` 看到 stash@{0}「slice2 WIP left by retired seat smtk-ingress-s2 (claude_threads flag)」，`git stash pop` 接手这份半成品**（runtime.ts / listener.ts / router.ts / session.ts / 两个 test），把它做完整。
输入：复核报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice2-review-39e3/out/review.md`（P1×1、P2×3，逐条修）；leader 三条裁决在 `progress/decisions.md`「codex-ingress 对 Claude 专属语义的三条投影裁决」（同前缀 /Users/smokingmouse/python/learning/trellis/）；方案 §3.3/§3.4。
要求：
1. `codex_ingress.claude_threads` 开关落地（默认 false；关时 thread/list 无 Claude 线程、start 选 Claude 模型明确拒绝）；冒烟脚本对 `--backend claude` 自动开闸（隔离 daemon 配置），使契约原样命令 `codex-remote-smoke.py --backend claude --expect thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok,resume_fresh_ok` 在干净 checkout 下 3/3 通过（这是复核 P1）。
2. 裁决①：Claude 通用工具审批（{toolName,input}）投影为 native `tool/requestUserInput`（标题「权限请求：<toolName>」、正文 input 摘要、选项 allow / deny），答案映射回 AS permissions 决策并经 broker 收口；真机用 Read 或 MCP 工具触发一次，证据进 result.md。
3. 裁决②：Claude 线程 live effort 返回明确错误，message 说明「Claude 线程 effort 只在新建时生效」。
4. 裁决③：multiSelect 问题投影为自由作答 + 题干列编号选项与「可多选，逗号分隔」提示，解析回 answers 数组；单测覆盖。
5. 复核 P2×3 逐条修或写明不修理由；方案 slice 2 判据 agent_message_delta / command_execution_output / user_input_question / unsupported_method_errors 进冒烟脚本。
6. `packages/agent-server` 全量测试与 typecheck 绿；两种后端冒烟各 3 次；协议文档更新。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`。提交到本分支，交付时 `git status --short` 必须为空。
