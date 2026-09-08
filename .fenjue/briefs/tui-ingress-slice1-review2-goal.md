复核 codex-ingress slice 1 返工 fj-tui-ingress-slice1-fix-cf4c（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice1-fix-cf4c/out/result.md`；你上一轮的报告与 41 项探针在 `.fenjue/archive/fj-tui-ingress-slice1-review-f08c/out/`，同前缀，临时件可能已不在，需要就按报告重建）。你是 Opus 复核坐席（复用），只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。分支 feat/codex-ingress（本 worktree）。隔离 daemon，不碰生产。
必做：
1. 原样重打你上一轮的 P1：as/1 客户端建线程（零 turn）→ 官方 TUI `codex resume --remote … <uuid>` 进入 → 发一轮 → turn/completed；再对「有 1 轮」「有多轮且分页」的线程各做一次 resume，历史回放顺序与内容正确。
2. `thread/turns/list` 与 resume 历史分页的响应结构、游标字段（含空页 backwardsCursor、excludeTurns）与上游 0.153.4 官方 `codex app-server` 对同类线程的响应逐字段对照（起一个官方 app-server 采样），不一致处列表。
3. 冒烟 6 判据连跑 3 次；41 项反例复跑零回归。
4. 抽核返工的 P2 处理与文档。
评级 P0/P1/P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
