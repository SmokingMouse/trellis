# 2026-08-28 · S4 二期:统一门户(自助注册 + 管理员宿主路由)+ 用户间模型共享

## Context

一期([同日 ADR](2026-08-28-multi-tenancy-instance-isolation.md):实例级隔离 + 薄网关)落地后,Owner 明确一期形态不是终态,目标形态四点:统一注册&登录入口;管理员从同一入口登录、工作目录 = 宿主机;普通用户工作目录在容器、文件隔离(一期已有);不同用户间模型共享。

Owner 拍板输入(2026-08-28):准入 = **邀请码自助注册**(拒绝完全开放:公网任何人可占 6G 内存容器);共享范围 = **任意用户间互享**(拒绝仅管理员单向共享池);共享对象 = **Claude 订阅 token + 第三方 API endpoint 两类**;管理面板 = **要在 trellis 里**(拒绝网关自渲染管理页:体验割裂)。

## Decision

1. **统一入口仍在网关**:`/__gw/register` 邀请码自助注册,注册成功自动开容器(异步 spawn tenantctl,页面轮询至健康)。邀请码与用户名解绑,成为独立实体(invites 表,一次一用),用户名注册时自选。
2. **网关 users 加 `role`(admin/user),admin 路由到宿主实例**:tenants/*.json 路由机制已不假设容器(只消费 hostPort + authToken,Explore 实证 tenants.ts:5-29),正式化一条 host 记录指向宿主单人版;宿主实例补开 auth gate。管理员与普通用户同一登录入口,凭 role 分流。
3. **管理面板分层:UI 在 trellis 本体,控制面 API 在网关**。trellis 新增 `/admin` 页与设置页共享区,由 env 开关控制仅宿主实例启用;前端调 `/__gw/api/*`——该前缀网关本就拦截自答不代理,天然带 gw session 鉴权,admin API 按 role 应答。docker / gateway.db 等特权操作全部集中网关进程,**trellis 本体进程不碰 docker、不读写 gateway.db**。
4. **共享池 = 发布/订阅模型**,数据存网关侧:用户发布凭证(claude-token / endpoint)并圈可见范围,他人订阅触发注入——claude-token 走 env + 容器重建(每租户同时仅一个激活,新订阅替换旧的),endpoint 写租户 HOME endpoints.yaml 标记块(可撤销、不碰用户自有条目)。「共享 = 交出」语义沿一期不变,UI 明示。
5. **修订一期「trellis 本体零改动」原则**:本体允许新增租户感知薄层(admin 页 / 共享设置区),但限定为「读 env 开关 + 调 /__gw/api」;两组件衔接面从 tenants/*.json 单点扩为「tenants/*.json + /__gw/api HTTP 约定([tenancy/gateway/API.md](../../tenancy/gateway/API.md))」两个显式窄接口,仍不共享 SQLite。

## Why

- admin→宿主路由是顺纹理的:网关路由逻辑无容器假设,手写三字段 JSON 即可路由,一期架构白送这条路。
- UI 放本体而非网关:统一体验(Owner 拍板)+ 复用完整 Next/React 栈;控制面留网关:租户容器里跑同一份 trellis 代码,够不着宿主特权面,/__gw/api 让租户容器里即使存在同样前端路由也调不通(role 闸在网关),双保险。
- 一期「零改动」原则的本意是控制改动面与泄露风险;本次修订保留其内核(本体无特权、无多租户数据模型),只放开纯消费性 UI 层——不是推翻,是收窄后的续期。

## Alternatives considered

- **管理页由网关服务端渲染** — rejected:Owner 否;网关手写 HTML 栈弱,重复造 UI。
- **trellis 本体直接 spawn tenantctl / 读写 gateway.db** — rejected:特权分散进本体,租户容器同码路径攻击面变大;两组件共享 SQLite 一期已拒,理由仍立。
- **完全开放注册** — rejected:资源(6G/容器)与安全。
- **仅管理员共享池(单向)** — rejected:Owner 明确要任意用户互享。

## 落地

焚决三单:`fj-gw-portal-be6e`(网关控制面,codex)∥ `fj-admin-ui-2029`(trellis UI,gemini)并行,worktree 隔离,接口以 API.md 为准;两单 settle + merge 后开第三单(接线联调:宿主实例入网关 + 真容器端到端)。
