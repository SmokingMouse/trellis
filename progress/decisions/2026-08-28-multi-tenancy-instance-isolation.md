# 2026-08-28 · S4 多租户:实例级隔离(每租户一容器)+ 薄网关,不做单实例多租户改造

## Context

用户要把 trellis 开放给小圈子朋友(邀请制,≤15 人),核心诉求是文件系统隔离。这是 [2026-07-27 ADR](2026-07-27-project-workspace-layer.md) 拆出的 S4「Runtime 隔离 + 多租户」的第一期落地。用户拍板的输入:小圈子邀请制;租户自带 LLM 凭证 + 可选房主共享;每租户一个 Docker 容器;跑 Mac mini 本机(Docker Desktop)。

## Decision

**每租户一个容器跑完整 trellis 实例,宿主加薄「租户网关」做认证 + 路由 + cookie 翻译。trellis 本体零改动。**

1. **隔离边界 = 容器**(OS 级):租户的 CLI 任意 Bash 逃不出;Docker Desktop 本身是 VM,再兜一层。
2. **网关 cookie 翻译**:浏览器持网关签发的 `trellis_gw_session`(argon2id + sha256 session,sameSite=strict);网关认证后改写 Cookie 头注入该租户实例的 `trellis_auth=<per-tenant TOKEN>`。实例照旧跑自己的 TRELLIS_AUTH_PASS/TOKEN 闸(纵深防御),实例侧认证代码零改动。
3. **单域名按 session 路由**(不做子域名/路径前缀):租户:实例 1:1,认出用户即认出实例;避开通配证书只匹配一层的坑;iframe/SSE/PWA 零改写。
4. **tenantctl(房主 CLI)与网关的唯一衔接 = `~/.trellis-tenancy/tenants/<name>.json`**(ctl 写、网关读),不共享 SQLite——两个组件可完全独立开发与测试。
5. **凭证**:租户容器内自己 `claude login`(默认);共享走 `claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN` env 注入——是 [2026-08-04「托管隔离暂缓」](../decisions.md)预设触发条件(多人部署提上日程)的兑现,且**绝不拷 credentials.json**(refresh 双副本分叉,同条已拒)。

## Why(单实例多租户改造被否的证据链)

- 三份代码探索实测:全库 0 个 user 概念;单实例改造 = 10 张表 + 73 个仓储函数 + 52 条 route + 2 条全局 SSE 广播(cli-sync-events / task-events 模块级全量广播)+ watcher/scheduler 进程级单例全部要加 owner 维度,漏一处即数据泄露;`projects.cluster_key` / `workspaces.path` / `agents.slug` 全局 UNIQUE 要改复合。
- 且改完应用层也防不住:CLI spawn 的 Bash 能任意读宿主文件系统,还得再做一遍 OS 沙箱——双倍工作。
- 反向:trellis 所有路径根都是 `path.join(os.homedir(), ...)`,容器 HOME=/home/tenant 即天然全量隔离;`TRELLIS_DB_PATH` 本就支持切库。实例级隔离是顺代码纹理的。
- ttyd `-a` 的 S4 前置闸(2026-07-27 ADR:多租户启动时必须去掉)自动消解:容器方案里 `?arg=` 注入 = 在自己容器里跑命令,本来就允许。
- happyclaw 对照(happyclaw-contrast.md):只借「每用户一容器」这一个形状,不抄 RBAC/计费/六态投递(riba 判词:量级匹配)。

## Alternatives considered

- **单实例多租户(全表加 owner_id)** — rejected:改动面与泄露风险如上,且与「不为泛用化把模型抽象到框架级」的项目定位冲突。
- **每租户一个 Unix 账户** — rejected:共享内核提权面,CLI 任意代码执行下只适合更高信任度;容器成本在本机(64GB)完全可承受。
- **应用层路径围栏** — rejected:CLI 一条 Bash 就绕过,只能当 UX 不能当安全边界。
- **子域名路由** — rejected:`*.home.smokingmouse.cn` 通配只匹配一层,新签证书/平铺命名都是白付的复杂度。
- **共享凭证拷 credentials.json** — rejected(沿用 2026-08-04 结论):refresh 轮换双副本互相作废,还会打断房主自己的 prod。

## 落地(2026-08-28,焚决四单全部 accepted)

- `fj-mt-spike-54c5`(gemini):网络前提实测——宿主 clash TUN **透明覆盖** Docker VM 出站,容器直连 api.anthropic.com/npm/claude.ai 全通,备用代理 `host.docker.internal:7897` 可达;bookworm 无 ttyd 包 → GitHub aarch64 1.7.7 二进制;claude/codex 容器内秒装,OAuth URL 正常生成。
- `fj-mt-image-681e`(codex):`tenancy/image/` + `tenantctl.ts`,D1-D7(build/起容/身份/mock 对话/重启持久/upgrade/purge)settle 独立复跑全绿。
- `fj-mt-gateway-0042`(codex):`tenancy/gateway/` + launchd 模板,selftest 12 项(含 cookie 翻译/SSE 时序/WS 二进制帧/维护页/禁用即时失效)settle 全绿。
- `fj-mt-m3-3073`(gemini):tenantctl 增补 `creds-share`/`backup`,D1-D4 settle 全绿。
- Supervisor 收尾:真容器 × 网关联调(邀请认领 → cookie 翻译 → 真实例 mock 对话 SSE 全链路)通过;selftest 补 120s watchdog;`tenancy/README.md`(架构/威胁模型/运维)。

## 遗留(待用户/后续)

- 公网接入:caddy 站点块 + 域名选择,由房主拍板后接(tenancy/README.md「公网接入」节)。
- 宿主 0.0.0.0 裸奔服务(memos:5230 / stirling:18080)建议改绑 127.0.0.1(容器可经 host.docker.internal 触达)。
- 真人租户端到端验收(真 claude login + 真对话 + Web 终端)待第一位朋友上车时做。
