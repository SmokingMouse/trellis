# Session Log

最近 5 条，倒序（Session 97 / 96 / 95 / 94 / 93）。更早的见 `archive.md`。

### Session 97（2026-08-16，处理 PR #14：大门反代接通客户端 abort，修 fd 泄漏静默卡死）
- **触发**: 用户「处理一下 GitHub 上的 PR」。唯一 open PR = #14（Aaron7621 = 二号机）：`server.ts` 两处反代 fetch 各加 `signal: req.signal`，把客户端断开传导给上游——SSE 遗弃连接把 launchd maxfiles(256) 打满后 accept 拿不到 fd，TCP 握手仍由内核 backlog 代答，成「端口通、进程活、应用层一字节不回」的静默卡死（二号机 8/6 挂 4 天、8/10 一天两次，KeepAlive 不救，只能 kickstart）。
- **Review 核实（逐条过下游代码，不是只读 PR 描述）**: ① 泄漏机制成立——两处 fetch 均未传 signal 且 `new Response(r.body)` 包装转发，断开不会自动传导到内层；② 「断开不杀 run」属实——chat 路由 onAbort 只 `unsubscribe(); close()`，run-bus Stage 17 注释明确 Run 自持 AbortController、落库走 appendNodeResponse 与订阅无关，`nodes/[id]/stream` 同模式；③ tasks/events、cli-sync/events 的 SSE teardown 本来就挂在 req.signal 上等着被接通；④ references 行为变化（关页面 → 抓取中止落 error）收尾路径核实：abort → catch → finalizeReferenceFetch 落库，无僵尸 streaming 卡；⑤ WS 路径 upgrade 在 fetch 之前，不受影响。
- **本地复核插曲**: PR 分支 tsc 先报 `lib/markdown-plugins.ts` 缺 rehype-katex/remark-math——不是 PR 的锅，是本地 main 落后 origin（katex、机器资源状态等已在远端），`git pull` + `bun install` 后 PR 分支 tsc 干净。本机 Bun 1.3.14 与 PR 靶场版本一致（repo 未锁 Bun 版本，修复依赖 Bun 的 req.signal 断开语义）。
- **处置**: approve 留两条非阻塞备忘（`/term` 路径 fetch 无 try/catch，客户端在响应头前断开抛的 AbortError 目前靠 Bun 静默吞掉——实测行为、非文档保证，升 Bun 时留意；转发 Next 的既有 catch 现在也会捕获客户端 abort，将来若要在 catch 里统计「Next 挂了」需先甄别 AbortError）→ merge commit `2967653` 进 main（沿仓库 merge-commit 惯例）。故障尸检已长存于 server.ts 内联注释 + PR #14 正文，不另开 failures.md 条目。
- **Done（同 session 续，用户「开始吧」授权清账）①部署**: `make deploy` 上线 `f106885`（S95 授权监控 + S96 SDK 0.5.1 + katex + 机器资源 + PR #14 一次到位），smoke 全绿、闸 on→on、旧 release gc。**PR #14 生产实证**：8 条 SSE 挂着时大门上游连接 8 条、客户端断开 3s 后归零（修复前断 8 泄 8）。build 期有条既存 Turbopack NFT 警告（workspaces/mkdir 路由 trace 到整个项目），非本次引入，未拦部署，留观。
- **Done ②验收四项全过**（agent-browser 真浏览器，:3088 prod）: S91 sameSite=strict——直接输地址登录无感、刷新登录态持久；S95 授权卡——真渲染正确（claude 绿灯 max/refresh 至 9-2 剩 16 天，codex 绿灯 ChatGPT），「重新探测」正常，**手机推送送达仍留用户确认**；S94 卡片图弹窗——预览+双按钮+Esc/scrim 关闭+暗色全过，headless 下复制被拒时按钮就地提示「复制失败，请用下载」（S94 要的正是不再静默），真手势下的复制成功留真人一点。
- **Done ③S75 hydration 悬案破案修复**（细节全链在 failures.md 已结案区）: 根因 = 用 127.0.0.1 访问 Next 16 dev 时 HMR WS 被 origin 校验静默掐死 + dev 的 hydration promise 与该 WS 绑死（上游 #91770）。修 = `next.config.ts` `allowedDevOrigins` 常驻 `"127.0.0.1"`。S75 的 CSS 假设证伪，`::highlight` 规则无辜还原。修后 127.0.0.1 访问 dev：fiber 0→26、交互复活。tsc 零错。**方法论教训**：七个环境假设（CSS/headers/runtime/bundler/版本/扩展/代理/headless）全灭后才转向框架内部等待链——对零报错的静默故障，应更早从"卡在哪一个 await"入手而不是枚举环境。
- **Next**: 用户手动项——①手机确认 S95 推送送达 ②S96 二号机四步（~/.claude 推送、CPA_API_KEY、二号机重部）③ BOE 部署（devbox 手跑）。可选小加固：launchd maxfiles 调大（纵深防御）、`/term` fetch 包 try/catch。管理台批 1-6 验收未做。

