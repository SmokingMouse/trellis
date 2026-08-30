# Trellis 多租户(S4):实例级隔离 + 薄网关

把 trellis 开放给小圈子(邀请制)的完整方案。**每租户一个 Docker 容器跑完整 trellis 实例**(自己的 server.ts + Next + SQLite + ttyd + claude CLI),宿主上一个薄网关做认证 + 路由 + cookie 翻译。trellis 本体零改动——文件系统隔离由容器边界(OS 级)承担,CLI 里任意 Bash 也逃不出。

```
浏览器 ──HTTPS(caddy)──▶ 网关 gateway.ts (127.0.0.1:3200)
                          │  per-user session(trellis_gw_session, argon2id + sha256)
                          │  Cookie 翻译:删 gw cookie → 注入该租户 trellis_auth
                          ├──▶ 127.0.0.1:42001  trellis-alice 容器(HOME=/home/tenant, named volume)
                          ├──▶ 127.0.0.1:42002  trellis-bob 容器
                          └──▶ (容器挂了 → 维护页)
```

## 组件

| 文件 | 职责 |
|---|---|
| `image/Dockerfile` + `image/entrypoint.sh` | 租户镜像:node:22-bookworm-slim + bun + claude/codex CLI + ttyd(GitHub aarch64 二进制,apt 无包)+ tmux;应用在 `/opt/trellis`;非 root 用户 tenant(node 用户原位重命名,UID 1000);entrypoint 幂等补 home 骨架(volume 只在空时被种入,升级新增骨架靠这里) |
| `tenantctl.ts` | 房主 CLI:`build / add / start / stop / restart / rm [--purge] / status / upgrade / port / creds-share / backup`。docker run 模板是安全承重面:`--init`(收僵尸)、per-tenant bridge network(防租户间横向)、`-p 127.0.0.1:<port>:3088`(仅回环)、named volume(SQLite WAL + inotify 要求 VM 内文件系统)、`--stop-timeout 35`(> server.ts 排空 18s)、`--memory 6g --cpus 4 --pids-limit 2048` |
| `gateway/` | 网关:users/sessions 两表(bun:sqlite,`~/.trellis-tenancy/gateway.db`);租户注册表读 `~/.trellis-tenancy/tenants/*.json`(tenantctl 写、网关读,双方唯一衔接);HTTP/SSE/WS 反代继承 server.ts 全部已付学费的坑(Host 改写 / 剥三头 / idleTimeout 0 / signal+duplex / redirect manual / Bun.serve 原生 WS);`selftest.ts` 12 项断言 + 120s watchdog |
| `launchd/com.smokingmouse.trellis-gw.plist` | 网关常驻模板(含 NumberOfFiles 4096——launchd 默认 256 是已知真实故障) |

宿主状态根 `~/.trellis-tenancy/`(0700):`gateway.db` / `tenants/*.json` / `env/<name>.env`(0600,TRELLIS_AUTH_PASS/TOKEN + 可选共享凭证)/ `backups/`。与单人版 `~/.trellis` 完全分开,互不影响。

## 日常操作

```bash
bun tenancy/tenantctl.ts build                      # 构建镜像 trellis:dev(git sha 可 --tag)
bun tenancy/tenantctl.ts add alice                  # 起租户:分配端口、生成闸凭证、等健康、打印一次性 PASS
bun tenancy/gateway/gateway.ts user add alice --tenant alice   # 网关建普通用户 → 打印旧式认领 URL
bun tenancy/gateway/gateway.ts user add admin --tenant host-admin --role admin  # 建管理员
bun tenancy/gateway/gateway.ts user invite alice    # 重新生成邀请(兼密码重置)
bun tenancy/tenantctl.ts status                     # 容器/健康/磁盘
bun tenancy/tenantctl.ts backup alice               # volume 打包到 backups/(升级前必做)
bun tenancy/tenantctl.ts build && bun tenancy/tenantctl.ts upgrade alice   # 升级(volume 数据无损)
bun tenancy/tenantctl.ts creds-share alice --claude-token "$(claude setup-token)"  # 共享房主年票
bun tenancy/tenantctl.ts creds-share alice --revoke # 撤销共享
```

