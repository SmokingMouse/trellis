目标：agent-server 的 Codex 引擎在 `turn/interrupt` 之后不再留下活着的命令子进程：正在跑的 commandExecution 被真正终止、对应 item 收到 `item/completed`（失败/中断语义，不伪造 exit code）、线程收敛到 idle，之后 `thread/close` 不再报 busy。

## 事实（已核实）

- 证据：2026-09-08 任务 fj-ingress-fresh-start-01bb 的迟到信件（trellis 仓 `.fenjue/archive/fj-ingress-fresh-start-01bb/mail-late-resend.ndjson` 末条）与其 `out/proof/`：真实 Codex 线程 `turn/interrupt` 有 request + ack、turn 终态 interrupted，但正在跑的 commandExecution 没有 item/completed，且 unifiedExec 会话里的 `sleep 600`（当时 PID 11163）10 秒后仍活。
- 引擎代码在 `packages/agent-server/src/engines/codex.ts`（映射在 `codex-mapper.ts`）；每个 AS thread 一个 `codex app-server --listen stdio://` 子进程；协议基线 codex-cli 0.153.4，schema 钉在 `docs/agent-server/codex-schema/0.153.4/`，版本号读 `docs/agent-server/codex-schema-version.txt`。
- 隔离起 daemon 的现成办法：`packages/agent-server/scripts/codex-remote-smoke.py`（隔离 HOME/DB/socket）与 `scripts/codex-ingress-upgrade-check.sh`；后者的 interrupt 判据在真实引擎上不稳定（backlog `codex-ingress-upgrade-check-interrupt-flaky`），本单不修脚本，只借它的隔离起法。
- 相邻 bug `agent-server-busy-after-engine-death`（interrupt 后线程仍 running、引擎死后 close 报 busy）：若根因与本单相同就一起修并写明；不同则只在 out/result.md 记录观察，不扩 scope。

## 要求

1. 先复现，写修前基线：隔离 HOME/DB/socket 起 daemon，真实 codex 线程（显式 model，full 权限），提示「在前台执行 `sleep 600` 并等它结束」，等 commandExecution item 进入 inProgress 且持续 ≥3 秒后发 `turn/interrupt`。记录 interrupt 的 request/ack 帧、turn 终态、该 item 有没有 completed、`sleep` 进程是否存活（`pgrep -f 'sleep 600'`，10 秒后再看一次）。
2. 查 codex app-server 0.153.4 在 `turn/interrupt` 后对 unified exec 会话的语义（钉住的 schema、协议文档、实际帧）。按结论在 daemon 的 codex 引擎里修：interrupt 时显式结束该 turn 的 exec 会话（或终止进程组），为未完成的 commandExecution item 补发 `item/completed`（状态与 AS 协议一致），activeTurn 清理，线程回 idle，随后 `thread/close` 成功。
3. 单测：用 mock/fixture 引擎覆盖「interrupt 时 inProgress 的 commandExecution 收到 completed」与「interrupt 后 thread/close 成功」；真实引擎用第 1 步同一流程做修后证据（10 秒内进程死亡、item completed、close 成功）。
4. `bun run typecheck` 与 `packages/agent-server` 下 `bun test` 全绿；提交到当前 worktree 分支 `fix/codex-interrupt-exec`，工作树干净。不 push、不 PR、不部署、不重启常驻 daemon、不碰常驻 daemon（`~/.sm-toolkit/agent-server.sock`）上的任何线程；自己起的隔离 daemon 与 codex 进程结束后全部关掉，`pgrep -f 'sleep 600'` 为空。
5. `out/result.md`：根因一句话、改动清单、每条命令与 exit、修前/修后证据（关键帧 + pgrep 输出）、未覆盖项。
