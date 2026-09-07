# agent-server 第二步跟进

- vendor 更新至 sm-toolkit `12daba705eeb543b1c984c64d361efd7dedcc58d`；读写客户端声明 pendingRequests，按服务端 midThreadFork 能力判断原生边界分叉。
- 删除影子/project 的 2 秒 attach 定时器；审批元状态订阅 `thread/pendingRequests`，初始化/重连仍用快照，project 重连幂等查询终态。子代理状态与 catchup 去重。
- 200 KB 无新增内容 10.1 秒实测：project SSE 从 1,000,580 B 降至 0 B；shadow SSE 均为 0 B；attach 从 10 次降至 0 次。证据：`scripts/mobile-verify/as-project-regression.ts` 的 `idle SSE` 用例。
- 原生分叉按 `as_turns.last_item_id` 截断，缺少 `midThreadFork` 才播种；移动验收改成早期续聊/显式 fork 均 200，逐项比对 daemon 历史前缀，并跑不声明能力的 mock 回退用例。README/.env.example 同步。
- 验证：`bunx tsc --noEmit` 通过，`bun test` 128 pass / 0 fail；通知、断线终态恢复、原生分叉与无能力回退均已覆盖。Next：移动验收与干净 clone 装建。
