异源终审急救返工 fj-tui-display-quickwin-fix2-7aac（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-display-quickwin-fix2-7aac/out/result.md`；二审报告 `.fenjue/archive/fj-tui-display-quickwin-review2-6bee/out/review.md` 的 P1-5 阻断项与探针，同前缀）。你是 gpt-6-astra 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。分支 feat/tui-display-quickwin（本 worktree）。
必做：
1. 原样重打 P1-5：折叠态最终显示行 ≤ 8，在 40/70/110/140 列 × 单行 5000 字符（含空格 / 不含空格 / CJK / emoji）× 成功 / 失败（exitCode 缺省、首行 Exit code 7）矩阵下成立；尾部取自最后一行末尾且截断行以 `…` 标明；失败诊断保留。用二审的探针原样跑，再加 keep=0 路径。
2. 真机：用本 worktree 入口连生产 daemon（显式 `--model sonnet`，`--permission default`），跑 `python3 -c "print('word '*2000)"` 与 `sh -c 'seq 1 310; exit 7'`，折叠 / Ctrl-O 展开 / 收起三连留帧。
3. 抽核 P1-1～P1-4、P1-6 不回归；`bun test apps/agent-tui/src` 当前环境与 `env -u NO_COLOR` 均全绿；324 格矩阵通过；diff 只含 apps/agent-tui。
评级 P0/P1/P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
