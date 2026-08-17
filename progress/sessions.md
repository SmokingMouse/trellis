# Session Log

最近 5 条，倒序（Session 98 / 97 / 96 / 95 / 94）。更早的见 `archive.md`。

### Session 98（2026-08-18，Tab 切换大延迟治理：HAST 渲染缓存 + 视口懒渲染）
- **触发**: 用户反馈会话节点多 / 内容大时，Tab 间切换延迟巨大。用户拍板范围 **P0+P1：连首次切换也治**。
- **根因**: 每次切 session，`apiNodeToChatNode` 铸造全新 node 对象击穿 React.memo，所有 done 卡片重跑完整 unified 管线（parse + remark + rehype-highlight + rehype-katex）。实测 40 个最大 done 节点（共 399KB）基线 **1149ms**。
- **Done（P0，新 `lib/markdown-cache.ts`）**: HAST 级缓存——按 `nodeId + content` 缓存管线产物树，重复挂载只跑 `toJsxRuntime`（近乎免费）。管线 + post-transform 忠实复刻 react-markdown v10 同步渲染路径（同插件、同 urlTransform、raw→text 兜底），文件头已标「升级 react-markdown 时需同步」。LRU 上限 200。
- **Done（P1，新 `hooks/useNearViewport.ts` + 接线）**: 线性阅读视图里视口外 done 卡片先挂纯文本占位（成本≈一个 text node，`aria-hidden` 防屏幕阅读器念原始 markdown 符号），滚到视口 800px 内才升级完整 markdown——首次切换也不必等全部卡片。占位高度在 IO 触发瞬间捕获，`useLayoutEffect` 里对 `[data-thread-scroll]` 容器做滚动补偿（仅当卡片原本在视口上沿之上），消除升级高度跳动；锚点跳转目标 `force` 立即渲染（marks 滚动闪烁依赖 markdown DOM）。
- **接线面**: TurnCard `ResponseBody` + `ReferenceFullBody`、ChatNode done 分支（画布不做懒渲染，canvas 会话 ≤20 节点）；流式分支保持原样（流式期间本就只跑最小 rehype）。其余 ReactMarkdown 消费者（CardImageButton / InteractionForm / FilePreview / ZoneEditor / HoverPreview）是小内容或按需渲染，不在热路径，未动。
- **验证**: ①等价性——真库 40 个最大 done 节点双路渲染（react-markdown 同步组件 vs `renderCachedMarkdown`）`renderToStaticMarkup` 逐字节比对 **40/40 一致**；②性能——同批基线 1149ms → 缓存冷 828ms → **缓存热 193ms（6x）**，P1 懒渲染让首次切换只渲染近视口约 10-20 张；③tsc 零错；④eslint 改动文件零新增（git stash 基线对照）。
- **已提交合并推送**: `04250dd`（特性分支 `perf/markdown-render-cache`）→ `--no-ff` 合 main（`3e513c2`）→ push `origin/main`。
- **已部署上线（`ebce0d176`）**: smoke 全绿、DB 备份、verify ready。**本机部署坑（重要）**：devbox 的 shell `HOME=/home/zhangpeng.pada` 是指向 `/data00/home/zhangpeng.pada` 的符号链接，直接 `make deploy` 会让 Turbopack build panic（`Invalid distDirRoot: ".next". distDirRoot should not navigate out of the projectPath`），且 deploy 预检会误报 systemd 单元工作目录不符（同一 inode 的字符串比较）。**正确姿势：`HOME=/data00/home/zhangpeng.pada make deploy`**（顺带让预检字符串对上，无需 `--force`；`TRELLIS_DEPLOY_ROOT` 单独给没用，build 仍 panic）。systemd 单元里 `HOME=/data00/...` 是刻意修过的（注释：Turbopack root 解析），别跑 `make install-service` 把它改回符号链接路径。
- **Next**: 用户真机点一轮长会话 Tab 切换确认体感（重点：快速滚动时占位升级有没有可见跳动、锚点跳转是否还准）。可选：把缓存扩到其余预览 / 编辑面。

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

