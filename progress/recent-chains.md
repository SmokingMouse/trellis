# 最近链状态

## 链状态语义

- 链仍由叶子 `tipId` 标识，状态判定范围是根到叶子的完整 `nodeIds`。
- 优先级固定为：等输入 `waiting` > 生成中 `streaming` > 出错 `error` > 未读 `unread` > 无 `done`。
- `waiting` / `streaming` 以 run-bus 内存态为实时真源；数据库只提供整条链的 `error` / `unread` / `done` 基线。
- 中段节点重跑时，所有包含该节点的 lineage 都显示实时状态，不要求运行节点是链尾。

## 实时数据流

1. run-bus 的 `getActiveRuns()` 暴露 node id 及是否正在等输入。
2. `/api/runs` 保留兼容的 `runningSessionIds`，并下发带 `sessionId` 的 `runningNodes` / `waitingNodes`。
3. `useRunPolling` 每 1.5 秒持续拉取，不以窗口焦点或页面可见性为开关。
4. store 保留 `runningSessionIds` 原语义，另存 `runningNodeIds` / `waitingNodeIds`。
5. `ChainRow` 用链的 `nodeIds` 与两个实时集合求交；node 状态 key 变化也会重拉 `/api/recent`，覆盖同会话链 A 结束、链 B 紧接着运行的情况。

## 会话聚合

- 「最近」里的会话行不直接读取 session 级 running 位图。
- 会话行对该会话的链状态取最高优先级，使用 `lib/recent.ts` 的纯函数，与链行共用同一判定。
- 其他侧栏分组继续使用原来的 session 级 running / unread 语义。

## 可见性

- 同一会话内按状态优先级提升链；同状态保持原活动时间顺序。
- 服务端在每会话最多 8 条的截断前提升，客户端在默认露出的 3 条前再次按最新轮询态提升。
- 因而会话行有状态时，下面至少有一条可见链行显示相同状态；活动中的旧链不会落进「还有 N 条链」。

## 不做

- 不改「最近」的会话数、每会话链数、标签、相对时间、分组与点击落链尾行为。
- 不改「最近」以外的侧栏分组，也不改变 `runningSessionIds` 的既有消费语义。
