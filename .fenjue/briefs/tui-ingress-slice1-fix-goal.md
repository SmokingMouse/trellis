目标：修 codex-ingress slice 1 复核的唯一阻断项 P1（复核报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice1-review-f08c/out/review.md`，先读全文；其 41 项反例矩阵与临时件路径在报告里）。你是 gpt-6-astra 实现坐席，分支 feat/codex-ingress（本 worktree，HEAD 62e1357）。
问题：任何**尚无 turn** 的 Codex 线程被 TUI resume 时报 `-32004 as-ingress: list_turns is not supported yet`。这正是 fj 的主路径（fj 用 as/1 建线程 → 官方 TUI `codex resume --remote … <uuid>` 进去看），冒烟因为总在跑完一轮之后才 resume 而系统性漏掉。
要求：
1. 实现 `thread/turns/list`（及 resume 路径依赖的历史分页方法）对零 turn / 有 turn 两种线程都按上游 0.153.4 语义返回（对照 `codex-rs/app-server-protocol` 的响应结构与分页字段，不自造）；resume 一个 as/1 建的零 turn 线程后能正常发一轮并收到通知。
2. 冒烟脚本增加判据 `resume_fresh_ok`：用 as/1 客户端建线程（不发 turn）→ TUI `resume --remote` 进入 → 发一轮 → turn/completed；默认 `--expect` 加上它。连续 5 次全过。
3. 复核报告里其余 P2 观察顺手修（若有），逐条写进 result.md；不改变已通过的 41 项反例行为（复跑其探针，路径见报告）。
4. `packages/agent-server` 全量测试与 typecheck 绿。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`。提交到本分支。
