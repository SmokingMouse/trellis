异源复核 agent-tui 信息设计急救 fj-tui-display-quickwin-e873（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-display-quickwin-e873/out/result.md`，先读；分支 feat/tui-display-quickwin，本 worktree 已是该分支）。你是 gpt-6-astra 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。
必做：
1. `bun test apps/agent-tui/src` 全绿；对 4 个快照变更逐条核对 result.md 的前后对比是否如实，快照里不得残留占位符（`?`、`—`、`[??????????]`）。
2. 真机（用本 worktree 重新打包的 `apps/agent-tui/bin/agent-tui` 连生产 daemon `~/.sm-toolkit/agent-server.sock`，显式 `--model sonnet` 起一个线程，让它跑一条输出 ≥ 300 行的命令与一条失败命令）：折叠态 ≤ 8 行且尾部行正确、Ctrl-O 展开完整、再按收起；空 reasoning 不占行；状态头 ≤ 2 行无占位符；Read/Grep 单行摘要；按词折行无单词中断。用 `herdr pane read` 或 PTY 快照留证据。
3. 按键语义零回归：审批卡 y/s/n/a、Ctrl-C 两次退出、Ctrl-N/Ctrl-T/Ctrl-R、324 格模态矩阵测试通过；Ctrl-O 不与既有键冲突。
4. 代码只改 apps/agent-tui；协议客户端 / 租约 / 审批握手文件零 diff（`git diff --stat feat/agent-server..HEAD`）。
评级 P0/P1/P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
