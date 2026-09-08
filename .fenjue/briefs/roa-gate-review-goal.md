复核只读门修复 fj-as-readonly-gate-fix-bcd4（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-gate-fix-bcd4/out/{diagnosis,result}.md`；坐席自报 partial，先读它自己列的未完成项并逐条核实）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。

必做：
1. 原样重打三审 Run 1–3（三审报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-allow-review3-8b89/out/review.md` §Run 1–3；/tmp/ro3.* 脚本不在就按其描述重写）：真机 readonly / plan / default 三线程各一次，显式 `--model sonnet` 且断言 init 帧 model。readonly 线程：`ls` 免审放行且 approvals 有 auto_allow 行；`touch <mktemp>/x` 产生 pendingRequests=1 且文件不存在；Edit 被拒绝并留痕。plan 线程按修复单最终方案断言（写命令绝不能无审批落地）。default 线程对照。
2. 新发现的独立 P0：standalone bash turn（`!` shell 模式的 bash 输入类型）在所有权限模式下绕过 can_use_tool——核实 sendTurn 的 gateStandaloneBash 对 readonly / plan / default / acceptEdits / bypass 全覆盖且 fail-closed，真机在 readonly 线程发一次 bash turn `touch`，断言不落地且有审批或拒绝留痕。
3. argv：五种模式的 argv 单测断言与 daemon 实际起的进程一致（`ps` 抓一次），特别是 `--disallowedTools` 与 `--settings permissions.ask` 是否真的到达进程。
4. 抽核 P2-1 / P2-3 / P2-4 / P2-5 修复与 P2-2 文档；确认 packages/agent-server 全量测试绿、无回归。

评级：P0（可无审批写）/ P1（fail-closed 破缺或审计缺失）/ P2。结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