### Session 96（2026-08-05，二号机双怪象破案：codex「未登录」是配置漂移伪装、claude「已登录」是环境变量 token）
- **触发**: 用户在二号机截图两怪象——「指定了 provider 却报 codex 未登录」+「没登录过 claude 却显示已登录 · oauth_token」。两个都不是字面上的问题。
- **诊断①（codex）**: 报错串只存在于 SDK 登录闸，0.5.0 起注入模式会跳过闸 → 触发只可能是 `configOverrides` 为空 = 解析降级。根因铁证：**cpa 的 `codex: wire_api: responses` 标记躺在本机 `~/.claude` 的未提交改动里**（`git -C ~/.claude diff` 实证），二号机靠 git 同步 → 它的 yaml 无标记 → 静默透传 → 撞闸。旧版 `resolveCodexModel` 一揽子 catch 把「yaml 没同步 / key 缺失」全吞成透传，配置漂移于是伪装成登录问题。**即使同步了 yaml 还差第二件**：`CPA_API_KEY` 在 `~/.agent-gateway.env`（机器本地、gitignored），二号机没有。
- **诊断②（claude）**: 逐来源实测 `claude auth status --json` 映射——本机交互登录 = `claude.ai`+email+订阅；`ANTHROPIC_AUTH_TOKEN` **或** `CLAUDE_CODE_OAUTH_TOKEN` = `oauth_token`+email/订阅全空（与截图吻合）；**塞假 token 照样 loggedIn:true**（status 只看有没有、不验真）。即二号机 trellis 进程 env 里有这两个变量之一（devbox 内部网关的可能性最大），卡片如实转述了一个语义比字面宽的「已登录」。
- **Done（SDK `@smokingmouse/agent@0.5.1`，已发 npm + push `31cb7d8`）**: `resolveCodexModel` 拆掉一揽子 catch——端点在 yaml 但无标记 → 仍透传（opt-in 语义不变）但带 `degraded` 原因；已标记但 key 缺失 → `fatal` 直接报错不 spawn（配置自相矛盾时静默换鉴权路线 = 把配置错误变成别的症状）；登录闸报错永远带诊断（degraded 原因或通用指引）。**四分支子进程实测**（SM_ENDPOINTS_PATH 指 yaml 变体 + 假 codex 二进制）：key 缺失点名 env var ✓ 无标记+未登录报「yaml 没同步」✓ 标记+key 齐全时假 codex login 恒 exit 1 仍 NO_ERROR（闸被跳过）且 argv 含注入、spawn env 含 key ✓ 原生名给通用指引 ✓。
- **Done（trellis）**: `auth-health.ts` 把 `oauth_token` 翻译成「环境变量 token」+ 来源警告（含「status 不验真」）；codex 那句「第三方 provider 路径不受影响」改成有条件表述（要求标记+key，并提示 SDK ≥0.5.1 报具体原因）。dep bump `^0.5.1` 从 registry 装，facts 清单三连 ✓（真目录 / 0.5.1 / dist 里 grep 到新错误串）。tsc 零错、eslint 零新增、假 env token 下探针实测出新语义。
- **二号机待办（都是用户手动，代码层已闭环）**: ① 本机 `~/.claude` 提交推送（**codex 标记还在未提交改动里**）→ 二号机 pull；② 二号机 `~/.agent-gateway.env` 补 `CPA_API_KEY`（值同本机）；③ 二号机重部 trellis 拿 0.5.1；④ 本机 prod 也要 `make deploy`（S95+S96 都没上线）。做完后二号机再选 cpa provider：若仍报错，错误信息这次会直说缺哪样。
- **Next**: 用户跑二号机四步 + 本机 deploy；验收队列照旧（S91 三处 + 管理台批 1-6 + S94 弹窗 + S95 授权卡）。

