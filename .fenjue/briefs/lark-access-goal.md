# lark-access：飞书 bot 对话审批（发送人白名单 + 管理员审批）

## 背景

要新建一个运维 bot「号池巡检」，绑定一个 sub2api 运维 agent，拉进「sub2api 测试群」。现在群里任何人 @bot 都会触发 agent 执行。用户要求：没审批过的人跟 agent 对话前，必须先经管理员（用户本人）审批。

现状：trellis 入站只判定「是不是在对 bot 说话」，没有任何发送人门禁。判定链路是 `lib/server/lark/handler.ts` 的 `acceptLarkEvent` → `resolveAddress`。

## 要交付的行为

按 bot 生效，默认关闭；存量 bot 零行为变化。

1. **开关**：bot 级 `accessMode: "open" | "approval"`，存为 `lark_bots` 新列，默认 `open`。

2. **成员表**：新建一张表，建议名 `lark_bot_members`。
   - `bot_id + open_id` 唯一。
   - `role`：`admin | member`。
   - `status`：`pending | approved | denied`。
   - `code`：4 位短码，供文字命令使用。
   - 最近一次挂起消息的入队所需字段（JSON）、预览（≤200 字）、所在 chat。
   - 各时间戳，以及 `decided_by`。
   - admin 的定义是 `role=admin` 且 `approved`；admin 恒放行。

3. **门禁位置**：在 `acceptLarkEvent` 里，确认「是对 bot 说的话」之后、`enqueueMessage` 之前。
   - 「对 bot 说的话」即 `address.addressed` 为真，包括非文本消息被 @、以及私聊。
   - approval 模式下，发送人不是 approved 时：
     - **denied**：inbox 记为 ignored，静默不回。
     - **其余情况**：upsert 成 pending（覆盖为最新一条挂起消息）。inbox 记为挂起态（新状态值，按 `lark_inbox` 现有约束加）。然后：
       - a. 引用该消息回复发送人：「这个机器人需要管理员审批后才能对话，已提交申请，通过后会自动回复你。」同一人 24h 内只回一次。
       - b. 私聊通知每位 admin，发一张 Schema 2.0 卡片，内容包括：
         - 申请人，用 `<at id=open_id></at>` 渲染名字，不需要通讯录权限；
         - 来源（群名或私聊）；
         - 消息预览；
         - [同意] [拒绝] 两个按钮；
         - 文字兜底提示：「或回复：同意 <code> / 拒绝 <code>」。

         同一申请人 1h 内不重复通知 admin。
       - c. 没有任何 admin 时：只打日志，申请在设置页可见，不报错。
   - 挂起路径上的群聊也要登记 chat（`ensureLarkChat`）。否则审批模式下，「新群 @ 一次完成登记」会失效。

4. **审批入口**：共三条，共用一个服务函数 `decideMember`。
   - **卡片按钮**
     - 在 WS EventDispatcher 上注册 `card.action.trigger`，注册位置在 `lib/server/lark/manager.ts` 的 connect 处。
     - 回调里校验操作者 open_id 是该 bot 的 admin；按钮 value 不可信，不能据此放行。
     - 成功后返回更新后的卡片（显示「已同意 / 已拒绝 · 操作人」），或返回 toast。
     - 动手前先读 `node_modules/@larksuiteoapi/node-sdk` 的源码，确认 WS 下 card 回调的投递形状和返回值约定。README 说长连接不支持回调，但 1.73 的 Channel 模块里有 `card.action.trigger` 处理，以源码为准。
     - 拿不准时按钮做成 best-effort，文字命令是保底。
   - **文字命令**
     - admin 在与 bot 的私聊里发「同意 <code>」「拒绝 <code>」「名单」。
     - 在门禁之前拦截处理，并回复处理结果。
     - 非 admin 发这些词，按普通消息走门禁。
   - **设置页**：在 `/settings/bots` 该 bot 下新增「对话权限」区，包含：
     - 开放 / 需审批 切换；
     - 成员列表：名字（没有名字时显示 open_id 尾 6 位）、角色、状态、申请预览、时间；
     - 每个成员的操作：同意 / 拒绝 / 设为管理员 / 取消管理员 / 移除；
     - 按 open_id 手动预先放行。

5. **同意 / 拒绝之后**
   - **同意**：
     - status 改为 approved。
     - 回复申请人的挂起消息：「✅ 管理员已同意，正在处理你的消息」。
     - 然后把挂起消息按原路径重新入队处理。只重放 24h 内的消息；更早的只提示「已通过，请重新发送」。
   - **拒绝**：status 改为 denied，并通知申请人一次：「管理员未通过你的申请」。

6. **API**：沿用 `app/api/lark-bots` 的路由风格。
   - PATCH bot 支持 `accessMode`。
   - 新增 members 接口：
     - GET：成员列表；
     - POST：预先放行、添加 admin；
     - PATCH：approve / deny / 改 role；
     - DELETE：移除。
   - 设置页走这些接口。

7. **首个 admin 的引导**
   - admin 本人先私聊 bot 一句，进入 pending；然后在设置页点「设为管理员」，即成为 approved + admin。
   - approval 模式下 admin 数为 0 时，设置页显示上面这段引导文案。

## 约束

- **open 模式行为不变**：逐字节不变，现有 lark 测试全绿是证据之一。不引入新依赖。
- **迁移风格**：跟 `lib/server/sqlite.ts` 现有写法一致，即 `CREATE TABLE IF NOT EXISTS`，以及用 `pragma_table_info` 检查后再 `ALTER`。
- **避让 leader 的并行改动**：leader 同时在改任务推送。下面这些位置不要动；需要新的发送函数（比如按 open_id 私聊）就新增函数。
  - `lib/server/tasks.ts`
  - `lib/server/lark/task-push-policy.ts`
  - `lib/server/lark/push.ts`
  - `handler.ts` 里 `runAgentTurn` 的回复正文那几行
  - `sdk.ts` 里 `sendLarkText` 的降级分支
  - `card.ts` 里的 summary 计算
- **写 API 路由 / 页面前**：先按 AGENTS.md 读 `node_modules/next/dist/docs/` 里对应的指南。
- **测试**：
  - 纯逻辑抽成可测函数，用 bun test 覆盖：门禁决策、命令解析、按钮 value 校验、重放时效判断。
  - store 层用临时 DB 测。
- **风格**：注释和界面文案用中文，跟随所在文件的风格。
- **禁止项**：
  - 不动 `.fenjue/**`，不 push，不 make deploy。
  - 不碰 `~/.trellis/data.db`。要验证的话，用 `sqlite3 .backup` 出的副本，配独立 HOME 和 `TRELLIS_LARK=off`，参照 `scripts/mobile-verify/` 的隔离实例配方。
- **收尾**：
  - 完成后 git commit，只 add 自己改的路径。
  - result 里列出改动文件、新增测试，以及 card 回调的结论（确认可用，或 best-effort 未实测）。

## 验收

- `bunx tsc --noEmit` 0 错
- `bun test` 全绿
- `bun --bun run build` 通过
