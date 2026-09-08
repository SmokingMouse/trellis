复核只读门二次返工 fj-as-readonly-gate-fix2-25bd（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-gate-fix2-25bd/out/result.md`，先读）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。四审报告在 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-gate-review-36dd/out/review.md`。

必做（全部真机，显式 `--model sonnet`，断言 init 帧 model）：
1. 原样重打四审 T1–T3 与「三、五模式独立 bash turn」矩阵：readonly（`readonly_auto_allow` 开 / 关各一次）、plan、default、acceptEdits、bypassPermissions、dontAsk 的独立 bash turn `touch <mktemp>/x`——readonly/plan/default/acceptEdits 必须文件不落地且 pendingRequests=1（名单外）或 auto_allow 留痕（名单内）；bypass/dontAsk 允许落地但必须有审计行。
2. P1-1：readonly 线程 Edit 的审计行真机可查到（approvals 表或 engineEvent 持久化），并核对文档写明的两层语义与实际一致。
3. 门与开关解耦的回归测试存在且真的会红（把解耦改回去应失败）。
4. 抽核：五模式 argv 单测与 `ps` 抓到的真进程一致；packages/agent-server 全量测试绿；无回归。

评级 P0 / P1 / P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
