# 最近链状态

## 链状态语义

链仍由叶子 `tipId` 标识，最终状态取下表最高优先级：

| 状态 | 实时（整链 `nodeIds`） | 基线（只看链尾） |
|---|---|---|
| `waiting` | 任一节点在 waiting 集合 | 链尾有待交互数据 |
| `streaming` | 任一节点在 running 集合 | 链尾 `status='streaming'` |
| `error` | 不判定 | 链尾 `status='error'` |
| `unread` | 不判定 | 链尾 done 且 `read_at` 为空 |
| `done` | 无实时节点 | 其余链尾状态 |

优先级为 waiting > streaming > error > unread > done。中段节点只传播实时态；
中段 error / unread 不污染已完成且已读的链尾。

## 实时数据流

1. run-bus 的 `getActiveRuns()` 暴露 node id 及是否正在等输入。
2. `/api/runs` 保留兼容的 `runningSessionIds`，并下发带 `sessionId` 的 `runningNodes` / `waitingNodes`。
3. `useRunPolling` 在页面可见时每 1.5 秒拉取；隐藏时暂停，重新可见立即拉一次。
4. store 保留 `runningSessionIds` 原语义，另存 `runningNodeIds` / `waitingNodeIds`。
5. `ChainRow` 用链的 `nodeIds` 与两个实时集合求交；node 状态 key 变化也会重拉 `/api/recent`，覆盖同会话链 A 结束、链 B 紧接着运行的情况。

## 会话聚合

- 「最近」会话行取链聚合与 session 级 running / unread 位图的最高优先级。
- running 位图还合并当前会话本地 `activeRunning`，保证新 run 未轮询到或链未下发时不比旧行为更暗。
- 聚合使用 `lib/recent.ts` 的纯函数，与链行共用同一优先级。
- 其他侧栏分组继续使用原来的 session 级 running / unread 语义。

## 可见性

- 只按实时态提升：waiting=2、streaming=1、其余=0；error / unread 不参与排序。
- 没有活跃 run 时严格保持原活动时间顺序。
- 服务端在每会话最多 8 条的截断前提升，客户端在默认露出的 3 条前再次按最新轮询态提升。
- 已下发的活跃链会进入可见区，不落进「还有 N 条链」；session 位图仍为未下发链兜底。

## 不做

- 不改「最近」的会话数、每会话链数、标签、相对时间、分组与点击落链尾行为。
- 不改「最近」以外的侧栏分组，也不改变 `runningSessionIds` 的既有消费语义。
