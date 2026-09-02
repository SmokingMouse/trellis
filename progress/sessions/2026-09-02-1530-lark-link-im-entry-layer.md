### Session 134（2026-09-02，飞书链路打通 + IM 入口层：ws 内联根因 → PR #34；四旋钮 / 话题即树 / 引用即分支 / @slug → PR #36）
- **撞号注记**: 本日 `sessions/` 下有两条 S133——`1430-leader-takeover`（本会话上午）与 `1610-recent-chains-sidebar`（并行 worktree 会话，已合 PR #35）。文件名即唯一键，并存不改号；本条顺延为 S134，代码注释里的「S134」均指本条。
- **触发**: backlog B1「飞书机器人关联流程长、私聊不通」→ 用户「先把飞书链路打通吧」；打通后用户提出「机器人本质是 IM 入口，im → agent → session，飞书应有可配置项（群触发形式、是否按话题回复）」并拍板默认值。
- **B1 根因链（三层排除法）**:
  1. 开放平台侧**全配好**：`application/v6/app_versions` 实测小秘书三版本已发布，事件含「接收消息」，权限含 `im:message.p2p_msg:readonly` / `group_at_msg:readonly` / `send_as_bot` / `reactions:write_only`；`bot/v3/info` activate_status=2。此前「流程长」的向导只验凭证不验入站，且 Launcher 是裸链接无模板。
  2. prod 日志只有 SDK 的 `[ws] ws connect failed`，`last_error` 却为空：SDK 握手失败**不回调** onError/onReconnecting，`start()` 在拿到 ws 地址后即 resolve（state=connecting），管理器把它当健康 → 静默。
  3. 终端 bun/node 探针 0.6s onReady；**一次性 launchd job**（同 plist env + release node_modules）0.4s onReady 排除环境；release 的 server chunk 里有 `Sec-WebSocket-Accept` / `bufferutil` 指纹 = Turbopack 把真 `ws` 内联；按路径加载真 ws 在 Bun 下 `Unexpected server response: 101`、按名字（Bun 原生替换）OPEN；node 两者皆 OPEN。坐实。
- **Done**:
  1. **PR #34**（2064c1e）: `serverExternalPackages` 追加 `@larksuiteoapi/node-sdk` + `ws`；manager `connect()` 加就绪门（等 onReady 20s，超时写 `last_error` + `[lark]` 日志，下轮重试；就绪打 `长连接就绪`）；test-lark-bot 加两条 externals 守卫。部署后 07:56 就绪；用户私聊「你好」→ inbox done、`kind='lark'` 会话 + 节点、6.7s / 82 tok 回包。**B1 关闭**。
  2. **PR #36**（b4ffaf4，spec `progress/im-entry-layer.md`）: `lib/server/im/policy.ts` 纯函数策略内核（resolveAddress / resolveTarget / extractAgentSlug）；协议层如实归一化 `thread_id/root_id/parent_id/mentionedBot`，群 @ 门控挪到 policy；`lark_bots` 加五列（mention / thread / thread / reaction 默认），新表 `lark_threads`（话题→树）/ `lark_outbox`（出站消息→节点）；`sendLarkText` 支持 quote/thread/plain 并回传 message_id/thread_id；handler 按落点建节点（branch / 同会话再长一棵树 `createRootInSession` / 新会话），`@slug` 走 ephemeral 与画布同语义，回复后登记 outbox 与话题叶子；机器人页「4. 群聊行为」四选择器。关键判据：「真引用」= `parent_id ≠ root_id`（话题内平铺发言 parent=root 不算引用，接叶子不接根）。
  3. 部署 `526d3ab`（含并行会话的 PR #35 侧栏最近分组），bot 重连就绪，live 库四列 + 两表落地。
- **验证**: tsc 0 错 · bun test 44/44 · test-lark-bot 27→55 断言（落点矩阵、prefix/all、话题平铺 vs 真引用、@slug、映射表往返）· build 过 · 定向 eslint 零新增（page.tsx 3 条 set-state-in-effect 为 HEAD 存量）· 迁移在 prod 库副本上加列建表成功。**群内四步活体验收待用户**：① @ 一次 → 话题回复 + 该群会话新树；② 话题内不 @ 追问 → 接叶子；③ 引用某条机器人回答 → 该节点下分支；④ 私聊不变。
- **顺手修的坑**: trellisctl 401 两层（shared/.env.local 旧凭证 + Bun 自动加载仓库 .env.local，见 S133 / facts）；`.feishu-cli` yaml 值带引号，探针解析要剥引号。
- **Next**: ① 群内四步验收 → 过则 backlog B2 关闭；② 本 session progress 文档提交（README / facts / backlog / sessions 两条 / SKILL.md）；③ 后续候选（spec「不做」节）：每群覆盖 agent 与工作目录、审批卡推飞书、画布事件反推私聊、卡片回复；④ 向导闭环自检（连上后主动发私聊「回复任意内容完成自检」）仍未做——B1 的「流程长」只解决了根因不解决体验。
