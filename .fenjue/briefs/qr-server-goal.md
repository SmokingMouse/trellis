# qr-server · 扫码建 / 更新飞书 bot：服务端

## 目标
用户在设置页点「扫码创建机器人」，在飞书确认页确认后，trellis 自动完成五件事：
1. 拿到凭证
2. 建 bot
3. 连上长连接
4. 把创建者设成管理员
5. 用新 bot 私聊创建者一句欢迎语

已有 bot 缺权限时，走同一流程的 update 模式，一次补齐 scope、事件、回调。

全程不复制 App ID / Secret，也不进开放平台控制台。

## 已核实的底座（不用再调研，直接用）

### 官方 Node SDK（已是依赖，1.73.0）导出 `registerApp`
- 实现在 `node_modules/@larksuiteoapi/node-sdk/lib/index.js:103037-103230`，类型在 `types/index.d.ts:321842-321963`。
- 参数：
  - `appPreset {name, desc, avatar}`：预填创建页。
  - `addons {preset?, scopes:{tenant,user}, events:{items:{tenant,user}}, callbacks:{items}}`：预带权限、事件、回调，确认页会列出来，用户确认后生效。
  - `createOnly: true`：只允许新建。
  - `appId`：更新已有应用，确认页显示 addons 带来的 diff。
- 返回：
  - 成功 resolve `{client_id, client_secret, user_info:{open_id, tenant_brand}}`。
  - 失败 reject 一个 `{code, description}` 对象，code 取值读 startPolling 源码确认（access_denied / expired_token 等）。
- 实测：服务端 begin 返回 `expires_in=3600`。

### 缺权限报错的形状
来源：官方 CLI 源码 `/tmp/larksuite-cli/internal/errclass/classify.go:536-590`。
- HTTP 400 的 body：`{code: 99991672, msg, error: {permission_violations: [{subject: "<scope>"}]}}`
- msg 里也带 `[scope]` 和申请链接。
- 补权限深链：`https://open.feishu.cn/page/scope-apply?clientID=<appId>&scopes=<逗号分隔>`

## trellis 现状地图（缩写：P=app/settings/bots/page.tsx，S=lib/server/lark/store.ts，M=lib/server/lark/manager.ts，K=lib/server/lark/sdk.ts，A=app/api/lark-bots）

**建 bot 与存储**
- 创建路由在 A/route.ts:10-31；app_id 重复时返回 400。
- 验凭证在 A/[id]/test/route.ts:10-21；bot info 在 K:40-50。
- 「验凭证 → 建或更新 bot → 写身份」这条链已有现成实现：discover.ts:222-272，照着复用。
- store 函数：createLarkBot S:232，updateLarkBot S:282，写身份 S:325，写连接状态 S:331。
- preapproveMember 在 S:621，可以直接设 admin。
- 表结构在 lib/server/sqlite.ts：lark_bots 874-890，策略列用 ALTER 加（917-930）。

**manager**
- 启动：instrumentation.ts:75-79 → M:165-172。
- 每 15s 跑一次 reconcile（M:121-159），用 appId+secret 指纹决定连哪些、断哪些（protocol.ts:261）。
- M:122 有防重入标志。
- 连接逻辑在 M:36-112，20s 超时。

**报错丢失的位置**
- K:21-26 只处理 HTTP 200 但 code≠0 的响应。
- HTTP 4xx 时 SDK 抛 AxiosError，飞书的 msg 留在 `response.data` 里，在三处被丢掉：M:32、handler.ts:375、K:28。

**跨 bundle**
- 路由和 instrumentation 在同一个 `next start` 进程里，但分属不同 bundle。
- 模块级变量不共享（M:24 的连接表，路由拿不到）；globalThis 是共享的。
- globalThis 单例的写法参照 herdr-fleet.ts:349。

## 交付物

### 1. `lib/server/lark/scopes.ts`
导出 `TRELLIS_BOT_ADDONS`，内容：
- **scope**：盘点 `lib/server/lark/` 里实际调用的飞书 API，逐个映射到应用身份 scope。至少覆盖：收私聊、收群 @、回复、发卡片、更新卡片、表情 ack（ackMode=reaction）、下载消息资源、群信息、bot info、batch_get_id。
- **事件**：`im.message.receive_v1`，以及 trellis 实际处理的其他事件。
- **回调**：`card.action.trigger`（审批卡按钮要用）。
- 每个 scope 都注释它服务哪个调用点（file:line）。
- `preset` 保持缺省，叠在平台模板上。