### Session 95（2026-08-04，授权健康 T0+T1：状态卡 + 到期预警，把「挂 6 天没人知道」封死）
- **触发**: 用户「有可能把 claude 和 codex 原生授权在平台上可以控制吗」。调研（claude-code-guide 权威查证 + 本地实测 + happyclaw 对照）后用户拍板：**T0+T1 先落地**，托管隔离（`CLAUDE_CONFIG_DIR` + setup-token 年票注入）等 BOE 多机坐实再上 —— 决策与 happyclaw 对照记 `decisions.md` 本日条。
- **调研拿到的抓手**（细节见 decisions 条）: `claude auth status --json` 是官方状态出口（2.1.207 实测）但**不含过期时间**，过期只能读 credentials.json（非公开 API，解析失败一律降级）；`CLAUDE_CODE_OAUTH_TOKEN` env 存在（认证优先级第 5，接 setup-token 一年期年票，设了就跳过本地凭证查找）；codex 有 `login --with-api-key` / `--with-access-token` 的 stdin 无头登录；**happyclaw 的做法 = 平台自持 Claude Code client_id 走 PKCE + 每 spawn 物化 .credentials.json 进独立 CLAUDE_CONFIG_DIR、绝不碰 ~/.claude —— 但平台侧从不 refresh（15 天保质期到了 UI 重新 OAuth），codex 零处理**。
- **Done（T0 状态可见）**: `lib/server/auth-health.ts`（探测 = auth status + credentials.json 时效 + **keychain 分叉哨兵**（S93 复发检测：副本落后文件 48h+ 即警）+ codex login status；30s 缓存）· `app/api/auth-health/route.ts` · `components/AuthHealthCard.tsx` 挂 `/settings/models` 顶部 —— 判断全在服务端，卡片只渲染，**预警与卡片共用同一份判断**，不会「卡片绿着、手机在报警」· TurnCard / ChatNode 错误卡对认证类错误多一行「→ 查看授权状态」出口（`lib/auth-error.ts` 判据，误报代价为零所以判宽）。
- **Done（T1 预警）**: scheduler 启动即查 + 每小时 :07 复查（跟 `TRELLIS_SCHEDULER` 闸走，smoke 实例不发真预警）；硬条件（claude 缺失 / 未登录 / refresh 已过期 / 将过期 <72h / keychain 分叉）→ notify 推送，24h 去重落 `~/.trellis/auth-alerts.json`。notify.ts 扩 `auth_alert` kind（taskId/runId 放宽可选）；**`~/.trellis/notify.json` 从缺失配到有**（bark-push.py，--group trellis --level timeSensitive）—— 此前 notify 一直是 no-op。顺带：claude-缺失告警让 S91 点名的「nvm 升级后 plist PATH 失效」隐患第一次有了可见症状。
- **验证**: tsc 零错 · eslint 4 条全既有（`git stash` 基线对照完全一致，我的文件零新增）· 模块直调（`bun --conditions=react-server`）：真机数据正确（claude max / refresh 至 8-20；codex ChatGPT）、健康态零误报零状态文件 · notify 链真推一条测试（执行无异常；**送达以手机收到为准**）· route handler 直调 200 · dev 编译零错（:3402 起停已清理；API 在 dev 里被既有 401 中间件拦，属预期）。**未验**: 卡片真浏览器渲染（dev 水合是 failures.md 开放故障，SSR 只出骨架）—— 部署后看一眼；每小时 tick 分支（与启动分支同一函数，只差触发时机）。
- **Next**: 部署后 ① 开 `/settings/models` 看授权卡真渲染 ② 手机确认「trellis 预警通道测试」推送收到（没收到 = bark 链路问题）③ 验收队列照旧（S91 三处 + 管理台批 1-6 + S94 弹窗、BOE）。T2（平台内重登录）/ T3（托管隔离）等 BOE 提上日程再开。

