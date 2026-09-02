# IM 入口层：im → agent → session（S134 定稿，飞书为首个实现）

## 一句话

机器人是 IM 入口，不是一个功能孤岛。任何 IM 进来的消息都走同一条链：**IM 层归一化 → agent 层决定谁答 → session 层决定落在画布哪里**。飞书是第一个 IM，配置项是 IM 无关的策略，飞书只提供实现。

## 为什么现在做（B1 / B2）

- B1（已关，S134）：入站链路在 prod 跑通——私聊「你好」6.7s 回包。此前失败根因是 Turbopack 内联真 `ws` 绕过 Bun 原生替换，与开放平台配置无关。
- B2：群里 @ 之后「交互存在于哪、和画布既有上下文什么关系」说不清。根因是 `lark_bots` 一行把三层揉在一起，且 session 策略写死为「一个 chat 一条线性链」。

## 三层各管什么

| 层 | 只回答 | 飞书实现 | 代码位置 |
|---|---|---|---|
| IM | 谁、在哪个 chat、哪个话题、引用了哪条、@ 了谁、说了什么；怎么把回复发回去 | `im.message.receive_v1` 事件（含 `thread_id` / `root_id` / `parent_id` / `mentions`）；`message.reply`（可 `reply_in_thread`）/ `message.create` / reaction | `lib/server/lark/protocol.ts`（入）· `sdk.ts`（出）|
| agent | 这一轮谁来答 | 机器人默认 agent → 消息里 `@slug` 单轮外援（与画布 @agent 同语义：折叠 4 轮、不 resume、不落盘） | `handler.ts` 调 `agents.ts` / `agent-pack.ts` |
| session | 这一轮落在画布哪里 | 见「落点策略」 | `lib/server/im/policy.ts`（纯函数，IM 无关）|

**抽象边界**：本轮只把「策略」和「飞书实现」分成两个文件。表名仍叫 `lark_*`、不做 adapter 接口、不接第二个 IM——等 Telegram / 企微真的要接时再抽，避免为想象中的入口造基础设施（S133 教训）。

## 四个旋钮（每个机器人一份，默认值已由用户拍板）

| 旋钮 | 取值 | 默认 | 语义 |
|---|---|---|---|
| `groupTrigger` | `mention` / `all` / `prefix`（配 `triggerPrefix`） | `mention` | 群里什么消息算对机器人说的。私聊固定全收。**无论哪档，机器人自己开的话题内的消息、引用机器人回复的消息，都视为对它说的**（那是对话的自然延续，不该要求再 @ 一次） |
| `sessionPolicy` | `thread` / `chat` | `thread` | `thread`：群里每个话题一棵树（顶层 @ = 新根；话题内消息接该树叶子）。`chat`：一个 chat 一条线性链（旧行为）。私聊恒为线性链。两档下**引用回复机器人的某条回答 = 在那条回答对应节点下分支**（始终生效） |
| `replyMode` | `thread` / `quote` / `plain` | `thread` | 群里回复形式：话题回复 `reply_in_thread` / 引用回复 / 平铺发送。私聊恒为引用回复 |
| `ackMode` | `reaction` / `none` | `reaction` | 收到即回 OnIt 表情 |

## 落点解析（`policy.ts` 纯函数，飞书无关）

输入：归一化消息 `{chatType, text, mentionedBot, threadId, rootId, parentId}` + 旋钮 + 三个查表回调（`threadTail(threadId)` / `nodeOfMessage(messageId)` / `chatTail()`）。

判定顺序（先命中先用）：

1. `parentId` 命中机器人发过的消息（`lark_outbox`）或用户发过的消息（`lark_inbox`）→ **branch** under 该节点（via `quote`）。
2. `threadId` 命中 `lark_threads` → **branch** under 该话题叶子（via `thread`）。`rootId` 命中 `lark_inbox` 亦同（话题根就是用户那条 @）。
3. 群 + `sessionPolicy=thread` → **root**（新树，via `thread`）。
4. 其余（私聊 / `chat` 策略）→ chat 链尾有则 **branch**（via `chain`），无则 **root**。

addressed 判定：私聊恒 true；群里 `mention` 档 = @ 到机器人 或 命中 1/2；`prefix` 档 = 文本以前缀开头（剥掉）或命中 1/2；`all` 档恒 true。

## 数据模型（全部加法 DDL，`pragma_table_info` 守卫）

- `lark_bots` + `group_trigger` `trigger_prefix` `reply_mode` `session_policy` `ack_mode`
- 新表 `lark_threads(id, bot_id, chat_id, thread_id, session_id, root_node_id, last_node_id, created_at, last_message_at, UNIQUE(bot_id, thread_id))` —— 话题 → 树
- 新表 `lark_outbox(message_id PK, bot_id, chat_id, node_id, thread_id, created_at)` —— 机器人发出的每条回复 → 节点（引用回复分支的查表源）
- `lark_chats` 语义不变：一个 chat 一个 `kind='lark'` 会话（画布容器）；`thread` 策略下该会话有多棵平行树

## 飞书侧细节

- 话题回复的响应带 `thread_id`（SDK 1.73 `message.reply` 返回 `data.thread_id`），据此登记 `lark_threads`；若响应无 thread_id，用用户那条消息 id 当 `rootId` 兜底（入站 `root_id` 可命中 `lark_inbox`）。
- `@slug` 外援：剥掉 bot mention 后，正则 `(^|\s)@([a-z0-9][a-z0-9-]{1,40})` 命中**已启用** agent 的 slug 即生效，token 从问题中剥除；语义与画布 @ 相同（`ephemeral`、折叠 4 轮、`agent_scope='mention'`）。
- 群里 `sessionPolicy=thread` 但 `replyMode≠thread` 的组合允许（树按话题分、回复不进话题），只是没有话题时飞书不会给 `thread_id`，后续消息靠 `rootId`/引用回复归树。UI 提示这一点。

## 不做（本轮）

每群覆盖 agent / 工作目录 · 卡片回复 · 流式编辑 · 审批卡推飞书 · 画布事件反推私聊 · 第二个 IM · 表重命名。

## 验收

- `scripts/test-lark-bot.ts`：policy 落点与 addressed 判定全组合、protocol 解析 thread/root/parent、store 话题/outbox 往返、@slug 剥离。
- 真飞书群：① @ 一次 → 话题回复 + 画布该群会话长出新树；② 话题内不 @ 追问 → 接在同一棵树叶子；③ 引用某条机器人回答提问 → 该节点下分支；④ 私聊行为不变。
