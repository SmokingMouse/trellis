# agent-server 第二步跟进

- vendor 更新至 sm-toolkit `12daba705eeb543b1c984c64d361efd7dedcc58d`；读写客户端声明 pendingRequests，按服务端 midThreadFork 能力判断原生边界分叉。
- 删除影子/project 的 2 秒 attach 定时器；审批元状态订阅 `thread/pendingRequests`，初始化/重连仍用快照，project 重连幂等查询终态。子代理状态与 catchup 去重。
- 200 KB 无新增内容 10.1 秒实测：project SSE 从 1,000,580 B 降至 0 B；shadow SSE 均为 0 B；attach 从 10 次降至 0 次。证据：`scripts/mobile-verify/as-project-regression.ts` 的 `idle SSE` 用例。
- 验证：通知相关 19 项测试通过；断线完成恢复用例通过。Next：验证历史边界分叉。
