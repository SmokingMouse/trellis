目标：codex-ingress slice 3「多线程 / fork / 历史分页 / 断线恢复」。你是 gpt-6-astra 实现坐席，分支 feat/codex-ingress-s3（基于 feat/codex-ingress 当前 HEAD，含 slice 1/2 与返工；worktree 无 node_modules，先 `bun install`）。同一时间 feat/codex-ingress 上有 Opus 在复核 slice 2 返工，若其结论要求再返工，会在 feat/codex-ingress 上出新提交，你交付前 `git merge feat/codex-ingress` 一次。
方案（必读）：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-design-cd8e/out/tui-ingress-design.md` §2.4 全局 thread/list 聚合、§2.5 线程 ID 规则、§4.1 租约、§5「slice 3」小节、§7 风险表。前两片的实现与复核报告在 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice{1-9065,1-fix-cf4c,1-review-f08c,1-review2-d094,2-6772,2-review-39e3,2-fix-d5b8}/out/`。
交付：
1. `thread/list` 聚合（as/1 全部线程 + native 元数据，分页与排序按上游）、`thread/loaded/list`；一个 TUI 连接操作多线程：picker 切换、两线程交替发 turn 不串线（路由表按 §2.5）。
2. `thread/fork`：映射到 AS thread/fork（含 fromItemId 边界），fork 出的线程立刻可在 TUI 里 resume 与发 turn。
3. 历史分页：turns/items 游标语义与上游 0.153.4 逐字段一致（含 backwardsCursor / excludeTurns / 空页），长历史（≥ 200 item）分页回放正确。
4. 断线恢复：TUI 连接断开不关线程（detach ≠ close）、不杀进程；重连（同 token）接管订阅与 pending 重放（serverRequest 未决的重发、已决的 resolved）；租约在断线后按 §4.1 释放 / 重取。
5. 冒烟脚本加判据 `multi_thread_ok`、`fork_ok`、`reconnect_ok`（含 pending 重放），两种后端各连跑 3 次全过；单测覆盖路由与分页；全量测试与 typecheck 绿；协议文档更新。
产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`。提交到本分支，交付时 `git status --short` 为空。
