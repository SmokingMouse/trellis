目标：独立复核 `fix/codex-interrupt-exec` 分支（worktree 见 audit-target）：Codex 线程 `turn/interrupt` 后命令子进程是否真的被终止、commandExecution item 是否收到 completed、线程能否 close；判定实现单的证据是否真实可复现。

## 怎么审

1. 读 `out/result.md` 与 diff（`git log main..HEAD`、`git diff main...HEAD`），列出改动面；核对改动只在 codex 引擎 / thread 生命周期，没有顺手改协议 item 类型集合或放宽治理。
2. 用实现单同样的隔离流程自己复跑一次（隔离 HOME/DB/socket，真实 codex 线程，前台 `sleep 600`，item inProgress ≥3 秒后 interrupt）：`pgrep -f 'sleep 600'` 10 秒后必须为空、item 有 completed、`thread/close` 成功。结果与实现单报告不一致即 fail。
3. 反例：interrupt 发生在命令刚 spawn 尚未有 item/started 时；一轮里两个连续命令；interrupt 后立刻 turn/start 新一轮——各跑一次，看是否留进程、是否卡 busy、是否有重复 completed。
4. 跑 `bun run typecheck` 与 `packages/agent-server` 下 `bun test`；检查新单测是否真的会因回退修复而变红（临时 `git stash` 或 revert 核心改动跑一次，跑完还原）。
5. 结束后关掉自己起的隔离 daemon 与 codex 进程，不碰常驻 daemon 上任何线程；不改被审 worktree 里的任何文件。

## 产出

`out/review.md`，首行必须是 `verdict: pass` 或 `verdict: fail`（fail 只用于：结论/行为错、证据伪造或不可复现到影响结论、凭证泄露、破坏现有测试）。随后按 P0/P1/P2 列发现，每条带复现命令与输出；`## 建议` 段放不影响结论的意见。
