# 网关门户 API v1(`/__gw/*`)

本文档是 fj-gw-portal(实现方,网关侧)与 fj-admin-ui(消费方,trellis UI 侧)的**接口契约**。实现与本文档的任何偏差必须在 result 中明示并更新本文档;消费方以本文档为唯一依据开发(mock 亦按此造)。

背景:`/__gw/` 前缀由网关拦截自答、不代理到租户实例(现有 login/invite/logout 机制的延伸,gateway.ts fetch handler)。

## 鉴权与通则

- 所有 `/__gw/api/*` 需有效 `trellis_gw_session` cookie;无效 → `401 {"error":"unauthenticated"}`。
- `/__gw/api/admin/*` 额外要求 users.role = 'admin';否则 → `403 {"error":"forbidden"}`。
- 响应一律 JSON;错误统一 `{"error": string}`(4xx/5xx)。
- users 表加列 `role TEXT NOT NULL DEFAULT 'user'`('admin' | 'user'),迁移沿 additive-only 纪律(db.ts)。

## 通用

| 方法/路径 | 语义 | 响应 |
|---|---|---|
| `GET /__gw/api/me` | 当前用户 | `200 {name, tenant, role}` |

## 注册(页面路由,未认证可达)

- `GET /__gw/register?code=<invite>` → 注册表单页(用户名 / 密码 / 邀请码,code 预填)。
- `POST /__gw/register` 表单 `{code, username, password}`:
  - 校验:code 存在且未用;username 匹配 `^[a-z0-9-]{1,32}$` 且未被占用(users 与 tenants 双查);password ≥ 8。
  - 成功:建 user(role='user', tenant=username)→ 标记 code 已用(记 used_by)→ **异步**开容器(spawn `bun tenancy/tenantctl.ts add <username>`,不阻塞响应)→ 签发 session(注册即登录)→ 302 `/__gw/register/pending`。
  - 失败:重渲染表单带错误。
- `GET /__gw/register/pending` → 「工作空间准备中」页,前端轮询 status,ready 后跳 `/`。
- `GET /__gw/api/register/status`(需登录)→ `200 {state: "provisioning"|"ready"|"failed", detail?: string}`。ready 判定 = 该用户 tenants/<name>.json 出现(tenantctl 健康后才写,沿现有语义);failed = spawn 退出非 0(detail 带尾部日志摘要)。
- 邀请码:`randomBytes(24) base64url`,invites 表 `{code PK, created_at, used_by TEXT NULL, used_at INTEGER NULL}`。**与一期 users.invite_code(认领设密码)并存不冲突**:旧机制继续可用,新注册走 invites 表。

## Admin API

| 方法/路径 | 语义 | 响应 |
|---|---|---|
| `GET /__gw/api/admin/users` | 全量用户 + 容器态 | `200 [{name, tenant, role, disabled, createdAt, container}]` |
| `POST /__gw/api/admin/invites` | 生成邀请码 | `201 {code, url}`(url = 完整注册链接) |
| `GET /__gw/api/admin/invites` | 邀请码列表 | `200 [{code, createdAt, usedBy}]` |
| `DELETE /__gw/api/admin/invites/:code` | 作废未用码 | `204`(已用 → 409) |
| `POST /__gw/api/admin/users/:name/disable` | 禁用(session 即时失效,沿现有 disabled 语义) | `204` |
| `POST /__gw/api/admin/users/:name/enable` | 解禁 | `204` |
| `POST /__gw/api/admin/users/:name/restart` | 重启其容器(spawn tenantctl restart) | `202`;host 租户 → `400` |

container 对象:`{state: "running"|"stopped"|"missing"|"host", healthy: boolean|null}`——state 来自 docker inspect(spawn,缓存数秒防抖);`host` = 宿主实例记录(不查 docker,healthy 来自 `/__gate/health` 探测或 null)。

`createdAt` / `created_at` 均为 Unix epoch milliseconds。三字段租户记录(`name/hostPort/authToken`,无 `container`)识别为 `host`;tenantctl 生成、带 `container` 的记录识别为容器租户。

## 共享池 API

Share 对象(**payload 永不回显**):

```
{id, type: "claude-token"|"endpoint", label, owner, visibility: "all"|string[], createdAt, subscriberCount}
```

| 方法/路径 | 语义 | 响应 |
|---|---|---|
| `GET /__gw/api/shares` | 我的视角 | `200 {published: Share[], available: (Share & {subscribed: boolean})[]}`(available = 他人发布且我在可见范围) |
| `POST /__gw/api/shares` | 发布 | `201 {id}` body `{type, label, payload, visibility}` |
| `DELETE /__gw/api/shares/:id` | 撤销(仅 owner) | `204`,**级联移除全部已订阅注入**(逐租户执行反注入) |
| `POST /__gw/api/shares/:id/subscribe` | 订阅并注入 | `202 {willRestart: boolean}` |
| `DELETE /__gw/api/shares/:id/subscribe` | 退订并移除注入 | `202 {willRestart: boolean}` |

payload 形状:

- `claude-token` → `{token: string}`(`claude setup-token` 产物)。注入 = 写 `env/<tenant>.env` 的 `CLAUDE_CODE_OAUTH_TOKEN` + 容器重建(沿 creds-share 路径)→ `willRestart: true`。**每租户同时仅一个激活的 claude-token 订阅**,新订阅自动替换旧的(响应 202,UI 提示替换)。
- `endpoint` → `{name, anthropic_url?, openai_url?, api_key_env?, apiKey?, models}`，与 `lib/server/model-config.ts` 的 `UpsertProviderInput` 对齐：
  - `name` 匹配 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`;`models` 是非空 string 数组;URL 若提供必须为 `http(s)://`;`api_key_env` 缺省为 `<NAME>_API_KEY`。
  - `apiKey` 是可选明文密钥，仅存 gateway.db payload，并注入 endpoints.yaml 的 `env_file`(没有则设 `~/.config/sm/.env`)；密钥不进入 YAML/API 响应。
  - provider 节点用 `# fj-share:<id>:begin` / `# fj-share:<id>:end` 标记；env key 也用同 ID 标记块。重复订阅先移除本 ID 旧块再写，撤销只移除本 ID 块；若同名用户自有 provider 已存在则拒绝注入，绝不覆盖。
  - 容器租户通过 tenantctl 的一次性 volume helper 写 HOME；host 租户按 `$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml` → legacy `~/.claude/global/endpoints.yaml` 搜索顺序写宿主文件。→ `willRestart: false`。

边界语义:

- 订阅者容器非 running → `409 {"error":"tenant container not running"}`。
- admin(host 租户)订阅:endpoint → 写宿主对应 endpoints.yaml 路径;claude-token → `501`(宿主 env 不代管,UI 提示手动配置)。
- 发布者 disabled / 被删除 → 其 shares 保留但不可新订阅(available 中隐去)。

## 安全语义(UI 必须呈现)

- **共享 = 交出**:订阅方容器内一切进程可提取凭证明文;撤销只保证停止后续注入,不能召回已泄出的值。
- 网关侧凭证明文落 0600 文件 / gateway.db;任何 API 不回显 payload。
- 本实现选 gateway.db 存 payload：共享元数据、owner、subscription 与凭证同库，便于事务一致性；状态根目录保持 0700、gateway.db 强制 0600。代价是数据库备份本身属于敏感凭证备份，运维必须按 secret 处理。
- 注册页 / 登录页限速沿现有内存计数机制扩展(register 亦 5 次/分钟)。
