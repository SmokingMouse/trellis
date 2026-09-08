异源复核急救返工 fj-tui-display-quickwin-fix-d55f（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-display-quickwin-fix-d55f/out/result.md`；上一轮复核 `.fenjue/archive/fj-tui-display-quickwin-review-9ab4/out/review.md` 的「阻断项」表给了每条 P1 的返工验收条件，同前缀）。你是 gpt-6-astra 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。分支 feat/tui-display-quickwin（本 worktree）。
必做：
1. 按上一轮的返工验收条件原样重打 P1-1～P1-6：状态头按实际终端行数 ≤2（70 / 110 / 140 列各验，含 usage 已知与租约持有）；Read/Grep 单行且 Read 范围与一基 offset 一致；空 reasoning 在整个时间线层面不占行（插入任意个前后高度不变）；失败命令折叠态保留退出码（用生产实际 payload：`sh -c 'seq 1 310; exit 7'`，exitCode 缺省的情况）；折叠态最终显示行 ≤ 8（长行用例）；`bun test apps/agent-tui/src` 在当前环境（NO_COLOR=1）与 `env -u NO_COLOR` 下都全绿。
2. 真机：用本 worktree 重新打包的入口连生产 daemon `~/.sm-toolkit/agent-server.sock`（显式 `--model sonnet`，`--permission default`），跑 `seq 1 320` 与上面的失败命令；折叠 / Ctrl-O 展开 / 再收起三连留帧证据。
3. 按键语义零回归（324 格矩阵 + Ctrl-O 12 模态）；`git diff --stat feat/agent-server..HEAD` 只含 apps/agent-tui。
评级 P0/P1/P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
