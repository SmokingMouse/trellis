复核 codex-ingress slice 3「多线程 / fork / 历史分页 / 断线恢复」（fj-tui-ingress-slice3-d89c，产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice3-d89c/out/`；方案 `.fenjue/archive/fj-tui-ingress-design-cd8e/out/tui-ingress-design.md` §2.4/§2.5/§4.1/§5 slice 3，同前缀）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。分支 feat/codex-ingress-s3（本 worktree）。隔离 daemon，不碰生产。
必做（全部真机，Claude 线程显式 sonnet 并断言 init 帧 model）：
1. 一个官方 TUI 连接开两个线程（一 Codex 一 Claude）交替发 turn：事件、审批、中断互不串线；picker 切换后视图正确。
2. fork：从末尾与从中间 item（fromItemId）各 fork 一次，fork 出的线程立刻可 resume 与发 turn，原线程不变。
3. 分页：≥ 200 item 的线程 resume 回放完整且顺序正确；turns/items 游标（backwardsCursor / excludeTurns / 空页）与官方 `codex app-server` 0.153.4 对同类线程的响应逐字段对照。
4. 断线恢复：审批待决时断开 TUI → 线程与进程存活（detach ≠ close）→ 同 token 重连 → pending 重放且可回答、订阅恢复；租约在断线后释放。
5. 九判据冒烟两种后端各 3 次；slice 1/2 的反例矩阵抽 15 项零回归；全量测试与 typecheck。
评级 P0（串线 / 断线丢线程 / 无审批写）/ P1 / P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
