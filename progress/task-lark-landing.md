# 定时任务飞书落点

## 目标

任务可绑定一个飞书机器人及其见过的 chat。绑定后，每次 run 在该 chat 对应的
`kind='lark'` 会话中新建一棵独立树，并把结算结果发到该 chat；后续话题或引用继续沿
S134 IM 入口层落回这棵树。

## 数据模型

- `tasks.lark_bot_id TEXT`、`tasks.lark_chat_id TEXT`，加法迁移、均可空。
- 两列同时非空才算绑定；创建/更新必须同时给或同时清空。
- chat 必须存在于该 bot 的 `lark_chats`，否则 API 返回 400。
- 继续复用 `lark_chats`、`lark_threads`、`lark_outbox`，不新增表。

## 落点规则

- 无绑定：原 `home_session_id`、`kind='task'` 行为不变。
- 有绑定：复用入站 handler 同一个 `createRootInLarkChat`，在 chat 会话创建平行根。
- chat 尚无有效 session 时创建 `kind='lark'` 会话并回写 `lark_chats.session_id`。
- bot 不存在/被停用或 chat 已消失：本次退回 home 会话，只写 `[lark]` 日志。
- 一次 run 恒为一棵新树；群 `sessionPolicy=chat` 的既有链尾不因任务根而改变。

## Agent 规则

- 任务根仍走任务的 `resolveEnabledAgent` / `resolveAgentSpawn`，并记录任务 agent。
- `setNodeAgent(nodeId, agentId, "session")` 只更新 `nodes.agent_id/agent_scope`，不会改
  `sessions.agent_id`，因此不会污染同一飞书会话里的其它树。
- 话题追问仍走 bot 默认 agent 或消息里的 `@slug`，不继承任务 agent。

## 推送规则

- 成功：无论 `notify_on`，发送节点 `response`。
- 失败/超时：`notify_on=error|always` 时发送
  `任务 <name> 失败：<error_message 前 200 字>`；`never` 不发。
- 群聊使用 `plain` 顶层消息，使推送可成为话题根；任务没有入站锚点，私聊也用
  chat_id create，成功后推进 p2p 链尾。
- 出站 helper 直接用 bot 的 app_id/app_secret 创建 client，不依赖 WS manager。
- 发送成功后登记 `lark_outbox(message_id → node_id)`；发送/登记失败只写日志，不影响
  run 留档与既有 notify，不另建 outbox 重试队列。
- 正文超过 4000 字符时截断，并在尾部附 `/?session=…&node=…` 画布深链。
- `TRELLIS_LARK=off` 只写 `[lark] dry-run push`，不建 client、不发送、不登记 outbox。

## 话题与引用

- 新话题首条入站若 `thread_id` 尚未登记且 `root_id` 命中本 bot/chat 的 outbox，沿
  outbox 节点父链找到树根，回填 `lark_threads`，再走现有 policy。
- 话题内平铺追问无需 @，接 `lark_threads.last_node_id`。
- 引用推送消息通过 outbox 映射在该节点下分支；具体引用优先于话题叶子。
- 非引用群消息仍完全遵循 bot 的 `groupTrigger/sessionPolicy`。

## API 与 UI

- `POST /api/tasks`、`PATCH /api/tasks/:id` 接受 `larkBotId/larkChatId`。
- 任务列表与详情返回两字段。
- `GET /api/lark-bots/:id/chats` 只读返回该 bot 见过的 chats。
- 任务表单的「飞书落点」只列已启用 bot × 已见 chat，默认「不落飞书」。

## 不做

- 不实现飞书消息触发任务，`task_triggers.kind='lark'` 保持空壳。
- 不做每群 agent 覆盖，不新增 agent 继承语义。
- 不做卡片或流式飞书回复。
- 不让 trellisctl 与 `skills/trellis-admin` 学新字段。

## 验收清单

- [ ] 类型检查、单元测试、飞书脚本（断言数 >55）全绿。
- [ ] production build 与旧库副本迁移通过。
- [ ] 隔离实例 API 建绑定任务并手动运行，根节点落到 chat session。
- [ ] 隔离库核对 `nodes.agent_id` 与 `task_runs`；日志出现 dry-run 且无 outbox。
- [ ] 改动已提交到 `feat/task-lark-landing`，工作树干净。
