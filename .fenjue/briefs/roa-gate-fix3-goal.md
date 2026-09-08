目标：修五审唯一阻塞项 P1-1 并顺手收 P2-1 / P2-2（复核报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-gate-review2-ea71/out/review.md`）。上一轮 1ec942f 的门与解耦全部经得起证伪，不要动。

leader 裁决：审计必须持久化，不放宽口径——「只读线程写工具被整体禁用」这一事实要在 daemon 侧持久可查：spawn 时落一行 `approvals`（kind=`readonly_tools_disabled`，含 threadId、禁用的工具列表、时间），并让 `thread/attach` 之后的客户端能通过既有查询路径看到（复用 `readonly_auto_allow` / `readonly_denied` 的持久化模式，不新建表）。同一模式下把 P2-1 收掉：bypassPermissions / dontAsk 的 `permission_auto_response` 同样落 approvals 行。P2-2：修正 protocol.md:270 的过期描述。

测试：单测断言 spawn 后 approvals 表有 `readonly_tools_disabled` 行、bypass/dontAsk 自动放行有行；真机一次（显式 `--model sonnet`，断言 init 帧 model）：起 readonly 线程 → 另起客户端 attach → 查到该行；bypass 线程跑一条 `ls` → 查到 auto_response 行。证据写进 out/result.md。全量 `bun test` 绿。提交到本分支。产物目录 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/`。
