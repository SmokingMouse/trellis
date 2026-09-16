目标：把上一单（fj-cxint-fix-5e70，commit 562b1a7「complete codex items on interrupt」）没做完的部分补齐——Codex 线程 `turn/interrupt` 后**命令子进程必须真的死掉**，并交出真实引擎的修前/修后证据与单测。上一单只补了 item/completed 的记账（mapper `interruptIncomplete()`），自己承认「未能在时限内完成隔离 daemon 实测」，diff 里也没有任何测试文件。

## 已知事实

- 原始证据：trellis 仓 `.fenjue/archive/fj-ingress-fresh-start-01bb/mail-late-resend.ndjson` 末条 + `out/proof/`：真实 Codex 线程 interrupt 有 ack、turn 终态 interrupted，但 unifiedExec 会话里的 `sleep 600` 10 秒后仍活。
- 上一单报告：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cxint-fix-5e70/out/result.md`；改动在 `packages/agent-server/src/engines/codex-mapper.ts`（+7）与 `codex.ts`（+1），当前 worktree HEAD 就是它，在其上继续。
- 一个独立复核坐席正并行审 562b1a7，报告会出现在 `/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-cxint-review-f43c/out/review.md`（或同名 archive/ 路径）；收尾前看一眼，若有 P0/P1 与本单相关就一并处理并在 result 里逐条回应。
- 隔离起 daemon 的现成办法：`packages/agent-server/scripts/codex-remote-smoke.py`（隔离 HOME/DB/socket，看它怎么起 daemon 与真实 codex 线程）；`scripts/codex-ingress-upgrade-check.sh` 的隔离起法也可借。协议基线 codex-cli 0.153.4，schema 在 `docs/agent-server/codex-schema/0.153.4/`。

## 要求（缺一条都算未完成）

1. **修前基线（真实引擎）**：隔离 HOME/DB/socket 起 daemon，真实 codex 线程（显式 model，full 权限），提示「在前台执行 `sleep 600` 并等它结束，不要放后台」，等 commandExecution item inProgress ≥3 秒后 `turn/interrupt`；记录 request/ack 帧、turn 终态、item 是否 completed、`pgrep -fx "sleep 600"` 立刻与 10 秒后的输出。写进 `out/interrupt-proof.md`。
2. **查清 codex app-server 0.153.4 对 interrupt 的语义**（读钉住的 schema/协议文档 + 观察实际帧：interrupt 后原生是否发 `item/completed` / 是否终止 exec 会话 / exec 会话是否按设计保留）。据此修 daemon 的 codex 引擎：interrupt 时显式结束该 turn 的 exec 会话（若原生有对应方法就调它；没有就终止命令进程组——找出子进程的可靠办法，比如 codex 子进程的进程组 / `commandExecution` item 里的 pid / 通过 pgrep 父子关系，写明选了哪种及为什么），未完成的 commandExecution item 收到 completed，线程回 idle，随后 `thread/close` 成功。上一单的 mapper 记账若仍合理就保留。
3. **单测**（新文件或现有 `codex.test.ts` 里的新用例，必须出现在 diff 里）：interrupt 时 inProgress 的 commandExecution 收到 completed；interrupt 后 activeTurn 清理、close 成功；若加了杀进程逻辑，用 mock/fixture 覆盖「interrupt 触发终止」。要能证明回退核心改动会红。
4. **修后证据（真实引擎）**：第 1 步同流程再跑一次，`sleep 600` 10 秒内死亡、item completed、close 成功，写进同一份 `out/interrupt-proof.md`（修前 / 修后两节，含命令与 exit）。
5. `bun run typecheck` 与 `packages/agent-server` 下 `bun test` 全绿；提交到当前分支 `fix/codex-interrupt-exec`，工作树干净。不 push、不 PR、不部署、不重启常驻 daemon、不碰常驻 daemon（`~/.sm-toolkit/agent-server.sock`）上的任何线程；自己起的隔离 daemon 与 codex 进程结束后全部关掉，收尾时 `pgrep -fx "sleep 600"` 为空。
6. `out/result.md`：根因一句话、改动清单（含测试文件名）、每条命令与 exit、证据文件路径、对复核报告 P0/P1 的逐条回应（若已出）、未覆盖项（若仍有，写清为什么）。
