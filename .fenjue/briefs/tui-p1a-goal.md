目标：阶段 1a「基线 + 帧探针」（方案 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-adoption-plan-7755/out/tui-adoption-plan.md` 的「### 阶段 1」表 1a 行与「1a 验收门」行，先读）。分支 feat/tui-bench（基于 feat/agent-server），worktree 无 node_modules，先 `bun install`。
输入：开源评估单的基准夹具 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-oss-tui-eval-f8c0/out/`（bench.ts、run-bench.py、manifest.ts、probes.ts、reproduce.sh、各 *.summary.json）与其报告 §3.1 口径；自审报告 §4.1 的现有渲染器数字（`.fenjue/archive/fj-tui-self-audit2-41fc/out/agent-tui-audit.md`，路径前缀同上）。
交付：
① 把夹具收编为 `apps/agent-tui/bench/`（run.ts 入口），口径原样保留：PTY OSC marker 逐帧分段、不关 OPOST、每趟 2000 样本 / 2001 marker、CPU 取子进程 process.cpuUsage()、RSS 逐帧采样峰值。三条固定负载：10000 条历史单帧；流式 token 2000 帧；宽字符/ZWJ（a/中/🙂/文/x/👩‍💻/空格/b 循环）。`--emit baseline.json` 输出含 samples/markers/p50/p95/bytes/cpu/rss。本单只测现有 renderer（--host legacy），OpenTUI host 的接线留给 1c，但 CLI 参数面（--host、--load、--against）现在就定好。
② 给现有 renderer 加分段计时：layout / wrap / diff / write + wrap 调用数 + item 数 + 字节数，`AGENT_TUI_FRAME_LOG=<path>` 开关（默认关，JSONL 一帧一行），分段枚举里为 reactCommit 预留独立一段。命名主动避让：用 FramePhaseSample，不用 FrameEvent。
③ 1a 验收门：基线复现量级——现有 renderer 完整历史 p50 落在 25–70 ms、10000×216 字符单帧 render 落在 150–165 ms；落不进区间先修夹具，把原因写进 out/result.md。
约束：不改渲染行为（174 个测试原样绿、4 个快照不变）；bench 与探针不进生产路径的默认开销。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md` + baseline.json 副本。提交到本分支。
