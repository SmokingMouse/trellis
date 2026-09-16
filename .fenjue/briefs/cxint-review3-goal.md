目标：独立复核 `fix/codex-interrupt-exec` 第三轮交付（实现坐席 Opus，报告在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cxint-fix3-3d62/out/，上一轮 Opus 复核报告与证据在 …/.fenjue/archive/fj-cxint-review-f43c/out/）：Codex 线程 interrupt 后命令子进程（含重挂到 PID 1 的孙进程）是否真的被收割，close / 引擎退出是否连坐清理，且不伤 daemon 自身与其它线程。你的 workdir 是该分支 tip 的私有副本（detached）；原实现 worktree 在 /Users/smokingmouse/.herdr/worktrees/sm-toolkit/fix-codex-interrupt-exec，不要碰它。

## 约束（用户 2026-09-16 裁决）

本轮不使用任何 GPT / codex 模型：cpa 网关 codex 号池无账号，`cxint-harness/run.sh` 这类要起真实 codex 线程的脚本跑不了，**不要尝试**，也不要为此发 blocker。判据改为：fake 进程树集成测试 + 代码审读 + 回退验证。

## 怎么审

1. 列改动面：`git log main..HEAD`、`git diff main...HEAD --stat`；核对 `interruptIncomplete` 已撤（`git grep interruptIncomplete HEAD -- packages/agent-server/src` 应为空），未改协议 item 类型集合、治理、只读名单。
2. 审 `packages/agent-server/src/engines/codex-interrupt-reap.test.ts` 是否「真」：fake app-server 是否真实 spawn 了一棵进程树、是否故意只杀直接子进程、断言是否真的查了孙进程存活（用 pid 而不是字符串）、close 后是否再查；把核心改动临时回退（在你自己的副本里 `git stash` / `git revert`，跑完还原）跑一次，该测试必须变红；`bun run typecheck` 与 `packages/agent-server` 下 `bun test` 全绿。
3. 审收割机制本身（读 `src/engines/codex.ts` 及相关）：
   - 快照时机是否在发 `turn/interrupt` 之前；后代遍历在 macOS 与 Linux 上是否都能跑（`ps` 参数）；快照到 kill 之间的竞态（进程已退出、pid 复用）是否安全（不会误杀无关进程）；SIGTERM→SIGKILL 宽限与超时；
   - `detached` / 进程组处理：`process.kill(-pgid)` 是否只影响该线程的 codex 进程组，会不会波及 daemon 自身、其它线程或调用方；引擎死亡 / daemon 关停路径是否也清理；
   - 与 `TurnQueue.complete → finishOpenItems` 的关系：有没有重复 completed、有没有把 turn 状态弄乱；上一轮 P1-2（ack 后迟到 delta 打死线程）在撤掉 interruptIncomplete 后是否自然消失，或是否被新逻辑重新引入。
4. 反例（用 fake fixture 或单测，不用真实 codex）：interrupt 时命令刚 spawn 尚无后代；一轮两条命令；interrupt 后立刻 turn/start；连续两次 interrupt；close 时无活跃 turn。各自是否留进程、是否报错、是否重复事件。
5. 逐条核对实现单 result.md 对上一轮 P0-1 / P0-2 / P1-1 / P1-2 / P2-1 / P2-2 的处置是否属实。
6. 结束后不留任何自己起的进程（`pgrep -fl sleep`、隔离 daemon），不碰常驻 daemon，不改被审 worktree。

## 产出

`out/review.md`，首行必须是 `verdict: pass` 或 `verdict: fail`（fail 只用于：结论/行为错、证据伪造或不可复现到影响结论、凭证泄露、破坏现有测试）。随后按 P0/P1/P2 列发现，每条带复现命令与输出；`## 建议` 段放不影响结论的意见；开头注明「本次复核与实现同为 Anthropic 模型（Opus 实现 / Sonnet 复核），同源、强度受限」。