### 2. `lib/server/lark/register.ts`：注册会话管理器
会话表挂在 globalThis 上。

**`startRegistration(req: LarkRegisterRequest): Promise<LarkRegisterStart>`**
- 调 registerApp，`source` 传 `"trellis"`：
  - create：`createOnly: true`，`appPreset {name, desc}`，addons 用 TRELLIS_BOT_ADDONS。
  - update：传 `appId`，addons = 标准集 ∪ req.scopes ∪ 该 bot 的 missingScopes。
- 等 onQRCodeReady 拿到 url 就返回；30s 拿不到算失败。

**后台流程：create 成功后**
1. status 置 binding。
2. 验凭证。
3. createLarkBot：enabled；带上 name、agentId、workspacePath；accessMode 缺省 approval。
4. 用 `user_info.open_id` 调 preapproveMember，角色 admin。open_id 按应用隔离，这里拿到的正是新应用下的 open_id。
5. 触发 manager 立即对账。
6. 等连上：判据是 DB 的 lastConnectedAt ≥ binding 开始时刻，最多等 30s。
7. 用新 bot 给这个 open_id 发一条欢迎私聊，文本即可，内容：bot 名；绑定的 agent 和工作目录；「你是管理员，别人私聊或 @ 它需要你批准」。
8. status 置 done。

任何一步失败都置 error，带中文原因；已建好的 bot 保留。

**后台流程：update 成功后**
1. 校验 `client_id === bot.appId`，不一致就置 error「确认的不是这个应用」。
2. 返回的 secret 和库里不同时，调 updateLarkBot 更新。
3. 清空 missingScopes。
4. 触发对账。
5. status 置 done。

**`getRegistration(id)` / `cancelRegistration(id)`**
- 取消走 AbortController，传给 registerApp 的 signal。
- 终态会话保留 10 分钟后清理。
- 依赖（registerApp、验凭证、发消息、store）都要可注入，便于单测。

### 3. 路由
放在 `app/api/lark-bots/register/` 下，自动受 proxy.ts:32 的 cookie 鉴权保护。
- `POST /api/lark-bots/register`：LarkRegisterRequest → LarkRegisterStart
- `GET /api/lark-bots/register/[sessionId]`：返回 LarkRegisterSession
- `DELETE /api/lark-bots/register/[sessionId]`：取消

契约已在 `lib/lark-types.ts` 末尾定好（main 7c57fe5），**不改契约**。确实需要改，先用 `fj mail send` 说明。

### 4. manager
- startLarkManager 往 globalThis 挂一个 `reconcileNow()`。
- M:122 的防重入标志改成「正在跑就记一笔，跑完再来一轮」，保证路由触发的对账不会被吞。

### 5. 权限报错
- 在 K 统一拆开 AxiosError 和 code≠0 的响应，识别 99991672。
- 从 `permission_violations[].subject` 取缺的 scope；取不到时从 msg 的 `[...]` 里解析。
- 新增列 `lark_bots.missing_scopes`（JSON 文本），迁移照 sqlite.ts:917-930 的 ALTER 风格，要可重入。
- `LarkBot.missingScopes` 从这一列读。
- last_error 写成可读的中文，带上 scope 名。
- 只接在现有会记 last_error 或回复失败的地方，不改业务流程。

### 6. 测试（bun test）
- 会话状态机，mock registerApp 覆盖：成功、denied、expired、取消、binding 中途失败。
- update 的两种情况：client_id 不一致；secret 发生变化。
- 权限报错解析的三种形状：AxiosError；code≠0 的响应；只能从 msg 兜底解析。
- manager 的 rerun 标志。
- missing_scopes 迁移可重入。

## 约束
- 动手前先读 `node_modules/next/dist/docs/` 里 route handler 相关的文档（仓库 AGENTS.md 的要求）。
- secret 和 tenant token 永远不打印、不返回、不写日志；会话视图里不含 secret。
- 不改 UI（`app/settings/**`），另一个坐席在并行做。
- 不改 `lib/lark-types.ts` 的契约。
- 不动生产：不跑 make deploy，不写 `~/.trellis/data.db`，测试用临时库。
- 不创建真实飞书应用。扫码的端到端验证由 leader 合并后和用户一起做。

## 验收
- `bun x tsc --noEmit` 通过。
- `bun test` 失败数 ≤ 5（main 基线已有 5 个存量红）。
- 汇报列出四样：TRELLIS_BOT_ADDONS 全表（scope → 调用点）、新增的列、新增的路由、做端到端验证时 leader 该看的日志关键字。