租户 onboarding:开邀请 URL → 设密码 → 进自己的 trellis → 开 Web 终端跑 `claude login`(headless 贴 code 流程,实测容器内 OAuth URL 正常生成)→ 开聊。第三方端点:设置页配 endpoints.yaml(落在自己容器里)。

## 宿主接线(host-admin,S130 已上线)

管理员经同一网关入口登录、路由到宿主单人版实例。本机现状(2026-08-30 接线,全链实测):

- **host 路由记录** `~/.trellis-tenancy/tenants/host-admin.json`:手写三字段 `{name, hostPort: 3088, authToken}`,**不带 container 字段**(网关判 kind=host;tenantctl 枚举时按此跳过,别补容器字段)。
- **宿主 prod 开闸**:`com.smokingmouse.trellis` plist 的 EnvironmentVariables 加 `TRELLIS_AUTH_PASS` / `TRELLIS_AUTH_TOKEN`(= host 记录 authToken) / `TRELLIS_ADMIN_UI=1`,bootout+bootstrap 重启生效。凭证记录在 `~/.trellis-tenancy/env/host-admin.env`(0600,含 gw admin 登录密码)。
- **网关常驻**:`~/Library/LaunchAgents/com.smokingmouse.trellis-gw.plist`,WorkingDirectory=`~/.trellis/current`(与 prod 同 release,deploy 后需手动重启网关吃新代码)。**模板缺 EnvironmentVariables——必须补 HOME 与含 bun/docker 的 PATH**,否则自助注册 spawn tenantctl/docker 全挂。
- **入口语义**:多租户走 `http://127.0.0.1:3200`(gw 账号);直连 3088 是单人版闸口(/login 输 PASS),看不到 /__gw 功能属预期降级。

- **默认租户自带**:容器内 `claude login`,凭证落 volume 的 `~/.claude/.credentials.json`(Linux 文件存储,无 keychain 坑)。
- **房主共享**:`claude setup-token` 一年期 token 经 `CLAUDE_CODE_OAUTH_TOKEN` env 注入(官方 headless 路径)。**绝不拷 credentials.json**——refresh 轮换会让双副本互相作废(decisions.md 2026-08-04);也绝不拷宿主 `.claude.json`(feature flags 会让容器内初始化挂起)。
- 共享 = 交出:env 对容器内一切进程可见,租户能提取 token。撤销 = `--revoke`(或房主换 token)。

## 网络(2026-08-28 实测,fj-mt-spike-54c5)

宿主 Clash Verge TUN 模式**透明覆盖 Docker Desktop VM 出站**:容器内直连 api.anthropic.com / npm / claude.ai 全通(fake-ip DNS 被 TUN 接管成功),构建与运行期**都不需要代理配置**。备用:`HTTPS_PROXY=http://host.docker.internal:7897`(verge mixed-port,实测容器可达)。TUN 关闭时切备用。

## 威胁模型(接受的剩余风险)

- **租户间**:容器隔离 + per-tenant network + 每容器独立随机闸凭证。租户 A 的 YOLO agent 到不了 B 的文件系统和端口。
- **租户 → 宿主**:容器可经 `host.docker.internal` 访问宿主上绑 0.0.0.0 的服务(如 memos:5230、stirling:18080——建议改绑 127.0.0.1);Docker Desktop 本身是 VM,容器逃逸也到不了 macOS 层。租户实例跑的是可被 prompt 注入驱动的 YOLO agent,威胁模型 ≠ 朋友本人。
- **降级不是回滚**:sqlite 迁移只保前向;回滚 = 旧镜像重建,前提是没跨 user_version 迁移。升级前 `backup`。
- tmux scrollback 不跨容器重建(upgrade 会丢终端历史,数据不丢)。
- 网关登录限速 5 次/分钟(内存计数);cookie sameSite=strict 是 `/term` 隔站驱动攻击的主防御,不许降级为 lax。

## 公网接入(待接)

caddy 加站点块 → `127.0.0.1:3200`;验证 x-forwarded-proto 让 gw cookie 带 secure;全链 WS/SSE 过一遍真浏览器。域名与是否挂公网由房主拍板。

## 开机自愈链

Docker Desktop 开机自启(GUI 勾选)+ 容器 `--restart unless-stopped` + 网关 launchd KeepAlive(`launchd/` 模板,`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.smokingmouse.trellis-gw.plist`)。三者启动顺序无依赖(网关对容器 down 出维护页)。