### Session 94（2026-08-04，卡片图改 happyclaw 式预览弹窗：复制 / 下载由用户选）
- **触发**: 用户反馈卡片图「必须把图片下载下来」，要像 happyclaw 那样点开后自选「下载」或「进剪贴板」。
- **根因**: 旧 `CardImageButton` 是自动写剪贴板、失败**静默降级**成下载 —— html-to-image 的异步渲染耗尽浏览器的用户手势时效，剪贴板写入总被拒，于是永远只会下载，且用户不知道为什么。
- **Done**: `components/CardImageButton.tsx` 重写成 happyclaw `ShareImageDialog` 的形态：点击 → 渲染 PNG → 预览弹窗 + 底部「复制图片 / 下载图片」双按钮，复制发生在按钮点击瞬间（blob 已备好，手势新鲜），失败就地在按钮上提示改用下载。弹窗复用 `ui/Modal`，但经 `createPortal` 挂到 body —— TurnCard 在 React Flow 的 transform 节点内，直接渲染 fixed 弹窗会锚到节点而非视口。渲染链路（离屏卡片 + html-to-image）未动。
- **流程教训（又一次）**: 在 main-2 worktree 里干活，一开始直接写了共享的 `sessions.md`/`archive.md`，收尾才发现主 worktree 有并行 session（S93 launchd 破案）动了同两个文件且撞了编号 —— `parallel-worktree.md` 的铁律（并行期只写 `blocks/<slug>.md`）第二次被违反（第一次是 S88）。按串行收尾处理：main-2 退回共享文件只提交源码 → 先提交对方 S93 记录 → `--no-ff` merge → 本条按 S94 叠上。
- **验证**: main-2 里 `bun install` 后 tsc 零错、eslint 对该文件零告警。**真浏览器未点过。**
- **Next**: 浏览器里点一轮（复制进剪贴板 / 下载 / Esc 与 scrim 关闭 / 暗色模式下预览底色）；跟 S93 的验收队列一起走（S91 三处 + 管理台批 1-6、BOE 部署）。

### Session 93（2026-08-04，S90 认证失败破案：launchd 上下文的 claude 读的是 keychain 里过期的凭证副本）
- **触发**: 用户截图 prod 聊天发 "hello" 报 `Failed to authenticate: OAuth session expired and could not be refreshed` —— 正好回答 S90 留的判定题：**普通聊天同样死 → 实例级故障，与任务链路无关**。
- **破案路径**: 错误串 `rg` 下来只存在于 claude.exe 二进制里（SDK / trellis 代码零嫌疑）→ 全机唯一 claude = nvm 的 2.1.207（7-13 装的，与故障时点无关），plist PATH 解析到同一个 → **一次性 launchd job（不经 trellis 任何代码）裸跑 `claude -p` 完整复现**：80ms 失败、`duration_api_ms: 0`（本地判死，网络请求都没发）；`env -i` 逐字同 env 在终端跑 → 成功（真调 API 4s 返回 "ok"）。唯一剩余变量 = launchd vs 终端的 macOS 安全上下文。
- **根因（launchd 探针钉死）**: Claude 凭证存了两份且已分叉 —— `~/.claude/.credentials.json` 由终端 claude 持续刷新（当天 16:16 mtime，refresh token 有效到 8-20）；Keychain `Claude Code-credentials` 项 **7-26 起停更**（mdat），内容是旧格式短 JSON（281B vs 文件 509B），`refreshTokenExpiresAt = 7-26 02:48`。launchd 上下文里 keychain 与文件**都可读**（探针实测），claude 在该上下文选了 keychain → 读到死 token → 时间戳一比对直接报错。与「nodes 表 7-28 10:52 后再无 done」吻合。
- **S90 五条排除为何全扑空**: 全部在终端做 —— `env -i` 能复制 env，复制不了「不是 launchd」这件事，而判别维度恰恰是上下文本身。
- **修复（用户点头后执行）**: `security delete-generic-password -s "Claude Code-credentials"` 删掉已死副本 → 所有上下文回退到新鲜的文件。不选「文件→keychain 同步」：refresh token 单次轮换，两份活副本必再分家、复发。
- **验证**: ① 同一 launchd 复现 job 转绿（修前 80ms 本地判死，修后真调 API 3.2s 返 "ok"）② 真 prod 进程端到端：trellisctl 建 chat 模式任务实跑 → run `45350b21` **done / 3s / 6 token**。顺带摸清 trellisctl 语法：`tasks run` 要完整 UUID（列表只显示 8 位短 id）、`tasks create` 收 JSON 体、无 workspace 必须 `"contextMode":"chat"`。③ /tmp 探针已清。**测试任务 `2c66ce0d`（authfix-verify）留在库里** —— trellisctl 没有 `tasks delete` 子命令，管理台 `/settings/tasks` 可删；S90 的 `bffbe8ed` 也还在。
- **落档**: `failures.md` 结案（resolved）· workspace.md 凭证表 + 复发坑表各加一行 · auto-memory 记「launchd-claude 凭证分叉」。复发哨兵：keychain 条目重新出现且 mdat 冻结。
- **Next**: prod 已复活；回到验收队列 —— S91 三处改动 + 管理台批 1-6 验收、BOE 部署（S88 遗留）。

