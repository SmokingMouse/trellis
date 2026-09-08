# S152 · 2026-09-08 07:30–08:30 · 阶段 1 累计 7 过 7；Trellis 第二步跟进两轮；异源复核持续挖出 P1

## 阶段 1（agent-tui runner，Codex）计数

| # | 单 | 起位 | 验收 | 复核 |
|---|---|---|---|---|
| 1 | as-polish2 | 2 次（首次配置缺失） | 通过 | — |
| 2 | as-pending-notify | 1 | 通过 | 通过（P2×4 → #5） |
| 3 | as-midfork | 1 | 通过 | 同上 |
| 4 | trellis-step2b（删轮询 99 KB/s → 0，走 midfork） | 1 | 通过 | 需返工：vendor 落后 → #7 |
| 5 | as-polish3（notify/fork P2×4） | 1 | 通过 | — |
| 6 | tui-fork-notify-ui | 1 | 通过 | 需返工：P1 卡片占屏 Enter 盲发 fork → #9 |
| 7 | trellis-step2c（re-vendor 236650b；修影子 E2E 高度收缩误判） | 1 | 通过（D5 改为祖先检查后 settle） | 复核在跑 |
| 8 | tui-engine-cmds（! shell、/diff /context /usage /mcp /rewind） | 1 | 通过 | 复核在跑 |
| 9 | tui-fn-fix | 1 | 在跑 | — |

- 累计起位 9 次成功 9 次（不含首次配置缺失）；验收 8 过 8（#9 在跑）；零 AS 丢消息、零审批卡死。阶段 1 目标 10 单接近。
- 验收侧教训：并行跑手机脚本的单，settle 的 D4 可能与坐席自己的脚本抢锁（两次），要求坐席独占复跑后再交；verify 里「必须等于上游 HEAD」是移动靶（上游有并行单在提交），改成「≥ 指定基线且为 HEAD 祖先」。

## Trellis 第二步线

- step2 → review（P0 重试丢答案、P1 非末端 503、P1 硬关闸失效）→ fix → review2 通过 → step2b（删轮询、走 midfork）→ review 需返工（vendor 落后）→ step2c → review 在跑。分支 feat/agent-server-step2。
- 合并仍等用户；它依赖 sm-toolkit feat/agent-server 的 vendor 与影子分支（feat/agent-server-client）。

## Next

- #9 验收 → tui-fn-review2（复用 smtk-tui-fn-review）；tui-cmds-review 结论 → 返工或收口；step2c review 结论。
- 阶段 1 满 10 单后：写阶段 1 结论（对照方案 §7 退出标准），进入阶段 2（Claude 坐席显式 sonnet）。
- 集成：feat/tui-engine-cmds 合回 feat/agent-server（小）。
- 用户待决：Herdr 桥合并上线、影子模式与第二步合并、agent-server 合 main 与发包、daemon 常驻。
