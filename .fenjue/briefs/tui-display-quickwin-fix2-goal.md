目标：修急救二次复核唯一阻断项 P1-5（复核报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-display-quickwin-review2-6bee/out/review.md`「阻断项」与 P1-5 行，先读证据与探针）。你是 Claude sonnet 坐席，分支 feat/tui-display-quickwin（本 worktree），只改 apps/agent-tui。
问题：折叠预算只对逻辑行成立；普通带空格的超长行在折行后仍能回吐 2484 行。上一轮的新增单测每个尾行只有约两物理行，没触发 keep=0 路径。
要求：
1. 折叠态对**最终显示行**施加预算：头部 + 尾部 + 提示行合计 ≤ 8 物理行，在任意列宽（40 / 70 / 110 / 140）与任意行长（含单行 5000 字符、含空格与不含空格、CJK 与 emoji）下成立；尾部从最后一行的**末尾**往前取显示行，被截断的行以 `…` 开头标明；失败诊断（退出码 / 首行 Exit code）始终保留一行。
2. 单测：把复核的探针参数化进 `render.test.ts`（长行 × 列宽矩阵），断言物理行数 ≤ 8 且尾部内容正确；keep=0 路径必须被覆盖。
3. `bun test apps/agent-tui/src` 在当前环境与 `env -u NO_COLOR` 下全绿；真机（显式 `--model sonnet`）跑一条输出长行的命令（如 `python3 -c "print('word '*2000)"`）截折叠帧。
产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`（含复核条件 → 证据）。提交到本分支。
