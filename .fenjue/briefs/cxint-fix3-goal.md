目标：Codex 线程 `turn/interrupt` 之后，命令子进程（含被 codex 杀掉 zsh 后重挂到 PID 1 的孙进程，例如 `sleep 600`）在 10 秒内必须死亡；`thread/close` 与 daemon 退出时同样不得留下该线程产生的进程。硬验收是一段真实引擎的隔离 daemon 复现脚本，过不了就不放行。

## 已核实的事实（来自独立复核 fj-cxint-review-f43c，报告与证据在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cxint-review-f43c/out/）

- codex app-server 0.153.4 的 exec 是 `/bin/zsh -lc '<cmd>'`；interrupt 时 codex 只杀直接子进程 zsh，孙进程 `sleep` 被重挂到 PID 1 继续跑满；`turn/interrupt` ack、`turn/completed(interrupted)`、`thread/close`、daemon SIGTERM/SIGKILL 之后它都还活着（3/3 复现，PPID=1）。AS 自己不 spawn 这个 exec，所以靠 mapper 改动修不掉。
- 分支上现有两个提交（562b1a7、e203dae）的 `interruptIncomplete()` 记账是无效的：main 的 `TurnQueue.complete → ItemLog.finishOpenItems`（`src/core/turn-queue.ts:90`、`src/core/item-log.ts:225`）在 ack 后 2ms 内已经补发同样的 `item/completed(failed)`；且它引入了窄窗口回归（ack 之后迟到的 delta 会让 mapper 抛 `Invalid Codex item delta` → `fail()` → SIGKILL codex，见复核 P1-2）和重复 completed（P2-1）。**先撤掉这两个提交的 mapper/engine 改动**（`git revert` 或重写历史都可以，最终 diff 里不应再有 `interruptIncomplete`），e203dae 的 7 行测试也一并处理。
- 复现脚本：`/Users/smokingmouse/python/learning/trellis/.fenjue/briefs/cxint-harness/run.sh <场景> <worktree根>`——在隔离 XDG_STATE_HOME / socket / DB 下用 `<worktree根>/packages/agent-server/bin/agent-server` 起 daemon，真实 codex 线程（模型 gpt-6-astra，`PROBE_MODEL` 可覆盖）跑场景，最后打印 `verdict=clean|leak:…`，只有 interrupt 后 10 秒与 close 后 `pgrep -fl "sleep 600"` 都为空才 exit 0。场景 A 是主判据；C（一轮两条命令）、D（interrupt 后立刻新一轮）也要过。脚本跑前需要 `bun run typecheck`（= tsc --build，会产出 dist）。它从不连常驻 daemon。

## 要求

1. 在 daemon 的 codex 引擎（`packages/agent-server/src/engines/codex.ts` 及其进程管理）里实现进程收割：
   - **interrupt 路径**：在向 codex 发送 `turn/interrupt` **之前**快照 codex 子进程的全部后代 pid（进程树遍历，例如 `ps -axo pid=,ppid=` 递归；macOS 与 Linux 都要能跑），ack 与 `turn/completed` 之后对仍存活、且不是 codex 进程本身的后代先 SIGTERM，宽限（≤2 秒）后 SIGKILL；也要覆盖 `turn/cancel`/freeze 兜底路径。孙进程重挂到 PID 1 后进程树上已经找不到它，所以快照必须发生在 interrupt 之前。
   - **close / 引擎退出路径**：给 codex 子进程 `detached: true` 自成进程组（或等价手段），`thread/close`、引擎死亡、daemon 关停时 `process.kill(-pgid, …)` 连坐清掉同组进程；确认这不影响 daemon 自身与其它线程。
   - 写清你选的机制与为什么；不要把 `sleep`/`pgrep` 字面量写进产品代码。
2. 单测（必须出现在 diff 里，且回退核心改动会变红）：用 `src/engines/codex.test.ts` 现成的 fake codex fixture（`spawnProcess` 注入）或新 fixture，覆盖「interrupt 前快照到的后代在 ack 后被收割」「close 时进程组被清」；再加一条复核建议 3 的回归：interrupt ack 后紧跟一帧 outputDelta，线程不死。
3. 真实引擎证据：`bash …/cxint-harness/run.sh A <worktree>` 修前一次（应 `leak`）、修后 A / C / D 各一次（应 `clean`），把每次的 `BASE=` 目录里的 `events.jsonl` 复制到 `out/evidence/` 并在 `out/interrupt-proof.md` 里列出命令、exit、verdict 行。
4. `bun run typecheck` 与 `packages/agent-server` 下 `bun test` 全绿；提交到当前分支 `fix/codex-interrupt-exec`，工作树干净。不 push、不 PR、不部署、不重启常驻 daemon、不碰常驻 daemon（`~/.sm-toolkit/agent-server.sock`）上的任何线程；自己起的隔离 daemon 与 codex 进程结束后全部关掉，收尾时 `pgrep -fx "sleep 600"` 为空。
5. `out/result.md`：根因一句话、机制与取舍、改动清单（含测试文件）、每条命令与 exit、证据路径、对复核报告 P0-1 / P0-2 / P1-1 / P1-2 / P2-1 / P2-2 的逐条处置、未覆盖项（若有，写清为什么）。
