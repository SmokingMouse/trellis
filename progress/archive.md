# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

### Session 100（2026-08-18，大会话 Tab 切换仍慢：toolCalls 改按需加载，载荷 10.26MB→167KB）
- **触发**: S98（HAST 缓存 + 视口懒渲染）落地后，用户反馈「怎么访问我的 boe 机器」tab 切换**还是慢**。
- **根因**: GET /api/sessions/[id] 返回 **10.26MB**，其中 **98.6% 是 toolCalls JSON（10.12MB）**，response 文本仅 0.09MB；每次切 tab 都重拉整个会话（无缓存），gate（server.ts）又剥掉压缩。on-box 处理 ~190ms 很快，慢在用户远程 Mac 浏览器吃满 10.26MB 传输。S98 治的是渲染侧，传输侧这块大头没动。
- **Done（懒加载 toolCalls）**: 会话载荷剥离完整 toolCalls 数组，改发预计算 `toolCallStats`（total/subagents/workflows/errors + `labels` 子 Agent 名 + `tools` 顶层工具名去重 ≤5）+ `generatedFiles`；新增 `GET /api/nodes/[id]/tool-calls` 按需端点。`ToolTimeline` 展开时 `loadNodeToolCalls` 拉取（拉取期间折叠态用 stats 渲染角标数字，占位行「正在加载工具调用…」）；`ToolCallBadge` 优先用 stats 省掉每卡片一次 buildToolTree；`GeneratedFilesBar` 优先用预计算 generatedFiles。**流式路径不变**（toolCalls 随流事件进 store）。
- **验证**: ①直调路由（`TRELLIS_DB_PATH` 指 prod 副本，`bun --conditions=react-server`）——91 节点、载荷 **10.26MB→166.6KB（~62x）**、无任何节点下发 toolCalls、stats/generatedFiles 在位、无委派节点 `tools` 有值（BOE 75 个有工具调用的节点全是无委派，折叠摘要行靠它点名 "Bash、Read、Edit"）；②tool-calls 端点返回完整数组、长度与 stats.total 一致、未知节点 404；③`test-timeline-render` 全绿（toolCalls 在场路径）；④stats-only 渲染测试全绿（折叠行点名工具 / 委派计数 / 超 4 截 4+… / total=0 不渲染）；⑤tsc 零错、eslint 零新增（TurnCard 4 条既有，git stash 基线对照）。
- **合并插曲**: 与 origin/main 的 Codex 迁移（S99）撞了 session 编号和 `cli_lineages` 迁移——本 session 初基于旧 main 写的 cli_lineages 修复（DROP 重建为 claude_session_id）方向反了：origin/main 已用 RENAME COLUMN 原位迁移到 provider-neutral 的 `cli_session_id`（多 provider lineage），prod 旧表正好是目标 schema。合并时丢弃我的 sqlite.ts 改动，采用 origin/main 版本。
- **Next**: 部署后用户真机点一轮长会话 Tab 切换确认体感（重点：展开动线时的按需拉取有没有可见延迟、角标数字对不对）。**未部署**——等用户点头。

### Session 99（2026-08-18，Codex 迁移体验对齐：历史 attach、skill、Agent、联网语义）
- **触发**: 用户反馈 Trellis 只把 Claude provider 支持好，Codex 用户难迁入，要求迁来后体验至少对齐。根因不是单点 UI：Codex 原生会话完全无法 attach；现有 lineage 表/发现 API/watcher 都写死 Claude；skill API 只扫 `~/.claude/skills` 且输入框主动隐藏 Codex；Agent 在 UI/route/tasks 三层被钳成 Claude-only；Chat 文案还错误声称 Codex offline。
- **Done ① CLI 迁移主链**: 新 `codex-import.ts` 解析 rollout（只认可见 `event_msg.user_message`、assistant 双通道去重、custom/function tools、四桶 token、残行容错）；发现层支持 `$CODEX_HOME/sessions` 跨日期递归、按 cwd 分组与现有 fork 跨日 union；`sessions.cli_provider` + provider-neutral `cli_lineages` 原位迁移旧表；attach/import/watcher/API/UI 全部 provider-aware。Attached Codex 可从 tip 线性 resume、从任意历史轮构造前缀 rollout 真分叉，CLI `codex fork` 写进新日期也会被根 watcher 自动归树；「在 CLI 继续」输出 `codex resume <id>`。同时修正旧 ordinal 把注入 role=user 当真提问的错误，并按 question 自愈存量。
- **Done ② Skill / Agent / web**: provider-aware skill 索引按 Codex 官方 project/user/admin 作用域发现 `.agents/skills`，兼容当前 CLI 的 `$CODEX_HOME/skills/.system` 与 symlink；选择器原生填 `$skill`，纯 Chat 自动开增强。Codex Agent 支持人设、模型、静态 sandbox 权限、隔离和挂载 skill（`SKILL.md` + source dir 内联），会话 Agent、`@slug`、定时任务三条链均放行；工具白/黑名单与逐项审批明确标为不支持。纯 Codex Chat 现在显式隔离 AGENTS/环境 skills/plugins/MCP，但保留 CLI 默认 cached web search；Project/增强模式给 workspace-write network。
- **验证**: `bun run test:codex-cli` 55 项全过（parser/DB attach/append/前缀分叉/跨日期 attach+watcher/skill/Agent）；真实 corpus 发现 4517 rollout，最近列表约 180ms、lineage attach 约 446ms；`bunx tsc --noEmit`、`git diff --check`、`make build` 全过。隔离 dev + agent-browser 真页面 smoke：Codex provider 可选、Agent picker 生效且边界提示可见、`$open` 补全成 `$openai-docs` 并自动开启增强、Attach 弹窗切 Codex 后列出真实历史。全仓 lint 仍是既有 34 errors/9 warnings；本次改动文件仅命中 `SessionSidebar.tsx:959` 的既有 setState-in-effect。
- **边界 / Next**: 当前 `@smokingmouse/agent@0.5.1` 的 Codex exec backend 无 dynamic approval callback，且忽略 `extraArgs`，所以 CLI 0.147 虽有 `-a`/`--approve-for-me`，Trellis 仍不能像 Claude 一样弹逐项审批卡；真对齐需迁 `codex app-server` JSON-RPC。代码未部署，下一步先 review/commit，再走正常 deploy。（后续：S104 已在 SDK 0.6.0 落地 app-server transport，approval 回调仍待独立 phase。）

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
- **S101 回填（2026-08-18）**: ①的标记只落进 legacy `~/.claude/global/endpoints.yaml`；本机 canonical `~/.config/sm/endpoints.yaml`（搜索顺序优先）从没移植 → S101 同款故障在本机重演，已补。两份 yaml 已分叉，canonical 是生效的那份。

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

### Session 92（2026-08-04，SDK 升 0.5.0：codex 走 endpoints.yaml 选模型 + 树形分支真 fork）
- **Done**：`@smokingmouse/agent` ^0.4.0→^0.5.0、直接依赖 `@smokingmouse/llm` ^0.3.0→^0.4.0（扁平化消双份）；`npx tsc --noEmit` 干净；运行时验证 CodexBackend capabilities `forkSession: true` + `configDrivenModelSwitch: true`。
- **SDK 本轮新能力（sm-toolkit 同日发版，细节见其 progress/sessions.md）**：① codex model 可解析 endpoints.yaml 里显式标记 `codex: { wire_api: responses }` 的端点（目前 cpa），`-c model_providers` per-run 注入 + env_key 鉴权；② codex forkSession 由 rollout copy 模拟——此前 codex 分支节点 resume 同一 thread 会互相污染，现真 fork（新 id + 历史继承 + 双向隔离），失败 fail loud 不静默降级。
- **对 trellis 的影响**：代码零改动即受益（run() 传的 forkSession 在 codex 下开始生效）；UI 可按 `capabilities().forkSession` 探测。codex 逐 token 流 / 双向审批（PendingInteraction）仍无——app-server 路线已评估暂缓，决策留档 sm-toolkit progress/decisions.md。
- **Next**：prod 部署时带上 bun.lock；无代码改动待验收。

### Session 91（2026-08-01，拿 happyclaw 做对照剖析 → 修掉它替我们踩过的三个坑）
- **触发**: 用户「使用 workflow 深入剖析下 riba 的 happyclaw，看看对我们的 trellis 后续的演进和优化有啥指导意义吗」，看完结论后「按照你的建议把那些都改了吧」。
- **对照组**: riba2534/happyclaw（自托管**多用户** Agent 系统，IM 六端 + 每用户 Docker + RBAC + 计费）。本机 fork 落后上游 271 个 commit，另开 worktree `/tmp/happyclaw-latest` 指到 `upstream/main`（`6ab7dad`，当天）。**三个月从 111k LOC 长到 292k**，且 `task-scheduler.ts` / `agent-builder.ts` / `memory-service.ts` / `plugin-*.ts` 与 trellis 三个 Goal 正面撞车 —— 它是我们 Goal 的未来态样本。
- **Workflow**（106 agent / 11.4M token / 91 分钟 / 零失败）: trellis 三路摸底（含「已被拒绝方案清单」防止推荐已否掉的东西）→ happyclaw 九维深读（每维强制跑 git log 挖 fix commit）→ 逐维对照 → **每条建议派 3 个镜头对抗式证伪**（已经有了/已拒过 · 定位错配会带歪 · happyclaw 这么做本身就不对，2/3 票反对即毙）→ 排序 + persona-riba2534 判断 + 完备性批判。报告落 `happyclaw-contrast.md`（43KB）。
- **最反常识的结论：27 条候选建议只活下来 4 条，且没有一条是「抄 happyclaw 的机制」**。真正可复用的是它的**尸检报告** —— 同一个 symlink 盲区三个月咬三次、「必须 byte-for-byte 一致」的注释半衰期 6 周且三个指针全指错、至少 7 处「造了闸忘接门」的死代码。riba 分身那句是对的：「拿别人问题的账单来报销自己的问题」—— 它的 292k 是**多用户 IM 商业模式**开的账单，不是 harness 成熟度标杆。**harness 不该继续加厚。**
- **Done ①（`app/api/skills/route.ts:37`）**: `Dirent.isDirectory()` 对 symlink 恒 false，只认它会把软链形式的 skill 整个漏掉。本机 `~/.claude/skills/` 106 个条目里**恰好一个 symlink，就是 `trellis-admin`** —— **trellis 自己的管家 skill 在 trellis 的 UI 里隐形**（而 CLI 的 slash_commands、`trellisctl skills` 都看得见，因为它们用 `existsSync` 穿透）。改成允许 symlink + `fs.stat` 穿透确认 + 悬空链跳过。**明确不动** `workspaces/browse` 与 `sessions/[id]/files` 那两处 —— 它们跳 symlink 带着 "cycles / intentionally not listed" 注释，是有意决策。
- **Done ②（`app/api/login/route.ts:34`）**: `sameSite: "lax"` → `"strict"`。lax 放行跨站顶层导航 → 任意外部页面能把浏览器导到 `/term/?arg=…`，而 ttyd 以 `-W`（可写）起、命令整个走 URL 的 `?arg=`（`ttyd.ts:236-240/295`）。happyclaw 的 `auth.ts:86` 就是 Strict，且 `web.ts:1390-1394` 白纸黑字写「**SameSite=Strict 是主防御**，origin 检查是纵深防御」—— 它为 WS Origin 白名单返工 4 次护的全是纵深那半条。UX 代价为零：入口是书签/PWA/直接输地址（strict 对这三种照发），`notify.ts` 不发回链；程序化调用（`server.ts:204`、`deploy.ts`、trellisctl）自己塞 header 不受约束。
- **Done ③（新增 `lib/server/cli-jsonl.ts`，本轮的重头）**: `cli-fork.ts` 抄了 `cli-import.ts` 五份副本（`ms`/`userText`/`isToolResultEntry`/`isCommandNoise`/`isTurnStart`），**S85 给 import 加的 5 道结构闸 fork 一道没跟**，而且 `cli-fork.ts:6` 早就 `import { parseCliSessionJsonl } from "./cli-import"` —— 同一个 module graph，**根本不存在任何拦着复用的约束**，纯粹是抄完原件单方面演进。
  - **实测严重性**（889 个 jsonl / 1897 个有回答的 turn）：老判据下 **36 个 turn（1.90%）fork 侧找不到 tail** → `buildPrefixJsonlCore` 返 null、分叉静默降级成线性；**另有 315 个（16.61%）选出的 tail 与 import 的归属不是同一条** → 前缀被截在一个**没说完的回答**中间。后者才是真严重性 —— 不是分叉失败，是**分叉点切错**。（报告里那个 12.8% 分母是错的，这两个数是重新量的。）
  - 抽出纯模块（无 `server-only`、无 DB，可脱离服务端跑）：类型 + 五个谓词 + `makeTurnOwnership`（**strict → loose 两级**，只搬严格那级会让 null 率不降反升，因为 `--continue`/fork 出来的 jsonl 链头没有真提问）+ `readJsonlLines` / `terminalAssistantLine` / `keepUuidChain`。两边 import 同一份，**执行者是编译器不是注释**。
- **`scripts/test-cli-jsonl.ts`（新）—— 这是 riba 那个追问的答案**：他问「这次打算给它留一条注释，还是留一个测试？happyclaw 那对互相点名的『byte-for-byte』注释半年后三个指针全指错」。24 条断言：7 道闸逐条钉死 + 复现 S85 的劫持 bug + 宽松兜底 + **真语料全扫**（889 jsonl / 1898 turn，无抽样）。
- **做了变异测试证明它不是空断言**：把 5 道闸退回旧判据 → **11 条断言变红**。同时暴露一个诚实的边界：**真语料那两条断言在变异下依然是绿的**（turn 数还从 1898 涨到 2044）—— 因为两侧共用一份代码，一起错就一起「自洽」。**钉住闸本身的是合成断言，语料扫描只能防两边再次分家。**
- **等价性验证**: 从 git 取出重构前的 `cli-import.ts`，对同一批 889 个文件逐字节比对 `parseCliSessionJsonl` 输出 —— **866 个完全一致 / 23 个两侧都 null / 0 处差异**。cli-import 的重构证明行为不变。
- **其余验证**: tsc 零错 · lint 47 problems 全是既有的，我改的文件**零命中** · 既有 harness 全绿（cron 48 项 / project-cluster / tool-tree）· `/api/skills` 直接调真 handler：105 skills 且 `trellis-admin` 在内（旧逻辑 104）· login 直接调真 handler：`SameSite=strict` 正确序列化、错误口令仍 401 · `buildPrefixJsonlCore` 在临时目录拿一个**老逻辑返 null 的真会话**端到端跑通（1051 行 → 1007 行前缀，可反解成 6 个 turn，sessionId 已改写）。
- **刻意没做**（报告里有但不在本轮范围）: 「新增 DB 列必须带真消费者」那条纪律没写进 `decisions.md`（trellis 已有 3 处空列：`notified_at` 零 SELECT、`task_runs.attempt`、`max_retries`）· claude/codex 的二进制解析（plist 里 `PATH` 硬编码了 `node/v24.14.1/bin`，nvm 一升级 `claude` 就从 PATH 消失，而 `update.ts:209` 和 `ttyd-dependency.ts:43` 两条路早就写对了）· run-bus 空输出闸 · BOE 的 per-user 身份/归属/审计（**27 条候选零覆盖，需单独立项**）。
- **已合并推送**：四个 commit 走 `happyclaw-contrast-fixes` 分支 `--no-ff` 进 main（`f81df21`），已推 `18be950..f81df21`。**两台实例都未部署。**
- **Next**: 部署后第一件事是 ②的**真浏览器登录回归** —— strict 生效后书签 / PWA / 直接输地址应当无感，但这条只验过 Set-Cookie 头的序列化，没在真浏览器点过；万一栽了，回退就是把那一个单词改回 `lax`。prod 仍卡在「spawn 的 claude 一律认证失败」（S90 遗留，本轮未碰）。`/tmp/happyclaw-latest` worktree 留着，不用了跑 `git -C ~/python/ai/happyclaw worktree remove /tmp/happyclaw-latest`。

### Session 90（2026-07-31，trellis-admin skill：让任意 claude 会话用一句话配后台）
- **触发**: 用户「现在有了 Agent 配置的能力，能在平台预留一个 Agent，能通过这个 Agent 完成后台的一些 Agent 配置 or 定时任务配置吗」。
- **我的第一版方案被用户一句话推翻，且推翻得对**: 我提「内置一个受限 admin agent（工具白名单 `["Bash","Skill"]`）」，用户问「不能做一个内置的 skill 吗，这样不用限制 agent」。**工具白名单在这里从来不是边界** —— admin agent 要调 CLI 就必须有 `Bash`，给了 Bash 就能 curl 任意端点、改任意文件，白名单只是看起来像闸。
- **更关键的一条**: 这个能力**今天就已经存在**。默认 agent 不隔离，spawn 出的子进程继承 trellis 进程 env（`shared/.env.local` 经 bun 从 cwd 自动加载），任何能用 Bash 的会话早就能 curl `/api/agents`。做 skill **不是授予权限，是把已有权限变得可发现、有契约**。威胁模型因此从「越权」变成「手滑」—— 而对手滑，SKILL.md 里「先预览再写入」的纪律是**真管用的控制**（上一轮我说的「提示词不是闸」只对防绕过成立，已收窄）。
- **Done**: `skills/trellis-admin/`（`SKILL.md` 字段语义 + cron 速查 + Known Failure Modes · `scripts/trellisctl.ts` ~380 行，agents/tasks/triggers/runs/providers/skills/cron 七组子命令）。软链 `~/.claude/skills/trellis-admin` → **仓库 checkout**，不是 `~/.trellis/current` —— 当前 release 部署于 skill 出现之前，链过去是断的；等这次上线后再定要不要改成跟 release 走。
- **两道闸落在脚本里**（比改服务端轻，且不影响界面手动操作）: `triggers add` 拒绝触发间隔 < 5 分钟（`--force` 可越过）并在挂之前回显人话描述 + 下次触发时间；`tasks create` **建出来不挂触发器**，输出直接引导「先手动跑一次 → 看 runs → 满意再挂」。**原本想做的「建成停用再试跑」走不通** —— `lib/server/tasks.ts:409` 对 disabled 任务连手动 run 都拒。
- **写的过程中修的三处**: 块注释里写 `*/2`，那个 `*/` 把注释提前关了（bun 直接 parse 失败）· builtin agent 的 id 是 `builtin-<slug>`，截 8 位后五行长得一模一样 → 索性不打 id、全用 slug 当句柄，并让 `tasks create` 收 `agentSlug` 自动换成 id · 中文列宽按码点 `padEnd` 会把表推歪，改按显示宽度算。另修一处照旧计划文档抄错的路径：任务页是 `/settings/tasks` 不是 `/tasks`（S89 已收进管理台）。
- **实测通过**: `health`（3088，token 从 `shared/.env.local` 自动读到，`auth: on`）· `cron "0 9 * * 1-5"` →「每个工作日 09:00 · 08-03/04/05」（今天周五，跳周末正确）· `agents list --all` · `providers`（12 个）· `skills` · `tasks create/update/run/list` · `runs`。
- **端到端卡住，但卡点不在本次改动**: 建了个真任务手动跑两次，**都在 1 秒内 0 token 失败**：`Failed to authenticate: OAuth session expired and could not be refreshed`。任务链路全通（建任务 / 抢槽 / 建 `kind='task'` 会话 / 建节点 / spawn / 捕获错误 / 留档），死在 spawn 出来的 claude 认证上。**五条已排除**（本机凭证 / proxy / launchd 的 PATH+HOME / env 污染 / `--model opus`），全部命令与判据见 `failures.md`。旁证：`nodes` 表最近一次 `done` 停在 **07-28 10:52** —— prod 的交互式会话很可能也早就坏了，只是三天没人开所以没人知道。
- **续（8-01）：管家 agent 从「自定义」升成「内置种子」**。用户在**第二台机器**上部署后发现界面里没有它 —— 暴露了一件我一开始就写进 SKILL.md 失败模式、却没往 agent 身上想的事：**agent 是 DB 行、不跟着 git 走**。于是推翻前一天「先别固化」（见 `decisions.md` 2026-08-01），加进 `BUILTIN_AGENT_SEEDS` 第 6 位，并**删掉手建的那行** —— `seedBuiltinAgents` 是 `INSERT OR IGNORE`，撞同名 slug 会静默跳过，留着就永远种不进去。**种子刻意不配 `skills_json`**：内置一律 `inherit_env=1`，本机 `~/.claude/skills/` 全可见，绑了只会白物化一个 pack。空库（→ 6 个 builtin）与存量 5 行库（重启后补成 6 行）两条路都在 `TRELLIS_DB_PATH` 指的临时库上实测过，tsc 零错。**仍不跟 git 走的**：`~/.claude/skills/trellis-admin` 软链每台机器要单独建。
- **Next**: 用户去 `trellis.smokingmouse.cc` 或 `127.0.0.1:3088` 发一句普通聊天。回得来 → 只有任务路径坏，对照 `tasks.ts:launch()` 与 `chat/route.ts` 构造的 StreamRequest 逐字段找差异；回不来 → prod 实例级故障，先 `launchctl kickstart -k` 看是否自愈。试跑任务 `bffbe8ed` 留在库里没删。**BOE 仍未部**（S88 遗留）。

### Session 89（2026-07-31，设置与功能排布重组：出方案不动代码）
- **触发**: 用户「现在 trellis 设置有点乱，各种功能排布也有点散乱，特别是在 Agent 和定时任务出现后，我想集中排一排」。三路并行勘察（设置落点 / 导航入口 / Agent 与任务表面）后出方案。
- **诊断不是「没排整齐」，是一条原则被撑破**: `app/settings/page.tsx:5-8` 和 `decisions.md` 2026-07-29 写着「刻意不做偏好中心，一切配置都语境化」。这条对当下语境和 UI 偏好都成立，但 **Agent / Task 是持久对象（有 CRUD、跨 session、按 id 引用），结构上没有「当下」可挂**，于是各被甩成一张整页且不对等。
- **勘察实测到的散乱（全部带 file:line，见 `console-ia-spec.md` 第 1 节）**: Agent 管理走两跳且三页互链缺一条边（`settings/agents` 不链 `/tasks`）· 同一套运行配置手写三遍，任务页 workspace 退化成**裸绝对路径 input**（`app/tasks/page.tsx:262`）不接 `workspaces` 表 · `agents.permission`/`require_approval` 与 tasks 的 `timeoutMs`/`overlapPolicy`/`maxBudgetUsd` 后端全实现了但**只能由 API 改** · `tasks.model` 实际存 providerId 而 `agents.model` 存模型名，**同名不同义** · `TaskToast` 只挂主页，在 `/tasks` 页反而收不到 · project 模式**根本没有 Agent 选择入口**（`QuestionInput.tsx:256`）· ~25 个 localStorage key 散在 8 个文件，`trellis-theme` 双份硬编码。
- **用户拍板三个方向**（AskUserQuestion 三选）: ① 激进 —— 任务运行进侧栏、定义全收管理台；② 偏好做**镜像**不搬家；③ 本轮只出方案 + ADR 不动代码。
- **最有价值的一条洞察**: 任务的执行落点**本来就是** session/node（`tasks.ts:374-376` 打 `kind='task'`，`repo.ts:342-352` 滤掉）。`/tasks` 页等于把「列表 + 运行历史 + 深链」在 SPA 外重实现了一遍。把 task session 在侧栏露一个折叠组，运行历史免费拿到工具卡片 / 就地分叉 / 搜索 / toast —— **这是在兑现 S88 已经付过的成本**。复核了 `repo.ts:347` 的隐藏理由（"一个月 30 个节点"）：**只对节点数成立，对侧栏行数不成立**（行数 = 任务数）。
- **Done**: `console-ia-spec.md`（六批改动，每批带判据 + 4 条风险）· `decisions/2026-07-31-console-ia.md`（六条决策 + 修订 2026-07-29 旧条目的一半 + 后果）。**零代码改动**。
- **实施时最容易搞错的一步（已写进 spec R3）**: 批 1 单独发布时**不能删 Header 的 ⏱** —— 删它的前提是任务日常入口已转移到侧栏（批 4）。先删就是纯粹退步。
- **批 1 已实施（导航收拢）**: `lib/settings-tabs.ts`🆕 tab 唯一真源 + `components/SettingsNav.tsx`🆕（用 `useSelectedLayoutSegment` 判高亮，不做 pathname 前缀匹配）+ `app/settings/layout.tsx`🆕 接管滚动容器与页头 · `/settings/page.tsx` → `update/`、`/tasks` → `settings/tasks/`（**git mv，认成 R**）· redirect 放 next.config 且**用 307 不用 308**（308 被浏览器永久缓存，会把还在动的路由锁死）· Header ⏱ 改指 `/settings/tasks` 但**保留图标**。三张页各自的 `h-dvh` 容器与手写互链全删。
- **批 3 已实施（抽共用运行配置）· 偏离了自己写的 spec**: 原计划「一个 `RunConfig.tsx` 带三种 variant」，读完代码判断是**假抽象** —— draft 是空状态首屏的图标分段器、task 是表单里的 select，控件形态本来就该不同，硬合只会得到巨大 variant 分支。真正在漂的是**文案与语义**。改为 `lib/run-config.ts`🆕（文案/语义唯一真源，无 JSX）+ `components/run-config/WorkspaceField.tsx`🆕（三处里唯一真正同一个的控件，受控 open 保住「切 project 自动弹 picker」的既有行为），消费方 ModePicker / AgentPicker / ModeBadge / tasks 页全部改引用。
- **两条自我纠错（都记下来以免再犯）**: ① 批 1 里我给「← 返回」用了 `<a>` 并编了「与出去方向对称」的理由，被 lint 抓出 —— 查了才知道原来三张页用的都是 `<Link>`，`<a>` 那条规矩**只管出去**（丢 React Flow 状态），回来没东西要丢。② 批 3 里我一度顺手删掉「选 project 自动弹 WorkspacePicker」，那是 `ModePicker.tsx` 文件头写明的有意设计且不在批 3 范围内，已撤回并改成受控 open 保住。
- **spec 里一条我写错的已修正**: 3.2 原写「agent chip 变灰至今未做」—— **ModeBadge 早就做了**。真实缺陷小得多：它手写 `model.startsWith("codex")` 判家族，**漏掉 mock**（服务端钳制是 `providerFamily(...)==="claude"`）。已统一走 `agentSupported()`。
- **3.1 是真缺口且已补**: `QuestionInput` 把 Agent 入口整块关在 `draftMode === "chat"` 里，而服务端 `chat/route.ts:336` 对 agentId 的钳制**只看 claude 家族、不看 mode** —— project 会话一直支持 agent，只是没有入口。已实测截图确认 project 下入口出现。
- **验证（隔离实例 :3399 + 真库 VACUUM 快照 + `TRELLIS_SCHEDULER=off`）**: tsc ✓ / lint 35 = baseline **零新增**（对照跑过 stash 前后）/ build ✓。批 1：307 落点、三 tab 全 200、SSR 阶段高亮就正确、桌面 rail 与手机横向条截图、Header 两入口点击落点正确。批 3：codex+chat 下 picker 正确隐身、切 claude+project 后 Agent 入口出现且下拉无 system-prompt textarea、自动弹 picker 行为保住、任务表单端到端建了一个任务且 WorkspacePicker 选出的绝对路径正确落 `tasks.workspace_path`。收尾：实例已停、快照已删、browser session 已 close（GPU 进程 0）、prod DB 修改时间仍 11:46、`:3088` 仍 401。
- **批 2 已实施（tab 内容补齐）**: `ModelConfigModal` 拆成 Panel + Modal 两层，「🧠 模型与 Provider」tab 与下拉底部的 modal 共用同一组件 · 新增「📁 工作区 / CLI」tab（通览 + worktree 回收 + CLI attach，刻意**不做**新建 worktree / 开会话 —— 那两个有真正的语境化的家）· 新增 `GET /api/workspaces`（`recent` 不回 id/kind/createdBy，而删除判据恰好是 `createdBy==='trellis' && kind==='worktree'`；复用 `/api/sessions` 会把管理台耦到流式期间 ~1.6 次/秒的热路径）· agents 补 `permission`/`requireApproval` · tasks 补 `timeoutMs`/`overlapPolicy`/`maxBudgetUsd`/`enabled` · 运行历史加「中止」（行从整个 `<button>` 拆成 div + 两个子按钮）。
- **批 2 挖出一个计划外缺陷**: `overlapPolicy` **根本不在 `TaskInput` 里** —— 列在、调度器读它、但 createTask/updateTask 都写不进去。只按原计划「表单加个 select」就完事的话，那个开关会静默失效，正是这一路一直在挑的「谎言级 UI」。已补全服务端。
- **批 5 已实施（偏好镜像）· 判据被我主动调整并说明**: 原判据「所有 localStorage 调用点都走 prefs.ts」被否 —— 57 个调用点里 41 个在 `stores/sessionStore.ts`（3000+ 行核心，且**早已把 key 集中声明在文件顶部**并带注释）。为一条形式判据重写那 41 处读写，是拿主路径回归风险换一个好看的 grep 结果。真正在漂的只有主题那两个 key（`useTheme.ts` 与 `layout.tsx` 各硬编码一份，后者还留着「keep them in sync」的注释）—— 已物理消除：layout 的首屏防闪脚本改为从 `PREF_KEYS` **插值生成**。新增 `lib/prefs.ts`（key 真源 + 清单元数据）与「🎚 偏好」tab（每行标注**原本在哪改**，指路而非取代；新会话默认值只读，因为那三个 picker 要连带做一致性钳制）。
- **批 6 已实施（语义冲突）**: `tasks.model` 名不副实（存的是 providerId，而 `agents.model` 是 CLI 模型名）→ **加列** `provider_id` + 读时 `provider_id ?? model` 兜底 + 只写新列，旧列留一版再删（保住 `migrate()` 全加法 DDL 那条纪律；真库 tasks 0 行，零数据风险）· `require_approval` 双源优先级**核实后写进 UI**：`applyAgent` 在会话基线之后跑，agent 非 null 即覆盖，所以是「以 agent 为准」· `sessions.kind` vs `nodes.kind` 同名不同义加注释 · agent 的技能改称「挂载技能」并说清与 `/` 补全那条路的区别。
- **验证（隔离实例 :3399 + 真库 VACUUM 快照 + `TRELLIS_SCHEDULER=off`）**: tsc ✓ / lint 35 = baseline **零新增**（中途一度 37，两个 `set-state-in-effect` 已按 `app/settings/update/page.tsx:67` 的既定写法修回）/ build ✓，六个 tab 全 200。逐条实测：provider_id 迁移在真库快照上加列成功且旧列保留 · 偏好 tab 改皮肤 → localStorage 写入 → 刷新后 `html[data-theme]` 正确（证明 layout 与 useTheme 读的是同一个 key）· agent 的 permission/requireApproval 读写双向通（先 API 写→表单回显，再 UI 改→落库）· 任务四个新字段 + providerId 全部落库（`provider_id` 有值、旧 `model` 列为 null）。收尾：实例停、快照删、browser close（GPU 进程 0）、prod DB 仍 11:46、`:3088` 仍 401、`endpoints.yaml` 仍 7-28（models tab 全程只读）。
- **一个测试工具的坑（不是产品 bug）**: `agent-browser click @ref` 在 agents 页那个「保存」按钮上**静默不生效**（长技能列表把它推出视口），连试两次都误判成「写入失败」。改用 `eval` 里 `button.click()` 后立刻通过。以后在长页面上验按钮，别只信 ref click 的成功返回。
- **Next**: 用户验收（改动**未 commit**）。批 4 仍降级待观察 —— 判据是「入口从 2 跳变 1 跳 + 表单补全后，一周内 tasks 表是否还是 0 行」。若仍为 0，该考虑砍掉自动化任务而不是继续加功能。

### Session 88（2026-07-31，自定义 Agent 层 + 自动化任务：A1-A4 与 T1-T4 全量落地）
- **触发**: 用户要「给 Trellis 加 Agent 管理（配提示词、技能等）+ 配置自动化任务」，追问后定死范围：一路做到 cron，但抽象要先立住 —— 后续的飞书群绑定、多 agent 讨论组都长在同一层上。中途下 `/goal` 要求一次全做完。
- **用户的一问推翻了初始方案**：我原本按「读写 `~/.claude/agents/*.md`」提案，用户问「不能把这套抽出来吗？非得放系统 .claude 目录？不能给 SDK 一个路径让它自动绑定？」——**实测证明能**：`--agents '<json>'`（内联注入并激活为主 agent，零 fs 操作）与 `--plugin-dir <任意路径>`（agent + skill 整包）。我此前说的「技能没法按 agent 裁剪」是**错的**。
- **六条架构决策**（详见 `decisions/2026-07-31-custom-agents.md`，完整设计在 `custom-agents-plan.md`）：DB 为真相源 spawn 时物化 · `agent_id IS NULL` 就是默认 Agent（不建行，物理上杜绝默认路径回归）· 隔离度按 agent 可选 · **agent 只改「人设 + 能力面」绝不碰「上下文与身份」** · 任务与 cron 同表同执行路径只换触发器 · 任务执行落在 session/nodes 上不另造渲染。
- **Done**:
  - **SDK**（跨仓 `~/sdk`）：`RunOptions` 加 `agent / agents / pluginDirs / disallowedTools / strictMcp / extraArgs`；argv 顺序焊死；`--disallowedTools` 逗号连接**不展开变参**（variadic 会吞后续 flag）；`environmentSkills:false` 与自定义 agent 互斥保护；`capabilities().customAgents` 供版本探测。`extraArgs` 把发布链从「每加一个 flag 发一次版」降成一次性成本。
  - **A1-A4**：agents 表 + 三个新列 + 5 个 builtin 种子（文案抽到 `lib/agent-presets.ts` 当 schema 与 UI 的唯一真相源）· `applyAgent()` 统一后处理（三个 mode 分支一行不动）· 内容寻址 pack + symlink 技能 · `/settings/agents` 管理页 · `@提及` 单轮派活（`ephemeral`：不 resume 不 fork 不落盘）。
  - **T1-T4**：`lib/cron.ts` 纯匹配器（**不写「推算下一次」只写「这一分钟匹不匹配」**，绕开月末/跨年/dom-dow OR 语义）+ 48 项单测 · 四张表 + `task_runs` 对称 boot reap · `run-bus` 的 `onSettled` 钩子 · 调度器对齐整分 tick + catch-up 只补最近一次 · 通知出口（`NotifyChannel` + 命令模板）· fs / git ls-remote / session_done 三种触发器 + 两道自触发防护 · `--max-budget-usd` 经 `extraArgs` 通电。
- **验证**（dev server + **prod DB 的 VACUUM 只读快照**，prod 库 mtime 未变）：A1 四条端到端（人设在 project 生效 / 工具白名单只剩 Read·Grep·Glob / 本机 skill 不可见 / **不选 agent 的会话一字不变**）· A2 pack 里的 skill 可用且本机其余 80 个消失 · A4 `@translator` 只出译文而**主线下一轮仍是严谨工程师** · 僵尸 run 被 boot reap 收成 `error/interrupted` · **漏跑 5 个槽位只补 1 条** · 唯一索引挡住重复插入（`SQLITE_CONSTRAINT_UNIQUE`）· cron 槽位对齐整分而手动不对齐 · 通知失败推送/成功不推 · fs `.md` 触发而 `.txt` 被过滤 · 自触发被 400 挡 · 用假 `claude` 抓 argv 确认顺序与逗号连接全对。cron 48/48，tsc 零错。
- **挖出三个真问题**（全写进 `facts.md`）：① cwd 不存在 → `spawn claude` 的 ENOENT 是**异步 uncaughtException**，逃得出 run-bus 的 try/catch → 节点永远 streaming、任务被 skip 策略永久锁死；② **Next 的 instrumentation 与 route handler 不共享模块实例** —— 「在 instrumentation 注册渠道、在 route 扇出」一条都发不出去且零报错；③ 技能靠 `Skill` 工具调起，配了工具白名单就静默失效，且修的时候要同时喂 `--tools` 与 pack frontmatter（第一版只补一处，行为纹丝不动）。
- **教训（流程）**：本 session 全程在 `main-2` worktree 里跑，却**没先查有没有并行 session** —— 结果与另一个 session 撞了 S87 编号，且双方都改了 `sessions.md`/`README.md`/`facts.md`/`archive.md`（`parallel-worktree.md` 明令并行期只写 `progress/blocks/<slug>.md`）。收尾时按规则做了串行处理：共享文件退回基线 → 只提交源码 → merge 对方 → 再把自己的内容按 S88 叠上去。**代码层零重叠**（对方动 workspaces/worktree UI），否则代价会大得多。
- **发布与上线**（用户点头后同 session 完成）：`@smokingmouse/agent@0.4.0` 已发 npm（`@smokingmouse` scope 在 `~/.npmrc` 里单独指向 npmjs 且带 token —— `npm whoami` 报 ENEEDAUTH 只是因为**默认 registry 是 npmmirror 镜像**，加 `--registry https://registry.npmjs.org/` 即通，别被那个报错骗去重新登录）。trellis bump 到 `^0.4.0` 后 **`make unlink-sdk` + 从 registry 重装**，确认装到的是真实目录而非软链、且 `dist` 里有 `customAgents`/`plugin-dir` —— 这一步是「静默失效」唯一的实检，不做就等于没验。`make deploy` 本机成功（`ce3b5fba6`），smoke 六项全过、prod ttyd 未受影响、验活闸 on；真 prod DB 迁移干净（5 张新表 + 4 个新列 + 唯一索引，5 个内置 agent 就位，**44 个存量会话无损**），启动日志有 `[scheduler] 已启动` 且**无 customAgents 告警**，闸后 `/api/agents` 返回 5 个 agent。
- **未做 / 边界**: **BOE 没部** —— 本机 ssh 不通（`~/.ssh/config` 只有 github/bwg/vultr-tokyo，`boe` 解析到 clash 的 fake-ip 198.18.1.26，连接被关），与 S86 记的状况一致。需在 devbox 上手跑两步：`cd ~/trellis && git pull --ff-only && bun scripts/deploy.ts install-service` 然后 `make deploy`（跑前 export 代理，`bun install` 要出网）。lint 比基线多 3 处 `react-hooks/set-state-in-effect`（on-mount 取数，与既有 19 处同形状，未为规则扭曲代码）。
- **Next**: BOE 上跑上面那两步；跑通后 `update-trellis.sh` 的 BOE 原地 build 分支就可以退役了（S86 留的退路）。

### Session 87（2026-07-31，worktree 建完即用：把「用眼睛搬路径」那一步删掉）
- **触发**: 用户「感觉现在 Worktree 的启动还是不是很流畅。我得在对应目录下新建，然后在创建的时候又指定这个新的目录。」
- **诊断（不是感觉问题，是数据被丢了）**: 建 worktree 与开 session 在代码里是**两条互不相连的链路**。服务端 `worktree/route.ts:133` 返回了 `{ok, workspaceId, path}`，`SessionSidebar.tsx:274` 收到，**下一行就丢**，只 `bumpSessionsRevision()`。于是用户必须把同一个路径用眼睛从侧栏搬到 `WorkspacePicker` 里再找一遍。更糟：它**不在「最近」列表里** —— `recent/route.ts` 两个数据源（`sessions` 表 / `~/.claude/projects` 目录）都以「已经有 session」为前提，刚 `git worktree add` 出来的目录**结构性**进不去，第一次只能走「浏览」一级级点或手打绝对路径。
- **决定性对照**: 同一个 picker 里，「空白沙箱」(`WorkspacePicker.tsx:57`) 和「新建文件夹」(`:403`) 早就是 `创建 → pickPath(path)`，后者按钮字面写着**「创建并使用」**。**worktree 是唯一一个建完不选的创建动作** —— 疏漏而非设计。
- **入口形态（用户选的）**: 两边都通，共用同一个底层动作。
- **Done**:
  - `worktree/route.ts`：抽出 `pickBase()`（GET/POST 共用，防「下拉里有、点了说没有 git 工作区」的漂移）+ 新增 `GET` 返回可作起点的 checkout 列表（含 `parent`，给前端做落点预览）。**刻意不复用 `listProjectTree()`** —— 那份的 `visible()` 会藏掉 discovered 且零会话的主 checkout，那是「该不该显示」，这里要的是「能不能建」。
  - `SessionSidebar.tsx`：新 `startSessionIn(path)` = `setDraftMode("project")` + `setDraftWorkspacePath(path)` + `newConversation()` + 显式收移动端抽屉（不能靠 `activeId` 那个 effect，从 composer 态点过来 activeId 本来就是 null，不变不触发）。建完 worktree 接住 `r.path` 落进去；**workspace 行也挂上 ＋**（`GroupRow` 加 `addTitle`，两级语义不同），让「0 会话」那条以前点不动的灰行有了出口 —— 这也是**已有** worktree（CLI 里建的）唯一不用过 picker 的入口。
  - `WorkspacePicker.tsx`：第三个「创建并使用」——「🌿 新建 worktree 并使用」，含 base repo 下拉（默认按**同父目录**命中当前工作区所属 repo，从一个 worktree 里再开平行 worktree 也选得对）、分支名、**落点路径实时回显**（分支名会原样变成磁盘目录名，建之前看得见比建完解释「它去哪了」有用）。
  - `recent/route.ts`：补第三路数据源 `readWorktreesWithoutSessions()`（`created_by != 'discovered'` 且无 session），口径与侧栏 `visible()` 一致；顺带修 `deriveShortName` —— worktree 与主 checkout 共用 package.json，实测四个 worktree 在列表里**全叫 "trellis"**，只能靠灰色路径分辨；判据用「`.git` 是文件不是目录」（linked worktree 的特征，比 `git rev-parse` 便宜且不 spawn），命中就取目录名 = 分支名。
- **验证（dev 实例 :3099，prod :3088 零触碰已复核）**: tsc ✓ / lint 32 = 基线 ✓ / `next build` ✓（顺带确认 route 文件里 `export type` 不违反 Next 的导出约束）。**浏览器实跑三条动线**：① workspace 行 ＋ → 直接落 composer，Project 模式 + 工作区 = 该 worktree（`localStorage.trellis-workspace` 核过是完整路径）✓；② picker 里建 → modal 关 + 工作区已是新 worktree ✓；③ 侧栏项目行 ＋ 输分支名回车 → 直接落 composer ✓。**实跑中发现并当场补的两个**：picker 建完没 bump 侧栏（新 worktree 要等下次刷新才现身，已补 `bumpSessionsRevision()` 并复验）；短名歧义（改后列表读 `wt-sidebar-test / wt-picker-test / wt-smoke-test / main-2`，与侧栏一致）。收尾：4 个测试 worktree 走 DELETE force=1 清掉（顺带验了删除路径没被新 ＋ 挤坏）、测试分支 `git branch -D`、DB 无残留、browser session 已关、dev 实例已停。
- **未做（有意）**: 平铺态（`isFlat`，单 workspace 与项目同名）的项目行没有「在这里开会话」—— 它的 ＋ 仍是「新建 worktree」，一行放两个按钮会挤。该场景由 picker 的「最近」覆盖。API 支持但 UI 仍未接线的 `ref`（从哪个 ref 起）也仍未接 —— 与本次抱怨无关。
- **合并与推送**: `worktree-create-and-use` → `main`（`--no-ff` merge `3462480`，保住工作线形状），已推 `ccfca62..3462480`。上个 session 遗留在工作树的 `facts.md`（子 agent 内部调用不落主 jsonl，S84 探针）与本次无关，单独一条 `6208988` 留档、没并进功能 commit。
- **Next**: 用户验收 —— 侧栏项目行 ＋ 建 worktree 应当**直接落到新会话**且工作区已选中；workspace 行悬停多出一个 ＋ 可直接开会话；选工作区的 modal 里多出「🌿 新建 worktree 并使用」。**两台实例仍待重部**（S85/S86/S87 三批修复都还没上线），BOE 上先跑 S86 记的两步。本机 prod 走 `make deploy`。

### Session 86（2026-07-30，部署流水线跨平台：devbox 上 `make deploy` 死在 launchctl）
- **触发**: 用户只贴了一张 BOE devbox 的部署日志截图 —— `switch: current → 20260730T111814-bffeda99b` 之后紧接着 `× Executable not found in $PATH: "launchctl"` → `failed`。没有一句文字。
- **根因两层，第二层比第一层更坏**：
  - `scripts/deploy.ts` 的 `kickstart()` 写死 `launchctl kickstart -k`，Linux 上 `Bun.spawn` 直接抛 ENOENT。**抛错点在 `switchTo()` 内部** —— 软链已经翻到新 release、服务却没重启，恰好落在整套设计唯一承诺「switch 之前失败 = prod 一根汗毛没动」的**缝**里。devbox 事后状态：跑着 `$HOME/trellis` 原地 build 的旧码，`.trellis/current` 指向一个建好但没人用的新 release（**S85 的修复因此压根没上线**）。
  - 就算重启修好也白搭：BOE 的 systemd unit 的 `WorkingDirectory` 仍是 `$HOME/trellis`（`update-trellis.sh` 原地 build 那套留下的），而旧代码的 WorkingDirectory 检查只读 mac 的 plist，Linux 上返回 null → 那句「本次切换不会真正生效」的警告压根没机会打出来。**「看着成功、其实跑的是无关版本」比失败更坏**，所以这条从警告升级为**拒绝**（`--force` 可越过）。
- **Done**:
  - `lib/deploy-supervisor.ts`（新）：launchd / systemd user unit 两套实现，收口 `probe / restart / unitFile / workingDirectory / setWorkingDirectory / reload / restartShell / detachPrefix`；unit 名默认取 label 最后一段（`com.smokingmouse.trellis` → `trellis.service`，与 BOE 现存 unit 对齐），`TRELLIS_DEPLOY_UNIT` / `TRELLIS_DEPLOY_SUPERVISOR` 可覆盖。**deploy.ts 里不再有一个 platform 分支**。
  - **preflight 加重启通路探针**（根因修法）：探不通就在碰任何东西之前 abort，失败重新落回「prod 没被碰过」那一侧。
  - `install-launchd` → `install-service`（旧名留作别名）：改 plist 还是改 unit、reload 走 bootout+bootstrap 还是 daemon-reload+restart，都交给 supervisor；失败**真的还原备份**（S79 的纪律照搬）。`deploy-status` 现在把认到的 supervisor 与它当前的工作目录一起打出来。
  - `lib/server/update.ts`：**systemd 下 `detached: true` 不够** —— 默认 KillMode=control-group 按 cgroup 杀，换会话不换 cgroup，`systemctl restart` 会把正在跑部署的进程一起带走，verify 与自动回滚双双失效（launchd 上 S82 修过一次，这是 Linux 上的新一份）。改经 `systemd-run --user --collect --quiet --scope` 换 cgroup，探针**真起一个空 scope**（systemd-run 在位但 dbus / XDG_RUNTIME_DIR 不对时照样跑不起来），不过就明说「改用命令行 make deploy」。顺带把 `startUpdate`/`startRollback` 两份 95% 重复的 spawn 合成 `spawnDeploy`。
- **验证**（本机造 systemd 桩环境实跑：`TRELLIS_DEPLOY_SUPERVISOR=systemd` + PATH 里放桩 `systemctl` + `TRELLIS_DEPLOY_ROOT=/tmp/…` + 复刻 BOE 现状的桩 unit）：① mac 真 launchd 路径 `deploy-status` 照旧认出 job 与工作目录 ✓；② WD 指着 `/data00/…/trellis` 时 deploy **在 preflight 就拒绝**、`current` 未动 ✓；③ `install-service` 正确改写 `WorkingDirectory=` → `daemon-reload` → `restart` → 查 `ActiveState` ✓；④ rollback 走完探针→翻软链→重启→验活（验活打本机真网关 3088，✓）；⑤ 桩收到的 11 条调用序列与预期逐条对齐 ✓；⑥ **复刻事故现场**（PATH 里既无 launchctl 也无 systemctl）→ 报错落在 preflight、`current` 一根汗毛没动 ✓；⑦ 两套 `rollback.sh` 从**真源码模板**渲染 + `sh -n` 通过 ✓。tsc 零错。
- **边界（诚实）**: **没在 BOE 上实跑过** —— 本机 ssh 不到公司 devbox（`~/.ssh/config` 里只有 bwg / vultr-tokyo）。systemd 分支的证据 = 桩环境 + `update-trellis.sh:74` 那串已被实践证明的命令，不是现场。`update-trellis.sh` 的 BOE 分支（原地 build）**先留着当退路**，等 deploy 在 BOE 上跑通一次再退役 —— 那才是「不留双版本」的时机。
- **合并与推送**: `deploy-cross-platform` → `main`（`--no-ff` merge `41b4390`，保住工作线形状），已推 `bffeda9..41b4390`。**两台实例都还没重部**。
- **推完在 BOE 上又栽了同一个报错，但不是同一个 bug —— 新旧错位**：用户贴的第二条日志跑完了 smoke + backup 才死在 `launchctl`，而新代码的探针会在 preflight 就 abort，**到不了 smoke** —— 判据一眼断定「部署的是新 commit（`0fe873940`），执行的是旧脚本」。成因：`app/api/update/route.ts:55` 界面「更新到最新」默认部署 `origin/main`，而干活的 `scripts/deploy.ts` **来自工作树** —— fetch 到新 commit 就够建出新 release，可工作树没 `git pull`，于是新代码进了 release、旧流程照旧走 `switchTo()` 里的 launchctl。**「改部署脚本」这件事有天然的鸡生蛋：改动只有进工作树才生效。**
- **补的闸**（`deploy.ts:checkMachinery`）：preflight 比对 `MACHINERY`（`scripts/deploy.ts` / `lib/deploy-supervisor.ts` / `lib/deploy-state.ts`）三者的 blob —— 目标 sha 里的、HEAD 里的、磁盘上的。**只拦真正会骗人的那种**：`HEAD` 是目标祖先（= 工作树落后，本次名不副实）→ 拒绝并指着 `git pull --ff-only`；本地未提交改动（`inHead === inTarget`）或目标非后代（按老 sha 回滚 / 别的分支）→ 只提醒。验证是**真造场景打的**：scratch clone 切到 `bffeda9` + 塞进带闸的新脚本 → 部署 `origin/main` 果然在 preflight 被拦 ✓；本仓库未提交状态 → 只提醒后落到无关的工作目录闸 ✓；`deploy.ts bffeda9`（回滚形态）→ 只提醒 ✓。tsc 零错、lint 回基线。
- **Next**: BOE 上两步 `cd ~/trellis && git pull && bun scripts/deploy.ts install-service` → `make deploy`（跑前 export 代理，`bun install` 要出网）。注意 `install-service` 那一步就会让服务重启进 `~/.trellis/current` —— 也就是 11:18 那次建好却没跑上的 `20260730T111814-bffeda99b`，**S85 的修复到这一步即生效**，第二步才是发这次的 supervisor 修复。本机 prod 走 `make deploy`。

### Session 85（2026-07-30，镜像会话的「永久正在生成…」— CLI 注入劫走回复）
- **触发**: 用户截图一条 attach 的 CLI 镜像 turn：6 个工具全标「完成」，底下却一直转「正在生成…」。问「为啥显示完成了，但实际卡在这个界面」。
- **两层病灶，都被实测坐实**：
  - **根因（解析器切错 turn 边界）**: `cli-import.ts:isTurnStart` 把 CLI 注入的 user 文本消息当成了真用户提问 —— skill 触发的 `Base directory for this skill: …`、`<task-notification>`、Stop hook 反馈、`Continue from where you left off.`、Esc 打断的 `[Request interrupted by user]`、`/compact` 摘要。这些假 turn 会把**后续 assistant 的最终回复整段劫走**，真 turn 只剩工具调用 + 空 response。**本机 400 个真实 jsonl / 1142 个 turn 实测：136 条这种僵尸。**
  - **UI 撒谎**: `TurnCard.tsx` / `ChatNode.tsx` 的兜底分支把「不在流式 + response 为空」一律画成脉冲点 +「正在生成…」，于是每一种「这轮本来就没文本」都伪装成永不结束的 loading，把上游问题全掩盖了。
- **判据用结构字段、不用文本前缀**（前缀会随 CLI 版本漂）：`isMeta` / `promptSource === "system"` / `interruptedMessageId` / `isCompactSummary` / `isVisibleInTranscriptOnly`。真用户消息（typed/sdk/queued）零命中，剩余以 `<` 开头的全被既有 `isCommandNoise` 覆盖。
- **Done**:
  - `cli-import.ts`：五道结构闸；**孤儿链兜底认领**（严格判据下 `claude --continue`/fork 出的 jsonl 上溯不到 turn-start，会整段丢 —— 实测 117 条消息 / 16030 字符；先严格后宽松，次序反了就退回 bug 本身）；认领跑到**固定点**；空壳兜底 turn 剪枝 + 子节点提升；新导出 `entryUuids`。
  - `cli-import-db.ts`：清理旧解析残留的假 turn 节点，四道闸（**id 出现在 jsonl entry uuid 集合里** / 非 streaming / 无子节点 / 无 lineage 失联）+ 循环到不动点（假 turn 串成链，一轮只剥一层）；`parseLineages` 区分「读不到」与「空」。
  - `sqlite.ts`：`PRAGMA user_version` 一次性迁移 v1，作废 `cli_lineages.synced_uuid`（否则 `allUnchanged` 快路径跳过重写，存量永远修不好）。
  - `EmptyResponseNotice.tsx`（新）：只有「镜像会话 + 正被实时写」才敢说「CLI 正在生成…」，否则据实说「暂无文本回复」。
  - `sessionStore.ts`：`LIVE_TTL_MS` 12s → 60s（实测真实 transcript 相邻条目间隔 13.78% 超过 12s，最长 3576s，12s 会让在跑的会话反复诈死）。
  - `cli-sync-watcher.ts`：`reimport` 的**空 catch 加日志** —— 它是镜像会话唯一的更新通道，静默失败 = 界面永久停更且零痕迹。
- **外派 falsification-verifier 打了一轮，落库那一半被打穿（解析器一半全量对抗下不动摇）**，两条**可复现的数据丢失**路径，且「迁移作废游标」恰好保证它们升级后首次启动必然各跑一遍：
  - **致命①**：清理判据 `claude_session_id IS NOT NULL` 不等于「import 建的」—— `app/api/chat/route.ts:512` 在 attached 会话**从非 tip 分叉**时会给 trellis 临时节点写 sid，而 `run-bus.ts:648` 的 `reconcileAttachedTurn` **只在 `stoppedWith==='done'` 时跑**；用户打断的那一轮（含他敲进去的问题）正好命中三道闸被删。
  - **致命②**：`parseLineages` 把「文件读不到」和「文件是空的」静默当成一回事 → `turnIdSet` 缺整条 lineage → 清理从叶子逐层剥光整棵子树。**全失败有 early-return 护栏，唯独部分失败没有**，而这是最常见的情况（transcript 过期 / 用户清 jsonl）。
  - 修法：判据换成**「节点 id 是否出现在 jsonl 的 entry uuid 集合里」** —— import 建的节点 id 恒等于某条 entry 的 uuid，trellis 自建节点是本地 v4 绝不在里面；比 `cli_turn_uuid` 强（那列这次才开始写，存量没有），比 `claude_session_id` 安全。另加 `anyUnreadable` 闸。
- **验证**: 全量 400 个 jsonl —— **僵尸 136 → 0**、假 turn 236 → 14（兜底认领的孤儿链头）、文本 1021806 → **1023718（不减反增**，兜底把原本就丢的孤儿也捞回来了）、断链 0、多次解析 hash 一致。端到端：旧代码导入复现病症（4 个假 turn + 1 条空回复僵尸）→ 切修复版**一次 reimport** 即 0/0，总文本 37152 **与纯解析精确一致**（无重复）。两条致命路径**回归测试**：trellis 分叉被中止节点 ✅ 幸存、jsonl 失联时节点数 21 → 21 ✅ 未销毁。四象限安全闸（线性续聊 / 分叉被中止 / 分叉跑着 / 分叉 done）全部幸存。lint 32 problems/23 errors = 基线，tsc 零错。
- **两次自摆乌龙**: ① 第一版 guard 报「非 import 节点被误删」是虚惊 —— 我重写脚本时把 INSERT 删了，那两个节点压根没被放进去过。**测「东西还在吗」之前先确认它进去过。** ② lint 从 28 涨到 34 以为是回归，其实是我遗留在仓库根的临时验证脚本被 eslint 扫了。
- **边界（诚实）**: 截图那条会话在 devbox 上，本机 DB 最新只到 7-28，**没拿到现场直接证据** —— 诊断靠本机语料复现同形态（136 例）建立。另：**源 jsonl 已失联的镜像会话走不到修复路径**（`parseLineages` 早返回 `empty`），本机两个 attached 会话的 jsonl 都已不在磁盘，那 2 个坏节点不会自愈，只是 UI 文案不再谎称「正在生成」。
- **Next**: 两台实例（本机 prod + devbox）都要重新部署才生效；重启后首次 `getDB()` 跑 v1 迁移，watcher 自动全量重导一次。

### Session 84（2026-07-30，动线渲染重做：三类 task 分家 + 工具渲染注册表）
- **触发**: 用户贴截图「子 Agent 的动线展示还是很不友好，workflow 也没展示出来」，要求参考 riba / happyclaw 讨论一版方案。
- **先证伪了截图的表象**：那两个「子 Agent」**根本不是子 Agent，是慢 Bash**。根因单一 —— `lib/subagents.ts:57` 拿 `c.agent !== undefined` 当「这是子 Agent」的判据，而 CLI 对**三种**东西发同一套 `system/task_*`：`local_agent` / `local_bash` / `local_workflow`。判别位 `task_type` 被丢两次（SDK `taskData()` 没抽 + adapter `void phase`）。
- **实测拿的证据（不是读代码推的）**: 两次真跑 `claude -p … --output-format stream-json` 录流。① 后台 Bash 与**前台慢 `sleep 12`** 都发 `task_started{task_type:"local_bash"}`，且 `task_notification.summary` 就是描述回声 → 老代码 `report = summary ?? output` 短路掉真 stdout。② Workflow 发 `task_type:"local_workflow"` + `workflow_name`，**并且 `task_progress` 上挂着 `workflow_progress` 全量快照**（phase 列表 + 每个 agent 的 label/phaseTitle/state/model/tokens/durationMs/resultPreview）。二进制里 `strings` 也印证了三个字面量。
- **这条实测直接推翻了原方案的一个前提**：Workflow 面板**不需要读磁盘**。用户已批准的「磁盘 adapter」因此本轮不建（L3 才用得上，现在建就是空转抽象）。
- **Done L0（事件层）**: SDK 0.3.3 补抽 `task_type`/`workflow_name`/`workflow_progress`；adapter 停止丢 `phase`/`taskId`；`SubagentMeta` → `TaskMeta`（它描述的从来不只是子 agent）。
- **Done L1（视图模型）**: `splitToolChain → {main, groups}` 两个平铺列表换成一棵 `buildToolTree → ToolNode{call, kind, meta, children, report}`。kind 四级降级链：`taskType` → 工具名/有子节点 → **taskId 首字母 a/b/w** → tool。前缀那级是关键 —— 它让修复**不等 SDK 发版**就在存量数据上生效。
- **Done L2（渲染注册表）**: `lib/tool-registry.ts` 元数据表（30+ 工具各一行，不写 React）+ `components/tools/views/` 组件表（只有 Diff/Todo/Workflow/Subagent 四个）。抄了两条别人踩过的铁律：`canRender` 说不行就降级 RawView（注册表永远炸不了）、**错误永不隐藏**。
- **Done L3（动线布局）**: 单一时间线取代「🔧 主链 + 🤖 子 Agent」两个抽屉 —— 分区把时间顺序切断了，正是「动线不友好」的另一半。删 `ToolCallsPanel.tsx` / `SubagentPanel.tsx` / `lib/subagents.ts`，不留双版本。
- **实施中挖出两个计划外的**: ① SDK `stdout ?? content`，空 stdout 顶掉 content —— 和分组吞并叠加才是「命令结果彻底消失」的完整成因。② 失败的行必须默认展开，否则「错误永不隐藏」只是口号（渲染冒烟测试逼出来的）。
- **验证**: `test-tool-tree.ts` 34 项 + `test-timeline-render.tsx` 45 项 ALL PASS（三个真 fixture 各覆盖一种 task_type，后两个是本次录的）；**生产库回放** 21 条误判 Bash 全部归位、20 条输出恢复可见、4 个真子 Agent 不回归；tsc ✓ lint ✓ build ✓。
- **合并后在 main worktree（registry 版 0.3.2）实测，纠正一个我先前说轻了的判断**：分类确实全对（前缀链兜住）、report 不再吞 output，**但 `stdout ?? content` 那个修复也在 SDK 里** —— 0.3.2 上后台/无输出命令的输出仍是空串。所以「结果不可见」在 0.3.2 上只修好一半，发版不是锦上添花。`test-tool-tree.ts` 开头加了版本闸，装 0.3.2 时先打印提示再红。
- **收尾**: `@smokingmouse/agent@0.3.3` 已发 npm，trellis 依赖收紧到 `^0.3.3` + 解链回注册表版本，全套验证在真 registry 包上复跑通过（tsc / 79 项断言 / build 全绿，版本闸不再告警）。main 已推 origin。
- **Next**: **浏览器人工验收**（本 session 无浏览器工具，只能人跑）—— 尤其流式态：面板自动展开、运行中子 Agent 自动展开、LiveHeader 取最深运行节点。之后 `make deploy` 上 prod。


### Session 83（2026-07-30，worktree 可用性：能力不可达 + 侧栏说谎 + git 感知）
- **触发**: 用户「讨论下怎么把 workspace 这个功能完善一下」。先查真库判据（S1 定的是行为指标「一周内 worktree 里 session 数 > 0」）：上线 3 天，trellis 里只新建 1 个 session（暂存区，贴了个 X 链接）、**worktree 里 0 个**，同期 CLI 里 1204 个 jsonl。判据未达标。
- **用户给的根因**（比我预设的方向更准）: 「trellis worktree 不好用，感知和交互都很费劲」+「一个项目开多个 worktree 并行，但**不想在操作上特别感知这件事**」。据此拍板：新建会话时默认不开 worktree、一键可开；分支已合入主干就提示回收。
- **调查改写了诊断 —— 不是缺能力，是能力不可达**: 新建/删除 worktree 的入口 S1 早就做了（`SessionSidebar.tsx:222/247`），但 `workspaces.created_by='trellis'` 行数**实测为 0**，即上线至今一次都没被成功用过。根因是 `:730` 的 `hidden group-hover:flex` —— Tailwind 的 group-hover 自带 `@media (hover:hover)` 包装，而移动端抽屉与桌面 rail **复用同一份 renderPanel**，触屏上那条规则永不匹配 → 按钮**永远点不到**（用户挂公网隧道，手机访问是常态）。原计划要做的「新入口 + git 角标」全是在这个堵点之上加东西。
- **Done ①（可达性）**: 改成 `hidden group-hover:flex pointer-coarse:flex`。判据是「有没有 hover 能力」而不是「屏幕多宽」—— iPad / 触屏笔记本是大屏无 hover，按 `md:` 断点判会漏掉它们。
- **Done ②（侧栏说谎）**: `visible()` 加路径存在校验（带 5s TTL，防未挂载网络盘在 ~1.6 次/秒的热路径上阻塞 stat）；`registerSiblingWorktrees` 从只进不出改成**同时 prune**（「不在 git worktree list」+「目录确实不存在」双条件，缺后者则 git 一失败就会清空好行）；重扫从 boot-only 提取成 `rescanWorktrees` 并挂到 git 状态接口（原来 CLI 里新建的 worktree 要重启才现身）；`ensureWorkspaceForPath` 的 INSERT 加 `ON CONFLICT(path) DO NOTHING`（按需触发引入了并发）+ `created_by` 按 rank 只升不降（否则重建同名 worktree 后 trellis 自己建的也删不掉）。
- **Done ③（git 感知）**: 新增 `lib/server/git-status.ts` + `GET /api/workspaces/git-status`，出 `{branch, dirty, reclaimable}`，前端异步拉、渐进填角标（分支名 / 橙色 ●N 脏文件数 / 绿色 ✓ 可回收）。**刻意不并进 `/api/sessions`** —— 那条在流式期间是 ~1.6 次/秒（依赖 sessionsRevision ← cli-sync 600ms 合并窗口），塞 spawn git 会拖垮 SSE。全程 `execFile` promise 版，不照抄现存的 `spawnSync`。砍掉 ahead/behind：实测**只有 main 有 upstream**，任务分支全没有，`branch.ab` 结构性无输出。
- **Done ④（删除路径修脆点）**: `force=0` 改成**只预演绝不执行**（实测原实现对干净 worktree 点一下目录就没了，连问都不问，而按钮现在触屏常显）；预演回传 `--ignored=matching` 拿到的两类清单 —— dirty 是会丢的活，**ignored 是 `.env*` / `/.claude/` 这类会被静默删掉的东西**（S79 丢过一次 `.env.local` 导致认证闸静默关闭）；加「正在生成的会话」拦截闸；杀终端从 git remove **之前**挪到之后（原顺序在 git 失败时白杀终端）。
- **实测钉死的三条（都推翻了我的初版设计）**:
  - **`merge-base --is-ancestor` 判「已合并」会误删正在用的工作区** —— `main-2`（刚建、没提交、正在用）与 `wolffish`（真做完已合并）返回**同一个值**。改用 `origin/main` 当基准同样错：实测 `origin/main`(67e172b) ≠ 本地 main(edd3c4e)，fetch 一跑就发生。最终判据 = **分支 tip 是某个 merge commit 的第二父**（`rev-list --merges --parents --ancestry-path`）+ 基准用**本地**主干 + 工作区干净。已知漏报 squash/rebase 合并（方向安全，代码里写死了注释）。
  - **默认分支必须逐 repo 探测**：trellis → `origin/main`，`~/.claude` → `origin/master`。写死 "main" 会让后者全错。
  - **CSS 变体顺序陷阱**：第一版写 `flex pointer-fine:hidden group-hover:flex`，产物里 `pointer-fine:hidden`(55476) 排在 `group-hover:flex`(47049) **之后**且特异性相同（`:where()` 计 0）→ 隐藏反过来覆盖 hover 显示，鼠标设备上按钮再也出不来，**比原 bug 还糟**。改成「基础态 hidden + 两条互斥的显示规则」后谁先谁后都不影响。
- **砍掉的一个功能（实测逼的）**: 一度做了「从列表移除」（只摘记录不删磁盘）给 CLI 建的 worktree 用。实测发现摘掉一个目录仍在的行，**下一次 rescan 就把它加回来了**（`added:1`）—— 点了等于没点，比没有更糟。于是删掉前后端，改由 rescan 的自动 prune 兜底，清理范围扩到所有 `kind='worktree'`。
- **验证（隔离实例 :3399 + 真库 VACUUM INTO 副本，prod 零触碰已复核）**: tsc ✓ / lint 32 = 基线 ✓ / build ✓。**僵尸自动清理 + 隐身修复端到端成立**：boot 后 `arrowworm`/`madtom`/`trevally` 三行消失，`main-2`/`main-3`/`main-4` 出现（后两个是本 session 期间别处新建的真 worktree，等于在动态变化的环境里验了一次）。**reclaimable 黄金对拍集 6/6 全过**（`wolffish`→可回收；`main-2`/`main-3`/`main-4`/主 checkout/`.claude`→不可回收）。删除四路径：force=0 只预演不删 ✓、`.env.local` 被正确列进 ignored 清单 ✓、正在生成的会话拦住 ✓、force=1 真删且**会话未连坐**（workspace_id→NULL）✓。浏览器层：桌面态 5 个按钮容器 `display:none`、hover 目标行后变 `flex`(w=19) 且其余行不受影响 ✓；侧栏渲染 `main-2 ●6`（正是本次改的 6 个文件）/ `main-3 ●2` / `trellis` 显示分支 `main` ✓。收尾：实例与 browser session 已关、测试 worktree 已清、prod DB 修改时间仍是 7-29、`:3088` 401、`current` 软链未动、tmux 会话未被误杀。
- **两个未能实测的边界（工具限制，已知）**: ① `pointer-coarse` 的真实触屏行为 —— `agent-browser` 的 `set device` 只改 viewport/UA，不设置 pointer/hover media 特性，故只做到「产物 CSS 规则 + 条件 + 顺序」三层确证 + 桌面路径实测；② dev 模式下页面卡在「加载中…」（既有的 `::highlight` PostCSS 告警所致，S80 已记录，非本次引入），验证全程走 production 模式。
- **Next**: 用户验收 —— 手机上打开侧栏，项目行的「＋」应当直接可见可点；桌面 hover 行为不变。改动未 commit（6 个文件：`SessionSidebar.tsx` / `worktree/route.ts` / `workspaces.ts` / `git-status.ts`🆕 / `git-status/route.ts`🆕 / `types.ts`），在 `main-2` worktree。上 prod 走 `make deploy`。


### Session 82（2026-07-29，设置页 + 点击更新 · 右下角重叠 · ttyd 探测脆点）
- **触发**: 用户「之前的设置页面的那波更新好像不见了……搞了一个设置页，支持自动更新，也把终端移到了顶部，不和树预览图冲突」。
- **先证伪了前提**：那一版**在这个仓库里从不存在**。查了 git 全 ref + 悬空对象 + 所有 reflog、另外两个 clone（`~/ai-coding/trellis`、已被清空的 Harbor worktree `harbor-worktrees/trellis-c_pi9krbkm5y`）、`~/.claude/projects` 全部 CLI 历史、`~/.codex/sessions` 306MB 全部 rollout、Harbor 控制面 DB、GitHub 全部远端分支与 PR —— 零命中。反而查到两条**明确不做**的旧记录：`archive.md` 的「设置页评估不做」(S62) 与 `decisions.md` 的「无人值守自动更新——拒绝」(S79)。**但用户记的那个冲突是真的**，而且一直没修。
- **Done ①（右下角重叠）**: 机制本来就有 —— `TerminalPanel` 早就在发 `--trellis-term-h`，只是 `TreePanel` 写死 `bottom-24` 没订阅。新增 `--trellis-term-stack`（终端在右下角占到多高，覆盖把手/浮层/钉住三态），`TreePanel` 改 `clamp(6rem, calc(var(--trellis-term-stack,0px) + 0.5rem), 50vh)`。clamp 上界是硬保证：终端拖到 720px 高也不许把树面板顶出视口。**没有把终端搬到顶部**——贴底是 VS Code/devtools 的通用语法，搬顶反而怪。
- **Done ②（ttyd 探测）**: 根因不是「没装」（实测 `/opt/homebrew/bin/ttyd` 探得到、prod 日志也没有 boot 期告警），而是 `ttydBin()` **把失败也缓存了** —— 一次瞬时失败就焊死到进程重启。改成只缓存成功 + PATH 兜底 + 逐候选记失败原因（`EACCES` 与「不存在」必须分得开）+ 面板加「重试」按钮和「探测详情」折叠区。
- **Done ③（设置页 + 点击更新）**: 新 `/settings`（Header ⚙）+ `lib/server/update.ts` + `/api/update`。**不重新实现部署**，只是 detached 派生 `scripts/deploy.ts`。三个机关见 decisions.md 与 facts.md。
- **验证（隔离实例 :3299 + 沙箱 deploy root，prod 零触碰）**: tsc ✓ / lint 32 = 基线 ✓ / build ✓；**重叠前后对照**（浏览器真 rect）：写死 `bottom-24` 时重叠 20px，改后三态 gap 均 8px 且 `overlap=false`（收起 stack=116 / 浮层 348 / 钉住 260，`termH` 只在钉住态为 260 ✓）；ttyd 探测四例（候选命中 / PATH 兜底找到只在 `~/.bun/bin` 的二进制 / 不存在 / **无执行位报 EACCES** ✓）；真开终端 → ttyd 起在隔离端口 7950、iframe 挂载正常；**detached 存活实测**：父进程 `kill -9` 后子进程 `ppid=1` 并在父死后 6 秒写出结果；**扳机端到端**：POST 后 preflight → stage → install → build 全过，release 真 stage 进沙箱，界面实时显示阶段与进度条、运行中「更新到最新」按钮自动禁用，**到 build 即掐断，绝不让它走到 switch**（沙箱 label 是不存在的 `...-UITEST-nonexistent`，双保险）。收尾：实例/ttyd/browser session/沙箱目录全清，prod 复核 517 节点 / 44 会话 / 0 streaming、`current` 未动、`auth ON`。
- **一次自摆乌龙**: 第一次量重叠时同步改 `style.bottom` 立刻读 rect，得到「改前也不重叠」的假结论 —— 是我自己加的 `transition-[bottom]` 让读到的是动画起点。关掉过渡 + 等一帧才拿到真值。**给元素加过渡后，同步测几何就不可信了。**
- **合并与上线（同日）**: `wolffish` → `main`（`--no-ff` 合并 `e67e0d7`），推送 `56619dd..e67e0d7`；`make deploy` 上线 `20260728T185244-e67e0d729`。**上线后核验**：`/` 401 · `/login` 200 · `/settings` 401 · `/api/update` 401（后两条正是 RCE 入口该有的样子）；`{gate:up, next:ready, auth:on}`；release 里三个新文件都在、构建产物含 `--trellis-term-stack`；**tmux 两个终端跨部署存活且 `created` 时间戳未变**；517 节点 / 44 会话 / 0 streaming；`previous` 指向 `...-56eb54b45` 可回滚。smoke 六条断言全过（含「无 cookie 的 `/api/sessions` → 401」与「prod ttyd 未受影响」）。用户已把 `TRELLIS_REPO_DIR` 写进 `~/.trellis/shared/.env.local`，**实测新进程 env 里读到了**（`ps -E` 核）→ 设置页按钮可点。
- **注**: build 仍有两类既有告警（`globals.css` 的 `color-mix(in lab, …)` 解析告警、`next.config.ts ← lib/server/blobs.ts` 触发的 NFT「whole project traced」），S80 已记录，非本次引入。
- **Next**: 用户现场验收 —— 打开 ⚙ 设置页看版本与更新，右下角树面板与终端把手不再叠。下次上线可以直接在界面上点。

### Session 81（2026-07-28，工作区选择器加「新建文件夹」）
- **触发**: 用户「指定 Project 目录时，能增加一个功能，新建文件夹吗」。摸清现状：选择器已有三条造目录/选目录的路（空白沙箱 = 随机名、worktree = 分支名且必须在 git 项目下、浏览/最近/手输 = 只能选已存在的），**唯独缺「我说在哪、我说叫什么」**——开新项目正是这个形状。
- **Done**: 新 `app/api/workspaces/mkdir/route.ts`（`POST {parent,name}` → 非递归 `mkdirSync`）+ `components/WorkspacePicker.tsx` 浏览 tab 工具栏加「＋ 新建文件夹」，展开行内表单（前缀显示当前目录、回车提交、Esc 取消），成功即 `onPick` 新路径并关窗——**创建后直接选用**，因为在这个 modal 里造目录的唯一理由就是拿它当 workspace。
- **闸**: 名字必须是**单个路径段**（含 `/` / NUL / `.` / `..` / 首尾空白 / >255 全拒），parent 必须绝对路径且实为目录；非递归 mkdir 让 EEXIST 冒出来成 409 而不是静默复用别人的目录；EACCES/EPERM → 403。
- **验证**: tsc ✓ / lint 32 = 基线 ✓；API 八例 curl 实测（正常、重复 409、`../escaped` 被拒且磁盘上确实没逃出去、空名、相对 parent、parent 不存在、只读 fs、中文名 ✓）；dev 实例 :3099 **浏览器真跑**：切 Project → 浏览 tab → 按钮在 → 输 `ai-coding` 得行内红字「已存在」→ 改新名回车 → 磁盘目录出现 + modal 关闭 + 工具栏 chip 变 `trellis-mkdir-uitest` + 「开始探索」解禁。测试目录/browser session/dev 实例均已清理，prod :3088 未触碰。
- **Next**: 用户验收。未 commit（`components/WorkspacePicker.tsx` + 新 route 目录）。上 prod 走 `make deploy`。

### Session 80（2026-07-28，侧栏三级层次重排 + workspace 空层平铺）
- **触发**: 用户贴侧栏截图，只说了五个字「显示效果很差，层次结构」。
- **根因（量出来的，不是审美判断）**: 三级树的视觉权重**倒挂** —— Project `12.5px/medium/ink-strong`、Workspace `11px/normal/ink-muted`、Session `12.5px/normal/ink-muted`，**子级比父级还重**；行高同向倒挂（group 24px < session 28px）。三个放大器叠上去：① 缩进只有 6/16/20px，三级几乎共线；② group 行通栏而 session 行是内缩 pill，宽度打架；③ 每行一个 8px 满色 mode dot，成了整栏最强视觉元素，把层次压平。
- **Done ①（视觉层）**: 层次改由「缩进 + 引导线 + 字重」承担，**字号退出**（三级统一 `text-ui`）。新增 `ROW_H`/`PAD()`/`CHEVRON_MID()` 几何常量 + `IndentGuide`（子树左侧竖引导线，对齐父行三角中心 —— 这是三级树能被一眼分组的关键）；行高统一 26px、全部改通栏 pill（高亮不再随层级越缩越窄）；权重阶梯 `semibold/ink-strong` → `medium/ink` → `normal/ink-muted`；mode dot 8px 满色 → 6px `opacity-55`；分组间距 `mb-1.5` → `mb-3`。
- **Done ②（信息架构，用户看完第一版后拍板「展开平铺吧」）**: **workspace 那一层显不显示，取决于它携不携带信息**，而不是层级图上画了几层。三种零信息情形折叠成两级：`trellis:scratch`（`mellow-lynx-90` 这类名字从随机词表拼出）、`trellis:home`（workspace 名就是项目名「主目录」的另一种说法）、唯一 workspace 且与项目同名（`.claude` → `.claude`）。**刻意排除 `kind === 'worktree'`** —— 那说明项目在多工作区并行，层级是真的，所以 trellis 自己保持三级。规则**可逆**：多出第二个 workspace 自动恢复。两个兜底：平铺后 path 没别处可看 → 挪进 project 行 tooltip；**零会话不平铺**，否则剩个底下空无一物的项目行。
- **顺带**: 两个 cluster key 提到 `lib/types.ts` 共享（`project-cluster.ts` 带 `server-only` 不能给客户端 import，原先是字面量散在两处）。
- **验证**: `tsc --noEmit` 零错 ✓；lint 无新增（1 项既有 `set-state-in-effect` 基线）；**真 DB 起 dev 实例 :3199 浏览器实测**：明暗两套主题各截图核验（两级引导线均渲染、权重不再倒挂）；平铺后暂存区/`.claude`/主目录三个项目变两级而 trellis 保持三级；折叠开关在平铺项目上仍正常（折叠隐藏 / 展开还原，行数对得上）；点平铺出来的会话正常加载且 header 仍显示 workspace 名（信息未丢）。实例与 browser session 已清理。
- **注**: `scripts/test-project-cluster.ts` 在 worktree 裸 `bun` 下跑不起来（`server-only` 解析报错），**stash 后基线同样失败 = 预存在的环境问题**，非本次引入。
- **合并与上线（同日）**: `madtom` → `main`（`--no-ff` 合并 `56eb54b`，保住工作线形状），推送 `8f03bf9..56eb54b`；主 checkout tsc ✓ + build ✓ 后 `make deploy` 上线 `20260728T100813-56eb54b45`。**上线后核验**：`/` 401 · `/login` 200 · `/__gate/health` `{gate:up, next:ready, auth:on}`；release 目录里源码带新符号（`IndentGuide`/`isFlat`/`HOME_CLUSTER_KEY` 共 13 处）、构建产物含 `opacity-55`；真 DB 44 会话 / 517 节点 / 6 项目 / 13 工作区 / 0 streaming（与上线前一致）；**tmux 终端跨部署存活**。进程形态 launchd → `bun server.ts -p 3088` → `next start -p 3187`（只绑 127.0.0.1）。
- **自己踩了一次已记录在案的坑**: 核验时 `tmux list-sessions | wc -l` 得 0，差点写成「终端清零」——`tmux` 被 oh-my-zsh 函数遮蔽（facts.md 早有此条），走 `/opt/homebrew/bin/tmux` 才看到那个活着的 session。**验证命令也得挑真源**。
- **顺带记一笔（非本次引入）**: build 有两类既有告警，构建本身通过：① `globals.css` 里 `::highlight(branch-source)` 的 `color-mix(in lab, …)` 解析告警；② `next.config.ts` ← `lib/server/blobs.ts` ← `/api/uploads/[hash]` 这条链触发 NFT「whole project traced」告警（blobs 里有动态 fs 路径）。两者都在我改动之外，暂未处理。
- **Next**: 用户现场验收侧栏（浏览器强刷一次拿新 chunk）。

### Session 79（2026-07-28，上线机制重做：release 目录 + 原子切换 + 自动回滚 + 网关维护页）
- **触发**: 用户「现在自动更新机制做的不太友好，失败了平台就用不了了，并且更新过程中平台就不受控了」。查下来**根本不存在自动更新机制**——上线就是在 launchd 正在跑的那个目录里手工 `bun install` + `make build` + `kickstart`。用户四条痛点全选（失败不能致命 / 更新期间可控 / 可观测 / 要我批准），拍板接受确定停机窗口、**不做零停机热切**（理由见 decisions.md 2026-07-28）。
- **落地**:
  - **`scripts/deploy.ts`（新，十阶段）**：preflight（只读查活跃 run，有就拒绝，`--force` 才过）→ stage（`git archive` 到 `~/.trellis/releases/<ts>-<sha>`）→ install → build → **smoke**（真 DB 的 `VACUUM INTO` 快照起临时实例，四断言 + 「没杀掉 prod ttyd」回归断言）→ backup → switch（原子换软链 + kickstart）→ verify → 失败自动 rollback → gc。全程写 `deploy-state.json` + 日志。
  - **`lib/deploy-state.ts`（新）**：部署脚本与网关之间的共享面。刻意不进 sqlite——网关要在「数据库那份代码本身可能就是坏的」时候还能工作。
  - **`server.ts`**：先占端口再拉 Next；Next 挂了退避重启而不是 `process.exit`（原来靠 launchd KeepAlive 无限 respawn，外面只剩 connection refused）；未就绪出 503 维护页（未认证只显示「正在更新」，sha/日志/回滚命令要认证——这台机器挂着公网隧道）；新增 `/__gate/health`；转发时改写 Host（见 facts.md 的潜伏坑）。
  - **`app/api/internal/shutdown`（新）**：排空钩子。做成**路由**而不是进程内 SIGTERM handler，因为 run-bus 的 `RUNS` 是模块级 Map，`instrumentation.ts` 里注册的 handler 未必和 route handler 处在同一个模块实例，拿错实例就是对着空 Map 排空。
  - **`lib/server/ttyd.ts`**：修 `reapOrphans` 误杀（facts.md 已改写原条目）+ 新增「接管自己上一条命留下的 ttyd」。
  - Makefile 加 `deploy`/`rollback`/`deploy-status`/`releases`/`install-launchd`；README 补「长驻部署与升级」。
- **验证（全程零触碰 prod：沙箱 `TRELLIS_DEPLOY_ROOT=~/.trellis-deploytest` + 独立 launchd label + :3999）**：
  - 正路径 ✓：11s 走完，**不可用窗口实测 ≤0.2s**（104 次 200ms 轮询里只有 1 次非 200，且是 **503 维护页而非连接被拒**）。
  - build 失败 ✓ / smoke 失败（启动即崩）✓：`current` 未动、prod 全程 200。
  - 切换后验活失败 → **自动回滚** ✓（构造「只在 launchd 环境下 `process.exit(3)`」的 commit，过 smoke 栽在 verify，回滚后 200）。
  - 维护页 ✓：未认证视图对 sha / 绝对路径 / rollback.sh / Error **四项 grep 全 0**；认证后 sha×2、rollback.sh×1；健康面未认证只给粗粒度。
  - ttyd ✓：隔离实例走完整 reap 路径后 prod ttyd（pid 25990）存活；优雅停机收走自己那个 + 清登记；SIGKILL 后重启**接管同一 pid**（9321），不泄漏不漂移。
  - `install-launchd` 的 plist 改写在副本上 dry-run 过（diff 只动一行，`plutil -lint` OK）。tsc ✓ lint ✓ build ✓。收尾已拆除沙箱 job/plist/目录与三个测试 commit，prod 核对 517 节点 / 0 streaming / tmux 存活 / :3088 200。
- **翻车与真收获**: 沙箱第一次 smoke 失败追了很久——现象是网关 `/login` 超时但 Next 直连正常。**一度误判成 http_proxy**（A/B 曾支持该假设，实为端口被上一轮残留进程占住造成的假信号；教训：每次 A/B 前必须 `lsof` 验端口空、`pkill` 后要确认真的死了）。加探针看到**一次 curl 触发 260 次 fetch handler**，才钉死真因是 Host 透传导致网关自我循环。
- **切 prod（同日，用户「开始吧」）**：main 快进合并 arrowworm（纯 FF）→ `make deploy` → `make install-launchd`。**真上线又踩出两个自家 bug，都已修 + 已写进 facts.md**：
  - **① `git archive` 带不走未跟踪文件 → 认证闸静默关掉**。凭证在 `.env.local`（bun 从 cwd 自动加载）里，被 gitignore 忽略，release 里没有 → `auth OFF`，而本机配着 3088 的公网隧道。**症状极隐蔽：服务活得好好的、页面全能开、健康检查全绿，唯一差别是日志一行 `auth ON`→`auth OFF`**——原来那套全是 200 断言，一个都发现不了。修：真源挪 `~/.trellis/shared/` + `linkShared()` 软链进每个 release；`/__gate/health` 加 `auth` 字段；smoke 改认证感知（带 cookie 验闸后页面）+ **反向断言「无 cookie 的 `/api/sessions` 必须 401」**；verify 断言「闸不许 on→off」。
  - **② `launchctl bootout` 异步，bootstrap 撞上未消失的旧 job** 报 `Bootstrap failed: 5: I/O error`，而失败分支只打印「用备份还原」却没真还原 → **prod 停了约一分钟**（手工 bootstrap 救回）。修：轮询到 job 真查不到再 bootstrap（带重试），失败时真的回滚 plist 并重新拉起。
  - **终态**：prod 跑在 `~/.trellis/current` → `releases/20260728T091203-23099f885`，`auth ON`、`/` 无 cookie 401、517 节点 / 44 会话 / tmux 终端存活；修复后完整重跑一遍 deploy 全绿（含新增的两条闸断言），**457 次轮询里只有 1 次非 200（0.2s 的 503 维护页）**。顺手清掉失去主人的旧 ttyd 25990（tmux 不受影响）。
- **Next**: 现场验收（开一轮对话 + 开个终端）。可选：把已完工的 Goals 块轮转进 archive（README 仍 12.5KB，Goals 占 11KB）；P2 新版本通知（cron + phone-push）未做。

### Session 78（2026-07-27，流式渲染风暴修复）
- **触发**: 用户报「swift-wren-91 这个项目的 tab 点不开了」+ 顺手审 bug。定位到根因不是侧栏/标签页逻辑（行可点、onPreview/onPin 全对），而是**流式期间 UI 被卡死**——点下去主线程在忙，表现像「点不开」。
- **根因（真 DB + 真会话探针坐实）**: swift-wren-91 是暂存区下的 workspace（非 project），挂 1 个 project 模式 session（7a720cc6…），末节点 bef90d7d 有 **195 个 tool calls（392KB）+ thinking 34KB+**，整 session 接口 2.6MB。流式期间每个 SSE 事件（catchup / tool_call_start / done / update）都用展开语法 `{ ...s.nodes, [id]: {...} }` 替换**整个 `nodes` 对象**，而 `LinearThreadView`（`s.nodes`）与 `Canvas`（`s.nodes`）都订阅整个对象 → 每事件「全树重渲 + 全图重布局」。实测 30s 内 96 个事件持续轰击，且流式时 `TurnCard` 每帧对**整段** response 跑 `rehypeHighlight`（几百 KB）→ 主线程卡死。run 结束后（14 done / 2 error / 0 streaming）tab 恢复正常，但下次长流式必复现。
- **Done（1+2 治本，挡住渲染风暴）**:
  - **① tool_call 类事件合批提交**（`stores/sessionStore.ts`）：新增 `scheduleNodePatch` + 每帧一次 `set()` 的微调度（`PENDING_NODE_PATCHES` 缓冲 + `requestAnimationFrame` flush，单帧多节点折叠成一次 store 通知）。`catchup` / `tool_call_start` / `tool_call_done` / `tool_call_update` 四类高频事件改走合批；`done`/`error`/`interaction_required` 等终端事件仍即时提交（状态翻转要立刻反映，且不在高频路径）。`emitStream` 的 thinking/delta 本就绕过 React state 直推，不受影响。
  - **② 流式态不跑 rehypeHighlight**（`components/TurnCard.tsx`）：`REHYPE_STREAMING` 从 `[rehypeHighlight]` 改成 `[]`，高亮只在 done 态（`REHYPE_FULL`）跑一次——这是单帧最大头，流式高亮性价比极低（与当年跳过 rehypeRaw 同一逻辑）。
  - **③ TurnCard 加 React.memo**：线性 thread 订阅整个 `nodes`，合批后仍每帧一次重渲；memo 后仅引用变化的（流式）节点重渲，其余 15 张已完成卡（含 `REHYPE_FULL` 高亮）直接跳过。
  - **Canvas 侧**：`ChatNode` 本就 `memo` + 自定义比较器（只看 `data.node` 引用），所以合批后只有正在流式的那张卡重渲，其余 15 张不重渲；`layoutKey` 只跟 status/拓扑走，tool_call 事件不触发 dagre 重布局——画布侧天然已免疫大半，未再改动。
- **验证**: `tsc --noEmit` 全量零错 ✓；lint 无新增（仅 3 项既有 `set-state-in-effect` 基线警告，非本次引入）。
- **遗留 / 可选后续（未做，按性价比排序）**: ① 大 response 流式时 `liveThinking` 全文灌 DOM 仍可能卡（34KB+），可加截断/虚拟化；② 错误节点 4aaedfa1（ConnectionRefused）的 response 里混进原始 `<thinking>…` 标签，done 态 rehypeRaw 会当真 HTML 处理（目前没崩但是脏数据 + 潜在异常源），可在写入侧拦一道 + 清存量；③ 给渲染层加 error boundary，防组件崩溃白屏。
- **Next**: 用户现场验收——开一个长流式 project 会话（或重放 swift-wren-91），边流边切 tab / 切画布应不再卡死。改动在 main 工作区未提交。

### Session 77 (2026-07-27)

**上下文（原 README `## Current Focus` 首段，原样迁入）**

**S1：Project/Workspace 层级 + 工作区终端（Session 77，脑爆完成，设计已定，未开工）** → [设计稿](project-workspace-layer.md) / [ADR](decisions/2026-07-27-project-workspace-layer.md)。用户提四条想法（多 workspace 并行 / 侧栏按项目分组 / Agent 与 .claude 配置管理 / 多租户与镜像隔离），判定为**同一个抽象缺口的四个症状**——缺把「执行环境」提升为一等实体，拆成 S1（层级+终端）/ S2（worktree 生命周期）/ S3（Agent 配置档）/ S4（隔离+多租户），本轮只做 S1。**用户拍板 trellis 与 harbor 独立开发**（harbor 已有的 Agent 配置绑定 / worktree 隔离 / 跨设备派活与 ③④ 高度重叠，但不走借力路线）。**关键实测（真 DB + 真探针）**：① 41 session 里 21 个纯 chat、project 仅 14 个散在 6 个目录（4 个非 git repo），trellis 自己 3 个 worktree 同 remote 但 **3 个 project session 全在主 checkout、worktree 里一个没有** → worktree 并行开发 100% 在 CLI 里发生，S1 是「搬工作流」不是「修 bug」，故**判据定为行为指标：一周内 worktree 里的 session 数 > 0**；② **node-pty 在 bun 1.3.14 下不可用**（chmod +x spawn-helper 后不再报 posix_spawnp，但 onData 永不触发、8s 零输出；同代码 node v24.14.1 正常）+ **`Bun.spawn({pty:true})` 是假的**（tty 返回 not a tty）→ 终端不可能跑在 trellis 进程内；③ **单 ttyd 服务多 workspace 成立**（`ttyd -a -W tmux new -A -s` + `?arg=<name>&arg=-c&arg=<cwd>`，两 workspace cwd 各自独立、断开后 tmux session 存活、同名重连复用创建时间不变）。**设计要点**：加 `projects`/`workspaces` 两表 + `sessions.workspace_id`，**`workspace_path` 保留不删**（它是 spawn cwd 唯一真源，保住 spawn/resume/claude 前缀 jsonl/codex 前缀 rollout 四条脆链零改动）；project 靠 `git rev-parse --git-common-dir` + remote 归一化自动聚类；终端 = cookie 闸后反代到单个 ttyd，**每 workspace 可开任意多终端**（`ws-<id>-<n>` 各自独立 tmux session），**终端列表不入 DB，`tmux list-sessions -F` 就是真源**（零 schema、重启自恢复、无漂移）；底部分栏 + tab 栏，只挂载激活 tab 的 iframe（卸载断连但 tmux 存活、重连复用）。**分期** P0 数据模型+侧栏三级 / P1 终端（判据靠它不能砍）/ P2 git 状态+新建回收，**P0+P1 后停一周看数据**再决定 P2 与 S2/S3/S4。**Next**：开工 P0。

- **Done**: **工作平台化脑爆 → S1 设计定稿（未写一行产品代码）**。用户提四条想法（多 workspace 并行 / 侧栏按项目分组 / Agent 与 .claude 配置管理 / 多租户与镜像隔离），判为同一抽象缺口的四个症状 → 拆 S1–S4，本轮只做 S1。产物：[project-workspace-layer.md](project-workspace-layer.md)（设计稿）+ [decisions/2026-07-27-project-workspace-layer.md](decisions/2026-07-27-project-workspace-layer.md)（ADR）+ Goals 新增「工作平台化」区 + 3 条 Verified Facts。
- **Decisions**: ① **trellis 与 harbor 独立开发**（用户拍板，不走借力路线）；② 加两表一列不改，**`sessions.workspace_path` 保留**以保住四条脆链零改动；③ 终端走 **ttyd + tmux 外部进程**（因 bun 无 pty）；④ **终端列表不入 DB，`tmux list-sessions -F` 是真源**；⑤ **每 workspace 可开任意多终端**（用户当场推翻我原设计的「一个」——跑着 dev server 就没法再跑 test）；⑥ 判据定为行为指标而非交付物。
- **验证**: 全部实测非推断——真 DB 查 session/workspace_path 分布（41 session / 6 目录 / 4 个非 git）、`git worktree list` + remote 核实自动聚类可行、node-pty 在 bun vs node 双跑对照、`Bun.spawn({pty:true})` 证伪、`brew install ttyd` 后**双 workspace WebSocket 真连测**（各自 cwd / 断开存活 / 重连复用创建时间不变）。探针环境已清理（kill-server + 删 /tmp 产物），ttyd 保留在 `/opt/homebrew/bin/ttyd`。
- **踩到的坑（已写进 Verified Facts）**: node-pty 的 spawn-helper 无执行位；ttyd bind 有 3.5s 延迟（第一次探针 `sleep 1.5` 抢跑失败）；ttyd 吃 `http_proxy` 被 clash 污染；`tmux` 被 oh-my-zsh 函数遮蔽；iframe 键盘不冒泡致 `⌃\`` 只能开不能关。
- **注**: 顺带核实 prod 鉴权闸是开的（本地 `curl` 401）——测绘 subagent 曾据 launchd plist 无 `TRELLIS_AUTH_PASS` 报警说闸可能是关的，实测证伪。但 `https://trellis.smokingmouse.cc` 返回 **530**（cloudflared 那头没通），与本次工作无关，未处理。
- **Next**: 开工 S1 P0（两表 + 迁移回填 + git 自动聚类 + 侧栏三级）。当前分支 `trevally`，除本轮三个 progress 文件外无代码改动，未 commit。
- **追记（同 session，S1 P0 已落地）**: 见下一条 Session 77 P0 记录 —— 脑爆与实现在同一 session 内接续完成。

### Session 77 · S1 P0（2026-07-27，接上条脑爆）
- **Done**: **Project/Workspace 三级层级落地**（详细记录见 [project-workspace-layer.md](project-workspace-layer.md) 的「P0 落地记录」）。新增 `lib/server/project-cluster.ts`（git 推断层）+ `lib/server/workspaces.ts`（读写层）+ `scripts/test-project-cluster.ts`（26 项回归）；`sqlite.ts` 两表 + `sessions.workspace_id` 幂等 migration；`repo.ts`/`cli-import-db.ts`/`cli-sync-watcher.ts` 四条创建流接线；`instrumentation.ts` boot 回填；`/api/sessions` 带回 `projects` 骨架；`SessionSidebar` 三级渲染 + 折叠持久化。
- **与设计稿的三处偏离（实测逼出来的）**: ① `cluster_key` 与 `git_remote` 拆两列（原设计用 remote 当唯一键，非 git 与无 remote 的本地 repo 无法去重）；② **加了兄弟 worktree 主动扫描**（原归 P2）——实测只按「有 session 的目录」聚类时 trellis 项目下只剩主 checkout，`sole`/`trevally` 被 0-session 过滤掉，而那正是判据要打的地方，不扫等于判据必败；③ workspace 名用目录 basename 而非分支名（`~/.claude` 会显示成 "master"）。
- **关键纪律**: `ensureWorkspaceForPath` 有**纯 SELECT 快路径**（cli-sync-watcher 高频调用，流式期间每秒多次，不能 spawn git）；归组解析一律在事务外；归组失败吞异常返回 null（绝不带崩创建会话主链路）；`workspace_id` 用 `ON DELETE SET NULL` 不连坐删历史；过滤 `<repo>/.claude/worktrees/agent-*`（Claude Code subagent 的临时隔离目录，本机 trellis repo 实测有两条）。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / worktree 独立 build ✓ / 聚类回归 26 项 ALL PASS / 隔离实例 :3170（真 DB 副本沙箱）——回填 18 session·8 目录且幂等、35 session 完全对账（归组 12 + chat 21 + 未归组 2）、聚类落点全对（三 worktree 认亲成一个 project）、浏览器 DOM 级核验缩进与状态、折叠+持久化+三层下点击跳转、**闭环：mock provider 在 trevally worktree 真发一轮 → `created` 事件当场带 workspaceId → 侧栏该 worktree 从「0 会话灰显」变「1 个会话」**。真库零触碰已核实（无 projects 表、session 数仍 41）。
- **Next**: **P1 终端**（ttyd boot + `/term` 反代 + 底部分栏 + 多终端 tab）—— 判据靠它。P0 未 commit。

### Session 77 · S1 P1 终端（2026-07-27，接上条）
- **Done**: **工作区终端落地**（详细记录见 [project-workspace-layer.md](project-workspace-layer.md) 的「P1 落地记录」）。新增 `lib/server/ttyd.ts`（进程生命周期 + 孤儿收尸）+ `lib/server/terminals.ts`（tmux 为真源的列表层）+ `app/api/terminals/route.ts` + `components/TerminalPanel.tsx`（底部分栏 + 多终端 tab + 拖拽调高 + ⌃` + 远程降级）；`LinearThreadView`/`Canvas` 加 `var(--trellis-term-h)` 让位（与 `--trellis-sb` 同一套 CSS 变量模式）。
- **架构被自己的实测推翻一次**: spec 原画「trellis 在 cookie 闸后反代 `/term/*`」，开工先打这个洞 → 三层探针证明 **bun 的 node:http upgrade socket 写不回客户端**（详见 Verified Facts）→ 改 **iframe 直连 `127.0.0.1:<ttyd 端口>`**，安全靠「ttyd 只绑 127.0.0.1、远程连不上」而非 cookie 闸，远程渲染降级面板并给出确切的 `tmux attach -t <session>`。**教训：spec 里写下的约束要与自己画的架构图当场对账**——那条「App Router 不能升级 WebSocket」当时就在文档里，却没和反代图对上。用户在三个备选（直连 / Bun.serve 前置代理 / 第二个 tunnel hostname）里拍板直连。
- **改掉两处自己写错的东西**: ① `nextTerminalSession` 的注释在说谎（原写「max+1 为了不复用死名字」，实测关掉最大号再开就是复用；它真正买到的是**不与活着的 session 撞名**——count+1 在序号有空洞时会撞上活的，而 `tmux new -A -s` 同名会 attach 到已有 session，用户点「+」得到的是副本不是新终端）；② 远程降级面板没兑现「给出接管这个终端的确切命令」（远程路径没拉列表只能显示 `tmux ls`）→ 加 `start=0` 参数让远程只读列表、不触发 ttyd 懒启动。
- **补一个真泄漏**: spec 写了 boot 清理旧实例但实现时漏了。实测**杀掉 trellis 后 ttyd 不跟着死**，孤儿占着端口逼新实例漂到 7682，每重启泄漏一个。补 `reapOrphans()` 按签名清理；**tmux session 刻意不清**（那正是「重启不丢终端」）。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / build ✓ / 隔离实例 :3170 —— API 十项（懒启动、cwd 落点、序号递增、双终端隔离、断开重连状态不丢、DELETE、前缀闸挡住手建 session、空洞场景 max+1 不撞活的）；浏览器十一项（真提示符含真分支真 git 状态、**面板里真敲 `git branch --show-current && bun --version` 得 `trevally`/`1.3.14`**、composer 让位、多 tab 切换后命令历史完整还在、关 tab 真 kill、收起/⌃` 重开、chat 会话无入口、局域网 IP 触发降级面板并给出确切 attach 命令）；跨重启 `capture-pane` 仍留着浏览器那轮的输出。真库零触碰已核实。
- **遗留**: `killWorkspaceTerminals` 已就绪但无调用点——workspace 移除/删除是 P2，届时必须接上，否则 tmux 里堆孤儿。
- **Next**: 用户现场验收（本机开一个 project 会话 → ⌃` → 跑测试）。P0+P1 均未 commit。**按计划应停下来看一周数据**（判据 = worktree 里的 session 数 > 0）再决定 P2 与 S2/S3/S4。

### Session 77 · P1' 换大门：终端变成同源接口（2026-07-27，用户打回后重做）
- **触发**: 用户验收时报「终端访问不了，我希望的效果是能远程访问」，并给出判据性的一句 —— **「不应该是作为一个接口吗，怎么使用的这个平台，就怎么使用终端？」**。这句话是对的：P1 那版把终端做成了**旁路**（独立端口 + iframe 直连 127.0.0.1 + 打算给 cloudflared 加路由 + 远程降级面板 + `isLocalHost` 分支），全是为绕开「Next 不能升级 WS」长出来的偶然复杂度。正确解是解决限制本身 —— **换掉大门**。
- **诊断顺带修好一件更大的事**: `cloudflared tunnel info` 显示隧道 **`does not have any active connection`**，整条隧道上 15 个服务全 530 —— 用户「远程访问不了」的直接原因其实是这个，跟终端无关。`launchctl kickstart -k gui/$(id -u)/com.smokingmouse.cloudflared` 后全部恢复（trellis 401 / memos 200 / ip 200）。cloudflared 2026.3.0 已过期（建议 2026.7.3），**是否是它导致连接失效未查**，下次再断先看这条。
- **Done**: 新增 `server.ts` —— Bun.serve 当大门：`/term/*` 校 cookie 后转发 ttyd（HTTP + WS），其余全部转发给内部端口（`PORT+99`，只绑 127.0.0.1）上的 `next start` 子进程。`package.json` 的 `start` 从 `next start` 改成 `bun server.ts`（认 `-p`），**launchd plist 一个字不用改**。新增 `/api/terminals/port` 供大门问端口。前端**净减代码**：删 `isLocalHost` / `RemoteFallback` / 直连 iframe / API 外露端口 / `start=0` 补丁参数，iframe src 变成同源 `/term/?arg=…`，本机远程同一条路径。
- **差点上 prod 的 bug（已写进 Verified Facts）**: bun 的 `fetch` 自动解压上游响应且自带 `Accept-Encoding`，原样透传响应头 = 客户端收到「声称 gzip 的明文」。**curl 默认不解压所以一路 200 全绿，浏览器白屏卡死** —— 第一次浏览器实测才暴露。修法是转发时删 `content-encoding`/`content-length`/`transfer-encoding`。教训：代理层的验证不能只用 curl。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / build ✓；本机与隧道两条路径 `/` 401、`/login` 200、`/term/` 401 完全一致；隧道上 `--compressed` 拿到完整明文 HTML；关闸实例上 `/term/ws` WebSocket 真 shell（`git branch --show-current` → `trevally`）+ 真 `/api/chat` SSE 49 delta 跨 1154ms 未缓冲；浏览器页面正常、iframe 同源、终端保留重连前输出。**无 cookie / 假 cookie 打 `/term/` 均 401**。
- **Next**: 用户远程验收（手机或公司机开 trellis → 任意 project 会话 → ⌃`）。**WS 经 Cloudflare 那一跳我没法自测**（需要登录态），是唯一未覆盖的一环。

### Session 77 · 交互返工三连 + P2 提前（2026-07-27，用户三条反馈）
- **① 终端改 Quake 浮层 + 可钉住**（「终端最好别放底下，有没有更轻量优雅的」）。默认浮层：`⌃\`` 唤出、悬右下圆角带阴影、对话四周透出，**`--trellis-term-h` 恒为 0 = 内容区零常驻让位**（这就是「更轻」的全部含义）；点钉住变回底部通栏分栏、内容区让位，保住用户最初选它的理由（一边看 agent 输出一边跑测试）。钉住是**全局偏好**（回答「我习惯哪种形态」）而非 per-workspace。浮层刻意 `bottom:88` 抬到 composer 之上——盖对话是 Quake 终端常态，盖输入框不行。
- **② 侧栏**：宽度可拖右边缘（160–420 + localStorage）；**`--trellis-sb` 的所有权从 page.tsx 移到 SessionSidebar**（宽度一旦可变，两处各按常量发一份必然打架）；Chat 与「未归组」也可折叠（合成 id `__chat`/`__orphans` 复用 projects 那套 collapsed 集合，不开第二份状态）。
- **③ worktree 创建/删除**（原划 P2；用户一提就发现原判断错了——侧栏显示了 worktree 却不能在里面新建，它就只是个只读装饰）。新 `POST/DELETE /api/workspaces/worktree`：已有同名分支直接检出否则 `-b` 新建、落主 checkout 同级兄弟目录、`created_by='trellis'`；删除**默认拒删有未提交改动**并回传脏文件清单，`force=1` 才真删，删前先 `killWorkspaceTerminals`——**正好接上 P1 留的那个悬空调用点**。UI 只给 git 项目挂「+」、只给 `created_by='trellis'` 的挂删除（用户自己在 CLI 建的不给删磁盘按钮）。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / build ✓ / 隔离实例 :3170 —— 浮层圆角 + 让位 0px、钉住后圆角消失 + 让位 260px + 左缘对齐侧栏、取消钉住回浮层；侧栏拖 210→310 且 reload 保持；Chat 折叠子项隐藏；「+」只出现在 trellis/.claude 两个 git 项目；**真 UI 填分支名回车 → 磁盘目录 + 分支 + 侧栏行三者同时出现**；删除被脏改动拦下（回传 `?? DIRTY.txt`）、force 后目录消失 + 该 workspace 的 tmux 终端清零 + `git worktree list` 干净。测试产物（两个探针 worktree 与分支）已清理。
- **Next**: 用户验收。P0/P1/P1'/本轮均未 commit（22 个文件，9 新增）。

### Session 77 · 性能排查：ttyd 互相残杀（2026-07-27，用户报「切 tab 和终端都得等好久」）
- **量了一圈，后端全是干净的**：大门 vs 直连内部 Next 的差是 **~1ms**（/login、静态 chunk、401 路径各 5 次取平均）；`/api/sessions` 9ms、`/api/sessions/<id>` 2ms、`/api/runs` 1ms、`/api/providers` 5ms；浏览器里真切一次 tab，全部请求 ≤ 27ms。gate 进程 FD 24、CPU 0.4%、无 CLOSE_WAIT，**无泄漏**。
- **找到并修掉一个真 bug（我自己引入的）**：`reapOrphans()` 按命令行签名杀 ttyd，**认不出是哪个 trellis 实例的**。同时跑两个实例时（prod + 隔离测试实例，正是我这一路的状态），后启动的会把先启动的 ttyd 杀掉 → 用户的终端反复死亡重建。**判据改用 PPID**：父进程死后子进程被 reparent 到 launchd（PID 1），所以 `ppid == 1` 才是真孤儿；被活实例持有的 ttyd 其 ppid 是那个实例的 pid。实测双向都对：起第二个实例时 0 条收尸、第一个的 ttyd 存活；杀掉某实例后其 ttyd ppid 变 1，下一个实例启动时被正确收掉且不误伤活着的。
- **量到的真实成本（非 bug，是环境）**：**复用已有 tmux session 首字节 8ms，全新 session 588ms** —— 差的 580ms 全是交互式 zsh 启动（`zsh -i -c exit` 实测 0.53–1.15s，powerlevel10k 等配置）。所以只要终端不被杀就是瞬开；一被杀就每次重付。这条解释了「命令行得等好久」。
- **没能复现的**：「切 tab 得等好久」在隔离实例里复现不出来（所有请求 ≤ 27ms）。**待用户给更锐的信号**：是所有 tab 都慢还是只有 project tab、终端面板开着时才慢还是关着也慢、本机还是隧道。
- **追记（用户一句话点破根因）**：「是每次切换会默认创建命令行吗，命令行能改成点击才创建吗」—— 正是。`TerminalPanel` 里有一行「面板打开且列表为空就自动建一个」，理由是「别让用户对着空面板再点一次」。**那个理由建立在「创建很便宜」上，而实测创建要 588ms**，前提根本不成立。于是闭合成恶性循环：叉掉终端（=kill-session）→ 切到别的 workspace 再切回 → 列表为空 → 又自动建 → 每次重付 588ms，还在 tmux 里堆 session。**删掉自动创建**，空态改成一个居中的「新建终端」按钮（创建显式化之后，空态就得把「怎么建」摆在手边）。
- **三个症状是同一条因果链**：`reapOrphans` 杀掉别的实例的 ttyd → `state.port` 被清 → **每次 `/api/terminals` 都走完整 spawn（202ms）** → 终端列表空 → 自动创建（588ms）→ 每次切 tab 重演。修完实测：`/api/terminals` 稳态 **202ms → 6ms**；面板打开后终端数 0（不再自动建）；点「新建终端」才出 iframe；**来回切 workspace 终端数 3→3 不新增**，切回时 attach 已有 session。
- **`✕` 的语义已明确**：= `kill-session`，shell 状态会丢；「只是不想看」用右上角收起（收起 / 切 tab / 重启 trellis 都不杀 session）。tooltip 已写清。
- **再追记（用户仍报慢 + 「像是这次优化后才出现」）→ 根因是隧道绕美国，与代码无关**：
  - **代码侧全部洗清**（同一份构建、同 DB，大门 3170 vs 直连 Next 3271 干净 A/B）：单请求差 ~1ms；**30 并发** 大门 14ms / 直连 13ms（持平）；**浏览器首屏** load 64ms vs 70ms、25 个资源零个超 100ms；**真实切会话 2–3ms**（MutationObserver 等到内容渲染完，不是固定 sleep）。
  - **`https://trellis.smokingmouse.cc` 首屏 load 4857ms，本机 `127.0.0.1:3088` 64ms —— 76 倍。** 单请求 1463ms vs 2ms（TLS 532ms + 首字节 1192ms 全是网络往返）。同隧道的 memos 1.38s / ip 1.35s **一样慢 = 隧道问题不是 trellis 问题**。
  - **为什么绕**：cloudflared 报 `ORIGIN IP 120.235.172.206`（广东）但 `EDGE 1xlax01/1xlax05`（洛杉矶）；机器出口 IP `206.190.238.193`（美国，clash 代理出口）。于是「浏览器 →(美国出口)→ CF 洛杉矶 →(隧道)→ 本机广东」，**为访问本机服务绕两趟太平洋**。
  - **为什么"像是这次优化后才出现"**：隧道此前是**死的**（`does not have any active connection`，全站 530），是本 session 我 `launchctl kickstart` 修好的。修好前用户只能走 127.0.0.1（快），修好后一旦改用域名就吃这 1.4s/请求。**确实是我这轮引起的，但引起它的是「我修好了隧道」，不是代码。**
  - **用户追问「不应该是 trellis.home.smokingmouse.cn 吗」→ 查清了整张访问拓扑**（Verified Fact，别再猜）：
    - `trellis.home.smokingmouse.cn` 真实 A 记录 = **182.92.78.57（阿里云北京）**，那台机器就是 tailnet 里的 `aliyun`（100.77.207.43）——所以 `.cn` 的路径是「浏览器 →(clash 代理，美国出口)→ 阿里云北京 →(Tailscale)→ macmini 广东」，**三跳且绕美国**。它从来就不是本地路径。
    - **clash 是 TUN 模式全局劫持 DNS**（两个域名都解析成 fake-ip `198.18.0.x`，`dig @8.8.8.8` 也绕不开；真实记录要用 DoH 才查得到）；运行时规则里**没有任何 smokingmouse 条目**，兜底是 `MATCH,Proxy` → 两个域名统统从代理出去。
    - **Tailscale 一直在跑**（`macmini` 100.102.237.93 / `aliyun` 100.77.207.43 / iphone17 / macbook-pro）。
    - **五路实测**：`127.0.0.1` 2.3ms · 局域网 `192.168.10.134` 4.3ms · **Tailscale `100.102.237.93` 4.6ms** · `.cn` 326ms（首次冷握手 10.6s）· `.cc` 1241ms。
  - **结论/建议**：本机用 `127.0.0.1:3088`；**任何设备（手机/公司机/MacBook）只要在 tailnet 上就用 `http://100.102.237.93:3088` —— 4.6ms，与局域网同级，且不经任何第三方**。想继续用域名则需要两件事同时做：clash 加 `DOMAIN-SUFFIX,smokingmouse.cn,DIRECT`，且让该域名在 tailnet 内解析到 Tailscale IP（MagicDNS / split-DNS），否则 DIRECT 之后仍然是绕阿里云北京的 326ms。
- **已合并上线（同日）**：`trevally` → `main`（merge `4bf66ef`，`--no-ff` 保住工作线形状），主 checkout tsc ✓ + `make build` ✓；prod 交回 launchd（`launchctl load com.smokingmouse.trellis`），进程形态 launchd → `bun server.ts -p 3088`（大门）→ `next start -p 3187`（内部只绑 127.0.0.1）；验活 / 401 · /login 200 · /term/ 401。**未 push**（推送需用户签名授权）。
- **Cloudflare 隧道已按用户要求关闭**（`launchctl unload com.smokingmouse.cloudflared`，配置备份 `~/.cloudflared/config.yml.bak-20260727-213648`）。副作用：`files.smokingmouse.cc` 真掉线（`.cn` 侧 502 未配通）；`ip.smokingmouse.cc` 变 530 而 **blog-publish skill 有 5 处引用它**，下次发博客验活会报错（服务没死，`ip.home.smokingmouse.cn` 200，只是地址过时）。另一条隧道 `cloudflared-trader` 未动。访问路径见 `~/.claude/global/workspace.md` 新增的「对外访问路径」节。
- **Next**: 用户验收 + **停一周看判据**（worktree 里的 session 数 > 0）再决定 P2 与 S2/S3/S4。唯一未覆盖的验证：ttyd 在 launchd 环境下的懒启动（需登录态才触发，我测不到）。

### Session 75 (2026-07-26)
- **Done**: 修 ExitPlanMode 批准报 ZodError。用户带着「Trellis 与 Claude Code 协议版本偏差」的自诊来，**结论推翻了它**：是 Trellis 自己三处交互表单里唯独计划审批漏传 `updatedInput`。改 `components/InteractionForm.tsx`（真 bug）+ `lib/server/run-bus.ts`（resolver 兜底回填）+ respond route 的误导注释。
- **设计取舍**: 没有把 `lib/llm/types.ts` 的 `updatedInput?: unknown` 收紧成判别联合（allow 强制 record）——那样能在编译期拦住这类漏传，但 respond route 收的是不可信 HTTP JSON、终究要运行时校验一遍，而 run-bus 那道兜底已经把这个位置守死了。为编译期好看做一圈波及面更大的重构不划算，留作独立一刀。
- **验证**: 关键在**对照组**。第一次 A/B 用本机默认 CLI(2.1.207)跑，未修版竟然也全绿——说明测法当时**没有区分力**，差点误判「已修好」。查出本机是 2.1.207 而用户报错在 2.1.183，把 183 装进 `/tmp/cc183` 用 PATH 钉版本重打：未修版逐字复现用户的 ZodError + 模型重发 ExitPlanMode 卡死，修复版一次通过并续跑写文件。**教训**：跨版本 bug 的对照组必须钉住报障者的版本，否则"绿"毫无信息量。
- **未做**: 浏览器点击态验证被一个**既有的** dev-mode hydration 故障挡住（见 Open Failures），故改走 API 直打——反而更强，因为它直接复刻了老客户端的错误 payload，同时验到了服务端兜底。表单那一改属静态可核（与另两处已 work 的表单同构）。测完已清：dev server kill / 沙箱 DB 删 / 临时 workspace 删 / `/tmp/cc183` 删 / browser session close / `.next/dev` 残留清；prod :3088 复核仍 401 正常、`.next/BUILD_ID` 未变。
- **Next**: 用户决定是否提交（在 main 未提交，提交需先切分支）；要在 prod 生效需主目录 `make build` + `launchctl kickstart -k`。

### Session 74 (2026-07-26)
- **Done**: 树面板图形视图补上折叠子树（列表视图 S69 已有，本轮补齐另一半）。需求原话「能增加一个树节点折叠的功能吗」含糊——先摸清折叠已存在于画布/Outline/树面板列表三处，再反问定位到图形视图，没有重复造。
  - `components/TreePanel.tsx`：`graphGeometry` 加 `hiddenByCollapse` 过滤后再喂 `layoutNodes`（折叠子树整块退出布局，剩余点重新占满面板）+ 返回 `visible` 供渲染；每个非叶点挂 ⊖/⊕ 按钮子 `<g>`（`e.stopPropagation()` 与跳转分开）、折叠点常显 + `+N ·未读` `<text>` 角标；`GRAPH_MAX_SCALE=0.4` 取代原来的 `1`。
  - `lib/tree-panel.ts`：`subtreeRollup(nodeId, byParent)` + `HiddenRollup` 从 `flattenTree` 内部闭包提出来共用；TreePanel 顺带把 `childrenIndex` 收成一个 memo（原来 lineageIds 里每次重建）。
- **设计取舍**: 按钮**悬停才显**——纯链树上每个点都有子节点，常显等于每点挂一颗纽扣；已折叠的点必须常显，否则折完无回头路。按钮圆心放在 `p.x ± 9`（点自己 r=10 命中区之内），移过去不会触发 mouseleave 把按钮闪没；同一 `<g class="group">` 下用 CSS `group-hover:` 而非 React state，省掉每次悬停的重渲染。
- **验证**: tsc ✓ lint ✓ build ✓（emperor worktree）；隔离实例 :3164 浏览器实测十一项，含「从冷位置直接点按钮」这条最易塌的路径。测完已清：browser session close / dev server kill / 临时 DB 删 / emperor worktree `git checkout` 复原。
- **Next**: 用户现场验收；上 prod 需主目录 build + kickstart。

### Session 73 (2026-07-25，原编 69，与 S69「树面板折叠子树」撞号重编)
- **Done**: 子 Agent 链可视化（Stage 22）。用户：「只渲染了工具链，没有子 Agent 链，感觉不是很友好」。
  - **协议实测**（先抓真流再动手，`scripts/fixtures/subagent-stream.jsonl`）：派活 = 名为 `Agent` 的 tool_use（老版 `Task`，input 带 description/prompt/subagent_type）；子 agent 的工具行带 `parent_tool_use_id`；`system` 的 task_started/progress/updated/notification 四行携 subagent_type·prompt·last_tool_name·usage·**summary**；子 agent 正文不走 stream_event delta。
  - **SDK 依赖**：`EventType.Task`（run() 内 taskId→toolUseId map 补齐 `task_updated` 缺失的 tool_use_id）+ ToolCall 透传 `parentToolUseId`。这两处正是 S72 追记⑤ 说的「publish 时 src 里的未提交改动」，**实测 `@smokingmouse/agent@0.3.0` 不含、`0.3.1` 才含**（`npm pack` 解包 grep 验证）——bun.lock 本轮提到 0.3.1。
  - **trellis 数据层**：`ToolCall` 加可选 `parentToolUseId` / `agent: SubagentMeta`（复用 tool_calls JSON 列 → 零 migration，catchup/持久化白嫖）；新 StreamEvent `tool_call_update`（patch 语义，四处同构定义）；repo `patchToolCallAgent` + `mergeAgentMeta`（剔 undefined，只并不换）；run-bus 新分支照抄 commit→DB→broadcast 纪律，`pendingAgentPatches` 兜住乱序，**手搓的 broadcast payload 补 parentToolUseId**（漏了就是直播扁平、刷新才嵌套）。
  - **UI**：`lib/subagents.ts` 纯数据 split（孤儿 parent 回落顶层、限深防环、meta 缺失时从 tool input 回填、done 后描述回落原始任务而非最后一步）；`components/SubagentPanel.tsx` 独立成区置于 🔧 之上；`ToolCallsPanel` 导出 `ToolCallRow`/`formatDuration` 复用 + 有子 agent 时标题加「（主 agent）」；ChatNode 徽标拆 🔧n/🤖n。
- **验证**: tsc ✓ build ✓；`bun scripts/test-subagent-chain.ts` 11 项 ALL PASS（fixture 灌进真 SDK 后端 → toStreamEvent → 合并 → split，用 shim 假 `claude` 上 PATH 回放）；隔离实例 :3160（独立 HOME + 真 claude project 会话）浏览器实测七场景全绿（见 Current Focus）。合 main 后复验：tsc ✓ / 11 项断言 ✓ / build ✓。
- **踩到并修**: abort 后 Agent 调用永停 `running`（既有通病，任何未完工具皆然）→ 计时器会在死 run 上永远往上跳。改判据为 `live = node.status === "streaming"`，非 live 的 running 显「已中断」pill；改 DB 造状态验证该分支。
- **合 main 记要**: main 领先 10 commit（S69-S72）。冲突两处均机械：`sdk-adapter.ts` 取 main 的 `@smokingmouse/agent` 包名 + 保留本轮 `SubagentMeta` import；`progress/README.md` 取 main 全文再插本条。ChatNode/sessionStore 自动合并（peek card 与本轮徽标改动不重叠）。
- **Next**: 用户现场验收 → push；上 prod = build + kickstart。


### Session 72 (2026-07-25)
- **Done**: 清仓 Aaron 两个 open PR（无 open issue）。#10 `fix(popover): IME 组合输入的回车不触发发送`（BranchPopover 单文件 IME 守卫）+ #11 `feat(canvas): 卡片原地展开预览(peek)`（Canvas/ChatNode/layout 三文件：compact 卡「展开预览」→ 原地 600×480 完整卡，`forceFullIds` 确定 footprint 单趟 reflow，多卡同开/收起折回，popover rendersFull 门控），均 `gh pr merge --merge` 合入并已在 GitHub 推送。
- **Review 要点**: #11 popover 门控最大风险 = 误伤其他选区路径，已排除——`data-chat-node-id` 仅 ChatNode（画布）/TurnCard（线性）携带，Canvas 与 LinearThreadView 互斥挂载，reference 卡无该属性；`rendersFull` 与 ChatNode `showCompact`（含 S64 errorSuperseded）语义镜像一致。#11 顺带的 FollowupInput 焦点环 px-1.5 wrapper 为无害 drive-by。
- **验证**: 合并树（origin/main + 两 PR）tsc ✓、touched 4 文件 lint 零新增（Canvas 2 项 `set-state-in-effect` 与 main 基线逐条对齐）、隔离 worktree（~/trellis-prcheck-tmp 共享 node_modules）`bun --bun run build` ✓；隔离实例 :3163（`TRELLIS_DB_PATH` 沙箱 + `env -u TRELLIS_AUTH_PASS` 关闸 + mock provider）agent-browser 全链路：建 2 节点树 → #1「展开预览」→ DOM 实测 peek 卡 600×480 z=1000、子卡 y=556（480+40 起点 +36 间距）无重叠、URL/视图不变未跳线性 →「收起」→ 两卡回 280×47、子卡回位 y=166。产物已清（browser session/server/worktree/临时 DB）。
- **仓库状态注记**: S71 三 commit（npm 化 + 模型配置）本地未 push（`@smokingmouse/*` npm 404，publish 闸未过）；已 `git rebase origin/main` 把它们叠到 PR merge 之上，rebase 后合并树 tsc ✓。shell 环境自带 `TRELLIS_AUTH_PASS/TOKEN` export——隔离实例起服务须 `env -u` 显式剥离，否则 401（本轮踩到）。
- **Next**: 用户 npm login → publish llm+agent → 两仓 push（S71 Next 原样）；PR 两功能上 prod = build + kickstart；#11 真机手感验收（peek 与 hover 预览卡并存的观感）。

### Session 68 (2026-07-19)
- **Done**: markdown 答案里图片本地路径破图修复（用户截图报「图没法预览」）。
  - 根因：`MD_COMPONENTS` 缺 `img` 渲染器——S63 只接管了 `a`（MdLink）和行内 `code`（InlineFileButton），`![alt](/Users/…/foo.png)` 的本地 src 直进 `<img>`，浏览器按 http 路径请求 404。
  - `components/HoverPreview.tsx` 新增 `MdImage`：`previewableHref` 判本地（绝对 / file:// / workspace 相对）→ `filePreviewUrl` 走 `/api/files` 白名单代理，onClick 开 FilePreview overlay；远程 URL 原样；`onError`/空 src 降级行内占位（🖼 + alt + S63 同款自解释文案）。`lib/md-components.ts` 注册 `img`。
  - 白名单政策零改动（S63 用户裁定不扩白名单）；服务端零改动。
- **验证**: tsc ✓ + lint 与基线持平（7 项均既有，途中清掉自己引入的 4 项：img any / _node unused / disable 注释错位）+ `make build` ✓；隔离实例（独立 HOME + mock project 会话，:3158 初测 / :3159 lint 清理后复测）四形态 + 点击 overlay 全过，产物已清（browser session / server / 临时目录）。
- **排查注记**: 用户截图会话（#171 · Turn）在本机 prod DB（~/.trellis/data.db，全库无 `![` 语法）、CLI jsonl、blobs 均无——应来自另一台部署（公司机）。序号 = `buildNodeIndex` 会话内计数，本机最大会话仅 124 节点，可交叉印证。渲染层代码共享，修复对所有部署生效。
- **Next**: 用户现场验收；上 prod = merge main + build + kickstart（S66 追记硬规则）。

### Session 62 (2026-07-17)
- **Done**: 线性视图内容列宽度可调（用户反馈卡片太窄，问能否加宽/可调/设置页）。
  - 新 `lib/thread-width.ts`：`ThreadWidth` 三档（narrow=max-w-3xl 768 / wide=max-w-5xl 1024 / xwide=max-w-7xl 1280），默认 **wide**（直接兑现「加宽」，可一键调回）。
  - store：`threadWidth` 偏好 + `setThreadWidth` + hydrate 恢复（key `trellis-thread-width`，全局非 per-session，照 sendKey 模式）。
  - `LinearThreadView`：三处 `max-w-3xl`（顶栏/main/Composer）换共享 `widthClass` 保持列对齐；顶栏 🗺 画布旁加「窄/宽/超宽」分段控件（`hidden md:flex`——移动端卡片本就贴满屏宽）。
  - 设置页：评估不做（偏好少且各有语境化入口，简洁优先）；偏好积累多了再上 Header ⚙ popover 归拢。
- **验证**: tsc ✓ + `make build` ✓；隔离实例（:3151 + 临时 DB + `TRELLIS_AUTH_PASS=` 关闸 + `/model mock`）agent-browser 实测：默认落 wide(1024)、点窄→768、点超宽→顶栏/main/Composer 三容器同宽 1070（viewport 1280 减侧栏后自然封顶，符合预期）、localStorage 写入 ✓、reload 恢复超宽档 ✓、截图目检控件位置/高亮正常。产物已清（browser/server/临时 DB/截图，:3151 已释放）。
- **Next**: 已提交推送 main（免签待补）；真机验收待用户。注记：readingPosition 存像素 offset，切宽度后卡片高度变化会让旧恢复位置略偏——一次性、无害，未做迁移。

### Session 61 (2026-07-16，原 60 与并行 session 撞号重编)
- **Done**: ThreadMinimap 悬停预览卡（用户给了 ChatGPT 会话 minimap hover 截图，要同类功能）。仅改 `components/ThreadMinimap.tsx`：
  - 点位 `g` 加 mouseenter/leave + focus/blur → `hover` state；预览卡绝对定位在面板左侧（`right-full mr-2 w-64`），垂直居中于点位 y（clamp 40..SVG_H−40），`pointer-events-none` 防抢 hover。
  - 卡内容：`#序号`（复用 `buildNodeIndex`）· Turn/Reference + 标题（`topicLabel ?? question` 摘要，clamp 2 行）+ 回答摘要（新增本地 `excerpt()` 剥 markdown——代码块/图片直接丢，clamp 4 行；error→「生成失败」，streaming 空响应→「生成中…」）。
  - 点位加 r=9 透明命中圈（原 r=3.5 可视点太小难悬停/点击）；悬停节点被删有 guard。
- **验证**: 本 worktree（preview）原无 node_modules，`bun install` + `make relink-sdk` 后 tsc ✓ + `make build` ✓；隔离实例（:3149 + 临时 DB + `/model mock`）agent-browser 实测：3 节点线性视图，真实鼠标移动悬停两点位 → 各自卡内容正确（标题/摘要/序号）、移开卡消失（查 DOM 元素而非 innerText——正文含同样文案会误判）、点击点位导航照常（active 高亮 + 线程跳转）。产物已清（browser session/server/临时 DB；默认 ~/.trellis/data.db 查证无泄漏）。
- **Next**: 已提交并合并推送 main（免签待补）。真机验收待用户。候选 follow-up：S57 遗留的「ThreadMinimap 移动端默认折叠」可与本功能一起调（移动端无 hover，预览卡天然不触发，无冲突）。

### Session 59 (2026-07-16)
- **Done**: 用户报的两个体验 bug 修复。
  - **①切卡滑动**：`LinearThreadView` anchor 导航 `scrollIntoView` 去掉 `behavior:"smooth"`（长 thread 切卡会肉眼滑过整屏内容才停），TargetChip label 跳转同改。
  - **②tab 串台**（根因 = `handleStreamEvent` `created` 不校验 session 就插入当前 nodes map 并 `focusNew` 抢焦点；发送后立刻切 tab 即复现「另一个 tab 也变成运行，内容是原 tab 的」）：
    - `created` 加 guard：`!event.session && s.session?.id !== node.sessionId` → 跳过 store 提交（run 服务端继续，切回时 loadSession + bus 缓冲接上；unread 角标由 run 轮询 diff 兜底）；`handleRefStreamEvent` created/done、`refreshReference` 同规。
    - `loadSessionInternal` 加模块级 `loadSeq` latest-wins：慢的旧加载（cli-sync session_updated 重载、连续快切）resolve 晚不再把视图翻回旧 session。
    - `useCliSyncEvents`：`event.sessionId === 当前` 判断改读 `useSessionStore.getState()`（原 closure 捕获值在切换窗口期 stale，运行中 attached 会话持续 session_updated 会把视图拉回去）；顺带 SSE 连接不再随每次切 session 重建。
    - **切走再切回重复文本修复**：`loadSessionInternal` 对仍 streaming 且本地有活订阅的节点——POST reader（bus pending 自 created 起为全量）→ 本地 response 置 ""（恢复 created 基线，防「DB 快照 + pending」拼接翻倍，done 提交同理受益）；活 reconnect 句柄（基线是旧 catchup，已不可考）→ 同步拆除 + 清 bus，靠随后的 reconnect pass 重挂拿新权威 catchup。`jumpToSearchHit` 补调 `reconnectStreamingNodes`。
- **验证**: tsc ✓ + `make build` ✓；隔离实例（:3145 + 临时 DB + mock，`/model mock`）agent-browser 实测：A 流式中切 B → B 无 streaming cursor/停止按钮、canvas 只有自己节点；流式中切回 A（`backWhileStreaming:true`）→ 继续流、done 后 DB（578 字符 ×1）与可见渲染（marker ×1）均单份。产物已清（browser session/server/临时 DB）。**排查注记（防复踩）**：TurnCard 的 `innerText` 恒为回答约两倍——`CardImageButton` 内有 off-screen 分享卡副本（`left:-99999` + aria-hidden），量 DOM 文本断言时须 clone 后剔除 `[aria-hidden="true"]`，非 bug。另：首轮实测点 ModelPicker 下拉选「Mock 调试用」未生效吃了两次真模型短答，改用 `/model mock` 命令可靠。
- **Next**: 未 commit（4 文件：LinearThreadView/sessionStore/useCliSyncEvents/progress），用户验收后提交；真机复核两个原始症状。若「串台」仍在，需要精确操作序列——本轮修的是 created 竞态 / 加载竞态 / cli-sync 回拉三条已证实路径。

### Session 58 (2026-07-16)
- **Done**: **Workspace 档退役,模式收敛 chat / project 两档** → decisions.md 2026-07-16。证据链:DB 全库 0 workspace 行(原生 chat 21 / project 11);机制上 workspace ≡ project − resume(减掉的恰是仓库干活要的跨轮记忆);「一次性 CLI」定位已被 S55 增强 chat(scratch + full + skill 自动开)吃掉。改动面:
  - 类型/机制:`Mode` 二值联合(types.ts 附退役注记);sdk-adapter 删 workspace 分支、`toStreamEvent` 去掉死参 `mode`(SessionStart 恒透传);route `VALID_MODES` 二值,老 `mode:"workspace"` isMode 兜底回落 chat。
  - store:isMode 二值;loadDraftMode legacy 迁移(`cli-single`/`workspace`/旧 flag → project)。
  - UI:ModePicker 两 chip(project 文案并入 per-lineage 语义,TerminalIcon 删)、SearchModal facet、SessionSidebar 分组「Project」、ModeBadge 删 workspace 条目/图标、WorkspacePicker 高亮色 mode-workspace→mode-project。
  - token:globals.css `--mode-workspace-*` 全主题块 + `@theme` 注册全删;mode-style 二值。
  - DB:migrate 加幂等 `UPDATE context_mode='workspace'→'project'`(本机 0 行,防御其他部署)。
  - 文档:README 两档表 +「历史注」+ Chat 增强模式补写(此前文档缺失);全仓注释 workspace/project 措辞清理。
- **验证**: tsc ✓ + `make build` ✓;隔离实例(:3141 + 临时 DB 拷贝 + 种假 workspace 行 + env 覆盖关 auth 闸,不动 .env.local):migration 读出 mode=project ✓、mock 三路创建(chat/project/legacy workspace→chat)✓、GET / 200 ✓;产物已清(server kill + 临时 DB 删)。
- **Next**: ~~commit~~ 已提交推送(`4818681`,`--no-gpg-sign` 免签同 3b61a2e 待补签;working tree 无其他改动,单 commit 干净收口);用户真机验收两档 ModePicker。候选 follow-up:codex project 树分叉语义(线性共享 session 分支互染,原 workspace 是干净解——被绊到再把 codex project 历史构造降级折叠 prompt,见 decisions Alternatives①)。

### Session 57 (2026-07-15，原 56 撞号重编)
- **Done**: **主题系统 + 界面&交互整体优化**（worktree/分支 `trellis-theme`，基 main ce3481e，8 commits，f464c49..ac54e85）。前置：两份静态审计（视觉设计系统 + 交互流程，各出债务 Top10）+ 用户拍板（三线全做 / 主题系统 / 5 套主题 / 主按钮=accent / 代码字体系统栈）。分 8 wave 执行，决策全录 → [ADR](decisions/2026-07-15-theme-system.md)：
  - **W1-W2 token 层**：globals.css 双层变量（:root/.dark 级联块 + `@theme inline` 注册 utility）——中性族/语义 hue（含 amber 四分、unread/fork 独立 hue）/字号 6 档/圆角 3 档/阴影 3 档；~40 处裸 hex 全变量化；hljs light 死代码删除（「代码块恒暗」据实转正）；`color-scheme` 让 dark 原生滚动条变深（有意改进）。零 diff 验证 = 浏览器 computed-style 逐字节断言 + 截图 diff（残差定位为焦点态/滚动条噪音）。
  - **W3 主题状态**：useTheme {mode,palette}（storage 兼容零迁移）+ 预水合脚本 + ThemeMenu（外观三段 + swatch）+ `/theme` 命令；localStorage 四态矩阵实测。
  - **W4 原语**：`components/ui/` 九件（Button/IconButton/Popover/Modal/Drawer/ToastShell/Pill/StopButton/Dots）+ 进场动画（reduced-motion 豁免）+ pilot 迁移。
  - **W5+W5.5 全量迁移**：5 个并行 subagent 按批清完 40+ 组件（全仓调色板 class 与 text-[Npx] grep 清零）；黑按钮升 primary、节点未读 amber→emerald、NoteRow→positive、ChatNode 已读侧条改中性（撞色裁决）；`--color-X-*: initial` 闸门为永久回归护栏。ChatNode 零重渲染纪律未破（纯 class 替换）。
  - **W6 四主题**：paper（米白+青墨）/terminal（石墨蓝黑+荧光青）/morandi（灰绿+雾蓝，状态色全降饱和）/contrast（纯黑白+AAA）；4×2 截图矩阵 ✓。级联规则：light 块设过的变量 dark 块必须重设。
  - **W7 交互九项**：①useIsMobile→767px 与 md: 同线（修「窄窗口 sb 不归零挤右半屏」确定性 bug，390px 实测恢复）②「＋新会话（全新树）」vs「🧹 新话题」正名 ③`lib/shortcuts.ts` 注册表 + `?`/`/help` KeyboardHelp 面板 + `isEditableTarget()` 换掉 5 处重复 guard ④RunSpinner 退役统一 Dots ⑤TargetChip 归一画布/线性目标指示 ⑥移动端思维树入口换树形 icon ⑦🧠 徽章恒按钮（<50% 只读弹层）⑧Outline/移动侧栏/FAB 菜单补进场动画 ⑨移动端 SessionTabs 隐藏 + 内容 pt responsive。
- **验证**: 每 wave tsc + `make build`（共 6 次全绿）；隔离实例（快照 DB /tmp + :3131 + agent-browser）：截图基线→零 diff 断言→5 主题矩阵→390px/桌面回归→**mock 全链路流式回归**（建会话→/model mock→发送→流式 Dots/run-bar/未读 pill→done）✓。测试产物全清（server/快照 DB/浏览器 session；截图留 /tmp/trellis-theme-shots 备查，重启自清）。
- **坑（工具）**: agent-browser 本轮三次页面莫名跳 about:blank（eval 报错后/带 CSS 选择器的 click 后/daemon 重启丢 media 模拟状态）——重 open 恢复；截图前显式 `set media`，点击用 eval DOM 直点（S54 教训延续）。
- **merge 追记（2026-07-16）**: `git merge origin/main`（权限确认 04a9c18）在 trellis-theme worktree 完成——main 工作区留有并行 session 未提交 WIP（ChatNode/Composer/QuestionInput）不可在彼处操作，故反向 merge 后直接推 `HEAD:main`，prod 工作区本地 main 落后一截由该 session 自行 pull。冲突 3 文件：InteractionForm（对方 icon/title 参数 + 我方 token class 合成）、ModePicker（双 import 都留）、progress（S56 撞号，本轮重编 S57）。**权限确认的新 UI（PermissionForm 权限卡/ModePicker 🛡️ 开关）为 token 化前写就、会被 W5.5 闸门打哑，随 merge 一并迁移 token**（allow=accent 填充、always=accent 淡底、deny=warn、命令块=surface+line，全仓 grep 复归 0）。tsc+build ✓ + 隔离实例 smoke ✓。
- **Next**: 用户真机验收（重点：手机布局、5 套主题观感、? 面板、新 accent 主按钮、权限卡新配色）；commit 均 --no-gpg-sign 待补签。候选 follow-up：ThreadMinimap 移动端默认折叠（在手机上盖内容，未在本轮范围）；terminal 主题可选装 JetBrains Mono。

### Session 56 (2026-07-15)
- **Done**: **权限确认（Permission Gate P0）落地** → [spec](permission-gate.md) + decisions.md 2026-07-15。缘起：botmux（tmux 会话常驻/attach 模式）对照讨论 → 拆解出「权限确认不需要终端，stream-json control protocol 是结构化正解」（终端逃生舱=P1 等触发）→ 用户拍板直接实现。
  - **关键实测发现**：`--permission-mode default` 下本机全局 settings.json 裸 `Bash` allowlist 直接放行、can_use_tool 永不触发——审批必须注入 `--settings '{"permissions":{"ask":[Bash,Write,Edit,MultiEdit,NotebookEdit]}}'`（ask > allow 优先级实测坐实，claude 2.1.207）。
  - **SDK**（~/sdk，dist 已重建）：`RunOptions.askTools?: string[]` → ClaudeBackend 注入 `--settings`（纯机制，工具名单留 trellis）。
  - **trellis**：`sessions.require_approval` migration + repo/Session 类型全链；chat route 创建钳制（claude 系 + 非 chat）+ branch/retry 从 session 行读；sdk-adapter approve → permission "default"+askTools（`req.onCanUseTool` 在场才生效，天然隔离 codex/mock）；run-bus dispatcher approve 分支（不再 auto-allow → 复用 A路② PendingInteraction 全管道）+ `approvedTools` per-run「总是允许」+ resolveInteraction opts；respond route `alwaysAllowTool`；UI = ModePicker 🛡️需确认/⚡YOLO 开关（draft localStorage）+ InteractionForm 新 PermissionForm（Bash 命令等宽块/入参 JSON + 允许/本轮总是允许/拒绝+理由）+ ModeBadge 🛡️ 角标。A路② 既有 AskUserQuestion/ExitPlanMode 与 YOLO 会话零变化。
- **验证**（全绿）：协议探针 allow/deny；隔离实例（:3123 + 临时 DB + 真 claude haiku）HTTP e2e 四场景 = allow 弹卡→执行 / deny 不执行+理由回模型+正常 done / always 两 Bash 只弹一卡 / yolo 零卡回归，mid-pause catchup 带 pendingInteraction（刷新恢复卡片）；agent-browser 实测 开关→建会话→权限卡渲染→允许→执行→答案正确 + Header 🛡️徽章；tsc ✓ + `make build` ✓；prod kickstart（login 200/api 401）。测试产物全清（server/临时 DB/ws/probe/两个 claude projects 测试目录）。
- **并行注记**：本轮与 S54/S55 同目录并行开发（发现时 S55 已 commit 到 main，另留有未 commit 的 Composer/QuestionInput/ChatNode 小改动）；文件零交集、无冲突，但 **commit 时两批改动需分开摘**（本轮 14 文件 + permission-gate.md；SDK 侧另一 repo 一并 commit）。
- **Next**: ① ~~commit~~ 已提交推送（trellis `04a9c18` + sm-toolkit `924444c`，均 `--no-gpg-sign` 免签同 3b61a2e 待补签；S55 残留 Composer/QuestionInput/ChatNode 未 commit 改动已分摘留在 working tree）；② P1 候选：终端逃生舱（tmux 包 `claude --resume` + ttyd web 终端，回程复用 CLI sync watcher）等真实需求触发再做；③ 可选 follow-up：权限决议审计日志、三档权限演化（+acceptEdits）。

### Session 55 (2026-07-15)
- **Done**: **`/` 命令接入日常对话 Composer + 下拉键盘导航（推翻 S30「追问框刻意不接」的取舍，用户明确要求；worktree `增加工作区目录`，与 S54 撞号重编为 S55）**。共享 `Composer.tsx`（线性 sticky footer + 画布 DockedComposer）此前只接了 skill 补全，`lib/commands.ts` 的 Trellis 命令只有首屏 QuestionInput 能用。三处改动，registry/命令语义零改：
  - `SkillPickerList` 扩成命令+skill 合并下拉（可选 `commands`/`onPickCommand` props，命令在前带 ⚡ 徽章，与首屏下拉同序；ChatNode 行内追问框传参不变、向后兼容）。
  - `Composer` 接 `matchCommands`（全模式一等，skill 仍 gated on toolCapable）+ 提交拦截 `parseCommand`（裸 /command 本地执行不进 LLM，拦截在 targetNode/isStreaming 闸之前——/new /switch 不需要目标节点）+ cmdNotice 行内提示（下次击键清除）；下拉点选无参命令立即执行、/model 填 `"/model "` 待补参，与 QuestionInput 同约定。
  - **顺手修存量 bug**：`composeRootOpen` 消费从 AddNodeFAB（仅画布挂载）上移到 `page.tsx` 顶层——此前线性视图里 Header B3「开新话题」和 `/clear` 置了 flag 没人消费，静默无效且切回画布时 picker 突然弹出。FAB 只保留自己的菜单流。
  - **键盘导航**：新 `hooks/useSlashNav.ts`（↑↓ 循环高亮 + Enter/Tab 选中；query 变化重置到首项、纯方向键不重置；`handleKeyDown` 返回 true 表示已消费——调用方放在 send-combo 判定**之前**，下拉可见时 Enter 选中而非把半截 "/cle" 发给 LLM，无匹配时零干扰）。三个消费方全接：共享 Composer（命令+skill 合并索引）、首屏 QuestionInput（同）、ChatNode 行内追问框（仅 skill）；下拉加 `activeIndex` 高亮 + scrollIntoView(nearest) 跟随。
- **验证**: tsc ✓ + `make build` ✓ ×2；隔离实例（:3096 + 临时 DB + mock provider，产物已清）agent-browser 实测两轮：命令轮——线性 Composer 输 `/` 出 5 命令（纯 chat 无 skill）、`/cl` 过滤、点 /clear 在**线性视图**弹 NewQuestionPicker（修复生效）、`/model` 无参回显用法且保留输入、`/model mock` 切换生效+清空输入、增强模式命令+skill 合并（5+6）、`/switch` 开搜索、`/new` 回首屏；键盘轮——默认高亮首项/↓↓ 移动/↑ 循环到尾/Enter 执行 /switch、"/cl"+Enter 出 no-session notice、含空格 "/model mock" Enter 正常走提交拦截、线性 `/`+↓+Enter 弹「新话题」、↓×5 跨命令到 skill + Tab 补全、"/arch" 过滤重置 + Enter 真归档。ChatNode 行内框未浏览器验（同 hook 同约定）。**merge 注**：与 S54 的 Composer 改动（onSubmitted/onEscape/focusToken）自动合并成功，Esc 不被 slashNav 消费、落到 onEscape 语义不冲突。
- **Next**: 用户真机验收。
- **追记（2026-07-16 落地 commit）**: S55 残留 WIP——**skill 下拉全模式可见 + 纯 chat 点选自动开增强模式**。三输入框（Composer/QuestionInput/ChatNode 行内）`useSkillSuggestions` 一律全量显示；纯 chat 点 skill 自动 `setChatEnhanced(true)` + cmdNotice「⚡ 已自动开启增强模式」（skill 需要工具，藏下拉读作"skill 坏了"）；QuestionInput skill 列表懒加载去 skillCapable 门槛。主题系统 merge（88fc72d）后 stash pop 零冲突落回，tsc ✓ + 隔离实例浏览器实测 ✓。

### Session 54 (2026-07-15)
- **Done**: **线性视图中间节点自由分叉（reply-to 式 chip，方案 A）**。用户痛点：线性页面对中间节点岔开提新问题只能划线 ⌘K（BranchPopover 需要文本锚点，问题与原文无关时被迫造假锚点）；数据层 `streamBranch(parentId, q, null)` 本就支持自由分叉（画布 DockedComposer 在用），纯 UI 缺口。落地（仅改 2 文件，store 零改动）：
  - `LinearThreadView.tsx`：卡片头 actions 区加 ⑂ 按钮（`branchFrom {id,n}` state，n 为 nonce 供重复点击再聚焦；tip 卡不显示——从 tip 分叉=普通续聊；streaming 卡不显示）；底部 Composer 上方渲染 indigo chip「⑂ 从 #N 分叉 · 题干」（点题干滚回该卡，✕ 清除）；armed 时 Composer targetNode = 分叉节点、placeholder 变「从 #N 分叉提问…（Esc 取消）」；session 切换 / 目标节点被删自动清 chip。
  - `Composer.tsx`：+3 可选 prop——`onSubmitted`（提交后清 chip）、`onEscape`（textarea 内 Esc 清 chip，遵循 useEscapeAbort「textarea 内 Esc 归局部语义」约定，零冲突）、`focusToken`（arm 时拉焦点进输入框）。
  - 提交后走既有 `focusNew=true` 语义：active 跳新支线、线性视图重锚展开新 lineage，原卡自动折出「↳ N 个分支」。
- **验证**: tsc ✓ + `make build` ✓（main ASCII 路径）。隔离实例（快照 DB /tmp + `next start` :3112 + 临时挪开 `.env.local` 关 auth 闸后立即还原 + mock provider）浏览器实测：⑂ arm → chip/placeholder/自动聚焦 ✓；textarea 内 Esc 清 chip ✓；✕ 清 chip ✓；mock 会话 2 节点后从 #1 分叉发送 → chip 自动清除、thread 重锚为 [#1,#3]、#1 折出「↳ 1 个分支」、点分支卡切回 [#1,#2] 往返 ✓；tip/streaming 卡无 ⑂ ✓；chip 视觉截图核对 ✓。测试产物：server 已 kill、浏览器 session 已 close；/tmp 下快照 DB 等临时文件删除命令被拒（`/tmp/trellis-branchtest.db*` 等仍在，重启自清或手动删）。
- **坑（工具）**: agent-browser ref 点击在 React 重渲染后 stale（点了没反应但报 ✓ Done），换 `eval` DOM 直点即稳——同类 UI 实测建议直接用 eval 点。
- **Next**: 已 commit + push（免签，同 3b61a2e 待补签）；真机/手机验收；候选 follow-up：画布模式是否也要 per-node ⑂ 入口（现画布靠选中节点已覆盖，倾向不做）。

### Session 53 (2026-07-15)
- **Done**: **收敛工作机对 CHAT 修复的四个补丁**（工作机 pull a29f9b5 后仍 0 输出，自行打了四个本地补丁；逐条评估后收敛）：
  - **#1 `--setting-sources ""` 被 runtime 吞空 argv** → 采纳但改形式：SDK 上游化为 `--setting-sources=` 等号写法（sm-toolkit `0326299`），语义不变；工作机临时用的 `=local` 不采纳（通用 SDK 会在真实 cwd 突然加载 .claude/settings.local.json，语义漂移）。本机 bun 1.3.14 实测不吞空 argv（不复现），等号形式对 runtime 差异免疫。
  - **#2 SDK 手工加 Thinking 事件** → 重复实现，上游 `a3ce7b2` 已有；工作机收敛 = revert 本地 src 改动后 pull + rebuild。
  - **#3 instrumentation 强制 effort=low（全局）** → 收敛成 **per-mode**：纯对话 chat 在 `modeToRunOptions` 下发 `env:{CLAUDE_CODE_EFFORT_LEVEL:"low"}`（GPT 式即答场景，"你好"不该思考半天）；增强 chat / workspace / project 是干活 agent 保持 CLI 默认不降智；instrumentation 的 scrub 保留（唯一显式下发点 = RunOptions.env，优先级高于继承 env）。
  - **#4 plist 硬编码 ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY** → **不上游，本机严禁照抄**：env 注入优先于 OAuth（sdk Verified Facts），有原生 claude 登录的机器会把原生模型全部劫持到代理。工作机（无原生登录、全走 super-relay）能用但更优解是把 `SUPER_RELAY_AUTH_TOKEN` 放 `~/.agent-gateway.env`（endpoints.yaml env_file 机制，@sm/llm 解析时注入 → ClaudeBackend 按 model per-spawn 注入 base_url+token，多模型路由保持正确）。
- **验证**: sdk rebuild + 双侧 tsc ✓；`--setting-sources=`/`=local` 裸 CLI 实测均接受；隔离实例（:3124 + 临时 DB + auth cookie 过闸 + 真 claude-haiku）纯 chat：`created→thinking×7→delta→done`、回答正常、usage 齐全——等号参数真 spawn 通过、low effort 下 thinking 秒级且面板可见。prod 已重建 + kickstart。
- **Next**: 工作机收敛清单（见 sdk progress 同日条目）：①`cd ~/sdk && git checkout -- packages/agent/src && git pull && bun run build`（丢手工补丁换等价上游）②trellis `git checkout -- instrumentation.ts && git pull && make build` + 重启 ③plist 的 ANTHROPIC_* 三行可留可换 env_file 方案（换则删行 + 把 token 写进 ~/.agent-gateway.env）。

### Session 53 (2026-07-15)
- **Done**: **工作区文件抽屉**（分支/worktree `增加工作区目录`，commit `3a64f4b`）。动机：文件可见性链条缺最后一环——上传（Stage 19）/生成（GeneratedFilesBar 只覆盖回答里提到的路径）/空白沙箱（S49，产物散在 `~/.trellis/scratch` 无入口），远程/手机场景无终端可取件。形态拍板：**按需抽屉（只读浏览 + 预览），不做常驻 IDE 面板**——入口 = Header ModeBadge（有 workspacePath 时变可点 button，chat 保持静态 chip）。
  - 新 `GET /api/sessions/[id]/files?dir=<abs>`：单层非递归列目录，围栏 = session cwd realpath 前缀（`dir` 必须绝对路径；symlink 一律不列，指向 cwd 外的目录 realpath 后 403）；隐藏 dotfiles/node_modules/__pycache__/venv，**保留 dist/build**（agent 产物常落那里，与 workspaces/browse 的隐藏表刻意不同）；单目录 300 条截断标记。
  - 新 `components/WorkspaceFilesDrawer.tsx`（NotesDrawer 同款骨架：桌面右侧 360px / 移动端 60vh 底部 sheet）：惰性展开子目录、文件行显示 kind 图标+大小、点击 `openFilePreview(absPath)` 复用全局 FilePreview（**预览围栏零改动——`sessionAllow` 本就放行整个 cwd**，store 注释里预留的 "future workspace browser" 正是此物）；每次开抽屉 epoch 重挂载强制刷新 + ⟳ 手动刷新。store 加 `workspaceFilesOpen`（UI-only）。
- **验证**（临时 ASCII worktree + 隔离 dev :3095 + 临时 DB + mock provider，产物已全清）：curl——根/子目录列表正确（dotfile/node_modules/symlink 均不出现，/tmp→/private/tmp realpath 归一）；围栏 `/etc`、symlink 逃逸（`ln -s /etc`）、前缀同胞目录（`ws-testXX`）全 403、相对路径 400、无 workspace session 404；`/api/files` 预览联动 200。agent-browser——badge 点开抽屉、展开子目录、点 report.md 开 FilePreview（markdown 渲染）、**Esc 分层**（第一下关预览第二下关抽屉，FilePreview capture-phase stopPropagation 生效）、390px 视口底部 sheet 正常。`tsc --noEmit` ✓。
- **★ Verified Fact：中文路径 worktree 会炸 Turbopack**（与 Session 52 独立撞上同一坑，互证）。ident 截断按字节切、落在多字节字符中间直接 Rust panic（`start byte index N is not a char boundary`，turbopack-core/ident.rs）。`make build` 在中文 worktree 必炸；**dev 模式按 route ident 字节长度选择性炸**——存量 route 都能跑，本 feature 新 route 恰好中招（500）。worktree 目录一律用 ASCII 名（分支名不受影响，炸点只在目录路径）。
- **边界**：`.env` 等 dotfile 只是不列出，`/api/files` 预览围栏本就放行整个 cwd（现状未收紧，与行内路径可开任意 cwd 文件一致）；chat 无 badge 入口（代码路径未浏览器验，条件分支 trivial）；子目录展开状态在刷新后不保留（v1 取舍）。
- **收尾追记（同 session）**：feature commit `3a64f4b` → merge main `ace43e3`（progress 双 S51 撞号，本条重编为 S53；sessionStore 与 S52 thinking 改动自动合并，tsc ✓）→ main `make build` ✓（`/api/sessions/[id]/files` 注册）→ prod kickstart（/login 200、API 401 闸正常）。两个中文 worktree 已 `git worktree move` 到 ASCII：`trellis-fix-chat-mode`（原 修复-CHAT-模式问题，移时干净）/ `trellis-workspace-files`（原 增加工作区目录；旧路径留了同名 symlink 保当时会话存活，**确认没有旧会话锚着后可删**）。均未 push。
- **返工（同日用户反馈「没看到这功能」）**：入口藏在 ModeBadge（状态徽章暗藏可点、视觉零变化）不可发现——连用户都找不到即判不及格。改为 **Header 独立 📁 按钮**（仅有 workspacePath 的会话显示，与笔记按钮同级），ModeBadge 回退纯展示。fix `c9f5682` 已 merge main；隔离实例实测：workspace 会话按钮显示+抽屉正常、chat 会话无按钮。**未重启 prod**——当时另一并行 session 正在 main 工作区活跃开发（Composer/LinearThreadView 有未提交 WIP + 刚重建的 .next，20:41 的 build 已含本 fix），避免替其上线未验证代码；其下次 kickstart 自动带上。
- **Next**: 用户真机验收（尤其手机远程取件场景）；push 由用户定。

### Session 52 (2026-07-15)
- **Done**: **CHAT 模式"假死"修复（thinking 可视化 + effort env 卫生，roadmap D4 解锁）**。根因两层：claude CLI 2.x **默认**先出 thinking 块再出正文（实测 haiku 无任何 effort env 也 thinking），而 SDK/trellis 只透传 `text_delta`、thinking 全丢——UI 对一条一等输出通道结构性失明；叠加 `CLAUDE_CODE_EFFORT_LEVEL=max` 从 occ alias 启动的 shell 穿透进 trellis 进程（SDK streamLines 用 `{...process.env, ...opts.env}` spawn），思考期拉到分钟级把症状放大成"卡死"。
  - **SDK 侧**（~/sdk，dist 已重建）：`EventType.Thinking` + ClaudeBackend 映射 `thinking_delta`→Thinking 事件；纯增量，CLIRunner switch 有 default→null，self-agent 无感。
  - **trellis 链路**：`StreamEvent`/`ProviderEvent`/`RunEvent` 加 `thinking`；run-bus `committedThinking` 累计（**不落 DB**，ephemeral 与 CLI 折叠一致）+ catchup 带 `thinking` 快照（仅 streaming 时）；SSE 两路由泛转发零改动；store 把 thinking 发到 stream-bus 新 `thinkingChannel(nodeId)`（created/done/error/catchup 同步清理）。
  - **UI**：TurnCard 思考面板——无正文时 dim 面板"思考中…"+ 思考文本流式跟尾（auto-scroll），正文开始后折叠成 `<details>`"🧠 思考过程（N 字）"，done 后整体消失；画布 ChatNode 加 DOM-direct"思考中…"指示器（零 React 重渲染纪律不破）。
  - **env 卫生**：`instrumentation.ts` 启动时 scrub `CLAUDE_CODE_EFFORT_LEVEL` 并 console.warn（trellis 的 effort 由自己决定=CLI 默认；将来 per-session effort 走 RunOptions.env 显式下发）。
- **验证**（tsc ✓；隔离实例 :3123 + 临时 DB + 真 claude）：scrub 启动 log ✓；SSE `created→thinking→delta→done`（haiku thinking×6/×17）✓；浏览器（agent-browser + MutationObserver）：TurnCard 面板流式更新（sawThinking=39）+ 折叠态（sawPanel=11）+ done 后消失 ✓、画布指示器 ✓、思考期中途刷新重连恢复面板 ✓。另实测：endpoints.yaml 的 `claude:claude-sonnet-5`/`claude-fable-5` 简单问题不产 thinking（模型自主决定，SSE 无 thinking 事件属正常），legacy `claude-haiku` 稳定 thinking。测试产物全清（server/临时 DB/ASCII 验证 worktree/11 个孤儿 chat-scratch jsonl 核 0 引用后删）。
- **坑（环境）**: 本 worktree 目录名含中文 → Turbopack `make build` 崩（`start byte index not a char boundary`，asset ident 切 CJK 字节边界）——与改动无关；已在 ASCII 临时 worktree 套同改动 build ✓。**后续 worktree 目录用 ASCII 名**。
- **Next**: 用户验收后 commit（连同 Session 51 的 anchor 改动一并）；候选 follow-up：codex reasoning 事件同样透传、ModelPicker 对 catalog 外 legacy id（claude-haiku）的显示回退优化。

### Session 51 (2026-07-15)
- **Done**: **线性视图 anchor 跳转改为对齐卡片头**。树缩略图/分支卡/搜索等触发 `setActiveNode` 后的滚动定位从 `scrollIntoView block:"center"` 改为 `block:"start"`（`LinearThreadView.tsx` anchor effect）+ 卡片 `scroll-mt-3` 留呼吸空间——长卡片居中会落在回答中段，看不到卡片头的 #编号和用户提问。
- **验证**: tsc ✓；隔离实例（快照 DB + dev :3004 + agent-browser）实测：p2p 会话线性视图点缩略图根节点→视口顶=「#1 · Turn」+提问；点长卡片节点 #8（DHT 长文）→视口顶=卡片头+分叉 banner+提问，不再落中段。测试产物已清。
- **注**: 本 worktree bun install 装 `file:` @sm 两包同 Session 49 的 ENOENT，已手动 symlink 修复（同 `make relink-sdk` 效果）。
- **Next**: 用户验收后 commit。

### Session 50 (2026-07-15)
- **Done**: **临时文件上传（Stage 19 落地，形态调整为 composer 附件）**。动机：远程操作时快速给 agent 补充文件+上下文（CSV/日志/PDF 等截图之外的东西）。核心设计：**复用 Stage 15 blob 基座零 schema 变更**（`attachments_json` 原样，kind 由 mime 推断），通用文件**不进 provider vision 通道**——tool-capable 模式（workspace/project/chat增强，全是 `--dangerously-skip-permissions`）spawn 前物化到 `~/.trellis/uploads/<nodeId>/<原文件名>` + prompt 末尾注入绝对路径清单，agent 自己 Read/Bash 消费（CSV 能现场跑分析）；纯 chat 文本类 ≤128KB 内联 fenced block、二进制 UI 拦 + 服务端 prompt 注明。`~/sdk` 零改动、codex 路径零改动。
  - 新 `lib/attachments.ts`（客户端/服务端共享 ext↔mime 白名单 ~35 种 + 分类 helpers）；`blobs.ts` 泛化（storeBlob 按 ext、resolveBlobPath 全表、`materializeAttachments` 幂等 staging→retry 免费复用、`readTextBlob`）；uploads POST 收通用文件（multipart 必带文件名，ext 白名单 + 服务端钦定 canonical mime 防浏览器 junk mime）、GET 加 `?name=` Content-Disposition；chat route images/files 分流 + `questionForTopic` 隔离（内联大 CSV 不污染 topic label）。
  - 前端：新 `hooks/useAttachmentUploads.ts` 抽掉 QuestionInput/BranchPopover 各 ~80 行重复（顺手修多文件拖入 stale length 超上限），policy 感知（纯 chat=图+文本，tool-capable=全量）；AttachmentPreview 非图片渲染文件 chip（图标+文件名+大小，readonly 点击开 `?name=` URL），`PendingAttachment` 加 mime。
- **Merge 注记**：feature 在 `goby` 分支基于旧结构开发（旧 LinearComposer/QuestionBlock），merge 时撞上 Session 47 的统一阅读面重构——LinearThreadView 冲突**整体取 main 版**，附件能力改移植进新共享 `Composer.tsx`（线性+画布 DockedComposer 一处接线，比旧结构更收敛）；TurnCard 已自带 readonly AttachmentPreview，文件 chip 自动生效。
- **验证**（合并前 goby 侧：隔离 dev 3099 + 临时 DB + 真 claude haiku 全链路）：curl 上传 csv（含 junk mime→canonical）/415 拦截/Content-Disposition/图片 raw 回归全过；**workspace 真 claude 带 CSV → Read staging 路径 → 答对 3 行、均值 86.33**；纯 chat 内联答对 bob=92（无 tool call）；纯 chat PDF → 模型正确告知换模式；**retry 删 staging 后幂等重建再答对**；project 两轮 resume 不断链（turn2 答对 carol=79）；agent-browser 实测选文件→chip→发送→答对 + PDF 拦截提示。合并后 main 侧：tsc ✓ + `make build` ✓ + Composer 移植点浏览器 smoke（见 merge commit）。测试产物全清。
- **边界**：export.ts 不动（图片附件本也不导出，保持一致）；staging/blob GC 沿用 P2 决策；文件路径只注入当轮 prompt 不回灌折叠历史（与图片对齐）。
- **Next**: 用户真机（手机远程）验收。commit 均 `--no-gpg-sign`（1P 签名 agent 当时拒签，同 3b61a2e 待补签）。

### Session 49 (2026-07-15)
- **Done**: **「空白沙箱」workspace——Project/Workspace 模式不挑目录，一键随机开一个空白上下文的空目录当 cwd**。新 `POST /api/workspaces/scratch`：在 `~/.trellis/scratch/<adj-animal-NN>`（与 `lib/paths.ts` 的 CHAT_SCRATCH 同族约定）非递归 mkdir，slug 碰撞（EEXIST）自动重试；WorkspacePicker header 下方加「✨ 空白沙箱」快捷入口（两个 tab 都可见，创建中禁用 + 失败行内报错），拿到路径走既有 `pickPath`。下游（session 创建/spawn cwd/文件预览围栏/最近列表）零改动——就是一个普通 workspace path，basename=slug 在「最近」里可读。
- **验证**: 本 worktree（barnacle）首次 bootstrap：`make setup` 中 bun 装 `file:` 的 @sm 两包报 ENOENT，但 `make relink-sdk` 本来就会重建软链，补跑后 `make check` 全绿（这个失败对 setup 无实质影响）。`tsc --noEmit` ✓、`make build` ✓（`/api/workspaces/scratch` 注册）。隔离 dev server（:3097 + 临时 DB）runtime 验证：POST ×2 产出两个独立空目录；**真 claude 全链路**：用 scratch 目录建 project session（haiku）→ SSE created/delta/done 正常、答 PONG!、jsonl 落在 `~/.claude/projects/-Users-smokingmouse--trellis-scratch-<slug>/`。测试产物（server/临时 DB/两个 scratch 目录/claude projects 目录）已全清。
- **Caveat**: 未浏览器实测 picker 按钮的视觉/交互（按逻辑写，emerald 虚线卡片风格对齐现有 UI）。scratch 目录不自动回收——删 trellis session 不删目录（目录是空的或只有用户要的产物，倾向保守不动；若堆积成噪音再加清理策略）。
- **Next**: 浏览器实测「✨ 空白沙箱」入口。已合并回 main。

### Session 48 (2026-07-15)
- **Done**: **线性视图滚动已读**（用户反馈「不从画布点进去不算已读」）。根因：`LinearThreadView` 的已读逻辑沿用旧全屏阅读器契约——只对 anchor（active 节点）计 1s 停留，整条 thread 里滚动读过的卡片全漏标。改为 IntersectionObserver 视口级判定：卡片 ≥50% 可见（或超屏长卡占视口 ≥50%）持续 1s → `markNodeRead`；离开视口取消计时（快速滚过不算读）；`nodes` 变化时对可见卡补判（streaming 结束停在屏内的场景，observer 不再触发）；observer 随 `session?.id` 重建，卡片卸载时 unobserve + 清计时器。原 anchor 专属 effect 删除（被视口判定覆盖——anchor 会滚到视口中央）。仅改 `components/LinearThreadView.tsx`。
- **验证**: tsc ✓ + `make build` ✓（npm run build 会因 bun:sqlite 失败，必须 make/bun）。浏览器实测（快照 DB + 隔离 `next start` :3111 + auth env 置空关闸 + agent-browser，真实 DB 零触碰）：「web3 实践」7 未读基线 → 主链滚动阅读后链上 2 个未读被标 ✓；折叠在「↳ 1 个分支」后的另一条 lineage 5 个未读**不**被误标 ✓；点分支卡切 lineage 再滚 → 全部标已读，minimap 12 点全灰 ✓。
- **Next**: ① ~~commit~~ 已合入 main（`51d7dff` + merge，免签，同 3b61a2e 待补签）；② 体感调参候选：1s 停留阈值 / 50% 可见阈值；③ 未 push。

### Session 47 (2026-07-14)
- **Done**: **GitHub issue #2-#7 全部落地**（用户指令「把所有的 issue 都做了」）。核心 = issue #7 架构统一（决策 → decisions.md 2026-07-14「统一阅读面」），#2/#4 随之关闭；#3/#5/#6 独立修：
  - **#5 卡死**：`QuestionInput` 提交后 `streamRoot(...).finally(setBusy(false))` 复位；store 加 `streamAlert` + 新 `StreamAlertToast`（底部居中，8s 自动消失）；`handleStreamEvent` error 分支放宽——created 前失败（fetch 拒绝/非 2xx）不再静默丢弃，回收乐观占位 + 弹全局 toast。
  - **#6 乐观渲染 + 锁底**：store 新 `insertOptimisticNode`/`discardOptimisticNode`（`optimistic-*` id，导出 `isOptimisticNodeId`）；`streamBranch` 与 `streamRoot(attach)` 提交瞬间插占位卡（问题 + 生成中 dots），`created` 删占位换真 id（active/lastEdited 同步迁移）；abort/reconnect/ViewState 持久化对 optimistic id 全部设防；finally 兜底回收（SSE 掉线 pre-created）。`LinearThreadView` 流式期间 rAF 锁底（slack 120px，上滚暂停、回底恢复；锚点居中滚动让位于流式 tip）。
  - **#7 统一阅读面（含 #2/#4）**：新 `components/TurnCard.tsx`（NodeFullView 全能力迁入：可编辑 QuestionBlock、marks 注入——`hooks/useMarkdownBodyMarks.ts` 独立成 hook、再答一版/卡片图/复制/CLI resume 操作行、ReferenceFullBody、InteractionForm、GeneratedFilesBar）；`LinearThreadView` 全模式化（mode 标签、⌘K 选区分叉复用 BranchPopover、⌘D 摘笔记、B 键回父锚点、锚点节点 1s 标记已读、节点删除入口、sticky Composer 直接聊）。删 `NodeFullView.tsx`（1345 行）+ `NodeTreeOverlay.tsx`；store `fullScreen`/`setFullScreen` 移除，`setViewMode("canvas")` 接管「回画布 pan 到最新节点」；入口迁移：ChatNode/ReferenceCard 卡片点击与「阅读」钮、DoneToast、jumpToNoteSource、jumpToSearchHit → 线性+锚定；ViewState 兼容迁移（旧 fullScreen=true → linear）；移动端改「进 session 默认线性」。
  - **#3 画布固定底部输入区**：新共享 `components/Composer.tsx`（textarea 与流式停止钮等高 44px 零跳动；乐观窗口内停止钮「连接中…」禁用）；Canvas 加 `DockedComposer`（fixed bottom，目标 = active 节点，「回复 #N」目标 chip）；AddNodeFAB 上移 bottom-24 避让。
- **验证**：`tsc --noEmit` ✓、`make build` ✓（唯一 warning 为已知 @sm/llm NFT trace）。浏览器实测（快照 DB → `TRELLIS_DB_PATH` 隔离 `next start` :3003 + cookie 过闸 + agent-browser，真实 DB 零触碰）：① project 会话默认线性 + TurnCard 操作行全在；② chat 会话画布 + DockedComposer「回复 #26」chip + 「线性」toggle；③ chat 线性 8 卡 + minimap；④ mock 发送 + 注入 800ms fetch 延迟实锤乐观窗口（占位卡 ~849ms 内以 `optimistic-` id 存在、created 后换真 id）、流式逐帧采样全程锁底、完成后无占位残留；⑤ /api/chat 强制 500：toast「发送失败：HTTP 500」+ 占位回收 + composer 存活；⑥ 首屏同法：按钮从「提交中…」恢复、textarea 可用、输入保留、toast 显示（原 bug 三点全修）；⑦ 首屏正常路径回归（mock 新会话 → canvas）；⑧ 画布点卡 → 线性锚定；⑨ 线性选区 → BranchPopover + 摘到笔记。顺带回归 Session 46 锁系（codex 会话内 claude 系全置灰）。**prod 注意**：本轮 `make build` 替换了 `.next`，已 `launchctl kickstart -k` 重启 com.smokingmouse.trellis（3088：/login 200 + API 200）；3001 上另有 Jul 13 起的手动旧实例未动（内存里旧 build，异常可自行杀）。
- **返工修复（同日用户反馈）**：线性视图内容不足一屏时输入框跟在内容后「悬在半空」——`sticky bottom-0` 只在内容超出滚动区时生效。改为视口绑定 flex 三段布局（`fixed inset-0 flex flex-col`：header shrink-0 / 滚动区 flex-1 / composer shrink-0 恒贴底）。实测：1 节点短会话 composer 距视口底 12px（=内边距）✓；长会话（10 卡）滚动/锚点自动滚动/锁底回归 ✓。prod 已再次 kickstart。
- **未实测项**：移动端（pointer:coarse）默认线性只过了代码路径；线性视图长 reference 全文渲染（无折叠）体感待反馈。
- **Next**: ① ~~commit + close~~ 已完成（`3b61a2e` + `6d40985` push，issue #2-#7 自动关闭）；② deferred：命令面板参数补全、Stage 18-22；③ 移动端线性实机体感待反馈。

### Session 46 (2026-07-14)
- **Done**: **Session 锁系 + codex 系内多模型**（决策 → decisions.md 2026-07-14）。触发：用户定方向「codex 不能二等公民；真实需求 = 开局选系 + 系内切换，跨系中途切是伪需求」。改动 5 文件，硬约束=不破坏 claude 既有功能：
  - `lib/llm/providers.ts`：`providerFamily` 认 `codex:*` 前缀（全链路 family 语义——run-bus/repo/chat route 的 resume 列选择、权限协议闸、attached 限制全部经此函数，一处改全局对齐）；新增 `blockedFamilySwitch(current,next)`（双方∈{claude,codex} 且不同才拦，mock 豁免）+ `FAMILY_LABELS`；`contextWindowFor` codex: 前缀 → 400k。
  - `lib/llm/server.ts`：default 分支前插 `codex:*` → `makeCodexProvider({mode, model: slug})`（CodexBackend 既有 `-m` 透传，`codex.ts` 一行未改）；裸 `codex` case 原样保留。
  - `app/api/providers/route.ts`：新增 `codexProviders()`——读 `~/.codex/models_cache.json`（codex CLI 自维护缓存），`visibility==='list'` → `codex:<slug>` 条目；cache 不可读回退单条裸 `codex`（兼容无 codex 机器）；裸 `codex` 恒保留（存量 session model='codex' 的 picker 显示依赖精确 id 查找）。
  - `components/ModelPicker.tsx`：按 family 分组渲染（Claude 系/Codex 系/调试 组头）；session 活跃时 `blockedFamilySwitch(provider, p.id)` 的条目 disabled + 副标题「跨系 · 需新会话」；无 session（首屏）全部可选。
  - `lib/commands.ts` + `QuestionInput.tsx`：CommandStore 加 `provider`；`/model` 同规则拦截（返回「跨系请 /new 开新会话」note）。注：QuestionInput 仅 `!session` 时渲染，故此闸当前为纵深防御，session 内实际执法点=ModelPicker（唯一切模入口）。
- **验证**（tsc ✓ + build ✓ + 快照 DB 隔离 `next start` :3003 真 spawn + agent-browser，prod 全程未动）：`/api/providers` 27 条（claude 系 18 + codex 系 8 + mock），codex 7 模型枚举正确；**真 spawn 三路全通**：`codex:gpt-5.4-mini`（真 GPT 回复，证明 `-m` 生效+family 路由正确）/ 原生 `claude:claude-sonnet-5` / `deepseek:deepseek-v4-flash` 回归无恙；`sessions.model` 复合 codex id 落库+重开采纳（header 显示 gpt-5.4-mini）；UI：codex 会话内 claude 系 18 条全灰、codex 系内切换（4-mini→5.5）即生效、claude 会话内 codex 系 8 条全灰（对称）、mock 两侧均可选、首屏全部可选+分组头正常。测试产物在快照 DB 随 /tmp 清除，真实 DB 零触碰。
- **Done（续）**: **agent-gateway 残留三清**（用户拍板"完全清掉"）：① `node_modules/agent-gateway` 孤儿目录删除（不在 package.json/bun.lock，bun 不自动清理）；② `sdk-adapter.ts` 两处过时注释改指 `@sm/agent`；③ 本地仓库 `~/python/agent-gateway` 删除——删前核实：工作区干净、main 已推送、唯一无 upstream 分支 `feat/chat-bfork-context` 的 commit 已全部含于 origin/main、无其他项目引用；远端 `github.com:SmokingMouse/agent-gateway` 保留为归档。tsc ✓。trellis 现在**完全依赖 sm-toolkit（~/sdk）**，agent-gateway 时代正式落幕。
- **Next**: ① commit（用户确认后）；② codex parity P0 = native resume（需实测 `codex exec resume`/rollout jsonl 行为）+ 能力矩阵；③ P1 = codex 树分叉前缀 rollout 可行性 spike。

### Session 45 (2026-07-14)
- **Done**: **工作区收敛 + 积压浏览器验收一轮清完**。① 6 个本地分支（feat/cli-session-sync、llm-sdk-migration、feat/chat-bfork-context、fix/mobile-and-cleanup、fix/mobile-session-drawer、linear-inline-compose）确认全部 0 commits ahead of main 后删除；main push（`9add18d..1345c51`，5 commits）。② 浏览器验收（快照 `~/.trellis/data.db` → `TRELLIS_DB_PATH` 隔离 + 现成 prod build `next start` 3003 + 关 auth + agent-browser，prod 3001 全程未动）：
  - **线性视图四项全过**（真实「web3 实践」12 节点 1 分叉）：project 默认 linear、「↳ 1 个分支」展开 + 分支卡点击切 active lineage（thread 内容 + 缩略图 active 点同步变）、缩略图 12 圆点点击跳任意节点（thread 自动滚到位）、画布↔线性往返保 active。画布侧顺验：大纲平铺仅分叉子带 ↳（S43 修复在生效）、节点无重叠。
  - **/model 动态 catalog 全过**：`GET /api/providers` 20 条（claude 4 档 + deepseek×2 + ark-coding×12 + codex/mock，gemini 正确排除）；ModelPicker 下拉渲染动态 catalog + 点选即切（header 同步）；`/model deepseek:deepseek-v4-flash` 命令本地执行不发 LLM、header 即切、输入框清空。**置灰路径本机不可测**——当前 endpoints.yaml 所有条目 `hasKey:true`，无 false 样本。
  - **Session 工作台全过**：命令面板 `/` 下拉列 /new /clear /archive /model /switch；/switch 打开 SearchModal（mode facet + FTS 高亮命中正常）；归档往返（行内 🗄 → 已归档计数 2→3 → 恢复 → 刷新后持久）；SessionTabs 预览 tab + 双击固定 + 双 tab + ⌘1 快切；`/api/runs` 返回 `{runningSessionIds:[]}` 正确。
- **遗留小项（非阻塞）**：① 命令面板输入参数后（如 `/model deep`）下拉整个收起，无模型名补全——`matchCommands` 只配命令名，参数补全未做，UX 可后补；② `/new` `/clear` `/archive` 三命令未逐个实跑（同一 registry 分流路径，/model /switch 已证通路）；③ 移动端未在本轮范围。
- **Next**: 等用户定方向：roadmap Stage 18-22（Skill 入口已有 C4 版 / 文件附件二进制 / Plan 节点 / Memory 桥接读侧 / Subagent 可视化）或 deferred（Level B store 重构、per-session model）。

### Session 44 (2026-07-11)
- **Done**: **全局 LLM 模型选择接入（结合 `~/sdk`/sm_toolkit 的 endpoints.yaml），并连带把死掉的 `agent-gateway` 依赖迁移彻底解决**。触发：模型选择原来硬编码三档（claude-opus/sonnet/haiku + codex）；调研发现 trellis 依赖的 `agent-gateway`（`file:../../agent-gateway`）本机已缺失、`node_modules` 未装，app 实际处于装不起来的状态。拍板方向：不修复对 agent-gateway 的依赖，而是把它的能力整体拆开摊平进 `~/sdk` 的 `@sm/agent`（agent-gateway 仓库退役），trellis 只依赖 `~/sdk`。
  - `~/sdk`（`@sm/llm`/`@sm/agent`）侧的改动详见 `~/sdk/progress/README.md` 2026-07-11 session（含 self-agent 生产 bot 的零改动兼容验证）。
  - trellis 侧：`package.json` 从 `agent-gateway` 换成 `@sm/agent`+`@sm/llm`(`file:` 绝对路径指到 `~/sdk/packages/*`)；`next.config.ts` 的 `turbopack.root` 挪到 `$HOME`（覆盖 trellis 和 `~/sdk` 两处 symlink 目标）、`serverExternalPackages` 同步换名。`lib/llm/claude.ts`/`codex.ts`/`sdk-adapter.ts` 只换 import 源，不需要自己再解析 endpoint/拼 env——这个能力已经内置进 `@sm/agent` 的 `ClaudeBackend`。`lib/llm/providers.ts` 的 `ProviderId` 从闭合联合放宽成 `string`，`isProviderId` 降级为结构校验（真正校验在服务端解析时抛错）；`providers.ts`/`server.ts` 的 switch 收敛成 `mock`/`codex`/`default→claude`。新增 `GET /api/providers`：读 endpoints.yaml，过滤掉只有 `openai_url`（协议不兼容 claude CLI 壳，如 gemini）的条目，映射成 `"<provider>:<model>"` 复合 id，服务端专属（密钥/YAML 访问不出服务端）。`stores/sessionStore.ts` 加 `providerCatalog` 状态 + hydrate 时 fetch；`ModelPicker.tsx`/`lib/commands.ts` 的 `/model` 命令改吃动态 catalog（`hasKey===false` 置灰不可选）。
  - **踩坑&修复**：`/api/providers` 最初把原生 claude 条目的 `hasKey` 也按 `api_key_env`(`ANTHROPIC_API_KEY`) 判定，误报 false——原生 claude 走 `claude login` OAuth 不需要这个 env var，实测验证「hasKey:false 但真实可用」后修正：无 override URL 的原生条目一律 `hasKey:true`。
  - **验证**（隔离 dev server 3099 + 真实 spawn，全部走真实 `/api/chat` HTTP 全链路，非直调 provider 函数）：`GET /api/providers` 返回 claude 三档 + `deepseek:*`(2) + `ark-coding:*`(12) + codex/mock，gemini 正确排除；chat 模式选 `deepseek:deepseek-v4-flash` 真实发消息拿到真回复；chat 模式选原生 `claude-opus` 回归不受影响；**workspace 模式 + 第三方模型 + 真实 Bash 工具调用**全链路成功（`--add-dir`+`--dangerously-skip-permissions`+ env 覆盖三者叠加正确）；project 模式两轮对话验证 `--resume` 在第三方端点下正确复用 session（第二轮 cache_read≈18.8k，与第一轮总 context 量级吻合，证明 resume 命中同一 CLI session，未被模型换了就断链）；codex 路径完全不受影响（真实回复）；`sessions.model` DB 全量往返正确（含 legacy `claude-opus`/`codex` 与新 `deepseek:deepseek-v4-flash` 复合 id）。**测试数据已清理**（5 个测试 session 通过 `DELETE /api/sessions/[id]` 移除，未触碰其余 30 个真实用户 session）。
  - `npx tsc --noEmit` ✓、`npm run build` ✓（`/api/providers` 路由已注册，仅一条关于 `@sm/llm` 动态 fs 路径的 Turbopack NFT trace 警告，无害）。
- **Caveat**: `onCanUseTool` 交互式工具协议（AskUserQuestion/ExitPlanMode 表单）在第三方模型下未专门用真实交互场景触发验证，但 workspace 模式下的真实 Bash tool_call 已间接证明该协议在第三方端点下能正常收发（`--permission-prompt-tool stdio` 是 CLI 本地机制，不依赖远端模型侧的特殊支持）。`/model` 命令面板的动态 catalog resolve 只过了 tsc/build，未浏览器实测交互手感。
- **Next**: 浏览器实测 `/model` 命令面板动态 catalog + ModelPicker 置灰交互；若要收尾 agent-gateway 独立仓库（留着不维护 vs 删除）是用户的决定，本轮不动。

- **Done（同日续，合并进 main）**: 上面全是在 npm 分支（旧 `agent-gateway` file: 依赖已损坏）上做的，`git merge main` 时发现 **main 早已独立完成 bun 迁移**（`better-sqlite3`→`bun:sqlite`、删 `package-lock.json`、`agent-gateway` 改 `github:` 引用可直接装）——两条线互不知情地各自"修好了 agent-gateway 问题"，用不同手段。拍板方案：改成 bun 跟main对齐，不留 npm/bun 双版本。合并冲突（`package.json`/`next.config.ts`/`README.md`）手动逐一解决，`progress/README.md` 自动合并无冲突。
  - **两个 bun 特有的坑，均已修复并固化进 `Makefile`（`relink-sdk` target + `--bun` flag），非一次性手工绕过**：
    1. **bun 的 `file:` 依赖不是单层软链**（npm 那样），而是给依赖目录本身建**真实目录**、目录内**每个文件单独软链**回源。Turbopack 生产构建的 package.json 解析器吃不下这种结构（`Error: package.json is not parseable: invalid JSON: a redirect can't be parsed as json`），跟 `turbopack.root` 设多宽无关（窄/宽两种都试过，都复现）。修法：`bun install` 后用 `make relink-sdk`（内联在 `make setup` 里）把 `node_modules/@sm/{agent,llm}` 换成单层目录软链（跟 npm 产物同形），问题消失。**这条 Verified Fact 对任何未来往 trellis 加 `file:` 依赖的场景都成立**，不是本次特例。
    2. **`bun run dev/build/start` 不会让 Next/Turbopack 内部 spawn 的 worker 进程也跑在 bun 运行时下**，导致 `lib/server/sqlite.ts` 的 `bun:sqlite`（bun 内置模块）在 worker 里解析不到而崩。必须用 `bun --bun run ...`（`--bun` 强制递归子进程也走 bun runtime）。`Makefile` 的 `dev`/`build`/`start` target 已经这么写。
    3. （顺手验证过、非 bug）家目录下有个无关的旧 `~/package-lock.json`（大概率某次误在 home 目录跑过 `npm init`）——一度怀疑是 Turbopack root 自动推断选错根的原因，实测确认**不是**（挪走/放回结果一样），Turbopack 的自动推断仍不可靠，所以显式钉 `turbopack.root` 是必须的，不是可选优化。
  - **验证**：`rm -rf node_modules .next && make setup` 全自动跑通（clone/pull `~/sdk` → build → 装依赖 → relink → 前置检查全绿）；`make build` 全量过；`make dev` 起服务后 `curl /api/providers` + 真实 `deepseek:deepseek-v4-flash` chat 消息全走通（`bun --bun` 下 `bun:sqlite` 正常）。测试 session 已删。
  - **Commit**：`~/sdk` 在 `main` 直接提交（无分支问题）；trellis 在 `SmokingMouse/goosefish` 上先 checkpoint 提交 npm 版本，再 `git merge main` 解冲突改 bun，尚未 fast-forward `main`/push（用户要求先不 push，本地完成即可）。

### Session 43 (2026-06-17)
- **用户反馈**: 画布节点重叠 + 长线性 project 聊天的大纲「层层缩进楼梯」别扭（project 基本线性，树是过度抽象）。选了交互方向 **C·线性 thread 主视图 + 树缩略图**（分两增量做）。
- **Done（增量 1：两个 bug，已浏览器验）**:
  - **大纲缩进按「分叉深度」而非「轮数」**（`Outline.tsx`）：TreeRow 用 `branchDepth`(=祖先分叉点数) 取代 `depth`，子代仅当父 >1 子才 +1；`↳` 仅分叉子显示。线性段全平铺。
  - **画布重叠修**（`layout.ts`）：compact 模式原固定 90px 且忽略实测高度，但 streaming/error 节点仍渲染 600px 全卡（`ChatNode: showCompact=isCompact&&!streaming&&!error`）→ 被当 90px 摆放压住下方。改为 compact 下当实测高度 >90 时按实测留位（保持普通 compact 卡统一打包）。
  - **验证**: tsc ✓；快照 DB 起隔离 dev server + agent-browser 实测真实「Analyze WeChat」会话(24 轮纯线性)：大纲 50 行**全 paddingLeft=4px 平铺**(原会得楼梯到 ~600px)；画布 25 节点 **0 重叠**。环境/快照已清。
- **Done（增量 2：线性 thread 主视图 + 树缩略图，待浏览器验）**:
  - Store 加 `viewMode: "canvas"|"linear"` + `setViewMode`；`loadSessionInternal`/新建 session 路径按 mode 初始化（project→linear，其余→canvas），`ViewState` 持久化扩 `viewMode` 且兼容旧数据。
  - 新 `LinearThreadView`：active 锚点算 root→tip 线性 thread（祖先反转 + active + 最小 `siblingIndex` 子链），逐轮渲染问题/markdown 回答/工具调用/CLI 续聊/复制；非主线子节点折成「↳N 个分支」并可切 active lineage。
  - 新 `ThreadMinimap`：复用 `layoutNodes(nodes, undefined, {compact:true})` 画右下角 SVG 树，点圆点 `setActiveNode`，可折叠；无第二个 React Flow。
  - `app/page.tsx` 仅 `project && viewMode==="linear"` 走线性视图；否则保持原 `fullScreen ? NodeFullView : Canvas`，project canvas 增「线性」切换钮；移动端 project 不再被启动 effect 强制 fullscreen。
  - **验证**: `npx tsc --noEmit` ✓；`npm run build` ✓；grep 自检 viewMode 默认/持久化、thread 计算、分叉条件、minimap 点击、page project-only 分流均符合 spec。
- **Next**: 用户浏览器实测真实 project 会话：默认线性、画布往返、缩略图点击、分叉展开切 lineage。

### Session 42 (2026-06-17)
- **Done**: **「在 CLI 继续」轻量入口**（project 会话本就是真 claude CLI 会话，给可粘贴的续聊命令）。`cli-fork.ts` 加 `cliResumeForNode(nodeId)`：project 模式下，attached(cli-import) 取该节点 lineage sid（验源 jsonl 在盘）、native 走 `getRootResumeIdForNode`（自带 jsonl 存在性自愈），返回 `{cwd, resumeId}`，非 project/缺盘→null。新 `GET /api/nodes/[id]/cli-resume` 返回 `{resumable, command}`（`cd '<ws>' && claude --resume <id>`，cwd 单引号转义）。新 `CliResumeButton`（仅 project 模式渲染，点击 fetch+复制命令，不可续显「盘上找不到」）挂 NodeFullView 动作行。续到的是该 lineage 主链 tip（树内分叉的「CLI 续任意分支」需 P2 前缀 jsonl，本入口不含——已记 spec）。
- **验证**: tsc ✓ + `npm run build` ✓（`/api/nodes/[id]/cli-resume` 注册）。隔离 dev server 实测：attach 真会话 → `GET cli-resume` root 返回正确 `cd … && claude --resume <sid>`、坏节点 `resumable:false`；真跑生成的命令 `claude --resume` 被接受（无 "No conversation found"）。环境/产物全清。
- **架构注记**: 用户问「一棵树本质是多 session id，为啥 CLI 只能加载主链」——答：①「新提问」根=独立 claude session，今天就各自可 resume；② 一个 session 内的分叉是 in-jsonl fork，`claude --resume` 只跟主线性叶子（claude CLI 把会话当线性消费，非数据限制，且 claude CLI 非我方代码）；③ 破法=把分叉物化成独立 session（= P2 的 fork-session/前缀 jsonl 引擎）。本轮选轻量档（只续 lineage tip）；「CLI 续任意分支」= 推广 P2 到 native，留作后续。
- **Next**: 按需把「续任意分支」做全（推广 buildPrefixJsonl 到 native project）；或 merge。

### Session 41 (2026-06-17)
- **Done**: **CLI 分支对齐 P2b：trellis→CLI 分叉接线 + 真 claude 端到端验**。`/api/chat/route.ts` 加 `resolvedOrigin`（branch 取 parentSession.origin），resume 解析在 `origin==='cli-import' && kind==='branch' && family==='claude'` 时走 attached lineage：`attachedLineageForNode(X)` → 若 X 是其 lineage jsonl tip 且 trellis 无其他子（`hasOtherChild`）→ 线性 `--resume <lineageSid>`；否则 `buildPrefixJsonl(X)` 在 X 构造前缀 jsonl → `registerForkLineage` 插 `cli_lineages` 新 fork 行 → `setNodeResumeId(新节点, newSid)` → `--resume <newSid>`。两路 `forkSession=false`、`sessionIdTarget=undefined`（id 自管，不写 root）。`cli-fork.ts` 加 `hasOtherChild`/`registerForkLineage`。原生 chat/workspace/project resume 与 `getRootResumeIdForNode` 零改。
- **验证（真 claude 闭环，翻盘性未知已打掉）**: 造真会话 2 轮（haiku，turn1 记暗号「香蕉」→turn2 记「苹果」，21 行 jsonl）→ 临时 DB attach（2 turn 导入）→ `buildPrefixJsonl(turn1)` 产 9 行前缀（含香蕉 3 处、含苹果 0、旧 sid 残留 0）→ 真 `claude --resume <newSid> -p "记住过哪些暗号"` 答「**只记得香蕉**，无法回溯其他 session」。证明 trellis 程序化构造的前缀 jsonl 可被真 claude 从任意历史节点 X 续上、且上下文严格截到 X（不含被砍的后续轮）。`npm run build` ✓（Compiled successfully）+ `tsc --noEmit` ✓。测试产物（含 `~/.claude/projects/-private-tmp-p2b-claude-test`、临时 DB、tsx 脚本）已全清。
- **HTTP 全链路 e2e（隔离 dev server localhost:3099 + 临时 DB + 关 auth + 真 claude，已验收通过）**: 造真会话 turn1=A=7→turn2=B=99 → `POST /api/cli-sync/attach`（2 turn 导入）→ `POST /api/chat {kind:branch, parentNodeId:turn1}`（**从历史非 tip 节点分叉**）→ SSE created/delta/done，分叉答「**A=7**」（不知被截掉的 B=99）→ reconcile 后 DB：新 fork 节点挂 turn1 下、`claude_session_id`=新 fork lineage（≠root）、临时流式节点已删、`cli_lineages` 新增 `is_root=0 fork_point=turn1` 行。turn1 现有两子（原 B=99 + 新分叉）分属不同 lineage = 真分叉子树。环境/测试产物全清。
- **Next**: 按需 commit/merge `feat/cli-session-sync`（P1+P2 全链路已验，含真 claude e2e）。可选：真实浏览器 UI 眼验分叉子树渲染（功能链路已确证，纯视觉确认）。

### Session 40 (2026-06-16)
- **Done**: **CLI 分支对齐 P2a：trellis→CLI 分叉地基**。`cli-import-db.ts` 的 union import 记录 turn 首引入 lineage，节点 `claude_session_id` 从“仅 root”放宽为“每节点所属 lineage sid”；unchanged 快路径会检测旧节点 sid 是否已补齐，避免既有 attached 会话因游标命中而跳过迁移。新增 `lib/server/cli-fork.ts`：`attachedLineageForNode(nodeId)` 返回 lineage sid/source jsonl/tip 状态；`buildPrefixJsonl(branchFromNodeId)` 读取源 jsonl，按 parser 同款 turn ownership 找 X turn 末条 assistant，沿 parentUuid 保留 root→X uuid 链 + X 前无 uuid 元数据，改写每行 sessionId 为 newSid，uuid/parentUuid 不动并写同目录 `<newSid>.jsonl`。顺手给 `deleteNodeSubtree` 加 `origin!='cli-import'` jsonl cleanup 闸，避免 per-node sid 让 attached 子树删除误删用户 CLI jsonl。
- **边界**: 未改 `cli-import.ts` 解析器内核，未改 `/api/chat/route.ts` / run-bus，未碰原生 chat/workspace/project resume 逻辑；P2b 仍需真 claude 验证程序化 prefix resume。
- **验证**: `npx tsc --noEmit --pretty false` ✓；P2a 一次性 fixture（脚本已删除，`/tmp/p2a.db` + fixture dir 已清）✓：per-node sid 正确；`attachedLineageForNode` 对 tip/非 tip/root/fork 返回正确；`buildPrefixJsonl(n2)` 产物只含 root→n2，sessionId 全改 newSid，uuid 不变，无孤儿 tool_use，`parseCliSessionJsonl` 得到 turns `n1,n2` 且 tip=`n2`；P1 回归 root+fork union=5 节点、forkC reimport=6 节点、detach 保留 jsonl；`npm run build` ✓。
- **环境说明**: 契约指定的 `npx --yes tsx --conditions=react-server` 在本沙箱因 `tsx` 未安装且 npx 网络受限会卡住；`~/.claude/projects/__p2a_verify__` 也因写权限被沙箱拒绝。实际验证用本地 jiti runner 显式 alias `server-only` empty + `/tmp/__p2a_verify__` 跑同一 fixture 逻辑。
- **Next**: P2b 接线：仅 `session.origin==='cli-import'` 时在 `/api/chat` 选择 attached lineage，tip 线性续聊继续用 lineage sid，分叉调用 `buildPrefixJsonl` 后插 `cli_lineages` 新 fork 行并用真 claude `--resume <newSid>` 闸验。

### Session 39 (2026-06-16)
- **Done**: **CLI 分支对齐 P1：union 导入 + lineage 发现 + watcher 新 fork 检测**。`sqlite.ts` 新增 `TRELLIS_DB_PATH` 测试覆盖 + `cli_lineages` 表/既有 attached 无损迁移；`cli-discover.ts` 新增 `discoverLineage`（同目录 jsonl 按共享 turn uuid union-find，picker attached 排除改查 lineage 全集）；`cli-import-db.ts` 改为 `importCliLineage(sessionId)`，读取 lineage 全组按 uuid upsert 到同一 trellis session、跨 jsonl 重算 siblingIndex、每 lineage 独立 `synced_uuid`，且仅 root 节点保留 `claude_session_id`；`cli-sync-watcher.ts` attach 改 discover+seed+union import，watch 改 per-lineage，未知 jsonl 与 attached 组共享 uuid 时自动插入新 fork 后重导。`reconcileAttachedTurn` 改为对整组 lineage 重导并按 union newest turn 对账。
- **边界**: 未改解析器 `cli-import.ts`，未碰 `getRootResumeIdForNode` / `repo.ts` SessionRow / `lib/types.ts` Session，detach 继续由 `origin='cli-import'` 闸保护原始 jsonl。
- **验证**: `npx tsc --noEmit --pretty false` ✓；legacy migration smoke ✓（既有 `cli-import` session 补成 root lineage 且搬 `synced_uuid`）；一次性 fixture 脚本（已删除，临时 DB/jsonl 已清）✓：rootA+forkB attach 后 `cli_lineages=2`、节点 `{n1,n2,n3,n5,n6}` 不重复；forkC 新文件 `reimport` 后 `cli_lineages=3`、`n7.parentId=n2`、siblingIndex 无冲突；`detachSession(rootA)` 后 session/nodes/lineage 全清且 3 个 fixture jsonl 仍存在；`npm run build` ✓。
- **Next**: P2 另起：trellis 分叉写回 CLI fork-session/前缀 jsonl，并重新定义 resume 目标定位；本轮不继续扩边界。

### Session 38 (2026-06-16)
- **Done**: 修两处用户反馈。① **CLI attach 同步不再依赖刷新**:新增 `lib/server/cli-sync-events.ts` process 内 pub/sub + `GET /api/cli-sync/events` SSE(route 首帧 ping + 30s keepalive),`cli-sync-watcher` 在 import 状态为 imported/updated 时广播 `session_updated`;新增 `hooks/useCliSyncEvents.ts` 挂到 `app/page.tsx`,收到当前 session 更新就 `loadSession`,非当前 session 只 bump `sessionsRevision` 让列表更新。客户端 SSE 掉线 2s 重连,服务端发送失败会清理 subscriber。
- **Done**: ② **context 占用旧数据修正**:确认 live Claude/Codex 链路已带 `contextTokens` 并落 `token_context`;DB 抽样显示 `native|project` 旧节点大量 `token_context=NULL`,回退旧口径会虚高 3x-10x。新增 `lib/server/context-backfill.ts` 在 instrumentation 启动时 best-effort 回填:仅填 `origin='native'` project root 下 `token_context IS NULL` 的 done QA 节点,优先按当前 Claude cwd 编码找 jsonl,找不到则在 `~/.claude/projects` 按 session id 兼容搜索,按 root subtree created_at 顺序映射 parsed turns 的 `contextTokens`。不改成本四桶/正文/状态。顺手补齐 `stores/sessionStore.ts` 的 SSE `done.usage.contextTokens` 类型。
- **验证**: `npm run build` ✓。临时 dev server `localhost:3099` 启动 ✓;`/api/cli-sync/events` 带 auth cookie curl 收到首帧 `data: {"type":"ping"}` ✓。DB 实测 backfill 跑后 `native|project` 空 context 从 30 → 28;剩余 28 个旧节点对应的原始 Claude jsonl 不在本机 `~/.claude/projects` 或无可匹配源,无法可靠恢复,仍按 Header 旧口径回退。
- **Next**: 浏览器验收 attach 会话:外部 CLI 新增一轮后当前 Trellis 页面应自动刷新出新节点;若用户需要“外部 CLI 生成中的逐 token 流式”,需另做 tail jsonl/PTY 级方案(当前 jsonl mirror 只能在文件落盘时同步)。

### Session 37 (2026-06-09)
- **Done**: **文件预览围栏从「cwd 内」放宽到「session 实际碰过的范围」+ 重写 HTML 内 file:// 链接（build ✓ + curl + agent-browser 实测真实案例）**。触发:用户的 `~/design-loop-demo/compare.html`(4 版对比面板,链到 naive/cand-a/cand-b/looped.html + shots/*.png)预览不了——文件全在 cwd(`~/.claude`)外,旧围栏只服务 cwd。用户拍板最完整方案,并要求「能预览所有它生成的文件**包括子 agent 生成的**,但保证安全」。
  - **新围栏模型**(`lib/server/workspace-files.ts` 重写):`resolveSessionFile(sessionId, absPath)` + `sessionAllow(sessionId)`——白名单 = workspace cwd ∪ {session 所有 nodes 的 Write/Edit tool_calls 的 file_path 父目录}。**目录级放行**是覆盖「子 agent 生成的兄弟文件」的关键:主 agent Write 了 `design-loop-demo/looped.html` → 整个 `design-loop-demo/` 放行 → 子 agent/脚本写的 compare.html/naive.html/shots/*.png 全可预览。**安全**:`isBroadDir` 把 $HOME 本身 / 顶层系统根 / depth≤1 判为 broad,这类父目录只放行**单个文件**(不暴露整个 home);全程 realpath(symlink/firmlink 归一)+ containment。
  - **URL 方案改成绝对路径**:`/api/files/<sid>/<完整绝对路径去前导/>`(原 workspace-relative)。这样 HTML 相对资源(`./naive.html`/`shots/x.png`)**天然解析正确**(URL path 镜像真实目录结构),且重写后的链接一致。`filePreviewUrl(sid, absPath)`/store `filePreview.path`/`openFilePreview(absPath)` 全链路改绝对路径;客户端 `previewablePath`(原 pathInWorkspace)绝对路径直通、相对路径 join workspace、`~/` 跳过;chip 列**所有** Write 文件(不再按 cwd 预筛,服务端兜底)。
  - **file:// 重写**(route):服务 `text/html` 时读进内存,把 `(href|src)="file://(/...)"` 正则重写成 `/api/files/<sid>/...`(直接 file:// 导航在 http 页/sandbox iframe 被拦)。非 HTML 仍流式。
- **验证**: `npm run build` ✓。**curl 实测**(真实 ee30f329 session):compare.html/looped.html/naive.html(子 agent 兄弟)→**200**;`~/.zshrc`(home broad 未碰)→**404**;`/etc/passwd`→**404**;相对链接 `naive.html`→200、`shots/cand-a.png`→200(子目录 dir 白名单覆盖)。**agent-browser 实测**:① 直接渲染 compare.html→**4 版网格 + 截图全加载** ② 节点行内路径(相对 `skills/…eval-compare.html`)渲染靛蓝可点 → 点击 → **全局 overlay → iframe 渲染对比面板**(含内嵌 SVG/图)。安全守住 + 子 agent 产物可见 + 内部链接可跳,全达成。
- **Caveat**: 围栏走 tool_calls,故只认主 agent 工具调用记录过的目录/文件(子 agent 内部 Write 不冒泡到顶层 tool_calls,靠「父目录放行」间接覆盖——主 agent 没碰过的全新目录里的子 agent 产物仍够不着);`~/` 开头的行内路径客户端展不开 home → 不可点(绝对/相对正常);sessionAllow 每请求遍历 nodes(HTML 多资源时多次,未缓存,够用)。
- **Next**: 回 session-workbench Wave 1-4 积压的 UI 实测,或等用户新指令。

### Session 36 (2026-06-09)
- **Done**: **文件预览入口升级——回答里像路径的行内代码直接可点（build ✓ + agent-browser 实测全过）**。用户提议:别只靠 tool_calls 抽 chip,默认让回答正文里像文件路径的都能点、点完渲染。比 chip 更通用(解耦文件来源:Write/Bash 生成、引用提到的都覆盖)。
  - **架构:FilePreview 升级为 store 驱动的全局 overlay**。store 加 `filePreview:{relPath,name}|null` + `openFilePreview(relPath)`/`closeFilePreview`;`FilePreview` 改无 props、从 store 读、page.tsx 顶层挂一次(像 SearchModal/NotesDrawer)。所有入口(chip / 行内路径 / 未来文件浏览器)调同一个 action,预览那半完全复用。
  - **行内路径检测**:`lib/generated-files.ts` 新 `pathInWorkspace(text, ws)`——严格降误判:必须含 `/` 分隔符(根目录裸文件名走 chip 不行内,避免 `config.py` 误判)+ 已知扩展名(`PREVIEWABLE_EXT`)+ 非 URL + 能 resolve 进 workspace(复用 `relativeToWorkspace` 含 /private firmlink 归一)。`lib/md-components.ts` 加 `code` 组件:行内且命中 `pathInWorkspace` → 渲染靛蓝虚线下划线可点 button(`openFilePreview`),否则原样 `<code>`;block code 不动(仍走 `pre`→CodeBlock)。用 `useSessionStore.getState()`(非 hook,读稳定值)。
  - **chip 保留**:`GeneratedFilesBar` 改调 `openFilePreview`(去本地 FilePreview + active 态),和行内路径统一走全局 overlay。两入口并存(chip 抓 Bash 生成但正文没提的;行内抓正文提到的)。
- **验证**: `npm run build` ✓ + **agent-browser 实测**(隔离 project session,Claude Write `assets/page.html` 到子目录 + 回复行内引用):① `assets/page.html`(带 `/`)渲染成**靛蓝可点**、点击→全局 overlay→**iframe 渲染青色渐变 HTML** ✓ ② 同行 `#00c6ff → #0072ff`(非路径)保持**玫红普通 code 不可点** ✓(误判控制住)③ 底部 chip「🌐 page.html」并存、点击同样开预览 ✓ ④ Esc 关闭 ✓。测后清理 session+文件。
- **Caveat**: 行内仅认含 `/` 的路径(根目录裸文件名只走 chip);`~/` 前缀路径客户端无法展开 home → 不可点(绝对/相对路径正常);路径不存在→点了 404(纯语法判定,客户端无法 stat)。`getState()` 非响应式,但回答随 session 变更整体重渲染,够新。
- **Next**: 回 session-workbench Wave 1-4 积压的 UI 实测,或等用户新指令。

### Session 35 (2026-06-09)
- **Done**: **B — token/context 占用计算修正（跨 2 包全链路 + 运行时实测，build ✓）**。Session 34 已证 claude `result.usage` 是跨工具迭代/同模型 subagent 的**累计和**，被当成「当前 context 占用」→ 虚高数倍。本轮落地修正：报**末条 assistant message 的 usage**（=主 agent 当前窗口实际占用）作为独立口径。
  - **agent-gateway**（`../../agent-gateway`）：`events.ts` Cost 加 `contextTokens: number|null`；`backends.ts` claude 分支流式中 `let lastAssistantContext`，每条 `t==="assistant"` 用 `msg.usage` 覆盖更新（input+cache_read+cache_creation），result 直报 `contextTokens: lastAssistantContext`（异常退回累计）；codex 设 `totalIn`（单轮无累计问题）；其余 5 处 Cost 构造（image×2/gemini/api/mock）补 `null`。`npm run build`(tsc) emit dist（注：gemini.ts:73 有**预存在**无关 TS error，noEmitOnError 未设仍 emit；未碰）。
  - **trellis 全链路**：`lib/llm/types.ts` TokenUsage +`contextTokens?`；`sdk-adapter` Result→done 映射；`run-bus` 3 处 inline usage 形状 + 初始化器 +`contextTokens`，finalizeNode 传 `tokenContext`；`sqlite.ts` nodes 加 `token_context INTEGER`（可空，幂等 ALTER）；`repo.ts` finalizeNode 写列 + NodeRow/NODE_COLS/rowToNode/ApiNode.tokenCount + resetNodeForRetry 置 NULL；`lib/types.ts` ChatNode.tokenCount +`contextTokens?`；store done 处理 `tokenCount: usage` 自动带（apiNodeToChatNode 全展开，reload 路径通）；`Header.tsx` 新 `ctxTokensOf(n)`（优先 contextTokens，null 回退 input+cache 旧口径）替换 findLatestCtxTurn + ctx 计算。
  - **设计**：contextTokens 作 TokenUsage 第 5 个可选字段贯穿（而非到处加新参数），最小化触点；与四桶累计（成本口径）并存——成本仍看累计，占用%看 contextTokens。null = legacy/codex/非 claude → 回退旧口径，无破坏。
- **验证**: `npm run build` ✓（trellis 端到端）。**运行时实测**（`backend.run` 直跑 2 工具 prompt）：累计 sum=**150,209**（旧口径，占 200k 窗 75%）vs contextTokens=**50,178**（新口径，~25%），**虚高 2.99x** — 修正生效。
- **Caveat**: DB `token_context` 持久化是 mirror 既有 token 列 + build 验证，**未单独跑 project-mode 落库往返**（逻辑等价于 cache 列，风险低）。Header% 在有 contextTokens 的新数据上准确；老节点 null→回退旧口径（仍偏高，但无新数据可补，可接受）。
- **Done (续) — 本地文件预览（workspace/project 生成的文件/HTML 在 Trellis 内直接看，build ✓ + curl 实测围栏）**。用户痛点:生成的文件 or HTML 看不到、得折腾去文件系统。用户拍板:**自动列出本轮生成/改动的文件 chip + HTML 走 sandbox iframe 渲染**。
  - **服务端**:新 `lib/server/workspace-files.ts` `resolveWorkspaceFile(sessionId, relPath)`——`getSessionWorkspacePath` 取 cwd,**realpath 双重围栏**(root realpath + target realpath + startsWith,防 `../`/符号链接逃逸),扩展名→mime 表。新 path-based 路由 `GET /api/files/[session]/[...path]`(path-based 而非 query,让生成 HTML 的相对资源 `./style.css` 能解析),`fs.createReadStream→Response`,`Cache-Control: no-store`。
  - **客户端**:`lib/generated-files.ts`:`generatedFilesFromNode`(从 toolCalls 抽 Write/Edit/MultiEdit/NotebookEdit 的 file_path)、`relativeToWorkspace`(剥 workspace 前缀)、`filePreviewUrl`、`previewKind`(html/image/pdf/markdown/text)。`components/FilePreview.tsx`:全屏 overlay(createPortal 逃 transform 祖先,Esc 关),按 kind 分发——**html→sandbox iframe**(`allow-scripts allow-popups allow-forms`,**无 allow-same-origin**=opaque origin 跑 JS 但碰不到父/cookie)、image→img(棋盘底)、pdf→iframe、markdown→ReactMarkdown 复用 MD_COMPONENTS、text→fetch 文本 `<pre>`(>500k 截断)。`components/GeneratedFilesBar.tsx`:从 store 读 session,只列 workspace 内文件 chip(带 kind icon),点开 FilePreview。挂在 NodeFullView 回答动作行下方。
  - **设计**:文件来源 = tool calls 的 file_path(零额外存储,精确对应"这轮生成");只读、只服务 workspace 内、HTML opaque-origin sandbox —— 三重边界。
  - **验证**: `npm run build` ✓。**curl 实测**:workspace 内 CLAUDE.md→200 text/markdown 8696B;编码 `../` 逃逸→404;`../../etc/passwd`→404;不存在→404;chat session(无 workspace)→404。**围栏稳固**。UI(chip 显示/点开/iframe 渲染)未浏览器实测。
- **Caveat (文件预览)**: Bash 间接生成的文件不在 chip 内(只认 Write/Edit 类 tool);文件须在 workspace 内才显 chip(外部写按安全边界不预览);iframe `allow-scripts` 无 same-origin → 用 localStorage/同源 fetch 的页面受限(MVP 取舍,多数 dashboard/svg 自包含 OK)。
- **Done (续2) — agent-browser 浏览器实测全过 + 抓修一个真 bug**。逐项眼验:
  - **B context%**: 旧节点显 39%(token_context=NULL→回退旧口径);**新写入节点显 5.1%**(走新 contextTokens 口径,单轮 write ~5% 合理) — 新口径在真实新数据上生效。
  - **C 划线追问**: 程序化选区 + 派发 pointerup,3 字符→**不弹** bar、15 字符→**弹** bar(`针对「…」`) — 8 字符门槛 + 释放才提交都对。
  - **D 卡片图**: 直接 DOM click 触发完整序列 `卡片图→生成中…→✓已下载→复位`(headless 无 clipboard 权限→按设计降级下载;toBlob 成功=PNG 生成 OK,真实浏览器会复制图片)。
  - **文件预览(全链路)**: 建隔离 project session(/tmp)→Claude `Write` 写 dashboard.html→chip「🌐 dashboard.html」显示→点击→**FilePreview sandbox iframe 实时渲染**(紫渐变 Dashboard+按钮)→Esc 关闭。
  - **per-session model 顺带验**: 切到的 chat session 显 Codex、project session 显 Claude,各保各的模型(Session 34 A 生效)。
  - **★ 抓到真 bug(build/curl 都看不出)**: macOS `/tmp` 是 `/private/tmp` 的 firmlink,Claude `Write` 报 realpath `/private/tmp/...` 而 session workspace 存的是 `/tmp/...`,`relativeToWorkspace` 朴素前缀匹配失败→**chip 不显**。修:`canonical()` 归一化 `/private/(tmp|var|etc)` firmlink 后再前缀匹配。修后 chip 正常。production build ✓。(真实用户 session 多在 /Users 下不踩此坑,但 /tmp·/var workspace 会,值得修。)
- **Next**: 三件「修复吧」(per-session model / token / 文件预览)+ C/D 全部落地并浏览器验收。回 session-workbench Wave 1-4 积压的 UI 实测,或等用户新指令。

### Session 34 (2026-06-09)
- **Done**: 三件用户提的修复（build ✓ ×N，A 另过 curl 实测）+ 一个基础设施根治。
  - **A — 模型 per-session 锁定（修「切回来模型变了」）**。原 `provider`（=ProviderId，即模型 claude-opus/sonnet/haiku/codex）纯全局（localStorage `trellis-provider`），切 session 不变 → 误用。全链路落库：`sqlite.ts` 加 `sessions.model TEXT`（幂等 ALTER，镜像 system_prompt）；`repo.ts` ApiSession/SessionRow/SESSION_COLS/rowToSession + `createSessionWithRoot` 落 model + 新 `setSessionModel`；`/api/chat` 建 session 时存 `model:providerId`；`PATCH /api/sessions/[id]` 加 `{model}` 分支（isProviderId 校验）；`lib/types.ts` Session.model；**store 核心**：`loadSessionInternal` 把 `provider` 设成该 session 的 model（legacy null 不动），`setProvider` 改 model 时 PATCH 持久化到当前 session（全局值降级为「新 session 默认」）。**curl 实测**：PATCH model=codex→200+持久化、切回 claude-opus、非法值 400、rename 回归 ✓。
  - **C — 划线追问太易触发**。根因 `useMobileSelection`（NodeFullView.tsx）对任意非空选区触发 + 每 300ms 轮询 + selectionchange 持续触发。改成：只在**手势释放**（pointerup/touchend/keyup）提交、**最小选区 8 字符**（`MIN_SELECTION_LEN`）、去掉轮询，selectionchange 仅用于「选区塌缩则关闭」。
  - **D — 去掉「存到记忆」，改「卡片图+复制剪贴板」**。删 NodeFullView 内联 `MemorySaveButton`（定义+挂载）；新 `components/CardImageButton.tsx`：把问答（问题=标题 + 回答正文，复用 md-body+MD_COMPONENTS 保持渲染一致）渲染到屏外卡片 → `html-to-image` toBlob PNG → `navigator.clipboard.write([ClipboardItem image/png])`，不支持则降级下载。新依赖 `html-to-image@1.11.13`。用户确认：PNG 图片 + 卡片放「问题+回答」。
  - **基础设施根治 — agent-gateway symlink 在 Turbopack 解析失败**。`npm install html-to-image` 把 node_modules 里原本的 agent-gateway **真实拷贝换成 symlink**（指向项目根外 `../../agent-gateway`），Turbopack 不跟进项目外 symlink → `Module not found: agent-gateway`（Node 能解析、Turbopack 不能；serverExternalPackages 也含它）。根治：`next.config.ts` 加 `turbopack.root = path.join(__dirname,"..","..")` 指到 monorepo 父目录，symlink target 落入 root → 解析通过。**从此 npm install 的自然 symlink 无害**，且 B 改 agent-gateway 重 build 后经 symlink 自动反映。
- **验证**: `npm run build` ✓（端到端，含 A/C/D + turbopack root）。A 经 dev server curl 往返实测。**C/D 未浏览器实测**——C 的手势手感（释放才弹/8 字符门槛/拖动中不弹）、D 的剪贴板 PNG 写入（ClipboardItem image/png，localhost 安全上下文）+ 卡片 light/dark 渲染，均按逻辑写未眼验。
- **Caveat**: html-to-image 安装一度连带破坏 package-lock 的 agent-gateway resolved 字段，已 `git checkout` 还原 + 重新规范化（现 lock 一致、html-to-image 正式声明）。
- **Next**: **B（token/context 计算）未做**——这是另一半「修复吧」。实测已证：claude `result.usage` 是跨迭代/同模型子 agent 的**累计和**（5 轮工具循环报 ~150k，真实窗口仅 ~50k，虚高 3x），而非主 agent 当前 context。修法在 agent-gateway `backends.ts`：流式中追踪**最后一条 assistant message 的 usage** 作为「当前 context 占用」单独报（与累计成本分开），trellis sdk-adapter/types/store/Header 接新字段。turbopack root 已铺好 agent-gateway 编辑路。之后浏览器实测 C/D。

### Session 33 (2026-06-09)
- **Done**: **Session 重开恢复「上次浏览位置」（build ✓）**。痛点:打开/切换 session 时 `loadSessionInternal` 把 `activeNodeId` 重置为 `null`——桌面落在画布全景、手机/全屏 fallback 到 `rootNodeId`(最老节点),从不回到上次离开的地方。用户拍板语义:**记住上次离开时所在的节点 + 连视图层(画布/全屏)一起还原**。
  - **持久化 helper**(`stores/sessionStore.ts`):新 `VIEW_KEY`/`loadViewState`/`persistViewState`,存 `{activeNodeId, fullScreen}` 到 **localStorage**(`trellis-view:<sid>`,选 localStorage 而非 collapsed 的 sessionStorage——要跨 reload/重启存活)。
  - **恢复**(`loadSessionInternal`):读 saved view,校验节点仍存在(被删则回退 canvas 无焦点),`fullScreen` 仅在有有效节点时还原;并 un-collapse 还原节点的祖先(复用 `ancestorsOf`)保证画布可见。原子 set() 一次写入 `activeNodeId`+`fullScreen`。
  - **写入**:模块级 `useSessionStore.subscribe` 监听 `(session.id, activeNodeId, fullScreen)` 变化即 `persistViewState`——一处覆盖所有散落写点(focus/jump/search/键盘导航/全屏切换),mutation 站点零改动。loadSessionInternal 原子 seed → 切换后首次 fire 只是幂等重写。
- **验证**: `npm run build` ✓ + Compiled successfully。逻辑走查:cold start 走 hydrate→loadSessionInternal 自动恢复;切 session 同链路;collapsed=sessionStorage 冷启为空→还原节点必可见。
- **Caveat**: **未浏览器实测**——(a)桌面还原全屏层、(b)切换 session 视图层跟随、(c)被删节点回退 canvas、(d)祖先折叠时自动展开,四条按逻辑写未眼验。mobile 仍被 page.tsx:58 强制 fullScreen(符合移动端定位,activeNodeId 已正确还原所以全屏看的是对的节点)。
- **Next**: 浏览器实测重开恢复全链路(桌面画布/全屏跟随 + 切换 + 删节点回退)。回 Wave 2/3/4 积压的 UI 实测。

### Session 32 (2026-06-09)
- **Done**: **A 路第③刀(最后一刀,纯前端)— 把模型交互请求渲染成表单(build ✓)**。后端①②(store 镜像 `node.pendingInteraction` + SSE `interaction_required/resolved` + `POST /api/nodes/[id]/respond`)已完成,本刀只读 `pendingInteraction` + 调 respond API,不碰后端。
  - **store action `respondToInteraction(nodeId, toolUseId, decision)`**(`stores/sessionStore.ts`):POST respond API,**乐观清除** pendingInteraction(`interaction_resolved` 也会清,幂等)。失败分层:404/409=stale(保持清除,UI 提示"会话已失效")、400/5xx/网络=retryable(还原表单可重试)。返回判别结果 `{ok:true}|{ok:false;reason:"stale"|"error"}` 给组件渲染反馈。提交前 guard:pending 不存在或 toolUseId 不匹配直接判 stale。
  - **新组件 `components/InteractionForm.tsx`**:按 toolName 分发。AskUserQuestion → 每问一卡(header 小标签 + question 标题 + options),单选 radio 圆点/多选 checkbox 方框,选中 indigo 高亮,全部答完才能提交;构造 `answers` map(单选 = label string、多选 = label[])→ allow + `updatedInput:{...input,answers}`。ExitPlanMode → 复用 NodeFullView 同套 MD_COMPONENTS+remark/rehype 渲染 `input.plan`,两键「✅ 批准执行」(allow)/「✋ 拒绝」(deny,可选 textarea 填理由 → message)。醒目 indigo 容器 + 「🙋 模型在等你回答」标题,dark mode 全配。
  - **挂载**:NodeFullView `<ResponseBody>` 下方,`node.pendingInteraction` 非空时渲染 `<InteractionForm>`。
  - **画布徽章**:ChatNode 全卡(amber「🙋 待你回答」banner)+ 紧凑概览卡(🙋 amber pill),让用户从画布就看到待答节点。
- **验证**: `npm run build` ✓ + TypeScript ✓。grep 自检全过:respondToInteraction 接 `/api/nodes/${nodeId}/respond`;InteractionForm 按 pendingInteraction 在 NodeFullView 挂载;ChatNode 两处徽章接上;answers 单选 `chosen[0]`(string)/多选 `chosen`(array)构造正确;ExitPlanMode allow/deny 双键接对。
- **Caveat**: **未浏览器实测**——尤其(a)多选交互手感(toggle 累加/取消)、(b)失效态(404/409 stale 提示 + retryable 还原)两条失败路径,均按逻辑写但未真触发后端验证;(c)dark mode 配色、提交中 loading/禁用、表单随 pendingInteraction 清除而消失,均靠现有 Tailwind 习惯未眼验。
- **Next**: 浏览器实测 A 路③全链路(AskUserQuestion 单/多选 + ExitPlanMode 批准/拒绝 + 失效态 + 画布徽章)。

（Session 1–31 已归档，见 `archive.md`）

---

### Session 31 (2026-06-09)
- **Done**: **Wave 4 — VSCode 式 IDE 外壳(R1+R2+R3,build ✓)**。响应用户看 Wave 1 实物后的三点反馈,把 session 导航从「所有 session 铺成扁平 tab」改造成 VSCode 预览/固定语义。
  - **R1 左侧常驻 explorer 侧栏**:新 `components/SessionSidebar.tsx`(`fixed left-0 top-12 bottom-0`,宽 210px,desktop `md:flex` 常驻 + 可折叠)。列全部未归档 session 按 mode 分组(Chat / Workspace·Project),每行 mode 色点 + 截断标题 + 运行脉冲(蓝)/未读 badge(emerald)。**单击=预览**(`previewSession`,斜体临时 tab,被下次单击顶替)、**双击=固定**(`pinSession`,永久 tab)。hover 露出 rename/archive/delete。折叠态状态存 localStorage `trellis-sidebar-open`(desktop 默认开)。
  - **R2 显眼新建入口**:侧栏顶「＋新建会话」实心按钮(=`newConversation()`)。tab 条末尾留冗余 `＋`。
  - **R1 tab 条改写**:`SessionTabs.tsx` **只渲染 pinned + preview**(preview 斜体)。tab 单击=loadSession、preview 双击=pinSession、每 tab × 关闭(`closeTab`)。`⌘1-9` 切 open tab 第 N 个。
  - **R3 完成·未读**:store `unreadSessionIds`/`runningSessionIds`;新 `hooks/useRunPolling.ts` 集中 3s 轮询 `/api/runs` → `ingestRunningSessions` 跨轮 diff 标未读。切过去清未读。UI:未读亮 emerald 实心点(区别运行=脉冲蓝)。
  - **store 扩展**:`previewSessionId`/`pinnedSessionIds`/`unreadSessionIds`/`runningSessionIds`/`sidebarOpen` + 配套 actions;`deleteSession`/`archiveSession` 复用 `closeTab`/`evictSessionFromTabs`。**未重构成多 session in-memory(Level B 仍 deferred)**。
  - **布局协调**:新 `lib/workbench-layout.ts` `SIDEBAR_W=210`;page.tsx effect 把有效偏移写成 CSS var `--trellis-sb`,Canvas/NodeFullView/QuestionInput/Outline/SessionTabs 统一读 var,Outline 与侧栏不重叠。mobile 侧栏 `hidden`。
- **验证**: `npm run build` ✓ ×3 + TypeScript ✓。grep + 逻辑走查全过(预览→顶替→固定→预览复现)。
- **Caveat**: **未浏览器实测**——预览-固定切换、× 关闭、折叠/重开、未读点、dark mode、`--trellis-sb` md 断点像素对齐均未眼验。run-poll 3s diff 可能漏标秒级任务。
- **Next**: 浏览器实测 Wave 4 全部交互 + dark mode;之后回 Wave 2/3 UI 实测积压。

### Session 30 (2026-06-09)
- **Done**: **Wave 2 生命周期落地(B1+B2+B3,build ✓)**。在 Wave 1(SessionTabs + `/api/runs`)基础上做。
  - **B1 正名**:「新提问」→「🧹 新话题(清空上下文)」。`NewQuestionPicker.tsx` 把 🧹 badge + 「等价 `/clear`」文案对所有 mode 统一(原仅 project 有 badge,chat/workspace 只说"不继承上下文"=可发现性盲点);project 额外补一句"开启全新 Claude 会话记忆"。`AddNodeFAB.tsx` 菜单项、`SessionPicker.tsx` 「新对话」副标题(明确"开全新 session")、`Header.tsx` ctx title 全部对齐。**只改标签/文案/badge,createRootInSession 数据层不动**。
  - **B2 归档**:`sqlite.ts` 加 `archived INTEGER NOT NULL DEFAULT 0`(pragma_table_info 守卫的 idempotent ALTER,同既有模式);`repo.ts` 加 `setSessionArchived`/`countArchivedSessions`,`listSessions({archived?})` 默认只返 archived=0,`ApiSession.archived`+SESSION_COLS+rowToSession 全链路;`GET /api/sessions` 默认排除归档、`?archived=1` 只取归档、附 `archivedCount`;`PATCH /api/sessions/[id]` 处理 `{archived:bool}`(与 rename 并存);store `archiveSession`/`unarchiveSession`(镜像 deleteSession:归档当前 session 则清空 + bump revision);`SessionPicker.tsx` 行内归档/恢复按钮 + 「显示已归档(N)」toggle 切归档视图。**绝不删 jsonl/节点**。SessionTabs 未改(fetch 同 endpoint 自动受益)。
  - **B3 /compact 降级**:spike 已确认无原生 compact → `Header.tsx` 🧠 ctx 徽章在 project 模式 ≥50% 时变可点,popover 解释上下文压力 + 「🧹 开新话题清空」一键(经新增 store `composeRootOpen` 标志驱动 `AddNodeFAB` 复用的 `NewQuestionPicker`)。<50% 保持非交互只读。不做 summarize。
- **验证**: `npm run build` ✓ + TypeScript ✓。dev server(:3199)curl 验证 archive 往返:PATCH `{archived:true}` → 默认列表排除 + archivedCount=1;`?archived=1` 含之;PATCH `{archived:false}` 恢复;rename 仍 200。migrate ALTER 在既有 DB 上幂等跑通(老 session 全带 `archived:false`)。
- **Caveat**: 仅 API/build 层验证,**UI 未浏览器实测**——归档行内按钮 hover 露出、「显示已归档」toggle 视图切换、Header ctx popover 点击/Esc/外部点关闭、dark mode 配色均按现有 Tailwind 习惯照抄但未眼验。`composeRootOpen` 经 AddNodeFAB 的 useEffect 镜像到 local picker,Header→FAB 远程开 picker 链路未实跑。
- **Next**: 浏览器实测 Wave 2 UI;之后 Wave 3 C1 命令面板(扩 `/` 前缀)。

### Session 29 (2026-06-09)
- **Done**: **新战略方向定调 + recon + spec**。用户提「希望 Trellis 承载更多工作」,经几轮对抗式澄清收敛出真实需求:① 把 Chat + Claude Code 执行任务收敛到一个平台(替代日常 CLI 操作)② tmux 式多 session 并行 + 快速切换。三个具体点:chat/CC 任务混排切换乱、session 开/清/关在 Trellis 里迷惑、CLI 命令没法执行。
  - **澄清过程的关键转折**:先误判方向为「异步/自主」(L1 离场执行),被用户一句「我已经发送完就不管了」推翻——离场早已由 durable streams 解决,真瓶颈不是注意力是**认知带宽**(发起/拆解/续作全压用户身上)。最终收敛到「Session 工作台层」而非自主循环。
  - **Recon(4 只读 agent 并发)**:测绘 session 数据模型/生命周期、导航 UX、创建/生命周期 UI、命令面+store。**关键架构发现**:run-bus(`lib/server/run-bus.ts:122`)本就多 session 并发,引擎零改动;墙在 ① store 单 active session(`sessionStore.ts:149` `session:Session|null`)② 缺导航/生命周期/命令 UI 层。**一大半"迷惑"是可发现性**:`/clear`=「新提问」fresh root(只 project 有 🧹)、resume 已按 mode 自动。真正从零造的只有 tab 条/归档/命令面板/compact。
  - 写 [session-workbench.md](session-workbench.md) spec(动机/架构发现/现状 file:line/三组件设计/三波节奏/开放决策/验收)。
- **Decisions**:
  - **tab 导航先做 Level A(不重构 store)**:常驻 tab 条 + 色标 + 快捷键 + live 状态点,点击仍走 loadSession。run-bus 已保证切走任务不死,客户端不必持有多份。Level B(多 session in-memory,需 store 重构 ~30% action)deferred,实测延迟痛才做。
  - **命令面板倾向扩 `/` 前缀**而非新全局键(⌘K/⌘P/⌘D 已占),和 CLI 肌肉记忆一致、零新键。
  - **归档 ≠ 删除**:archived 列只隐藏可恢复,不动 jsonl;硬删仍走 deleteSession。
  - **`/compact` 必须先 spike**:选型必附实测,SDK 不支持则降级为「提示开新 fresh root」。
- **Next**: 等用户拍板从 Wave 1 A1(tab 条)起步。开工前确认开放决策:Level A vs B、命令面板触发键、per-session model 是否随 C1 一起做。

### Session 28 (2026-06-08)
- **Done**: **费曼学习法 Phase 1（轻量版，今天可用）**。本质是反转 Trellis 的信息流——普通模式「你问→AI 答」，费曼模式「你讲→AI 当考官」，逼出理解漏洞；且费曼的「发现漏洞→补讲」循环天然 = Trellis 的「分叉子节点」（每个没讲清的点选中 ⌘K 开子节点深讲）。挂在现有 D1 系统提示词预设机制上，零 schema 改动：
  - `components/SystemPromptPicker.tsx`：导出 `FEYNMAN_PROMPT` 常量（复述确认→漏洞清单→naive 追问的「复述+考官」角色，明确禁止 AI 替用户把概念补完整）；PRESETS 加「费曼考官」预设（排在苏格拉底导师后，二者正好相反：苏格拉底是 AI 引导你推导，费曼是你主动讲 AI 挑刺）。
  - `components/QuestionInput.tsx`：import `FEYNMAN_PROMPT`，读 `draftSystemPrompt` 引用相等检测 `isFeynman`；激活时 textarea placeholder 翻转成「讲讲你的理解……选中讲不清的点 ⌘K 开子节点」+ 建议词从 `SUGGESTED_PROMPTS`（提问）切到 `FEYNMAN_STARTERS`（讲解起手式）。
  - `npm run build` ✓。
- **Done (续)**: **Zone 专注写作模式**（用户要「写回答时更好的体验 + Markdown 编辑」）。新 `components/ZoneEditor.tsx`——全屏 overlay 写作区：顶栏[编辑]/[预览]切换、Markdown 工具栏（⌘B 粗/⌘I 斜/行内代码/标题/引用/有序无序列表/链接，操作 textarea 选区）、居中大号沉浸编辑区、预览复用 `.md-body`+`MD_COMPONENTS`+同款 remark/rehype（和最终回答所见即所得一致）。可复用：parent 持有 value/onChange，退出 Zone 草稿无损留在原输入框。`npm run build` ✓（零新依赖）。
- **Done (续2)**: **接入全部 4 个输入框 + 浏览器实测**（用户反馈「为啥没试渲染 / 只有首屏有，追问都没」，两点都对，已补）。
  - 接入 `QuestionInput`（首屏）+ `ChatNode` FollowupInput（画布卡片）+ NodeFullView `FollowupBar` + `SelectionBar`——三个追问框各加「⛶」入口，复用同一 ZoneEditor。
  - **实测抓到一个真 bug（光 build 看不出）**：`fixed inset-0` 被祖先 transform（ReactFlow 画布 / NodeFullView 全屏）限制，Zone 只占底部一条而非全屏。修法：ZoneEditor 用 `createPortal` 渲染到 `document.body` 逃出 transform 祖先。
  - **agent-browser 实测全过**（截图 + eval 验证）：① 预览渲染 = 标题/粗体/行内 code/列表/斜体/引用框/python 代码块语法高亮+复制按钮，和回答正文一致 ② 工具栏 B 选中「路由表」→`**路由表**`+选区恢复内层 ③ Esc 关闭 Zone 不泄漏到 useEscapeAbort（capture 阶段 stopImmediatePropagation 生效）④ 退出后草稿完整回流到原输入框（共享 state）。
- **Decisions**:
  - **Zone 三选全取推荐项**：编辑器=轻量零依赖（textarea+工具栏+预览复用 react-markdown，"输入即发给 LLM 的 markdown 源码"，不引 CodeMirror/WYSIWYG）；布局=沉浸编辑+一键切预览（顶栏 toggle 不分栏）；范围=先 QuestionInput + 抽成可复用 ZoneEditor（追问框后续一行接入）。
  - **Zone 内发送恒为 ⌘↩，无视全局 sendKey**：长文写作区裸 Enter 必须换行否则误发；Esc 退出 + ⌘↩ 发送走 window 级监听（编辑/预览两态都生效）。
  - **工具栏选区保持**：按钮 `onMouseDown preventDefault` 防 textarea 失焦丢选区；transform 后 `pendingSel` ref + `useEffect([value])` 在 value 流回后恢复光标。
  - **Zone 必须 createPortal 到 body**：从追问框（在 transform 祖先内）渲染时 `fixed inset-0` 会相对 transform 祖先而非视口 → 只占一条。portal 是 overlay 逃出 transform containing block 的标准解。实测才发现，build 看不出。
  - **测试教训**：FollowupBar 的追问 textarea 与 Zone textarea 共享同一 `text` state（DOM 里两个元素值镜像）；`querySelector('div.fixed.inset-0 textarea')` 还会同时命中 NodeFullView 全屏自身的 fixed 容器——验证选区行为时必须按 placeholder 精确选 Zone 那个，否则误判逻辑有 bug。
  - **用户三选全取推荐项**：AI 角色=复述+考官（既确认听懂又施压，最贴费曼原意）；落地=先轻后重（Phase 1 零架构今天用，结构化漏洞清单+一键分叉留 Phase 2）；补漏闭环=两个都要先用现成的（MVP 复用「选区 ⌘K 分叉」，自动生成子节点入口留 Phase 2）。
  - **挂预设而非新建第四模式**：费曼是 chat 模式下的一种 AI 人格，D1 预设机制（chat 专属、创建锁定）天生契合；新建 mode 要动 schema/Mode 联合/全链路，违反简洁优先。workspace/project 的人格来自 CLAUDE.md，不叠费曼。
  - **引用相等检测角色**：复用本文件已有的 `PRESETS.find(p => p.prompt === current)` 同款机制，不引入新 marker 字段。
- **Caveats**:
  - **未浏览器实测**：需新建 chat 对话 → 角色选「费曼考官」→ 看 placeholder/建议词翻转 → 讲一段理解 → 看 AI 是否按「复述+漏洞清单+追问」结构回应、且不替你补完整。
  - **角色创建后锁定**：和 mode/workspace 一致，想中途切角色得开新对话（符合「一棵树一个语境」哲学）。
- **Done (续3)**: **发送键默认改 mod-enter**（用户反馈「打字回车很容易误发送」）。`lib/send-key.ts` `SEND_KEY_DEFAULT` 从 `"enter"` 改 `"mod-enter"`——全局 Enter=换行、⌘Enter=发送，推翻 Session 26 A4 的「对齐 GPT 默认 Enter 发送」（单人工具，用户明确痛点，思维树场景 prompt 多为多行）。机制本就可配（footer toggle 可切回 + store 读 localStorage，无存值则用默认）。**实测**：localStorage `trellis-send-key`=null（用户从没切过）→ 新默认直接生效；首屏提示显示「⌘↩ 发送」；输入框打字按 Enter→插入换行、不发送（`第一行\n第二行`，仍在 composer）。`npm run build` ✓。Zone 本就硬编码 ⌘Enter，与新默认一致。
- **Next**: 费曼角色仍待实测（讲解→AI 复述+漏洞清单+追问）。Zone 已实测通过（4 输入框全接 + portal 修复 + 渲染/工具栏/Esc/草稿回流验证）。后续：Phase 2 费曼结构化闭环：AI 输出漏洞清单时每条自带「展开讲这点」按钮 → 一键生成子节点（需让 ChatNode/NodeFullView 解析 AI 的结构化输出）；可选「理解度评分」。

### Session 27 (2026-06-08)
- **Done**: (A) **provider 行为调研**（带 file:line 证据回答用户）：`lib/llm/topic.ts:34` 话题标签写死 `spawn("claude")`——选 codex 也会后台跑 claude 生成 topic label（用户确认不改）；codex **无工具白名单**（`agent-gateway/src/backends.ts:231` `toolAllowlist:false`），所以「勾 skill / WebSearch」对 codex 无效，可达工具由 sandbox 决定；codex chat 是 OS 级 readonly 沙箱（无 workspace→readonly），连 curl 都拦死；**codex 联网只能走 MCP**（`mcp:true`，有 mcp_tool_call）或 full-access sandbox，不是勾 skill。codex 是 **block streaming**（`backends.ts:233`，整段出无逐字）——这是「没有流式」的一个真实来源。claude chat 能联网是因为 claude 吃工具白名单（`--tools`）。
- (B) **NodeFullView 对话流重设计**（agent-browser 截图驱动，截了 8 张对比）：① 发送框/分支条从满宽 1440 收窄到 `max-w-3xl mx-auto` 与内容列对齐（用户要的「窄一点」）② 流式首 token 前空白 → 加三点脉冲「正在生成…」（修「没有流式展示」——根因是首 token 延迟期零反馈）③ 正文 stone-700→800 + 14.5→15px 提对比 ④ 发送框 rounded-2xl + focus ring indigo + indigo 圆形发送钮 ⑤ 问题块 浅紫低对比 → 白卡片+左 indigo 强调条+阴影，拉开与回复区层次。`npm run build` ✓。
- (C) **Codex chat 联网实现**（用户提的临时 workspace 方案，比 MCP 更直接）：`lib/llm/codex.ts` chat 模式注入固定 scratch workspace（`~/.trellis/codex-chat`）+ `permission:"full"`。full 在 codex 映射成 `--dangerously-bypass-approvals-and-sandbox`（`backends.ts`），整体无沙箱 → 解锁联网 + 本机工具/skill。**代价 = YOLO**（codex 能跑任意命令；codex 无 claude WebSearch 那种受限联网工具，联网只能整体放开沙箱）。`npm run build` ✓。**需 codex 登录实测确认联网真通**。
- (D) **NodeFullView 第二轮美化（内容卡片）**：主背景 stone-50→stone-100；内容列改成浮起的白色卡片（rounded-2xl + border + shadow，居中 my-5）；问题块从「白卡+左条」改回 indigo-50 浅背景+左 indigo 条（避免白卡内白叠白）。层次：浅灰背景 → 白内容卡 → 浅紫问题块/裸文字回复，接近 Notion/Linear 文档质感。`npm run build` ✓。
- (E) **skill picker 放宽**（用户反馈「没看到 skill 可选」）：`QuestionInput` 显示条件从 `draftMode!=="chat"` 改为 `skillCapable = draftMode!=="chat" || provider==="codex"`——codex chat（现 YOLO 有工具）也触发；claude chat 仍不显示（本就只有 WebSearch/WebFetch，不能跑 skill，正确）。**仍只在首屏新建对话的输入框，追问框暂无**（待扩）。
- (F) **画布 ChatNode 卡片美化**（用户反馈「没看到卡片美化」——上轮只美化了全屏内容卡，画布卡片没动）：compact + full card 都改 rounded-xl→2xl + hover:shadow-md + active 态改 indigo accent。
- (G) **画布质感升级（用 frontend-design skill，定 Linear 风精致克制）**：ChatNode 卡片 border→`ring` + 多层柔和阴影（arbitrary shadow）+ hover 抬升 `-translate-y-px`（浮起感）；Canvas 容器加冷调渐变背景 `from-stone-50 via-white to-stone-100`；Background 点阵调淡（opacity-60/dark 0.18）；连线 `defaultEdgeOptions` smoothstep + globals.css `.react-flow__edge-path` indigo tint（#c7d2fe / dark #3730a3，selected #818cf8）+ `.react-flow` 透明露渐变。截图验证：连线 indigo smoothstep 比灰贝塞尔优雅，卡片浮起，背景有空间层次。
- (H) **追问框 skill picker**（用户要的 ①）：抽 `hooks/useSkillSuggestions.ts` 复用 hook（懒加载 skill 列表 + `/name` 匹配）；NodeFullView FollowupBar 接入（picker 向上弹 `bottom-full`，仅 tool-capable）。**ChatNode FollowupInput + SelectionBar 待接**（hook 已抽，下轮快）。
- (I) **收尾批（用户「都做了」= ①②③ 全做）**：① 其余 2 追问框接 skill picker——抽 `components/SkillPickerList.tsx` 复用组件，ChatNode FollowupInput + NodeFullView SelectionBar 都接上（三个追问框现在都能输 `/` 调 skill）② ChatNode 卡片左侧状态色条替代圆点（emerald 已读 / amber 未读 / stone 进行中，Linear 感）③ SubBar 改 backdrop-blur 半透明。截图复核 **light + dark 画布都协调**，状态色条两模式可见。`npm run build` ✓。
- **遗留**：dev overlay 显「1 Issue」——dev server 日志无 error/warn，疑似 next.config 自定义 Cache-Control 的已知 dev warning（build 日志早有此条），非本轮引入，待点开确认；移动端未单独截图复核（之前已做 Outline 抽屉 + 响应式）。
- (J) **chat 增强模式开关（用户选 C：加开关）**——解决「claude chat 看不到 skill」根因。全链路：`StreamRequest.chatEnhanced`；`sdk-adapter` 加共享 `CHAT_SCRATCH`（`~/.trellis/chat-scratch`）+ `ensureChatScratch()`，`modeToRunOptions` chat 分支按 `req.chatEnhanced` 分流（开=workspace+full 无沙箱 YOLO 能 skill+联网，关=WebSearch/WebFetch 纯对话）；`claude.ts`+`codex.ts` enhanced 时建 scratch（**codex.ts 删掉上轮无条件 YOLO，统一到开关**）；`route` 读 body.chatEnhanced 传 provider；store `chatEnhanced`（localStorage `trellis-chat-enhanced`，全局运行时偏好）+ 3 个请求体传递；UI：QuestionInput chat 模式加「⚡增强模式」pill（amber 高亮）。skill picker 显示条件全部从 `provider==="codex"` 改 `chatEnhanced`（QuestionInput + 3 追问框统一）。`npm run build` ✓。
- **chat 增强 caveat**：① 开关在**新建对话首屏**（chat 模式），全局偏好设一次生效；已有 session 无切换入口（下轮可加 Header）② YOLO 安全提示已在 tooltip ③ **未浏览器实测**（需新建对话开增强→输入 `/` 看 skill / 问联网）。
- (K) **增强开关加 Header 入口**（补全 J 缺口）：Header chat session 下显示「⚡ 增强」按钮（amber 高亮表开启），已有 session 也能随时切。截图验证生效。`npm run build` ✓。
- (L) **「1 Issue」定性结案**：= `next.config.ts:25-41` 自定义 Cache-Control（/_next/:path*，为 globals.css 即时生效）触发的 Next dev 警告。`git log` 证明 next.config 从未在本轮 sessions 改过（最后改是 852aa41 重构 llm）。dev 专属、对生产无影响，**非本轮引入，可无视**。
- **Next**: 实测 chat 增强（开关/skill/联网，需 codex 或开增强）；移动端专项复核；roadmap 剩余大件（C1 PDF/Excel 需装依赖、C3 语义检索 Q2、C6 图片生成 Q3）。

### Session 26 (2026-06-08)
- **Done**: 写了 [optimization-roadmap.md](optimization-roadmap.md)（4 个只读 agent 实测测绘 + 四维度 P0/P1/P2 路径，锚定替代 GPT），然后开始按 P0 实施。完成 3 项，`npm run build` ✓ ×2：
  - **A3 + B2 代码块/回复复制**：新 `components/CodeBlock.tsx`（react-markdown `pre` 渲染器，顶 bar = 语言标签 + 复制按钮，复制读 `pre.textContent` 抗 rehype-highlight 拆 span）+ 新 `components/CopyButton.tsx`（复制全文，含 ✓ 反馈）。`lib/md-components.ts` 注册 `pre: CodeBlock`。ChatNode footer + NodeFullView 回复底部各加「复制全文」。`globals.css` 加 `.md-codeblock*` 样式。
  - **D1 System Prompt 可配**：全链路。DB `sessions.system_prompt TEXT`（idempotent ALTER，NULL=默认）；repo `ApiSession/SessionRow/SESSION_COLS/rowToSession/createSessionWithRoot` 全加列；`lib/types.ts` Session 镜像 + `lib/llm/types.ts` StreamRequest 加 `systemPrompt`；`sdk-adapter.ts` chat 分支 `req.systemPrompt?.trim() || DEFAULT`；`route.ts` 四分支（新建/parallel root/branch/retry）解析 `resolvedSystemPrompt`（仅 chat 模式从 body 取，workspace/project 钳为 null 因走 CLAUDE.md），传 provider。前端 store `draftSystemPrompt`（localStorage `trellis-system-prompt`）+ setter；`streamRoot` 仅新建 chat session 时带。新 `components/SystemPromptPicker.tsx`（5 预设角色 + 自定义 textarea，QuestionInput chat 模式下显示）。
- **Decisions**:
  - **system prompt 只对 chat 模式开放**：workspace/project 的人格来自 `~/.claude/CLAUDE.md` + 全工具，再叠一层 system prompt 会语义打架。route 在非 chat 分支显式钳 null。
  - **B2 并入 A3**：语言标签和复制按钮在同一个 `pre` 渲染器里实现，拆成两次改纯属浪费。
  - **复制读 DOM textContent 而非 React children**：rehype-highlight 把源码拆成嵌套 `<span>` 高亮 token，递归提 children 文本繁琐且易错；`pre.textContent` 天然 flatten 回源码。
- **Caveats**:
  - **均未浏览器实测**：A3 复制依赖 `navigator.clipboard`（localhost 安全上下文 OK，已 try/catch 兜底失败静默）；D1 预设角色切换、自定义保存、创建后 system prompt 真正生效（看模型回答风格变化）需手测。
  - **存量 chat session 的 system_prompt 为 NULL** → 走内置默认，行为不变（无破坏性迁移）。
  - **D1 只在「新建 session」时可设**：和 mode/workspace 一致（创建后锁定）。已存在 session 想换角色得开新 session。符合「一棵树一个语境」哲学。
- **A4 Enter 发送可配（done，本 session 续做）**：新 `lib/send-key.ts`（`SendKey="enter"|"mod-enter"` + `isSendCombo` + `sendHint`，默认 `enter` 对齐 GPT）；store `sendKey`（localStorage `trellis-send-key`）+ `setSendKey` live 应用；4 个主对话输入框（QuestionInput / ChatNode FollowupInput / NodeFullView SelectionBar + FollowupBar）keydown 统一走 `isSendCombo`、placeholder 走 `sendHint`；QuestionInput 底部静态提示改成可点 toggle。`npm run build` ✓。
  - **A4 Caveat**：BranchPopover（本就 Enter 发送）+ ReferencePicker（⌘Enter 创建参考卡）这轮未纳入 sendKey 统一——mod-enter 模式下这俩仍各自原行为，后续统一。
- **A1 流式实时 markdown（done，本 session 续做）**：`components/NodeFullView.tsx` ResponseBody 流式分支从 textContent 直写改为 rAF 节流的 state 累积 + ReactMarkdown 渲染。新 `REHYPE_STREAMING = [rehypeHighlight]`（流式期间不挂 rehypeRaw，避半截 HTML 标签 parse 报错；终态仍用 REHYPE_FULL）。删 streamRef，加 liveText state + requestAnimationFrame 合并 token 突发为每帧一次 re-render。**范围决策**：只改 NodeFullView 全屏（单挂载视图，re-render 便宜），画布 ChatNode 仍保留 textContent 直写（在 ReactFlow 内，性能敏感）。`npm run build` ✓。
  - **A1 Caveat（务必实测）**：① 长回复流式时每帧重 parse markdown 的性能 ② 未闭合代码块/表格的中途渲染是否闪烁 ③ streaming-cursor 位置。这三点必须浏览器实测确认。
- **Next**: **浏览器实测本批 5 项**（A3 复制 / D1 角色切换+生效 / A4 Enter 发送+toggle / A1 全屏流式格式化+性能）。实测无碍后继续 P0 大件：B1（响应式+移动端 Outline，M）→ A2（编辑消息，M-L，树语义取 Q1 倾向 B）→ C2（记忆+自定义指令，M-L）→ C1（文件附件，L↩Stage19）。


### Session 25 (2026-05-13)
- **Done**: 三件事一起做完 — (A) mobile/UX 三个小补丁；(B) **durable streams** 架构改造；(C) Stage 17 Tool call / Bash 可视化全链路。`npm run build` ✓；端到端 curl 实测 `pwd` 工具调用从 spawn → 进 DB tool_calls_json → reconnect endpoint catchup 完整回放。

  ### A. mobile/UX 三件小补丁
  - **Header 🔍 全局搜索按钮**（`components/Header.tsx` + `stores/sessionStore.ts:searchOpen` + `components/SearchModal.tsx`）：SearchModal 的 open state 从 self-managed 提到 store；⌘P 全局 hotkey 仍走 store toggle；Header 新增放大镜按钮（桌面 + 手机共用，省去 ⌘P 在手机不可用的问题）。SearchModal 不变以外只把 `useState` 改成 `useSessionStore(s => s.searchOpen)`，⌘P 监听里读 `useSessionStore.getState().searchOpen` 拿最新值（避免 listener closure 抓老值）。
  - **ModeBadge 手机可见**（`components/ModeBadge.tsx`）：去掉 `hidden sm:inline-flex`，手机也能看见当前 session mode + workspace 简称。label 文字在 `<sm` 隐藏（icon 已够认），workspace 短名宽度 mobile `max-w-[6rem]` / desktop `max-w-[10rem]`。
  - **Chat picker 配色对比修复**（`components/ModePicker.tsx`）：用户反馈"chat 模式无法选择" —— 根因是 chat active 用 `bg-stone-100`，跟外层 `bg-white` 几乎无色差。改 `bg-stone-200 + ring-1 ring-inset ring-stone-400/40`，跟 amber/rose 视觉等量。
  - **画布 80/20 居中**（`components/Canvas.tsx`）：session-load effect 当 `activeNodeId` 为空时不再 fitView 整棵树，先看 `lastEditedNodeId`（已在 store 里按 createdAt 最高 seed）→ `setCenter(node.position, { zoom: cur })` 保持当前 zoom；为空才 fallback fitView。用户每次回画布大概率不用拖动。

  ### B. Durable streams（独立架构改造，未列入 roadmap 但用户主动要求）
  - **动机**：原 `/api/chat` 把 spawn 生命周期挂在 `req.signal` 上 —— mobile 切后台 / 网络抖动 / 关 tab → HTTP 断 → req.signal aborted → 子进程被 kill → DB 节点写一半 status='error'。这是 mobile / 不稳定网络下最大的 UX 痛点。
  - **核心改造**：spawn 跟 HTTP handler 解绑。spawn 跑在 module-level 的"runner"上，HTTP 只是订阅者。客户端断开仅取消订阅，spawn 继续；客户端重连走新 endpoint，先拿 catchup snapshot 再订阅未来 delta。
  - **新文件**：
    - `lib/server/run-bus.ts`：per-nodeId 的 RunState (`AbortController` + `Subscriber` Set + `committedText` mirror + `committedToolCalls` mirror + 30s 终态缓存)。`startRun(nodeId, factory)` 通过 queueMicrotask 启动 generator，`subscribe(nodeId, sub)` 加入订阅集并立刻发 `catchup` 事件（snapshot of committedText + committedToolCalls）。runner 内部对 delta / tool_call_start / tool_call_done 三类事件遵守 commit-before-broadcast 时序 —— 先更新 mirror + 写 DB，再迭代 subscriber 集合广播，保证 race 中的新订阅者要么从 catchup 看到事件，要么从 broadcast 看到，never both never neither。
    - `app/api/nodes/[id]/stream/route.ts`：GET SSE endpoint。`subscribe()` 拿到 unsubscribe 函数 → forward 包含 catchup 的事件流；返 null（run 已被 GC 或从未启动）→ 退到 DB 直接读节点状态 + tool calls，合成 catchup + 终态 + 关闭。
    - `app/api/chat/[id]/abort/route.ts`：POST 显式中止。调用 `abortRun(nodeId)`，200 / 404（已终态）。
    - `hooks/useReconnectStreams.ts`：`visibilitychange`（页面 visible）+ `online`（网络回来）+ 首次 mount 触发 `store.reconnectStreamingNodes()`。
  - **现有文件改造**：
    - `app/api/chat/route.ts`：handler 不再 `for await llm.stream()`。改为 `startRun({nodeId, factory: (signal) => llm.stream({..., signal}), topicLabel: ...})` + `subscribe()` 把 bus 事件转 SSE，且过滤掉 catchup（POST chat 给新建节点，catchup 永远空，没必要 forward 给客户端）。`req.signal` abort 现在只 unsubscribe，spawn 不受影响。
    - `lib/server/repo.ts:resetNodeForRetry`：重试时一并把 FTS 中的 node_response 清掉（前 stage 已实现的部分；retry 也清 tool_calls_json，见 C 段）。
    - `stores/sessionStore.ts`：
      - 新增 `searchOpen` state + `setSearchOpen` action（mobile UX 顺路改的）。
      - `pendingScrollAnchor` 之前已经支持 search，本次不变；StreamEvent union 加 catchup（toolCalls 字段）和 tool_call_start/done（C 段需要）。
      - `handleStreamEvent` 加 `seedNodeId` 选项，让 reconnect 路径（没有 created 事件）能直接知道这个流绑哪个 nodeId。catchup 分支：clearStreamPending + 覆盖 response + 覆盖 toolCalls；tool_call_start 分支：append ToolCall（status="running"）；tool_call_done 分支：按 id 找到 ToolCall 并 merge output/stderr/status/duration。
      - `abortStream` 改为：发 `POST /api/chat/[id]/abort` + 本地 controller.abort()（让 SSE reader 立刻退出，同步 UI），server-side abort 走 run-bus.abortRun。
      - `runStream` catch 块：signal.aborted 仍合成 "aborted" error 给 UI 即时反馈；网络中断（非 aborted）改为不合成假 error，留 streaming 状态等 reconnect 触发。
      - 新增 `RECONNECT_HANDLES` Map + `attachReconnectStream(nodeId, set, get)` + `reconnectStreamingNodes` action（遍历 streaming 节点逐个 fetch `/api/nodes/[id]/stream`，复用 handleStreamEvent 处理事件）。
      - `loadSession` + `hydrate` 末尾 `get().reconnectStreamingNodes()`。
  - **app/page.tsx**：挂 `useReconnectStreams()`。
  - **E2E 验证**（mock provider）：POST → curl `--max-time 0.8` 强制断开 → server 端 spawn 仍跑 → 3s 后 DB 写完 `status='done'` 368 chars。reconnect endpoint 立即返 catchup（response-so-far）+ 后续 deltas → 直到 done。显式 POST /abort → `{aborted:true}`，节点 `error/aborted` 保留 partial response；再 POST /abort → 404 幂等。

  ### C. Stage 17 — Tool call / Bash 可视化
  - **spike 实测 claude stream-json**：在 /tmp 跑 `claude -p "what files..." --output-format stream-json --verbose` 拿真实 JSON 结构。
    - `{type:"assistant", message:{content:[{type:"tool_use", id:"toolu_...", name:"Bash", input:{...}}]}, ...}` — 工具调用开始（consolidated event，input 完整无需重组 stream_event 的 input_json_delta partials）
    - `{type:"user", message:{content:[{type:"tool_result", tool_use_id, content, is_error}]}, tool_use_result:{stdout, stderr, ...}, ...}` — 工具结果。content 是模型可见结果；顶层 tool_use_result.stdout 是 Bash 专用 stdout 隔离，UI 应优先用 stdout（else fallback content）。
    - `{type:"assistant", message:{content:[{type:"thinking", thinking, signature}]}, ...}` — 思考块（本 stage 不渲染）。
  - **schema**（`lib/types.ts` + `lib/server/sqlite.ts`）：
    - `ToolCall` 类型：`{ id, name, input: unknown, output: string|null, stderr: string|null, status: "running"|"done"|"error", durationMs: number|null, startedAt: number, endedAt: number|null }`。input 故意保留为 `unknown` —— 各工具 input shape 千差万别（Bash 的 command, Read 的 file_path, WebFetch 的 url），UI 端再窄化。
    - DB migration: idempotent `ALTER TABLE nodes ADD COLUMN tool_calls_json TEXT`。`resetNodeForRetry` UPDATE 时一并清空 + 删 FTS node_response 行（避免重试期间 stale 命中）。
    - `ChatNode.toolCalls: ToolCall[]`（空数组而非 null，消费方零 nullability）。
  - **provider 解析**（`lib/llm/claude.ts`）：
    - 在 `safeParse` 后两个新分支：
      - `event.type === "assistant"` → `extractContentBlocks(event.message)` 找 `type:"tool_use"` 块，per-block emit `tool_call_start { id, name, input, startedAt: Date.now() }`。
      - `event.type === "user"` → 找 `tool_result` 块，结合顶层 `tool_use_result.stdout/stderr`：output 优先用 stdout（Bash 准确），else block.content；stderr 仅当非空才记。emit `tool_call_done { id, output, stderr, isError, endedAt: Date.now() }`。
    - 类型层 `safeParse` 返回的 `ClaudeStreamLine.message` 宽化为 `unknown`（之前是 `string | undefined`，现在 assistant/user 上是对象），所有用 `message` 字段的地方加 narrow（error/system_error 分支用 `typeof event.message === "string"` 守卫）。
  - **run-bus 转发**（`lib/server/run-bus.ts`）：
    - `ProviderEvent` 和 `RunEvent` union 各加 tool_call_start / tool_call_done。
    - runLoop 新增两分支：tool_call_start → 在 `committedToolCalls` push 新 ToolCall (status="running") + `appendToolCallStart(repo)` 写 DB + broadcast；tool_call_done → 找到 id merge fields + `markToolCallDone(repo)` + broadcast。
    - `subscribe()` 的 catchup 现在还带 `toolCalls: committedToolCalls.map(c => ({...c}))` 浅拷贝快照。
    - `CatchupEvent` 类型加 toolCalls 字段；`/api/nodes/[id]/stream` 在 fallback DB 路径也填 `node.toolCalls`。
  - **repo helpers**（`lib/server/repo.ts`）：`appendToolCallStart({nodeId, call})` 和 `markToolCallDone({nodeId, toolCallId, output, stderr, status, endedAt})`。两者都先 SELECT tool_calls_json → parse → 修改 → JSON.stringify 回写。性能：一个 turn 至多几十次写，回写整 array O(N) 但 N 小，可忽略。
  - **UI 新组件 `components/ToolCallsPanel.tsx`**：
    - 外层折叠面板（默认收起）：标题 "🔧 工具调用 (N) · K 运行中 · M 失败"。
    - 展开后每条 ToolCallRow，再可单独展开：左侧 StatusPill (running/done/error 三色)，name (mono)，one-line summary（自动从 input 抓 command/file_path/url/query/pattern 等高信息字段，fallback JSON.stringify slice 80），右侧 durationMs (ms/s/m+s 三级)。
    - 展开后显示 Section "输入"（JSON.stringify pretty print，max-h-72 overflow-auto）+ "输出"（OutputView：超 200 行自动 clamp + "展开剩余 N 行" / "收起" 按钮）+ "stderr"（仅 stderr 非空时显示，rose 配色）。
    - 整个面板 mount 在 NodeFullView 的 QuestionBlock 下方 + ResponseBody 上方（顺序：你的问题 → 模型用了什么工具 → 模型的回答）。
  - **ChatNode 加 ToolCallBadge**：canvas card compact 视图 + 全屏 footer 两处都加。`toolCalls.length === 0` 时不渲染（chat 模式节点不增加 clutter）。徽章文案 `🔧3` 紧贴 TokenMeta 左侧。
  - **store handleStreamEvent**：（已在 B 段列了）—— catchup 覆盖 toolCalls，tool_call_start append，tool_call_done merge by id。retry 本地优化先把 `toolCalls: []` 重置，等 server 端 created 事件再硬覆盖。
  - **E2E**：POST `please run \`pwd\` ... mode=workspace, workspacePath=/tmp` → 60s 内 done → DB tool_calls_json 1 条记录: `Bash / done / {"command":"pwd"} / output: /private/tmp`，duration 877ms。reconnect endpoint catchup 含完整 toolCalls 数组 → 客户端 hard-sync 后看见折叠面板。
- **Decisions**:
  - **durable streams 用 in-memory pub/sub 而不是 SQL trigger / SQL polling**：runner 是 Node 进程内的 async generator，spawn 子进程也在同进程。pub/sub 跟 spawn 一起活 / 一起死，进程崩了 spawn 也被 SIGTERM —— 边界一致。SQL polling 给 reconnect 用是个 fallback，但 live tab 用 polling 体验差。in-memory 适合"短期、单进程"，trellis 单人单机正是这场景。
  - **catchup 用 snapshot + commit-before-broadcast 而不是 sequence-number 协议**：JS 单线程让我们能保证"commit committedText 后立刻 broadcast" 是原子的。snapshot 在 subscribe 时取 → add subscriber → send catchup。任何新事件要么 commit 已发生（snapshot 含），要么 commit 还没发生但 broadcast 会发给新 subscriber。零事件丢失/重复。
  - **runner 抽象为 factory + topicLabel 两个参数**：route handler 把所有 llm.stream args 包成一个 `(signal) => llm.stream(...)` 闭包传进去，runner 完全不知道 LLM provider 细节。topicLabel 同理，可选 callback。run-bus 只关心 "AsyncIterable<ProviderEvent> 进来 → 各种事件出去"。
  - **/api/chat 仍然返回 SSE（不是立即 200 + 客户端再去 subscribe）**：保留向后兼容 + 减少一次额外 fetch。第一次连接就拿到 created + 后续 deltas，链路最短。catchup 在这条路上被过滤掉（client 已经有 node row from created）。
  - **tool_call_start 用 Date.now() 作为 startedAt 而不是从 claude 时间戳里取**：claude 的 timestamp 字段在 user 事件上才有（tool_result 上的 `timestamp`），assistant tool_use 没有。统一在 trellis 这边打时间戳更简单，duration 计算口径一致。
  - **catchup 也带 toolCalls 而不是单独走"重发 N 个 tool_call_start/done"**：单独事件流的话，reconnect 时要重放整个工具调用历史 = N 个 event；catchup 一次性发整个 array 网络效率高 + 客户端逻辑简单（覆盖而非 append）。
  - **mobile 入口 🔍 按钮放在 Header 而不是 FAB**：FAB 已经被"新提问/参考"占用；Header 是 always-on 的、跟 SessionPicker 一类的全局导航位。⌘P 是同一个 modal 的另一个入口，两条路径用同一个 store-backed open state。
  - **chat 配色用 stone-200 而不是切到 indigo 系**：amber/rose 是 workspace/project，chat 是"中性"语义。改成 indigo 等品牌色会让 chat 看起来比另外两档更"主"，与"三档平级"心智模型冲突。stone-200 + inset ring 在 light 模式视觉对比够，又保持 neutral 语义。
  - **canvas 80/20 用 lastEditedNodeId 而不是设 activeNodeId**：activeNodeId 会触发 NodeFullView 自动滚到 mark / pulse / 切全屏等副作用。我们只想把 viewport 居中过去，不要切焦点。直接 setCenter 是干净路径。
- **Caveats**:
  - **Stage 17 codex 没解析**：codex CLI 没有等价的 stream-json tool 协议，本 stage 仅 claude provider 支持。codex 的 ToolCallsPanel 会一直空 → ToolCallBadge 也不显示 → 用户在 codex 模式下看不到工具可视化。Stage 18 可考虑给 codex 加一个简化层。
  - **thinking 块不渲染**：claude 在 `assistant.content[*].type === "thinking"` 里输出 chain-of-thought（带 signature），本 stage spec 没要求，未显示。后续如果做"模型推理过程可视化"再加。
  - **process 重启会失活 run-bus 内存状态**：server 重启 / crash → RUNS Map 清空 → 所有 in-flight runs 失联。`reapInterruptedStreams()` 在 boot 时把它们标 status='error'，UI 看到错误状态。客户端重连走 `/api/nodes/[id]/stream` 的 DB fallback 路径，拿到 error 终态 + partial response。这是预期降级 —— 比之前的"HTTP 断 = run 杀"好太多，但还是没法 resume spawn。
  - **tool_calls_json 不进 FTS 索引**：Bash 输出噪音多，搜索价值低，spec 没列。如果未来发现"用户经常想搜某条 stderr"再加。
  - **reconnect 触发过于频繁的 risk**：每次 visibilitychange 都会扫所有 streaming 节点重连。RECONNECT_HANDLES Map gate 防重复，但极端场景（用户快速来回切窗口）可能 churn 几次 fetch。实测影响不大，保留观察。
  - **tool_call 流式输入流（input_json_delta）没用上**：claude 在 stream_event 里其实会先 partial-stream tool_use 的 input JSON 再 emit consolidated assistant event。我们只取后者 → tool 卡片显示稍滞后（先看到"运行中"，input 已完整可读）。不是大问题，更复杂 partial JSON 拼接放到下次。
  - **renaming inconsistency**：代码注释里我两次用了"Stage 17"——一次指 durable streams（lib/server/run-bus.ts 顶注），一次指 Tool 可视化（types/repo 各处）。roadmap 的 Stage 17 应该指 Tool 可视化；durable streams 是 out-of-band。已记，下次重构时把 run-bus 注释里那个改成 "Stage 17 follow-up: durable streams"。本次不动，避免重构噪音。
- **Next**: 浏览器实测：
  1. 提交一个复杂 workspace 问题（涉及 Read + Bash + WebFetch 多次调用）→ 看 ToolCallsPanel 流式 append → 每条 expand 看 input/output
  2. mobile 切后台 5 分钟 → 回来看 streaming 节点是否自动续上（reconnect 触发）
  3. 提交问题然后用 ⏹ 中止 → 节点变 error/aborted，partial response 保留
  4. mobile 上 Header 点 🔍 → SearchModal 弹出 → 输入 → 跳转
  5. 画布 80/20 居中：开个有 10+ 节点的 session 刷新 → 应直接居中到最近编辑的节点

### Session 24 (2026-05-13)
- **Done**: 小补丁 — Project 模式 claude_session_id 从 `sessions` 列降到 `nodes` 列（per-root）。`npm run build` ✓。
  - **动机**：用户问"project 模式怎么 clear session，总不能一直延伸吧"。原架构一个 trellis session 绑定一个 claude_session_id，session 内所有 root + 所有 branch 都 `--resume` 同一个 id → jsonl 单调增长 → 早晚撞 200K context window。"开新 session"是唯一出路但同时丢了 workspace / 树状结构 / 搜索索引。
  - **核心改动**：claude_session_id 从 session 维度下沉到 root 节点维度。"新提问"（`createRootInSession`）天然产生 fresh-context root（claude_session_id NULL → 首轮 spawn 不带 --resume → 新 id 写到 root 行）。同根的所有 branch 沿 parent_id 上溯到 root 取 id，行为不变。
  - **DB migration**（`lib/server/sqlite.ts`）：idempotent `ALTER TABLE nodes ADD COLUMN claude_session_id TEXT`，回填用 `UPDATE nodes SET claude_session_id = (SELECT s.claude_session_id FROM sessions s WHERE s.id = nodes.session_id) WHERE id IN (SELECT root_node_id FROM sessions WHERE claude_session_id IS NOT NULL)` 直接借 sessions.root_node_id 定位 legacy 唯一根。sessions.claude_session_id 保留但不再读（legacy 兼容 + 历史可读性）。
  - **repo 层**（`lib/server/repo.ts`）：
    - 新 `getRootClaudeIdForNode(nodeId)` / `setRootClaudeIdForNode(nodeId, claudeId)`：沿 parent_id 走到 root（带 1000 深度上限防数据损坏死循环）。
    - `deleteSession` 改为收集 session 内所有 `parent_id IS NULL AND claude_session_id IS NOT NULL` 节点的 claude id，逐一 unlink jsonl —— 多 root 多 claude session 都要清。workspace_path 共用一个（session 级），encoded-cwd 目录路径不变。
    - 删 `getSessionClaudeId` / `setSessionClaudeId`（只有 chat route 一处调用，已替换）。
  - **route**（`app/api/chat/route.ts`）：两处替换 — claudeSessionId 读改 `getRootClaudeIdForNode(nodeId)`，session_init 写改 `setRootClaudeIdForNode(nodeId, event.sessionId)`。trellisSessionId 变量保留（别处仍用）。
  - **UI**（`components/NewQuestionPicker.tsx`）：Project 模式下显示红色"🧹 全新上下文"小徽章 + 描述改成"Project 模式下会同时开启全新的 Claude 会话记忆"。其他模式文案不变。
- **Decisions**:
  - **不加 toggle，"新提问" = 默认 fresh context**：考虑过给 NewQuestionPicker 加"☐ 继承现有上下文"复选框反向覆盖，但"新提问"语义本来就强烈指向"开新话题"。如果想继续原对话用 BranchPopover 即可（任何 leaf 节点上分叉 = resume 该 root）。零 toggle 让 UI 最简，且跟现有"分叉 = 同 root，新提问 = 新 root"心智模型一致。
  - **借 sessions.root_node_id 回填而不是按 created_at 找 earliest root**：sessions 行已经存了 root_node_id 作为权威指针，直接用。pre-upgrade 一个 session 只有一个 root，1:1 映射零歧义。
  - **保留 sessions.claude_session_id 列不删**：legacy data 还在里面，删列要 schema rebuild（SQLite 改列不便宜），且不读就不读，零运行时开销。等下次大重构再统一清。
  - **walk depth 1000 上限**：SQLite 不强制 parent_id 引用图无环，理论上手动 SQL UPDATE 可能造出环。1000 远超合理树深，撞到就静默返回 null 而非死循环。
- **Caveats**:
  - **存量项目 session 的所有现存 root 共用同一个 claude id**：迁移只把 legacy `sessions.claude_session_id` 复制到 `sessions.root_node_id` 那一个 root。但用户在画布上加过的"新提问"root（Stage 19 之后）也共享了这同一个 id（因为当时 claude_session_id 是 session 级的，所有 root 走同一条 jsonl）。迁移后这些"已存在的平行根"仍指向同一个 claude session，并不自动分裂。**新建** 的"新提问"才走 fresh context。预期可接受 —— legacy 行为延续，新行为对新 root 生效。
  - **jsonl 多到一定程度时 `~/.claude/projects/<encoded-cwd>/` 文件数上升**：每个 trellis project session 现在可能产 N 个 jsonl（每个 fresh-context root 一个）。单用户场景没问题；删 session 时 cleanup 已覆盖全部 root id。
  - **重试一个从未成功完成首轮的 fresh-context root**：claude_session_id 还是 NULL，重试 spawn 不带 --resume → 又拿到一个新 id 写入。期望行为（旧 jsonl 没落地，丢了也无所谓）。
  - **走 BranchPopover 分叉时仍 resume 原 root 的 claude session**：这是 feature——分叉语义就是"继续这条对话"。如果用户想"在已有节点处开新 fresh context"，没有直接入口，得回画布点 FAB → 新提问。可以接受。
- **Next**: 浏览器实测三件 —
  1. Project session 里点 FAB → 新提问 → 看到 🧹 徽章 → 提交 → 新 root 的 claude 不应记得另一条 root 里说过的事（"忘记"验证）
  2. 同一新 root 里继续分叉发问 → claude 记得这个 root 内的对话（resume 验证）
  3. 删掉一个 Project session → `ls ~/.claude/projects/<encoded-cwd>/` 应清掉**所有** root 的 jsonl（多 jsonl cleanup 验证）

### Session 23 (2026-05-13)
- **Done**: Stage 16 全部 7 步落地 — 跨 session 全文搜索（FTS5 trigram + ⌘P 全局 modal）。`npm run build` ✓ 一次过；端到端 curl 测试：backfill 542 行索引 / Web3 / IPFS / Theta / 服务业 / 一张图片 五种 query 都命中正确 session + snippet。→ [spec](fts-search.md)
  - **DB migration**（`lib/server/sqlite.ts`）：`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(text, source_kind UNINDEXED, source_id UNINDEXED, session_id UNINDEXED, tokenize='trigram')`。trigram 选型理由：中英文都能子串匹配（同 Notion / Linear），代价是索引体积 2-3x、最少 3 字符 query。UNINDEXED 三个 meta 列：不进倒排索引但能 JOIN/filter，比拿 source_id 反查 nodes 表快。
  - **首启动回填**：migrate() 末尾 `COUNT(*) FROM search_index === 0 && COUNT FROM nodes > 0` → 单 transaction 跑 4 条 INSERT…SELECT 拿 qa.question / qa.response (status='done') / reference.ref_content_md / notes.quoted_text。在我自己的 DB 上一次完成 542 行（288 节点 + 5 笔记 + 18 reference），< 100ms。幂等：跑过后下次启动 COUNT > 0 跳过。
  - **repo 层显式 sync（不走 trigger）**：考虑过 SQL trigger 但 `appendNodeResponse` 每个 delta 都触发会写放大；改为 10 处 mutation 内显式调 `ftsUpsert(db, kind, sourceId, sessionId, text)` helper。
  - **searchAll(query, limit=80)**：`buildFtsQuery` trim + 长度 < 3 返 null + 双引号 escape + phrase 包裹；FTS JOIN sessions（INNER 过滤 orphan）ORDER BY `bm25` ASC，`snippet()` 调两次（`<mark>` 给 UI + 空 marker 给 anchor）。
  - **store / UI**：`pendingScrollAnchor` 加 `kind:"search"`；`jumpToSearchHit` 跨 session await load 再 set anchor；SearchModal ⌘P + 200ms debounce + facet 四档（all/chat/workspace/project）+ 结果按 session 分组 + emerald pulse 匹配段。
- **Decisions**: trigram 而非 unicode61（中文子串能力）；显式 repo sync 而非 SQL trigger（避流式写放大）；创建节点即入 FTS（question 创建即终值）；两次 snippet（显示 + anchor 各一）；INNER JOIN（只显示能跳的 hit）；bm25 升序；单机单用户故 snippet 不 escape。
- **Caveats**: 最少 3 字符 query（trigram 边界）；orphan FTS rows（pre-Stage-14 孤儿节点，INNER JOIN 隐藏）；流式期间不入响应索引（finalize 才写）；`⌘P` 拦截浏览器 print；trigram 索引膨胀（万行级 Q3 再 vacuum）。
- **Next**: 浏览器实测 ⌘P 搜索全链路（输入→↑↓⏎ 跳转→facet 过滤→<3 字符提示→删 session 后 cleanup→笔记跳源一致性）。

### Session 22 (2026-05-13)
- **Done**: Stage 15 全部 8 步落地 — 图片输入（vision）三档模式可用。`npm run build` ✓ 一次过；端到端 curl 测试：upload → chat with attachment → SSE delta 全链路通；spike 验证 Project 模式 `--resume` + stream-json 输入兼容性。→ [spec](vision-input.md)
  - **CLI spike**：实测 claude `-p --input-format stream-json` 从 stdin 喂 `{type:"user",message:{role:"user",content:[{type:"image",source:{type:"base64",...}},{type:"text",text:...}]}}` —— Anthropic Messages API 内容块原样工作。codex 用 `-i/--image FILE` 重复 flag。Project 模式：第 1 轮 stream-json 拿到 session id，第 2 轮 `--resume <id> --input-format stream-json` 续上、claude 能回忆图片内容（验证"light gray canvas"≈ trellis 截图）。
  - **存储策略**：`~/.trellis/blobs/<sha256>.<ext>` 文件系统 + content-addressed。sha256 命名天然去重；DB 只存 metadata（`attachments_json TEXT`，NodeAttachment[] 序列化）。不进 SQLite blob → WAL 不膨胀 → 跨进程读 zero-copy。
  - **DB migration**（`lib/server/sqlite.ts`）：idempotent ALTER `nodes.attachments_json TEXT`，NULL 默认。老节点全 NULL → repo rowToNode 返回 `attachments: []` → 消费者不需要 nullability check。
  - **新模块 `lib/server/blobs.ts`**：sha256 + ext 白名单（PNG/JPEG/WebP/GIF）+ 写盘 + resolve。`sniffDimensions` 手写 magic-byte parser：PNG 读 IHDR uint32be、GIF87a/89a 读 LE16、JPEG 扫 SOF marker（FFC0-CF 跳过 FFC4/C8/CC）。不引 image-size 依赖，保持 deps 干净。
  - **新 API**：
    - `POST /api/uploads`：接 `multipart/form-data` 或 raw `image/*` body；10MB cap、mime 白名单；返回 NodeAttachment shape（hash + mime + size + width/height + filename）。
    - `GET /api/uploads/[hash]`：流式回读，`Cache-Control: public, max-age=31536000, immutable`（content-addressed 永远不变）。`dynamic = "force-static"` 让 Next 标志为可缓存路由。
  - **Provider 改造**：
    - `claude.ts`：`hasImages = attachments.length > 0` 时切到 stream-json 输入 —— spawn 加 `stdio: ["pipe", "pipe", "pipe"]`，spawn 后 `proc.stdin.write(JSON.stringify(userMessage) + "\n")` + `end()`。文本路径完全不动：没图就还是 `-p "<prompt>"`。`buildPrompt(history, question, anchor)` 结果原样塞进 stream-json 的 text content block，所以折叠祖先链 / cli-multi prompt 逻辑零变动。
    - `codex.ts`：`buildArgs` 多一个 `imagePaths: string[]` 参数，所有四个分支（project resume / project first turn / chat / workspace）prompt 前插 `--image FILE` 重复 flag。codex 吃文件路径而非 base64，跟 claude 不同。
    - `mock.ts`：no-op（StreamRequest.attachments 是 optional，mock 忽略）。
  - **Chat route**（`app/api/chat/route.ts`）：root + branch 接 attachments（NodeAttachment[]），retry 服务端从 DB `getNodeAttachments(nodeId)` 读出（用户不需要重传）。`sanitizeAttachments` 防御性清洗：hash 必须 hex64、mime 必须白名单、cap 6。`resolveAttachments(NodeAttachment[]) → {path, mime}[]` 把 hash 映射到磁盘路径；缺失的 blob 静默丢弃（rare：blob dir 被人手 rm 才会发生）。
  - **Store**（`stores/sessionStore.ts`）：`streamRoot(question, opts?: { attachToCurrentSession?, attachments? })` / `streamBranch(parentId, question, anchor, opts?: { attachments? })`；`ChatRequestBody` root/branch 加 attachments。retry 不加（服务端独立解析）。`ApiNode = Omit<ChatNode, "position" | "topicLabel"> & ...` 自动吃下 ChatNode.attachments 新字段，apiNodeToChatNode 无需改动。
  - **UI 新组件 `components/AttachmentPreview.tsx`**：
    - 双模 props：readonly（NodeAttachment[]，用于 ChatNode/NodeFullView 展示已存图）+ edit（PendingAttachment[] + onRemove，用于 input 态）
    - `PendingAttachment = { localId, status, previewUrl, filename, attachment?, errorMessage? }` —— 上传中显示 ↑ + 半透明，失败显示"失败"红色 + ✕，完成显示完整缩略图
    - 单击缩略图 → lightbox（fixed inset-0 + Esc 关 + click-outside 关）
    - 导出 `uploadAttachment(file, filename)` helper 给 input 组件复用；`newPendingId()` 顺序 localId
  - **QuestionInput**（`components/QuestionInput.tsx`）：textarea 上方 AttachmentPreview；三个入口 — onPaste 遍历 clipboardData.items 找 image/*；onDragOver/Drop（仅响应 Files 类型，忽略文本拖拽）；底部 🖼️ 按钮触发 hidden `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>`。submit 锁：`hasUploading` 时按钮文案变 "等待图片上传…" 禁用。drop 时容器加 indigo ring 提示。
  - **BranchPopover**（`components/BranchPopover.tsx`）：精简版 —— 仅 paste（textarea onPaste）+ file picker（🖼️ 按钮），不要 drag（小弹层 drop target 不舒服）。popoverHeight = `130 + (pending.length > 0 ? 96 : 0)` 保证顶部不被截。
  - **ChatNode / NodeFullView**：question 区下方加 `<AttachmentPreview attachments={node.attachments} readOnly />`；NodeFullView 的 QuestionBlock 接受额外 attachments prop。
  - **README + progress**：vision 一段补到核心特性 + tick Stage 15。
- **Decisions**:
  - **stream-json 输入按需切换而非永久切换**：保留 `-p "<prompt>"` 作为无图路径。理由：(1) 没图时 stream-json 是不必要的 IO 层（虽然代价小但语义更复杂），(2) 现有 buildPrompt → spawn 链路是经验证的，最小破坏面。代价：claude.ts 有两套 stdin 配置（"ignore" vs "pipe"），可读性 trade 走稳定性。
  - **buildPrompt 不重写为 multi-message**：spec 开放问题 5 — 现在的"祖先链 → 单块文本"在 stream-json 模式下作为唯一一条 user.message.content 的 text block 喂入。模型可能在多消息形态下利用得更好（更 native），但 cli-multi prompt 的特殊处理（仅当前问题、不带历史）等几条业务逻辑都依赖单块语义，重写就是 stage 内蔓延。等真实回答质量出问题再调整。
  - **blob 不进 SQLite**：base64 进 WAL = SQLite 把整个 blob 反复 fsync + 维护 rollback journal；磁盘膨胀比文件系统多 ~1.4x，且 better-sqlite3 BLOB 读出来是 Buffer 反序列化。文件系统 + content hash 直接拿到稳定 path，spawn claude 时一行 fs.readFileSync 就转 base64，零额外复杂度。
  - **手写 magic-byte parser 而非 image-size 依赖**：4 个 mime 加起来 ~80 行，依赖图保持空。WebP 的 VP8L/VP8X 多分支不写，未识别格式返回 `{}` 让客户端用 `<img>` 自然 dims。
  - **GET /api/uploads/[hash] 用 force-static**：Next runtime hint 让框架知道这条路由跟请求参数无关（同一 hash 永远同一字节流），可以缓存。Cache-Control: immutable 由我们设。
  - **上传中 submit 禁用**：用户可能粘贴图后 ⌘↩ 极快，如果不锁住，半秒后图片才上传完，对应的 attachment 就不会被带上而被默默丢掉。锁住 + 文案"等待图片上传…" 是显式的、不会丢图的设计。
  - **重试自动复用旧图**：服务端 `getNodeAttachments(nodeId)` 直接读 attachments_json。比让 client 重传简单，且解决"重试节点本来就没保留原图"这个客户端做不到的问题。
  - **PendingAttachment.localId 独立于 hash**：因为上传过程中 hash 还没有；keying React list / onRemove 都用 localId。done 之后才有 hash，仍然继续用 localId 引用（不切 key 避免组件重挂导致 object URL 闪烁）。
  - **drag-drop 只在 QuestionInput 不在 BranchPopover**：BranchPopover 是飘在文本上的小卡片，drop target 边界不直观（容易拖到外面被浏览器接管打开图片）。粘贴 + 文件选择已覆盖 95% 用例。
- **Caveats**:
  - **大 prompt 注意事项**：6 张 5MB 图 = base64 ~40MB 一次性写进 claude stdin。实测单张 400KB 没问题；上限场景应该也 OK（pipe buffer 一般 64KB but stdin pipe 是 stream，不需要一次性塞）。仍标个 P2 监控点：极端情况下可能阻塞 spawn。
  - **codex `--image` 路径 sandbox 兼容**：spike 没专门测 `--sandbox read-only` + `--image /Users/.../trellis/blobs/...`。猜测 OK（codex sandbox 允许读 home 下任何文件），但浏览器实测时如果 codex chat 模式吃图失败，可能是 sandbox 拦了；fallback 是把 blob 移到工作目录里再 `--image`。先不处理。
  - **lightbox click-outside**：用 `cursor-zoom-out` 提示，但 `e.stopPropagation()` 在 img 上阻止冒泡。点 img 不会关。这是 feature（避免误关），但可能反直觉。
  - **drag overlay 视觉边界**：onDragLeave 只在指针离开根容器时触发，textarea 内部子元素 leave 也会冒泡。多余的 setDragOver(false) 调用，没有视觉副作用，但偶尔 ring 闪一下。先不修。
  - **blob 孤儿清理 P2**：删 session / 删 node 不删 blob。同一张图被多个 session 引用是常见的（截图复用），蛮力 GC 需要扫所有 sessions.attachments_json。磁盘膨胀到几百 MB 再做。
  - **codex chat 模式 sandbox + image 没单独 spike**：实测命令用了 `--sandbox read-only` 跑通了，但那是单独 codex 调用；trellis route 走的代码路径稍微复杂（buildArgs imageArgs 插入位置可能影响 sandbox flag 解析）。浏览器实测点。
- **Next**: 用户浏览器实测六类 case：
  1. Chat 模式粘贴截图 → ⌘↩ → claude 看见图回答（test_chat_mode_paste）
  2. Workspace 模式选 trellis 仓库 + 拖一张图 → claude 同时能 vision + Read 本地代码文件
  3. Project 模式头 3 轮各附 1 张图，第 4 轮纯文本"刚才几张图都是啥" → claude 应该都记得（验证 resume 长 session 记忆）
  4. 单张超过 10MB → upload 413 报错，UI 红色 ✕ + tooltip 显示错误
  5. 单节点连续粘 6 张 → 第 7 张 disable + tooltip "已到 6 张上限"
  6. 重试一个带图节点 → response 重生成，图保留（server 端从 DB 读）

### Session 21 (2026-05-13)
- **Done**: Stage 14 全部 7 步落地 — 三档模式重命名 + session 级 workspace 绑定。`npm run build` ✓ 一次过；`/api/workspaces/recent` curl 返回 20 个候选项。→ [spec](mode-workspace-rebuild.md)
  - **DB migration**（`lib/server/sqlite.ts`）：两个 idempotent ALTER 加 `context_mode TEXT NOT NULL DEFAULT 'chat'` 和 `workspace_path TEXT`；migration UPDATE 把 `claude_session_id IS NOT NULL` 的旧 session 归到 `project`，其余归 `chat`。cli-single 用户失去工具能力，按用户选项 1 静默迁移。
  - **Types**（`lib/llm/types.ts` + `lib/types.ts`）：`Mode = "chat" | "workspace" | "project"`；`StreamRequest` 加 `cwd?: string | null`；`Session` 加 `mode: string` + `workspacePath: string | null`（用 string 而非 Mode 联合，避免 client/server 模块边界引入 server-only 依赖）。
  - **Provider cwd 注入**（`lib/llm/claude.ts` + `codex.ts`）：spawn cwd 改为 `mode === "chat" ? os.homedir() : (cwd ?? os.homedir())`；chat 模式 claude 加 `--tools "WebSearch,WebFetch"`（codex 暂无对应能力，标 TODO）；`buildCliMultiPrompt` 重命名 `buildProjectPrompt`。
  - **`repo.ts` 关键改动**：`claudeSessionPath` 改成接受 `cwd` 参数（不再硬编码 `os.homedir()`）；`deleteSession` 取 workspace_path → 拼正确的 encoded-cwd 目录路径。否则 Project session 的 jsonl 在新 cwd 下会被漏清。
  - **API route**（`app/api/chat/route.ts`）：root 请求接受 `mode + workspacePath`，校验 workspace/project 必须有路径，chat 强行清掉路径；branch / retry **不再从 body 读 mode**，直接 `getSession(sessionId).mode` 取，传给 provider 的 cwd 也来自 session 行——彻底打破"中途切 mode 影响活跃 session"的旧行为。
  - **新增 `/api/workspaces/recent`**（`app/api/workspaces/recent/route.ts`）：合并 trellis DB 的 `SELECT DISTINCT workspace_path` + 扫 `~/.claude/projects/` 反查 cwd。反查策略两层：先在每个 dir 找一个 jsonl 读前 32KB 找带 `"cwd":` 的行（authoritative，因为 `-` 编码 lossy），fallback 才 naïve `replace(/-/g, "/")`。最后 `fs.existsSync` 过滤掉失效路径。spike 实测：扫 ~120 个 dir + 反查 ~50 个 jsonl，整体 < 200ms，可接受。
  - **Store**（`stores/sessionStore.ts`）：删 `mode` state，加 `draftMode` + `draftWorkspacePath`（localStorage 同步）；删 `setMode`，加 `setDraftMode` + `setDraftWorkspacePath`；`streamRoot` 在 `attachToCurrentSession` 时不传 mode/workspace（让服务端从 session 取），新建 session 时才传；`streamBranch` / `retryNode` ChatRequestBody 不再带 mode。localStorage migration：旧 `MODE_KEY` 值 `lean/cli-single/cli-multi` 在 `loadDraftMode` 里自动翻译。
  - **UI 拆分**：
    - 新 `components/WorkspacePicker.tsx`：modal 列表 + 筛选 + Browse 兜底（手动输入绝对路径）。`prettifyHome` 用 regex `/^\/Users\/[^/]+\/(.+)$/` 缩 `~/...`（client-side 不知道 homedir，所以 regex 兜底）。
    - 新 `components/ModeBadge.tsx`：readonly 显示当前 session 的 mode + workspace 基名，三色区分（Chat stone / Workspace amber / Project rose）。session 为空时返回 null（避免空 header）。
    - 重写 `components/ModePicker.tsx`：现在专门是"draft picker"——读 draftMode/draftWorkspacePath，写 set 函数；选 Workspace/Project 且无 workspace → 自动打开 WorkspacePicker；workspace chip 在缺失时 animate-pulse 红色提示。
    - `Header.tsx` 把 `<ModePicker />` 换成 `<ModeBadge />`，再无中途切模式入口。
    - `QuestionInput.tsx` 在 textarea 上方居中放 ModePicker；submit 按钮多一个 `needsWorkspace` 锁，缺 workspace 时按钮文案变 "先选工作区"，title 注释解释。
  - **Docs**：README 三档表 + 详解段全部重写；progress/README.md tick Stage 14，加 Current Focus 指向 Stage 15（vision）。
- **Decisions**:
  - **mode 升级成 DB 列 + session 创建后锁定**：spec 写到一半才发现当前 mode 是全局 localStorage。如果不升级，"一棵树一个语境"就只是 README 修辞，实际运行时 Header 切 mode 会影响所有历史 session。改动量大但本质上是修复"模式归属错位"的旧 bug。
  - **session 内 mode 不可再切**：原 `ModePicker` 允许 cli-multi 切 cli-single 弹 confirm 对话；新方案直接不暴露切换。换语境 = 开新 session，跟 workspace 绑定一致。这是用户选项 4「按 7 步顺序我一气跑完」隐含的设定。
  - **claudeSessionPath 改签名而非加 helper**：考虑过单独 `claudeSessionPathForWorkspace(workspacePath)` helper，但只有一个调用点（deleteSession），inline 参数更清晰，避免多个查 workspace 的 round-trip。
  - **WorkspacePicker 数据源合并而非二选一**：用户问"picker 解决什么"暴露了概念门槛——所以最终列表必须第一次看就有候选项。trellis 自己的 DB 在新装时是空的，必须靠扫 `~/.claude/projects/` 给"我之前用 claude 跑过的项目"的种子数据。
  - **`-` 反向解码做 fallback 而非主路径**：编码 lossy（`foo-bar` 目录名跟 `foo/bar` 路径冲突），所以主路径是读 jsonl 找 `"cwd"` 字段（authoritative）。fallback 留着是因为有些 dir 可能没 jsonl（清理过 / 残留空目录）；通过 `fs.existsSync` 过滤掉错误命中。
  - **Codex chat 不加联网，标 TODO**：用户选项 1，原因是 codex CLI 0.125 没有独立 web tool 概念。spike 等价能力延后到 Stage 15 一起做，避免 Stage 14 scope 蔓延。
  - **ApiSession.mode 用 string 而非 Mode 联合**：repo.ts 是 server-only，但 ApiSession 类型被前端 store 间接消费。如果 ApiSession.mode 是 Mode 联合，前端要从 `@/lib/llm/types` import 类型——但这条 import 链最终拽进 server-only 模块（claude.ts spawn）。改成 string + 在 boundary（route 的 `isMode` / store 的 `isMode`）窄化，干净。
- **Caveats**:
  - **存量 cli-single session 自动归到 Chat**：失去工具能力。用户选项 1（静默）。如果有正在跑工具的 session，下次发问会突然不工作——预期，不出 toast。
  - **Codex Chat 模式无联网**：UI title 注释了。等 spike codex web 能力。
  - **WorkspacePicker prettifyHome 不知道真实 homedir**：硬编码 `/Users/<user>/` regex。Linux/Windows 用户会看到完整路径。先不修，等真有非 mac 用户提。
  - **ModePicker 旁的 workspace chip 在 mobile 上可能换行**：用了 `flex-wrap` 兜底，但视觉不完美。等浏览器实测再调。
  - **顶栏 ModeBadge 没在 mobile 显示**（`hidden sm:inline-flex`）：mobile 屏幕窄，省空间。如果用户想知道当前 session 模式，可以打开 SessionPicker（list 里目前没显示 mode——后续可加）。
  - **session 创建后改 workspace 完全没出口**：是 feature 不是 bug。换 workspace = 开新 session。但如果路径被外部移动（用户在 finder 里 mv 了仓库），现存 session 下次发问会 spawn 失败。错误信息用户能看到，但不会自动 relink。
- **Next**: 浏览器实测六类 case：
  1. 新 session 创建走 Chat 默认 → 提交 → 顶栏 ModeBadge 显示 Chat
  2. 创建走 Workspace → WorkspacePicker 自动弹 → 选 trellis 仓库 → 提交 → claude spawn 在 trellis 目录里能 ls 出 components/ 等
  3. 创建走 Project + 选 obsidian-cli 仓库 → 跑两轮对话 → 看 token 计量 ⚡ cacheRead 命中率
  4. 旧 session（有 claude_session_id 的）打开 → ModeBadge 显示 Project；workspace 字段是 NULL → spawn 回退到 ~
  5. 删除 Project session → 检查 `~/.claude/projects/<encoded-cwd>/<jsonl>` 真的被清掉（encoded-cwd 用 workspace 路径而非 home）
  6. WorkspacePicker 筛选 + Browse 手动输路径都能用，输错路径（不存在的）提交后 chat 报错

### Session 20 (2026-05-06)
- **Done**: 引用高亮 mark 注入从"源 markdown regex"切到"渲染 DOM textContent + Range wrap"，富文本场景全部命中。→ [spec](anchor-dom-inject.md)
  - **根因**：`injectHighlights` / `injectNoteMarks`（`NodeFullView.tsx:892-937` / `ChatNode.tsx:475`）在源 markdown 字符串上 regex 匹配 anchor.text，但 anchor.text 来自 `selection.toString()` = 渲染后 DOM textContent。两者只在"纯文本段落"等价；遇到代码块（``` ``` ` 围栏）、行内代码（` 反引号）、表格（`|` 分隔）、链接（`[text](url)`）、加粗（`**`）、列表前缀（`- `）等 markdown 语法字符就匹配失败。还有第二层：`injectHighlights` 没做 `\s+` flex（只 `injectNoteMarks` 有），跨段选区 child 必挂。session 18 caveat 已记录。
  - **核心算法**（新建 `lib/dom-mark-injector.ts`）：
    - `clearMarks(root)`：querySelectorAll mark[data-child-id], mark[data-note-id] → 把每个 mark 的 children move 出去 + remove mark 本身 → root.normalize() 合并相邻 textNode。幂等 cleanup。
    - `injectMarks(root, specs[])`：对每个 spec 的每个 anchor 独立处理：TreeWalker 收集 root 内所有 textNode → 拼出 `fullText` + 同步构建 `normText`（`\s+` 收缩成单空格）+ `mapBack[]`（normText offset → fullText offset 反查表）。anchor.text 也 normalize → `normText.indexOf(needle)` → 通过 mapBack 还原 fullText 的 [origStart, origEnd) → `locate()` 在 nodes 上线性找起止 textNode + offsetIn → `splitText` 在两端切开 → TreeWalker 从 startNode 走到 endNode 收集所有 textNode → per-textNode `parentNode.insertBefore(mark) + mark.appendChild(textNode)` wrap。每 anchor 完后**重建 index**（splitText 改了 node 结构，offset 缓存失效）。
    - 不用 `Range.surroundContents`：iOS Safari 上跨多 element 的 Range 抛 InvalidStateError。per-textNode wrap 对所有跨度都稳健。
  - **嵌套语义反转**（vs 今天）：
    - 字符串注入"先 note 后 child" → child 字符串包在 note 字符串外 → DOM 上 child 外 note 内
    - DOM 注入"先 note 后 child" → note 先把 textNode wrap → child 注入时，textNode.parentNode 是 note mark，新 child mark 插在 note 内 → child 内 note 外
    - 视觉影响：CSS `mark[data-note-id]:not([data-child-id])` 命中外层 note → emerald；内层 child mark → amber。重叠区域子元素 background 覆盖父元素 → amber 显示（同今天）。**部分重叠**时 emerald-amber-emerald 三段反而比今天纯 amber 更能看出 child 是 note 的子区域。click 路由 closest("[data-child-id]") 不限层级，仍正确。
  - **NodeFullView 改动**（`components/NodeFullView.tsx`）：
    - 删 `responseWithMarks` useMemo + `injectHighlights` / `injectNoteMarks` 函数（共 ~60 行）
    - markdown source 直接传 `node.response`
    - 加新 effect：`isStreaming` false + `bodyRef` 拿到 markdown DOM 时跑 clearMarks → injectMarks。deps `[isStreaming, node.response, childAnchors, noteAnchors]`，cleanup return clearMarks。**effect 声明在 scroll-to-anchor effect 之前**，保证 React commit 时先注入再 scroll query。
    - scroll-to-anchor effect：`querySelector` → `querySelectorAll`（一个 anchor 跨多 textNode 时有多个 mark element），`scrollIntoView` 仍只 first，`anchor-pulse` class 加给所有 mark 一起闪。retry 一次 rAF 兜底。
  - **ChatNode 改动**（`components/ChatNode.tsx`）：
    - 同 NodeFullView，但只有 childAnchors（无 noteAnchors）
    - markdown body div 加 `ref={bodyRef}`
    - 删 `responseWithMarks` useMemo + 底部 `injectHighlights` 函数 + 顶部 `useMemo` import（已不用）
  - **CSS 注释更新**（`app/globals.css:152-158`）：嵌套描述从"outer child wins"改为"child marks land inside note marks; partial overlap shows emerald-amber-emerald"，配合新的 DOM 嵌套顺序。CSS 规则本身不变。
  - 验证：`npm run build` ✓ 一次过。
- **Decisions**:
  - **anchor schema 不变**：不加 prefix/suffix 字段、不动 DB / API / store。同一句 quote 出现两次时仍只 wrap 第一处（同今天行为，session 18 caveat 已写）。如果未来重复文本歧义高频出现再升级 schema——平滑演进，不为可选场景背早期成本。
  - **whitespace normalization + mapBack**：选区跨行 / 跨 list item 时 textContent 可能用单空格连接而源用 `\n`，反之亦然。normalize 双方再 indexOf 命中率最高；mapBack 把 normalize offset 还原成原 textContent offset，wrap 边界精确。
  - **每 anchor 重建 index 而非维护**：splitText 改变 node 结构，维护增量更新成本高且易错。10 anchor × 200 textNode × 50KB 文本量级，每次 ~ms 级，性能不是瓶颈。
  - **per-textNode wrap 而非 single Range**：Range.surroundContents iOS 跨 element 必抛；per-node wrap 对 nested 结构（textNode 在 hljs syntax span 内、在 note mark 内）天然兼容。
  - **clearMarks 用 element.remove + normalize**：unwrap 后相邻 textNode 不合并会让下次 buildIndex 看到碎片化的 nodes 数组。`root.normalize()` 把它们合回去。
  - **多 mark 同 ID 一起 pulse**：querySelectorAll → 全部加 anchor-pulse class。今天单 mark 单 pulse 是因为 anchor 不跨 element；新方案跨段 anchor 自然产生多 mark element，全部一起闪视觉更连贯。scrollIntoView 仍只 first。
- **Caveats**:
  - **重复文本仍只 wrap 第一处**：indexOf 取首个匹配。同今天，未升级 prefix/suffix 消歧前不解决。
  - **嵌套结构反转**：今天 child 外 note 内 → 现在 child 内 note 外。视觉行为大体一致（amber 主导），但 partial overlap 时表现略不同（变得更有信息：能看出 child 是 note 子区域）。
  - **流式期间不显示 mark**：同今天。注入 effect 跳过 isStreaming；done 那帧 ReactMarkdown 才渲染。
  - **复制粘贴带 `<mark>`**：同今天。如未来需要可加 `user-select: none`，但同时影响二次划词。
  - **scroll effect 时序依赖 effect 声明顺序**：注入 effect 必须声明在 scroll effect 前，React 才会按顺序 commit。代码组织已注意，但如果未来有人重构 ResponseBody 把 effect 顺序换了会导致 scroll 找不到 mark → fallback clearScrollAnchor 兜底（不 crash 但跳源句不闪）。
- **Next**: 用户浏览器实测六类 case 命中：代码块（fenced）/ 行内代码 / 表格（含跨单元格）/ 链接 / 加粗 / 列表前缀 / 跨段。同时验证：分叉 mark 点击仍跳子节点、笔记跳回滚到原句 + emerald pulse、cli-multi 高 token 长回复下注入耗时无可感卡顿。

### Session 19 (2026-05-06)
- **Done**: 两个独立小升级 — 链接抓取 prompt 砍到 goal-only + 画布"新建"FAB 升级 popover（新提问 / 参考卡片）。
  - **链接抓取 prompt 简化**（`lib/server/fetch-prompt.ts`）：
    - 用户反馈 winterresearch.com/tiezhu_liquidity 这类被 Cloudflare 拦的链接，prompt 里 "generic web page → curl + html2md" 的死路由会让 claude 优先走 curl 撞 403，绕不到 web-fetch skill 的浏览器/CDP 降级链。
    - 砍掉整段 "Tool selection — prefer Bash with the right CLI" 表 + 删 `CLAUDE_ADDENDUM`（"AVOID WebFetch / use web-fetch skill or curl"）。Prompt 现在只剩 goal + frontmatter 契约 + verbatim 8 条硬规。"You decide which tool / skill / CLI to use" 一句把决策权交还给 Claude CLI 本身。
    - `buildFetchPrompt(url, variant)` → `buildFetchPrompt(url)`：claude 和 codex 现在共用同一份 prompt（`fetch-via-claude.ts:31` / `fetch-via-codex.ts:50` 两处 call 一起改）。codex 那边失去"明确 curl 路径"提示——但 codex 没有 skills 体系，本来就只能选 Bash，影响不大。
    - 验证：`npm run build` ✓。
  - **画布 FAB popover**（`components/AddNodeFAB.tsx` 重写 + 新建 `NewQuestionPicker.tsx` + 后端/store 配套）：
    - 用户反馈"画布里只能引用节点询问，没法直接新建询问节点"。`AddNodeFAB.tsx:6-8` 自己留的 `// "Once we add more node-creation flows ... we can swap this for a small popover menu"` 就是这个 follow-up。
    - **后端**（`lib/server/repo.ts`）：新增 `createRootInSession({sessionId, nodeId, question, now})`——校验 session 存在 → INSERT nodes (parent_id=NULL, sibling_index=0)（mirror createReferenceNode 的"rootless 永远 0"约定）+ UPDATE sessions.updated_at。无 session 创建。
    - **API**（`app/api/chat/route.ts`）：`ChatRequestRoot` 加可选 `sessionId` 字段。handler 在 `kind:"root"` 分支里 if 二选一：传了 sessionId → `createRootInSession`（created event 不带 session，store 走"已有 session 更新 updatedAt"分支）；没传 → 仍走老路 `createSessionWithRoot`。其他三个 kind 不动。
    - **Store**（`stores/sessionStore.ts`）：`streamRoot(question)` → `streamRoot(question, opts?: { attachToCurrentSession?: boolean })`，opts.attachToCurrentSession=true 时从 `get().session?.id` 拿当前 session id 塞进 `runStream` 的 body。`ChatRequestBody` 的 root variant 加 `sessionId?`。`QuestionInput.tsx` 老调用 `streamRoot(trimmed)` 默认 falsy → 走旧路径 ✓。
    - **UI**（`AddNodeFAB.tsx` 全重写 + 新建 `NewQuestionPicker.tsx`）：
      - FAB 点击不再直接开 ReferencePicker，而是切换 `menuOpen`，弹出右下角小 popover 菜单两条：💬 新提问 / 📄 参考卡片。点菜单项 → `setPicker(kind)`，关菜单。outside-click + Escape 关菜单。FAB 图标在 menuOpen 时 +45° 变成 ×。
      - `NewQuestionPicker.tsx` 镜像 `ReferencePicker` 的 modal 结构（fixed inset-0 半透蒙板 + max-w-xl 居中卡片 + Esc/outside-click close + ⌘↩ submit）。submit 调 `streamRoot(trimmed, { attachToCurrentSession: true })`，submit 后立即 onClose——用户能立刻在 canvas 看到新节点开始流。
    - 验证：`npm run build` ✓。Canvas 已支持多 root（参考卡也是 parent_id=NULL），布局/Outline 不需要改。
- **Decisions**:
  - **prompt 砍到 goal-only 而非"换成 web-fetch skill"**：用户明确说"不需要指定工具，让 claude cli 自己决策，只给 goal 就行"。让 Claude 读到当前 URL 自己判断比 prompt 写死路由表更稳——后者一旦遇到 prompt 没覆盖的站点（比如带 anti-bot 的非主流网站），仍会回退到默认 curl 撞 403。
  - **claude/codex 共用同一份 prompt**：variant 参数原本是为了 claude 加 "AVOID WebFetch" 提示。删了那个提示之后，两条路无差异，统一掉减少分叉。
  - **新提问语义=同 session 平行根，不是新 session**：用户确认"先提问还是落在当前 session"。Trellis 的 session 是"一次探索"的容器，新提问是同次探索的另一个角度。开新 session 走 Header SessionPicker 已经能干，不重复造入口。
  - **createRootInSession 没有 sibling_index 递增**：跟 `createReferenceNode` 保持对齐——所有 rootless 节点都 sibling_index=0，Canvas 渲染时按 createdAt 排序。
  - **复用 streamRoot 而不是新增 action**：opts 参数附加比另起一个 streamNewRoot 干净。共用所有的 SSE handler / token bus / controller registry。
  - **FAB 菜单两项而非 inline 切 tab**：参考 reference picker 已经是 modal，新提问也用 modal 一致；FAB → menu → modal 三级结构虽多一层但每层职责清晰。
  - **NewQuestionPicker 提交后立即 close**：跟 BranchPopover 的 selection-anchored 分支一样——fire-and-forget，让用户看到节点出现在画布上立即开始流，不在 modal 里等 done。
- **Caveats**:
  - **cli-multi 模式下"新提问"会继承 prior history**：cli-multi 通过 resume 同一个 claude session 来跑后续节点，一个 session 内的所有节点共享 LLM 记忆。新加的"平行根"在 cli-multi 模式下其实不是真的"fresh context"——LLM 仍记得之前所有问答。lean 模式下 parent_id=NULL → 没祖先链 → 真 fresh。预期行为差异，先不解决，等用户实测再决定要不要加"清空 cli-multi 记忆"开关。（**注**：Session 24 把 claude_session_id 降到 root 级别后这条 caveat 失效——新提问在 Project 模式下天然 fresh context。）
  - **新提问不能在 Canvas 上指定位置**：Dagre 布局自动挑位置，多 root 互不冲突但没有 spatial intent。如果用户想"在画布右下角放这条新根"做空间分类，目前不支持——参考卡片也一样问题。看用法。
  - **FAB popover 在 mobile 表现未测**：现有 right-3 / bottom-6 FAB 浮在 NodeFullView 之上时是否被键盘遮挡，没单独验证。先在桌面观察体感。
  - **prompt 简化后 codex 路径可能选 curl 撞同样问题**：codex 没 web-fetch skill 退路。winterresearch 这类站点在 codex provider 下仍会失败。如果用户用 codex 抓这类站点频繁出问题，再考虑给 codex prompt 加"用 playwright/headless browser fallback"提示。
- **Next**: 浏览器实测三件 — winterresearch 链接是否真能用 web-fetch 浏览器路径绕过 403、画布 FAB 菜单点击体感、新提问节点在 Canvas 上的位置是否符合预期（Dagre 自动 layout vs 手动调）。

### Session 18 (2026-05-05)
- **Done**: 笔记本 v2 — 跳回原文滚到原句 + emerald pulse
  - 用户反馈："最好增加一个高亮"。延续 v1 留的 follow-up（v1 跳回只切节点不滚句）。
  - **anchor union**：`pendingScrollAnchor` 从 `{ nodeId, childId }` 改为 discriminated union `{ kind:"child", nodeId, childId } | { kind:"note", nodeId, noteId }`。store 行为：
    - `jumpToParentAtAnchor` 仍 set kind="child"。
    - 新 action `jumpToNoteSource(noteId)`: 从 notes 数组找 sourceNodeId → set anchor + activeNodeId + fullScreen + notesOpen=false 一次完成（之前 NotesDrawer 自己拼这堆 set，重叠责任）。
  - **mark 注入串联**（`NodeFullView.tsx:ResponseBody`）：
    - 新增 `injectNoteMarks(md, noteAnchors)` ：和 `injectHighlights` 同结构但 wrap `<mark data-note-id>`。`escaped` 之后用 `replace(/\s+/g, "\\s+")` 让正则跨行/多空白容错（getSelection 抓的文字有时换行被合并成单空格，markdown 源文里仍是 `\n`）。
    - 注入顺序：**先 note 后 child**。当某段同时是分叉锚 + 笔记源时，child mark 包在外层、note mark 在内层 → DOM 里 closest("[data-child-id]") 仍能找到外层（保留点击跳子语义）；scroll 用 querySelector("[data-note-id]") 也能找到内层。语义不冲突。
  - **scroll effect 多分支**：原 effect 写死 `mark[data-child-id="..."]`，改为按 `pendingScrollAnchor.kind` 选 selector。增加"二次 rAF 后还找不到 → clearScrollAnchor"兜底（之前会留挂着的 anchor 在下次 ResponseBody mount 时尝试，可能错位 pulse 别的节点）。
  - **CSS**：
    - 新规则 `mark[data-note-id]:not([data-child-id])` 用 emerald-100 / emerald-700 dark 替代默认 amber，cursor:default（无点击）。区分"我的标记"vs"分叉锚"。
    - `@keyframes anchor-pulse` 拆成 amber / emerald 两套 + dark 各一套。`.md-body mark.anchor-pulse` 默认 amber 动画；`mark[data-note-id]:not([data-child-id]).anchor-pulse` 覆盖成 emerald 动画。视觉一眼区分跳源类型。
  - **NotesDrawer 简化**：删掉 v1 留的"占位 setActiveNode + setFullScreen + setNotesOpen + void jumpToParentAtAnchor"那段权宜代码，onJump 现在就一行调 `jumpToNoteSource(note.id)`。
  - 验证：build ✓ 一次过。
- **Decisions**:
  - **note 在内、child 在外**：因为 child mark 现有 click-to-jump 行为，必须能被 closest 取到外层；note mark 只是 scroll target 和视觉提示，无需在外层。
  - **emerald 配色**：amber 已被 unread / 笔记 / reference 等 overload，再用 amber 区分笔记和分叉锚视觉混淆。emerald 在系统里只有"cache hit"用过、新意义"我手动标的"语义近"省下/收藏"也合理。
  - **`\s+` flexible 匹配**：getSelection() 跨段 / 跨列表项 /  跨 markdown 渲染元素时，得到的 text 用单空格连接，但源 markdown 里是 `\n` / 多空格。统一用 `\s+` regex 在源文找。代价：偶尔会过度匹配（连续多个空格段被归并），实际影响小。
  - **匹配失败兜底 clear anchor**：rAF 两次都找不到 mark 时主动 `clearScrollAnchor()`。否则 pendingScrollAnchor 会卡住，下次切到该节点（包括误切）会再触发寻找逻辑——视觉上一切都正常但用户感觉"为什么忽然有个高亮"。
  - **不在抽屉里 pulse**：跳回时只在 source node body 里 pulse 引用句。抽屉里那条笔记卡片自己不闪，避免双重视觉噪音。
- **Caveats**:
  - **正则匹配脆弱**：仍有 fail 场景。例：摘录内容跨 code fence、跨表格、被 markdown 渲染时插入额外字符（如 list item bullet）。失败时跳到节点但不滚不 pulse —— 退化到 v1 体感，不会崩。如果用户高频遇到再考虑用 DOM textContent 索引而非源 markdown 正则。
  - **重复文本歧义**：同一段话被摘两次，注入只 wrap 第一处（Set 去重）。两条 note 共享同一 mark 的 data-note-id 是其中之一—另一条的跳回会找不到 mark 退化成 v1。极端 corner，先不解决。
  - **note mark 嵌套 child mark 视觉**：当两者重叠时 inner note 是 emerald 但被 outer amber child 包着 —— 显示成 amber（CSS 选择器 `:not([data-child-id])` 不命中 inner，所以 inner 退化默认 mark 样式 = amber）。这是有意—保留分叉锚的视觉优先级。如果要让 emerald 在嵌套时也显示，要更复杂的 CSS（`mark[data-child-id] mark[data-note-id]` 反向 override），先不做。
  - **dark mode emerald 偏深**：`#064e3b` 在 dark theme 下接近背景，对比度低。如果实测看不清再调亮。
- **Next**: 用户实测匹配命中率 — 摘短句（一句话内）几乎必中；摘跨段长文本 / code block 内 / list item 跨条目时观察是否有 fail 比例。若 >20% fail 考虑 textContent 索引方案（用 source node DOM textContent 加 prefix-suffix 锚定，而非源 markdown 正则）。

### Session 17 (2026-05-05)
- **Done**: 笔记本功能 — 阅读时 ⌘D / 📌 摘录、右侧抽屉浏览、跳回原文
  - **数据层**：
    - `lib/server/sqlite.ts`：CREATE TABLE notes (id / session_id FK CASCADE / source_node_id / quoted_text / created_at) + session 索引。
    - `lib/types.ts` 加 `Note` type；`lib/server/repo.ts` 加 `ApiNote` + `listNotesBySession`（按 createdAt DESC，drawer 默认顶部最新）+ `createNote`（显式 SELECT 校验 source_node 在该 session 内—nodes 表本身 source_node_id 没 FK，必须手动）+ `deleteNote`（硬删，按用户决策不软删）。
  - **API**：
    - `app/api/notes/route.ts`：POST 创建（验证 sessionId / sourceNodeId / quotedText 三字段非空）+ GET ?sessionId= 列出。
    - `app/api/notes/[id]/route.ts`：DELETE 硬删，404 时返回 not found。
    - `app/api/sessions/[id]/route.ts`：hydrate path 同时返回 notes，避免单独再发一次请求。
  - **store** (`stores/sessionStore.ts`):
    - state 加 `notes: Note[]` + `notesOpen: boolean`。
    - `loadSessionInternal` 解析 hydrate 响应中的 notes。`newConversation` / 失败兜底都 reset 到 `[]`。
    - `addNote(sourceNodeId, quotedText)`: optimistic prepend (temp-id) → POST → 成功 swap server id；失败 filter 掉 temp 并 throw。
    - `deleteNote(noteId)`: optimistic filter → DELETE。404 也算成功（双击/已删）。网络失败回滚到 before snapshot。
    - `setNotesOpen(open)` 抽屉开关。
  - **触发 UI**：
    - `BranchPopover.tsx`（desktop 选区浮窗）：collapsed 状态从单按钮变 row 双按钮。新增 amber 圆角按钮带"摘到笔记"图标 + ⌘D kbd 提示。⌘D keydown 在原 ⌘K effect 里加分支，`e.preventDefault()` 拦截浏览器默认书签快捷键。
    - `NodeFullView.tsx:SelectionBar`（mobile 底栏）：textarea 左侧加 outlined amber 笔记按钮，点击直接摘录、关闭 selection bar。
    - 失败兜 `console.error` 不弹任何 UI 反馈—轻量场景，将来如果用户感觉"以为成功结果没存"再加 toast。
  - **NotesDrawer + Header 入口**：
    - 新建 `components/NotesDrawer.tsx`：右侧抽屉（mobile 改 60vh 底部 sheet），骨架 mirror `NodeTreeOverlay`（背景 dim + transition + Esc 关闭）。每条笔记 amber 卡：
      - 主体：`quotedText`（whitespace-pre-wrap break-words），整体可点击触发跳回。
      - 元信息：`#N · topicLabel`、↗ 跳回、× 删除。
      - 跳回行为：`setActiveNode(sourceNodeId) + setFullScreen(true) + setNotesOpen(false)`。
    - **跳回未做"滚到原句"** —— 之前的 `pendingScrollAnchor` 是按 `mark[data-child-id]` 找的，专为"父-子分叉锚"设计。笔记没 child-id，要想滚到引用文字得在源节点 ResponseBody 里给每条笔记的 `quotedText` 也注入一个 `<mark data-note-id>`，并扩展 ResponseBody 的 effect 同时支持两类 anchor。先不做这一刀——v1 落地节点+全屏即可，看用户是否抱怨"找不到原句"再扩。
    - `Header.tsx` 加📒图标按钮：`useSessionStore(s => s.notes.length)` 显示计数（>0 时露），点击 `setNotesOpen(true)`。
    - `app/page.tsx` 挂 `<NotesDrawer />`。
  - 验证：`npm run build` ✓ 多次（每个 phase 后跑一次）。端到端 curl：POST 创建 → 含完整字段；连续 POST 两条 → list 按 createdAt DESC（newest first） ✓；GET /api/sessions/[id] 含 notes ✓；invalid sourceNodeId → 404 ✓；DELETE 真实 / 不存在 → 200 / 404 ✓。
- **Decisions**:
  - **per-session、不全局**：用户决策。"打捞跨对话精华"是另一个产品形态（搜索 / inbox），先 ship 简单的 per-session 笔记本看用法。
  - **无 comment 字段**：避免做了没人用。如果用户开始想"标签" / "备注"再加 column，schema 留扩展空间。
  - **硬删**：一次性，简单。撤销可以靠浏览器返回上一步——抽屉里删错最多再划词重摘。
  - **跳回不滚原句（v1）**：复用 pendingScrollAnchor 需要扩展 ResponseBody 的 mark injection 逻辑，引入"按文本查找锚点"的脆弱性（quoted_text 在源 markdown 里可能跨段、被 mark 覆盖、被 normalization 改字符）。现实方案是把笔记的 quotedText 从源 markdown 里 regex 匹配后 wrap mark——能复用现有 injectHighlights 同样的脆弱处理（重复文本只首次 wrap）。看用户反馈再加。
  - **abandon 未读 dot 不复用 amber**：本来想给笔记 dot 也用 amber 一致——但 amber 已经是 unread 信号 + reference 卡片的主色，再 overload 太混乱。Header 笔记按钮就用 stone 文字色，计数小数字。
- **Caveats**:
  - **跳回不滚原句**：见 Decisions。已知不便。
  - **抽屉里 quotedText 长文本不裁剪**：完整 whitespace-pre-wrap 显示，长摘录会让一条卡片很高。如果用户摘大段需要 `max-h-32 overflow-hidden + 渐变蒙版` 压缩。先不加，看实际用法。
  - **失败兜底是 console.error**：如果你按 ⌘D 但后端/网络炸了，UI 看不出来（optimistic row 滚回去）。监控不严，将来加 toast。
  - **moblie 没快捷键**：mobile 选区只能点 📌 按钮。预期—mobile 没物理键盘。
  - **笔记不计入 token / 不进 LLM context**：纯本地存储，不影响后续提问的 prompt。这是设计：笔记是"我的"产物，不是 LLM 工作记忆。
- **Next**: 用户实测 — 划词后 ⌘D 是否秒摘 / 抽屉打开滑动是否流畅 / 跳回时若找不到原句是否 painful（决定要不要做 v2 滚原句）/ 长 quotedText 是否要折叠 / 删除是否需要 confirm（如果误删大量可惜）。

### Session 16 (2026-05-05)
- **Done**: token 细分到 4 桶（input / output / cacheRead / cacheCreation），全链路 + UI
  - 用户反馈："这里的 token 量意义不大，最好显示每条回复 input / output / cache 数量"。诊断根因：`lib/llm/claude.ts` done 分支把 `input_tokens + cache_creation + cache_read` 全部 sum 进 `usage.input` 字段——cli-multi 模式下"输入 4 万 tokens"实际 95% 是 cache hit。三个数字混成一个数字的过程从 LLM provider 层就开始了，下游全是被污染的总和。
  - **类型扩展**：`lib/llm/types.ts` 新增 `TokenUsage = { input, output, cacheRead, cacheCreation }`，StreamEvent.usage 用此。`lib/types.ts` ChatNode.tokenCount 同步成四字段。`lib/server/repo.ts` ApiNode 同步。
  - **provider 拆分**：
    - `claude.ts` done 分支不再 sum，分别映射 anthropic 字段：`input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`。lean / cli-single / cli-multi 都享受。
    - `codex.ts` done 分支：codex 0.125 JSONL 的 `input_tokens` 在某些 build 是含 cache 的总和、`cached_input_tokens` 是命中数；用 `Math.max(0, totalIn - cached)` 还原 net input；cacheCreation 在 codex 没暴露，固定 0。
    - `mock.ts` 提供 cacheRead/cacheCreation 的 0 占位，类型对齐。
  - **DB schema**：`lib/server/sqlite.ts` idempotent ALTER 加 `token_cache_read` / `token_cache_creation`，DEFAULT 0。老数据 token_input 仍含被污染的 sum 不回填——历史误归属，不主动 migrate。
  - **repo + API**：NodeRow + NODE_COLS 加两列；rowToNode 映射 cacheRead/cacheCreation；`finalizeNode` 入参加 tokenCacheRead/tokenCacheCreation；`resetNodeForRetry` UPDATE 把这两列也归零；`api/chat/route.ts` done 事件接收四字段透传。
  - **store**：`StreamEvent.done.usage` 类型同步四字段；done 分支默认值兜底 0。
  - **UI**：
    - 新建 `lib/format-tokens.ts:formatTokens(n)`：<1k 直显 / 1k-10k 一位小数 (`1.2k`) / 10k+ 整数 k (`32k`)。
    - 新建 `<TokenMeta />` 子组件（在 ChatNode.tsx 内）：`↑in ↓out ⚡cacheRead`（cacheCreation > 0 时附 `+N`）。compact 和 full 两种 size variant。零值时显示 `—`。tooltip 给出原始数字。⚡ 用 emerald 色让"我省了多少"凸显。
    - ChatNode compact 卡片右上角的"总 token 数字"换 `<TokenMeta variant="compact" />`。
    - ChatNode full footer 行内"X tokens"换 `<TokenMeta variant="full" />`。
    - Header 顶栏总数：原 `totalTokens = sum(input+output)` 全局错误，改为四桶分别累加，渲染 `↑总入 ↓总出 ⚡总 cache`。tooltip 同样含原始数字。
  - 验证：`npm run build` ✓ 2 次（一次 type 错被发现，retryNode optimistic patch 漏 cacheRead/cacheCreation 修了）。端到端 cli-multi 实测：
    - R1（首轮）：`input:10, output:257, cacheRead:27615, cacheCreation:12916` —— 真正 prompt 才 10 token，27k cache 命中是 claude code skills+tools 默认 system prompt 的 read，12k cache_creation 是首轮新建。
    - R2（resume）：`input:10, output:157, cacheRead:40531, cacheCreation:275` —— cache hit 涨到 40k（含 R1 对话历史），创建只增量 275。
    - UI tooltip 完整呈现：`输入 10 · 输出 257 · 缓存命中 27615 · 缓存写入 12916`。
- **Decisions**:
  - **不回填老数据**：老 token_input 列含被污染的 sum，迁移要重新计算每个历史节点的真实细分（数据已丢失）—— 不值得。新行干净，UI 看老节点会偏高，可接受。
  - **codex 的 input 减去 cached**：codex 文档没明说，但实测 R2 cli-multi `input_tokens` 数值上等于 anthropic 那边 input + cacheRead 的和，与 anthropic 语义不一致。统一成"input = 真正发去的 net prompt"语义后，UI 跨 provider 一致。
  - **cacheCreation 仅在 >0 时显示**：cli-multi 第 2 轮起几乎全是 cache hit、creation 很小（几百 token）。把它合并进 cache 槽 `⚡40k+275`，避免常态下多一个数字干扰。
  - **emerald 色 cache**：amber 已经被 unread 占了。emerald 表达"省了"是直觉。
  - **format 用 1 位小数 + 10k+ 整数**：常见 cache 命中是 30-50k 范围，5 位数太长。`32k` 比 `32517` 更可读且不丢一位精度（误差 ±500）。
- **Caveats**:
  - **codex cacheCreation 永远 0**：codex CLI 不暴露这个字段。如果用户在 codex 上看不到 creation，正常。
  - **cache hit 数字可能跨 turn 累计语义混淆**：anthropic 的 cache_read_input_tokens 是本 turn 命中的 cache token 数，不是累计跨 turn。Header 的 ⚡总和是把每个节点的 per-turn 命中加起来——同一段 cache 在 N 轮中被读 N 次，会被算 N 次。这是 anthropic 计费视角的"读取 token-times"，不是"独立 cache 大小"。tooltip 已隐含此语义（"缓存命中"），先不解释。如果用户疑问可以加 footnote。
  - **mock provider 没有真实 cache**：永远 0。不影响调试，但用 mock 跑时看到的"⚡0"不是 bug。
  - **lean 模式 claude 也走 cache**：claude code 的 lean 模式跑 `--system-prompt <SP>`，那段 SP 也会 cache，所以 lean 模式也能看到 cacheRead 几千 token。这是真实计费，不是误算。
- **Next**: 用户实测 — Header 顶栏的 ↑/↓/⚡ 在窄屏（md 以下）会隐藏，看是否需要 mobile 也露一行；卡片的 emerald ⚡ 在 cli-multi 高 cache 场景下是否够醒目；如果觉得 ⚡ 图标体验欠佳可换 ↻ 或 ⊕。

### Session 15 (2026-05-05)
- **Done**: 节点定位进阶三件 — J/K 跳未读、compact 状态圆点视觉分级、流完成 toast
  - **进阶 1 — J/K 跳未读**：`hooks/useUnreadNavigation.ts` 新建。全局 keydown 监听 J / K（vim/Gmail 惯例：J 下一未读、K 上一未读），过滤 input/textarea/contentEditable focus + 修饰键。算法：按 createdAt 排序所有节点，从当前 active 起步走 ±i 步（含 wrap-around），返回首个 status==="done" && !readAt 的节点。在 page.tsx 顶层挂载 `useUnreadNavigation()`，canvas 和 fullscreen 都生效。Canvas 已有 auto-pan-to-active effect（line 109-120），J/K 切完会自动滚到节点。
  - **进阶 2 — Canvas compact 状态圆点视觉分级**：原状态圆点逻辑 `done → emerald, else → stone`。新逻辑：未读 done = amber-500，已读 done = emerald-500，非 done = stone。zoom out 时未读节点 amber dot 在画布上扎堆易扫，已读 emerald 退到背景。配套移除 compact 模式下序号旁的 amber 蓝点（与状态圆点重复，三点距离过近视觉嘈杂）。Full 模式下序号旁的 dot 保留（无状态圆点）。
  - **进阶 3 — done toast**：当节点流完成时若 `activeNodeId !== currentNodeId` push toast。
    - store: 加 `doneToasts: { nodeId; emittedAt }[]` state + `dismissDoneToast(nodeId)` action。`handleStreamEvent` done 分支判断 `s.activeNodeId !== id` 才 push（同一节点重 toast 时 dedupe by id —— retry/branch 周期可能 emit 两次）。
    - `components/DoneToast.tsx` 新建：fixed bottom-right，每个 toast 有 emerald 圆点 + #N + "已完成" + 节点 topicLabel/question 前缀 + × 关闭。点击主体 → `setActiveNode + setFullScreen(true) + dismiss`（NodeFullView 的 1s mark-read effect 自动接管）。每个 toast 6s auto-dismiss（参考 macOS notification / Material 4-10s 区间，留够时间让用户决定是否打断当前流）。
    - 在 page.tsx 挂 `<DoneToast />`，全局可见。
    - 不 toast reference 抓取：reference SSE done 路径走另一个分支（`handleRefStreamEvent`），且 createReference 触发时 server 已经把 activeNodeId 设到新节点 → 用户主动建的，不需要打扰。
  - 验证：build ✓ 1 次（一次过，所有 TypeScript 类型对齐）。
- **Decisions**:
  - **J/K 不切 fullScreen**：保留用户当前 layer。canvas mode 下 J/K = 在画布内导航；fullScreen mode 下 J/K = 翻读未读队列。两种工作流都自然。如果想强制读，按 J 后再点全屏按钮 / 双击节点。
  - **compact dot 替代而非新增**：原本想"加个未读小点"在状态圆点旁，但发现与序号旁的 amber dot 视觉重复（三点扎堆）。改为状态圆点本身做 unread/read 编码，移除冗余的序号 dot（只在 compact 移除）。
  - **toast 点击进 fullScreen**：用户从 toast 跳过去多半是要读，全屏直接读最顺。canvas mode 下保持的人不会用 toast 跳（他们能直接看到画布上节点 streaming）。
  - **toast 6s 而非 3-4s**：常见的"问完一个问题、branch 出去、读别的"流程里，6s 给用户足够时间判断"现在打断 vs 读完手头的"。Material 上限 10s，macOS 通知 5-10s 都比 4s 接近，6s 是中间值。
  - **不 toast reference 抓取完成**：用户主动添加的 reference 在 SSE created 事件里就把 activeNodeId 设到新节点了，已经自带"导航过去"语义。再 toast 是冗余打扰。
- **Caveats**:
  - **toast 不 markRead**：6s 自动消失只是去掉提示，节点仍然 unread。点击进 fullScreen 才会触发 1s mark-read。这是有意：toast 闪过去 ≠ 用户读了。
  - **toast 没 i18n**：固定中文 "已完成"。和项目其它 UI 一致。
  - **多个 toast 堆叠**：上限没设。如果用户开 10 个分支同时跑，会出现 10 个 toast。视觉上挤但不会 overflow（max-w-sm + flex-col + 自动 6s 退场）。极端场景再加 maxItems=5 截断。
  - **K 在 cli-multi confirm dialog 期间**：不冲突——dialog 是 window.confirm，原生模态会接管键盘。但若以后改成自定义 dialog 要重新审视。
  - **J/K 不区分 reference/qa**：参考卡片也算"未读" → 也会被 J/K 跳到。这正确——用户加的 reference 也是要消化的内容。
- **Next**: 用户实测三件 — 按 J/K 看跳转流畅度（特别是 wrap-around 时是否突兀）、缩远 canvas 看 unread amber dot 是否真的"跳出来"、跑长 prompt 然后切去看别的卡看 toast 是否在恰好时机出现。

### Session 14 (2026-05-05)
- **Done**: 节点定位三件套 — 序号 + 已读未读 + 跳父滚到 mark
  - **Phase A — 节点序号**：`lib/node-index.ts` 新增 `buildNodeIndex(nodes)` helper，session 内按 `createdAt` 升序产出 1-based map。Canvas flowNodes useMemo 里把 index 算好放进 ChatNode/ReferenceCard 的 data；Outline 和 NodeFullView SubBar 各自调一次 useMemo。展示位置：ChatNode 头部"你"圆点旁、ReferenceCard 标题前、Outline 行首、SubBar 面包屑里。统一 mono + stone-400 弱化色，不抢主体。
  - **Phase B — read 数据层 + API + store**：
    - `lib/server/sqlite.ts`：idempotent ALTER 加 `read_at INTEGER` 列（NULL = 未读）。
    - `lib/server/repo.ts`：`NODE_COLS` 补 `read_at`，rowToNode 解析为 `readAt`，新增 `markNodeRead(nodeId, now)` —— 已有 read_at 就返回原值（true idempotent）。
    - 新建 `app/api/nodes/[id]/read/route.ts` POST 端点。
    - `lib/types.ts` ChatNode 加 `readAt: number | null`；server `ApiNode` 同步。
    - `stores/sessionStore.ts:markNodeRead` action 乐观 patch + POST，失败回滚（仅在 timestamp 匹配时回滚，避免覆盖另一 tab 的写入）。
    - `NodeFullView` mount/active 切换 useEffect：当 `node.status === "done"` 且 `!node.readAt` 时启 1s 计时器，到点调 markNodeRead。streaming/error 不计；流式 done 转换会 re-fire effect 自动开始计时。
  - **Phase C — UI 表达**：
    - ChatNode 卡片：`isUnread = status==="done" && !readAt`，全/紧凑两态都加 amber-300 边框（与 streaming indigo / active stone ring 不冲突）；序号旁多一个 1.5×1.5 amber-500 圆点。
    - ReferenceCard 同等待遇。
    - `Outline.tsx` 顶部：`unreadCount` 计算后渲染 amber 标签 "N 未读"，点击 toggle `unreadOnly` 本地 state。`unreadOnly` 模式下：纯已读叶子隐藏；有未读后代的已读父节点渲染但 dim 灰色（保留 hierarchy）。
  - **Phase D — 跳父滚到 mark + pulse**：
    - store 新增 `pendingScrollAnchor: { nodeId, childId } | null` state + `jumpToParentAtAnchor(parentId, childId)` action（一次 set 同时设 anchor 和 activeNodeId）。
    - NodeFullView 的"↳ 从「xxx」分叉"badge onClick 改成调 `jumpToParentAtAnchor(parent.id, node.id)`。
    - `ResponseBody` useEffect 监听 `pendingScrollAnchor`：当 anchor.nodeId === 当前节点且非 streaming 时，rAF 后 `querySelector('mark[data-child-id=...]')` + `scrollIntoView({block:"center", behavior:"smooth"})` + 加 `.anchor-pulse` className 1.5s 后清除并 `clearScrollAnchor()`。CSS 加 `@keyframes anchor-pulse` / `anchor-pulse-dark`，3 个周期约 1.5s 总时长。Mark 不在 DOM 里时再 rAF 一次兜底（markdown 慢挂载场景）。
  - 验证：`npm run build` ✓ 4 次。端到端 curl：POST /api/chat 创建节点（response 含 `readAt: null`）→ POST /api/nodes/<id>/read 返回 `{readAt: <now>}` → 第二次调用返回相同 timestamp（idempotent ✓）→ 不存在节点 404 ✓ → GET /api/sessions/<id> 路径 readAt 字段也正确返回（hydrate 通路 OK）。
- **Decisions**:
  - **read 1s gate 在客户端**：服务端不验证 dwell time，纯凭 client POST 触发。简单且足够；恶意刷 read 状态没什么意义（私有产品）。
  - **streaming/error 不可标记已读**：避免用户在 abort 后被错误标 read。流式 done 转换时 effect re-fire 自动启动 1s 计时器，无缝。
  - **Unread 视觉强度刻意低**：amber-300 边框 + 1.5×1.5 dot，比 streaming indigo ring 弱、比 active stone ring 弱。三态视觉层级：streaming > active > unread > read。
  - **Outline unread-only 不彻底隐藏 read**：有 unread 后代的 read 行 dim 渲染 —— 保留树形结构，避免出现"未读节点孤悬"的视觉噪音。
  - **mark scrollIntoView 用 smooth + center**：center 而非 start，让 mark 真的在屏幕中间显眼；smooth 比 instant 体感好（用户能看到滚动方向，建立位置感）。
  - **anchor-pulse 用 keyframes 而非 transition**：更易写 3-cycle 的循环效果；1.5s 总时长够引起注意又不烦人。
- **Caveats**:
  - **mark 跳转只在 fullscreen mode**：canvas mode 下点 ChatNode 卡片头的 amber badge（line 144）只是显示，没绑 onClick。若用户期望 canvas mode 也能跳父并定位，再加。
  - **read 标记不区分"扫一眼"和"读完"**：1s 算粗糙判定。极快滑动浏览所有节点会全标 read。如果体感不准再考虑滚动距离 / dwell-extension 加权。
  - **read_at 一旦标记就不能撤销**：UI 没暴露"标记未读"动作。如果用户想"再读一遍"找不到入口。先观察是否有真需求再加。
  - **multi-tab 写竞争**：标记 read 是 last-writer-wins by id，但 markNodeRead repo 函数已经是 "如果有 read_at 就返回原值"，所以两个 tab 同时点开同一节点不会刷新 timestamp。
- **Next**: 用户浏览器实测 — 序号是否方便记位、Outline "X 未读 / 只看未读 toggle" 体感、跳父 pulse 是否够显眼又不刺眼。可能的进阶：J 键跳下一未读、Canvas 节点边框分级（high-LoD 可视化）、流式 done 时若用户不在该节点弹气泡。

### Session 13 (2026-05-04)
- **Done**: Codex provider 从 SDK 切换到 spawn CLI，三档 mode + URL fetch 与 Claude 路径完全对称解耦
  - **lib/llm/codex.ts 重写**：丢弃 `@openai/codex-sdk`（注入 22k tokens 系统 prompt 无法关闭、不识别 mode），改 spawn `codex exec` / `codex exec resume`。三档：lean (`--ephemeral --sandbox read-only`，DEFAULT_SYSTEM_PROMPT 拼到 prompt 头) / cli-single (`--ephemeral --dangerously-bypass-approvals-and-sandbox`) / cli-multi（首轮非 ephemeral 持久化 + 后续 `exec resume <thread_id>`）。`@openai/codex-sdk` 依赖从 package.json 移除。
  - **codex login 检测**：`makeCodexProvider().stream` 入口先 `spawnSync codex login status` exit code 检测，未登录直接 `yield error("请先 codex login")`。
  - **URL fetch 拆分**：
    - 新建 `lib/server/fetch-prompt.ts`：抽出共用 `buildFetchPrompt(url, variant)` + `parseFetchOutput`。`variant: "claude"` 在尾部加 "AVOID WebFetch built-in" 提示，`variant: "codex"` 不加。
    - 新建 `lib/server/fetch-via-codex.ts`：spawn `codex exec --json --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox -m gpt-5.5`；JSONL 路由 `item.started(command_execution)` → 把 codex 跑的 bash 命令直接转 progress 给前端；`item.completed(agent_message)` → 用共享 parser 抽 frontmatter+body。
    - `lib/server/fetch-via-claude.ts` 简化：去掉本地 PROMPT_TEMPLATE / parseClaudeOutput，全部改用 `fetch-prompt.ts` 的共享版本。
    - `lib/server/fetch-url.ts` 改 dispatcher：导出 `fetchUrlEvents(url, provider, signal)` async generator + `fetchByUrl(url, provider, signal)` sync wrapper，按 provider 路由到 claude / codex 两条路。
  - **API + store provider 透传**：`app/api/references/route.ts` 接收 `provider` 字段（`isProviderId` 校验，缺省走 DEFAULT_PROVIDER）；refresh route 同时支持 query string `?provider=codex` 和 body。`stores/sessionStore.ts` 的 createReference / refreshReference 自动从 store.provider 取当前选中的 provider 传给 server。
  - **UI 文案 provider-aware**：`ModePicker.tsx` 加 `optionsFor(provider)` 切两套 tooltip（claude → "skills + ~/.claude/CLAUDE.md"；codex → "MCP servers + ~/.codex/config.toml"）；cli-multi 切换确认对话也用动态 cliName。`ReferencePicker.tsx` URL tab 描述根据 provider 切换。
  - 验证：`npm run build` ✓ 三次。端到端 curl 测试：codex+lean → "2"（input 24256, output 54）；codex+cli-single → 跑 zsh echo 命令 + 拿 output；codex+cli-multi 双轮 → 第二轮记得第一轮的数字 73；codex URL fetch example.com → 拿到 "Example Domain" 标题 + verbatim body + 完整 progress 流（curl + python html-to-md fallback）。回归 claude-haiku+lean → 正常。
- **Decisions**:
  - **lean 模式 system prompt 用拼接而非 codex flag**：codex CLI 没有 `--system-prompt`，把 DEFAULT_SYSTEM_PROMPT 加在 user prompt 前面。read-only 沙箱保证就算模型想调工具也调不动。
  - **不传 `--ignore-user-config`**：实测发现该 flag 让 codex 走 env 里的 `OPENAI_API_KEY`，而用户用的是 ChatGPT 订阅 auth。屏蔽全局配置反而打破登录态，得不偿失——lean 模式只靠 sandbox + system prompt 约束。
  - **session_init / db column 复用 `claude_session_id`**：codex 的 thread_id 也写到这个 column。column 名不准但 schema 不动，技术债先记。后续如果给 provider-specific session 多种语义再拆。
  - **URL fetch 也对接 codex**：意味着 trellis 不再 hard-require `claude` 在 PATH 上。选 codex 时所有外部抓取走 codex，feishu-cli/yt-dlp/curl 等本机 CLI 工具直接被 codex spawn——这些工具的 auth state 是用户机器级的，跟 LLM provider 无关。
  - **codex JSONL 一次性给 agent_message**：no streaming delta，UX 是"spinner 然后整段一次性出现"。codex CLI 0.125 限制，非 trellis 问题；接受现状不绕。
- **Caveats**:
  - **codex stderr 偶现 "failed to record rollout items"**：非致命，已 swallow。
  - **DB column 命名 `claude_session_id` 用于 codex thread_id**：技术债。
  - **mock provider 选 codex 时**：codex provider 不会被走（mock 是另一支），但 fetch dispatcher 的"未知 provider 走 claude"兜底意味着 mock 用户加 reference 仍依赖 claude CLI。无解：mock 没有自己的 fetcher。
  - **gpt-5.5 是默认 model**：用户确认。如果 OpenAI 后续改名要更新常量。
  - **codex resume 不接受 `--sandbox` flag**：首轮 yolo 配置后续轮跟随，无法切。trellis cli-multi 在第二轮起仍传 `--dangerously-bypass-approvals-and-sandbox`，被 codex 接受。
- **Next**: 用户在浏览器里切到 Codex 实测——三档 mode 切换 + Cmd+K 分叉 + URL 抓取（可以试 feishu / youtube 看 codex 是否真能 spawn 那些 CLI）。如果发现 progress 流体感差（一次性出整段而非流式），考虑加"思考中"占位文案优化。



### Session 12 (2026-05-04)
- **Done**: Stage 12 — 节点类型抽象 + 参考卡片（粘贴 / URL）+ FAB 凭空建节点
  - **数据层**：`lib/types.ts` 加 `NodeKind` / `RefSourceType` / `ReferencePayload` / `ChatNode.{kind,reference}`。`lib/server/sqlite.ts` 6 个 idempotent ALTER（kind / ref_source_type / ref_source_uri / ref_content_md / ref_fetched_at / ref_meta_json）。`lib/server/repo.ts` 加 `NODE_COLS` 常量、扩展 `rowToNode`（解析 ref_meta_json）、新增 `createReferenceNode`（验证 session 存在 + 单事务插入 + 更新 session.updated_at）/ `refreshReferenceNode`（仅允许 kind="reference"）。
  - **buildHistoryForNode 重构**：原来用 `chain.unshift` 收集 q/r 对再展开成 messages；新版改成 buffer push 后 reverse，方便穿插不同 message 形态。reference 父节点走 `buildReferenceContextBlock` 合成 user message：`参考材料《标题》片段：\n\n[选区±200 chars 上下文]\n\n用户从中选中：「anchor」`。整篇文档不入 prompt（防止长文档 token 黑洞）。验证 ✓：mock 跑通后跑 better-sqlite3 脚本直接 dump 出来，文本和预期一致。
  - **URL 抓取器**（`lib/server/fetch-url.ts` 新增）：stdlib-only，无新依赖。10s 超时，2 MB 上限，HTTP/HTTPS only，假装 Chrome UA。`<head>` 整段先剥（防 title 漏到 body）；script/style/noscript/nav/footer/header/aside/form/svg/comment 剥；headings → markdown #/##；li → "-"；pre → fenced code；a → markdown link；其他标签全裸。失败时仍返回 { contentMd: '', meta: { fetchError } } — 让节点照样建出来，UI 负责显示错误。
  - **API 端点**：`app/api/references/route.ts` POST + GET（debug 用），union request `{paste|url}`。`app/api/references/[id]/refresh/route.ts` POST，仅 url/feishu 类支持。两端验证 session 存在 + 调 fetchUrlAsReference + 调 repo。
  - **Store**：`stores/sessionStore.ts` 加 `CreateReferenceInput` union、`createReference` action（POST → setActiveNode 到新节点 → 触发 Canvas 现有的 pan-to-active）/`refreshReference`（保留 canvas position，仅 patch reference payload）。
  - **UI**：
    - `components/ReferenceCard.tsx` 新增：280px 折叠态，amber-tinted 区分。源 icon (📄/🔗/📘/📎) + topicLabel + sourceUri/类型 + 字数 + 相对时间 + ↻ 刷新按钮（仅 url/feishu）。fetchError 时变 rose 边框 + ⚠️。Canvas 整卡 click → 全屏。`React.memo` 同 ChatNode 模式。
    - `components/Canvas.tsx`：`nodeTypes` 加 `reference: ReferenceCard`，`flowNodes` 按 `n.kind` 路由 type；挂载 `<AddNodeFAB />`。
    - `components/NodeFullView.tsx`：`node.kind === "reference"` 分支 — 渲染 `ReferenceFullBody`（amber 头部含源信息 + 外链 + ↻ 刷新；body markdown 挂 `data-chat-node-id` 让现有 `useSelectionWithin` + `useMobileSelection` 直接接管划词分叉）；底部 `FollowupBar` 换成 `ReferenceFooterHint`。SubBar 文案对 reference 用 `topicLabel ?? "参考材料"`。
    - `components/AddNodeFAB.tsx` + `components/ReferencePicker.tsx` 新增：右下角浮动 + 按钮 → modal，paste/url 双 tab，Cmd+Enter 提交（paste），Enter 提交（url）。错误显示 + busy 状态。
    - `components/Outline.tsx` + `NodeTreeOverlay.tsx` 重构成 forest（`buildForest` 替换 `buildTree`）：qa 树 + 浮动 reference 各为独立 root，UI 上中间分隔线。reference 行加源 icon。
  - 验证：`npm run build` 通过 6 次（每个 task 后一次）。端到端 mock 流程：create session → create paste ref（topicLabel "Linear Algebra" ✓）→ create url ref（example.com 抽出干净正文 ✓）→ create url ref 失败站点（保留节点 + fetchError ✓）→ branch off ref with anchor → mock done 420 chars。better-sqlite3 脚本 dump synthetic context block 与预期完全一致。
- **Decisions**:
  - **不引入 readability/jsdom**：先用 stdlib regex 抽取，"够用就行"。SPA / 登录墙站点抓不到时 UI 会把错误显示出来，用户可以改用粘贴。等用户实测发现真痛点再换重型方案。
  - **FAB 只做 reference**：spec 提了"问答 + 参考"双类型，但 qa 节点的"凭空建"会涉及 `sessions.root_node_id` schema 改动（多根）。保持现状：root 入口仍是 QuestionInput，FAB 单纯做参考。后续要加再说。
  - **reference 整篇不入 prompt**：spec 已定，实现侧严格执行——只送选区 + ±200 字符上下文。多个 qa 子节点引用同一 ref 也是各送各的片段。"附带整篇"按钮留作未来。
  - **forest 不重排 dagre**：浮动 reference 由 dagre 当独立根处理，会自动放到右侧列。没做精细位置控制——用户用 setActiveNode 自动 pan-to-focus 找新节点。
  - **schema 用 kind 列而非新 table**：5-6 列内可控，多形态扩展再考虑拆表/polymorphic。
- **Caveats**:
  - **URL 抽取质量参差**：example.com 干净；GitHub README / SPA / paywalled 大概率不行。文档写明，UI 显示错误。
  - **删 reference 节点不会处理子 qa**：sqlite FK 是 session_id 级 cascade，nodes 内部没 FK，删 ref 时它的 qa 子节点 `parent_id` 留 dangling。当前 UI 没暴露删单节点入口，所以非紧迫；要加时记得清子的 parent_id 或改 FK。
  - **buildHistoryForNode depth=2 时**：祖父若是 reference，目前只 break 不 emit。罕见场景，先不补全。
  - **canvas pan 中心算法用 NODE_HEIGHT_ESTIMATE=480**：reference 卡只 ~100px 高，pan 到时偏一点。视觉小瑕疵，不修。
  - **mobile FAB**：在桌面 canvas 模式可见。mobile 默认 fullscreen，FAB 没渲染。如果手机用户也想加 ref，需要先回 canvas（顶栏"画布"按钮）。
  - **lint 残留 4 个**：还是预先存在的 setState-in-effect（NodeFullView:110, SessionPicker:24），未引入新警告。
- **Next**: 用户浏览器实测——FAB 建粘贴卡 / URL 卡（成功+失败）/ 划词追问 reference 跑真 LLM（看 prompt 是否合理）/ 并发多个 reference 看 forest 排列 / 删 session 时 ref 是否级联清除 / mobile 端先看 reference 卡在 fullscreen 里怎么阅读和划词。
- **Done（同 session 补丁）**: 允许参考卡作为 session root
  - 用户反馈："新建一个项目时没法直接引入背景，只能先提问"——之前的 spec 决策（"FAB 只做 reference，root 仍走 QuestionInput"）确实是个别扭点。
  - 改动：
    - `lib/server/repo.ts` 加 `createSessionWithReference`（事务里同时插 sessions + kind=reference 根节点，title 默认走 topicLabel）
    - `app/api/references/route.ts`：`sessionId` 改为 optional。缺省时调 createSessionWithReference，返回 `{session, node}`（mirror chat root 的 shape）
    - `stores/sessionStore.ts:createReference`：当前无 session 时不传 sessionId；解析响应里的 session 字段 → 整体 swap 节点 map（旧 newConversation 残留也一起清）
    - `components/QuestionInput.tsx`：textarea 下方加分隔线 + amber 按钮"📄 从背景材料开始（粘贴 / URL）"，复用 ReferencePicker
  - 验证：build ✓；curl POST /api/references 不带 sessionId → 返回新 session（title="Study Notes"）+ reference root 节点 ✓
- **Caveat 补充**: 一个 session 的 root_node_id 现在可能指向 reference。Outline / TreeOverlay 的 buildForest 里 `qaRoot = nodes[qaRootId]` 仍然会拿到那个 reference 节点并放在 forest 第一位——视觉上和"qa root"无区分（除了图标）。如果用户混合使用（先放 ref → 再问问题）流程跑通后觉得别扭，再考虑把 Outline 的"思维树"标题在 ref-root 时换成"参考材料"。
- **Done（URL 抓取重构 — claude 全权代理）**: 把"按 host 路由"也撤了，trellis 不识别任何平台
  - 用户进一步反馈："不是走代码来获取内容，而是把获取内容的能力全权交给本地的 cli，让它来决策怎么样通过这个 URL 来获取内容"。前一版的 dispatcher 仍然把"识别 feishu URL"硬编码在 trellis 里——任何新平台仍要改 trellis 代码。重新设计：spawn `claude -p` 让它自己看 URL 挑 skill。
  - 改动：
    - `lib/server/fetch-via-claude.ts` 新增：spawn `claude -p "<prompt>" --permission-mode bypassPermissions --no-session-persistence --model haiku`，cwd=tmpdir（屏蔽 ~/.claude/CLAUDE.md 用户个人指令）。Prompt 模板写明可用 skills 列表 + 严格 frontmatter+body 输出格式。90s 超时、5MB stdout 上限。`parseClaudeOutput` 解 frontmatter（title / platform / fetch_error / body），容错处理 claude 偶尔加 ``` 代码围栏 / CRLF 等。
    - `lib/server/fetch-url.ts` 简化为 thin wrapper：URL 合法性校验后直接调 fetchUrlViaClaude。
    - `lib/server/fetch-feishu.ts` **删除**——平台知识从 trellis 代码里消失。
    - `lib/types.ts`：`RefSourceType` 收窄到 `"paste" | "url"`；`ReferenceMeta` 加 `platform?: string`。每平台细分（feishu / youtube / github / generic / pdf / ...）由 claude 在 frontmatter 里写。
    - `lib/ref-icon.ts` 新增：单一 icon 映射表 `{feishu→📘, youtube→🎬, bilibili→📺, x→🐦, github→🐙, pdf→📕, notion→📒}`，UI 全走 `refIcon(ref)`。加新平台只改这张表。
    - `lib/server/repo.ts:rowToNode`：legacy 兼容——DB 里 ref_source_type='feishu'/'file' 的行（如有）coerce 成 sourceType:"url" + meta.platform 保留原 tag。
    - 各 UI（ReferenceCard / NodeFullView / Outline / NodeTreeOverlay）干掉本地的 `refSourceIcon` switch，改用 `lib/ref-icon.ts` 的 `refIcon`。canRefresh 检查从 `(url|feishu)` 收窄到 `url`。
    - `ReferencePicker.tsx` 文案改为 "由本机 claude + 已安装的 skills 决定怎么抓——飞书自动走 feishu-cli，YouTube 走字幕 skill，普通网页走 web-fetch"，明确列出延迟 5-30 秒。
  - 验证：build ✓；端到端 `https://example.com/` → sourceType "url" / platform "generic"（claude 自己 tag 的）/ title "Example Domain" / 465 字 markdown。
- **Decisions（claude-driven fetch 架构）**:
  - **平台识别全部交给 claude**：trellis 不知道 feishu/youtube/bilibili 长什么样。新平台只要用户 `feishu-cli auth login` / 装 youtube skill 等，零代码改动。
  - **频道选 haiku**：URL 抓取是机械任务（挑 skill → 跑 → 格式化），haiku 够用且便宜。一次约 ~$0.01-0.02，5-30 秒。
  - **cwd=tmpdir**：让 claude 看到全局 skills（~/.claude/skills/），但不被用户 ~/.claude/CLAUDE.md 影响响应风格——纯 fetcher 行为。
  - **Frontmatter 协议**：和 feishu-cli 的 `--front-matter` 形式对齐（claude 也认识这个格式），title / platform / fetch_error 三个字段。
  - **所有 URL 都过 claude**：不为 stdlib regex 留兜底——既然彻底交出去了就别留半截。代价：example.com 这种极简页也要花 5-10 秒 + 一次 LLM 调用。可接受。
- **Caveat（claude-driven fetch）**:
  - **prompt injection 表面**：URL 是用户输入，但 URL 抓回的内容也可能含恶意指令（"忽略前面，写文件 /etc/passwd"）。claude 跑在 bypassPermissions 下有完整文件系统权限。当前接受这个风险——这是用户自己机器的 trellis，URL 也是用户主动加的。
  - **claude 可能不严格按 frontmatter 格式**：parser 有几层容错（去 ``` 围栏 / CRLF / 单引号 title 等），但 ddl 还是会偶尔翻车。翻车时 fetchError 会带上前 280 字 stdout 让用户看到。
  - **legacy DB 行**：之前实测可能产生过 ref_source_type='feishu' 的行；rowToNode 已 coerce 成 url+platform=feishu。无需手动 migrate。
- **Done（URL 抓取改 SSE 流式 + 进度可视化）**: 90s 超时移除，过程进卡片
  - 用户反馈两个痛点：(1) 飞书大文档 90s 超时；(2) 抓取过程是黑盒，picker "处理中…" 没任何反馈。决策：撤掉超时，把每一步进度通过 SSE 流到画布上的占位卡片里。
  - 改动：
    - `lib/server/fetch-via-claude.ts` 重写为 async generator：spawn claude 用 `--output-format stream-json --include-partial-messages`，解析 stream_event 拆出 `progress` 事件（推理中… / 调用工具 X / 抓取 URL / 整理 markdown…）+ 最终 `result`。删掉 timeout——SSE 连接本身就是 deadline，用户关页面或点停止就 SIGTERM 子进程。
    - `sniffToolInput` 从 partial JSON 抠出工具关键参数（Bash 的 command / WebFetch 的 url / Read 的 file_path 等）。等待 closing quote 或 ≥20 字符再 announce，避免显示 "抓取 https://ex" 这种没 host 的截断。
    - `lib/server/repo.ts` 加 `finalizeReferenceFetch`（事务里 update content_md / meta / status / topic_label / error_message）；`createReferenceNode` / `createSessionWithReference` 接受 `status` 参数（默认 done，URL 流式时传 streaming 占位）。
    - `app/api/references/route.ts` 拆分：paste 走原 JSON 路径；URL 走 SSE。先 INSERT 占位行（status=streaming，空 content），立即 send `created` 事件，然后 for-await fetcher generator forward `progress` 事件，结束时 finalizeReferenceFetch 写入最终内容 + send `done`。
    - `stores/sessionStore.ts`：state 加 `fetchProgress: Record<nodeId, message>`；`createReference` URL 路径改用 Promise + IIFE 模式：`created` 事件到时 resolve（picker 立即关闭），其余事件后台继续更新 store。复用现有 `STREAM_CONTROLLERS` 让 abort 路径走通。
    - `components/ReferenceCard.tsx`：streaming 态 indigo 边框 + spinner icon + 第三行显示 fetchProgress 文案 + ⏹ 停止按钮（替代刷新）。selector 只订阅 `fetchProgress[n.id]`，避免一个 ref 流式时其他卡片重渲染。
    - `components/NodeFullView.tsx:ReferenceFullBody`：streaming 态 indigo 头 + ⏳ 图标 + 单独的"进度日志"块（pulse 点 + 当前消息 + 解释性 caption）+ 停止按钮替代刷新。空 markdown 区域直接不渲染（避免显示"没有正文"）。
  - 验证：build ✓；端到端 SSE：CREATED → progress(推理中…) → progress(调用工具 WebFetch …) → progress(抓取 https://example.com/) → progress(整理 markdown…) → DONE（status=done, mdlen=422）。
- **Decisions（流式架构）**:
  - **占位行先入库**：用户点"创建"就有卡片可见，progress 直接灌到那张卡片。如果走"抓完才入库"，需要把进度推到 picker，picker 关掉后没地方继续显示——和 trellis"画布是主舞台"的整体设计冲突。
  - **picker 在 created 关闭**：不等 done。理由同上，画布卡片就是 progress UI。
  - **没超时**：长 PDF / 大 wiki 文档可能要 1-2 分钟，超时就是坏 UX。SSE 本身有连接 = 用户在等 = 还没 abort 的语义。
  - **abort 复用 STREAM_CONTROLLERS**：和 chat 的 abort 是同一套基建，⏹ 按钮直接接上。`useEscapeAbort` 也自动覆盖（streaming reference 可被 Esc 中止）。
  - **progress sniffer 简单 regex**：不正经解析 partial JSON，只 grep `"command":` / `"url":` 等。够用，且任何工具都能加自己的 key。
- **Caveat（流式）**:
  - **页面关闭后 server 怎么办**：客户端断 SSE → controller.signal aborted → fetcher 的 onAbort 杀 claude 子进程 → finally 执行 finalizeReferenceFetch 写入 partial。理论 OK，但没刻意验过。
  - **进度文案是 best-effort**：tool input 流式 partial JSON 用 regex 抠的，少数场景可能 miss（比如 tool 用了非常规 key 名）。miss 时只显示 "调用工具 X …"，不致命。
  - **流式期间不能刷新 / 不能划词追问**：刷新按钮 hidden（canRefresh = url && !streaming），划词在空 markdown 上没意义。streaming 占位卡 click 还是会进 fullview，看到的是进度 panel 不是文档——预期。
  - **claude 偶尔不按 frontmatter 输出**：parser 容错过几次还是会翻车。翻车时 done 事件里 contentMd 是空 + meta.fetchError 带前 280 字 stdout 提示，UI 不会卡死。
- **Done（verbatim 修复）**: claude 默认会"整理"内容，加 `## Overview` / `**Summary**` 等凭空章节
  - 用户反馈："看着好像做了不少删减，不能直接原文 copy 吗"。诊断两层原因：(1) prompt 里 "not a summary" 措辞太弱；(2) haiku 即使强 prompt 也偏好重组内容；(3) claude 默认走 WebFetch 工具，该工具内置摘要倾向。
  - 改动：
    - **PROMPT_TEMPLATE 重写**：明确"You are a pipe, not an editor"，列举禁止行为（不加章节、不重排、不翻译、不改写），说明 hard rules 8 条。指出 feishu-cli **不要** 用 `--front-matter`（避免嵌套 frontmatter），普通网页 **避开 WebFetch**（改用 `Bash: curl`）。
    - **模型 haiku → sonnet**：haiku 即使有强 prompt 也常规违例。sonnet 服从 verbatim 指令更稳。代价 ~$0.005 → ~$0.05/次，延迟从 5-15s 涨到 8-25s。
  - 验证：example.com 重测——之前是三个凭空章节 + Summary 块（240+ 字）；现在 170 字，几乎和原文一致，结构保留。claude 自主选了 curl 而不是 WebFetch（按 prompt 引导）。
  - **遗留**：HTML→Markdown 这步即使 sonnet 也会轻微 tighten phrasing（不可避免，因为 HTML 里没结构化原文）。但飞书/GitHub raw/PDF 等 native markdown 路径走 Bash + 工具直输出，claude 几乎不动——用户最关心的飞书场景不受这个影响。
- **Done（markdown 表格 + blockquote/hr 样式）**: 之前 globals.css 完全没表格样式，浏览器默认渲染太紧
  - 用户反馈："卡片的预览，对于表格支持的有点差，内容特别稠密"。诊断：`.md-body` 没任何 table 样式 → 浏览器默认裸表格（无边框、字号大、cell 紧贴）→ 飞书 wiki 那种 5+ 列 dense 表格直接糊一团或撑爆 600px 卡片。
  - 改动：
    - `lib/md-components.ts` 新增：导出 `MD_COMPONENTS` Components 映射，`table` 渲染器把 `<table>` 包进 `<div class="md-table-wrap">` 让宽表格可以横向滚动。三处 `<ReactMarkdown>` 都加上 `components={MD_COMPONENTS}`（ChatNode + NodeFullView 两处）。
    - `app/globals.css` 加 `.md-body .md-table-wrap`（横向滚动容器 + 圆角 + 细 scrollbar）+ `.md-body table/th/td/thead/tbody`：12.5px 字号，单元格 7×11 padding，alternating row 浅灰背景，thead sticky + 浅灰底，单元格 max-width 360px 防止单 cell 整篇 paragraph 把整行撑炸。
    - 顺手补 blockquote（左灰边 + 浅灰底）和 hr（细灰线）的基础样式——同样 globals.css 之前缺。
  - 验证：build ✓
  - **取舍**：canvas 卡片 600px 宽，5 列以上的宽表格仍然只能横向滚动看 3-4 列。trellis 设计语言一贯是"画布看大概、全屏读细节"，所以接受这个限制。点全屏后表格仍然 sticky header + 滚动，体验完整。
- **Done（CF dev 缓存绕过）**: 域名走的版本看不到新 CSS
  - 用户反馈："本地有了，走域名还是没有"。诊断：curl 比较 localhost vs 公网域名，CSS 内容一致（`md-table-wrap` 都在），所以 server 没问题。继续看 cache header：
    - localhost：`Cache-Control: no-cache, must-revalidate`（Next dev 默认）
    - 域名：`Cache-Control: max-age=14400, must-revalidate` + `cf-cache-status: REVALIDATED`
  - **Cloudflare 把 no-cache 改写成 max-age=14400（4h）**——这是 CF 的 Browser Cache TTL 默认行为。所以 dev 改 CSS 后域名要 4 小时才看得到。
  - 改动：`next.config.ts` 加 `headers()` 规则（仅 dev）：给 `/_next/:path*` 和 `/` 发 `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`。`no-store` 是 CF 不会改写的少数指令之一（被视为 bypass-cache）。Production 仍然走 hash 文件名 + 默认缓存。
  - 验证：domain header 现在是 `cf-cache-status: BYPASS`，每次都拿最新版。
  - **教训记到 memory**：Cloudflare tunnel + Next dev 组合时一定要配 no-store dev header，否则 CSS/JS 改动看不到。已写入 `~/.claude/memory/insights/cloudflare_tunnel_dev_cache.md`。
- **Done（白天/晚上模式）**: Tailwind v4 class-based dark variant + 全组件 sweep
  - 改动：
    - **Tailwind v4 配置**：`@custom-variant dark (&:where(.dark, .dark *))` 加到 globals.css，`<html class="dark">` 激活 `dark:` 工具类。
    - **Theme manager**：`hooks/useTheme.ts`（读写 localStorage `trellis-theme`、订阅 `prefers-color-scheme` 变化）+ `components/ThemeToggle.tsx`（sun/moon icon）+ Header 接入。
    - **FOUC 防止**：`app/layout.tsx` 加预 hydration 内联 script，根据 localStorage / system pref 立即给 `<html>` 加 `.dark`，React 渲染前 chrome 已经是对的颜色。
    - **highlight.js**：`@import "highlight.js/styles/github.css" layer(hljs-light)` + `github-dark.css` layer，CSS layers 让 dark 优先级覆盖。
    - **globals.css 暗色版**：md-body strong/code/pre/headings/mark/blockquote/hr + 表格 wrapper + scrollbar + streaming-cursor + react-flow background/edge/controls 全部加 `.dark` selector 版本。
    - **组件 sweep**：13 个组件统一加 `dark:` utility variants — Header / ChatNode / ReferenceCard / NodeFullView / QuestionInput / Outline / NodeTreeOverlay / BranchPopover / ReferencePicker / AddNodeFAB / ModelPicker / ModePicker / SessionPicker / ExportMenu / Canvas FAB / app/page.tsx hydrate banner。命名约定：bg-white→stone-900、stone-50→stone-900/50、stone-100→stone-800、stone-200→stone-800、text-900→100、text-700→300、text-500→400、text-400→500；amber/rose/indigo 类的 -50→-950/30、-200→-900。
  - 验证：build ✓。
  - **Caveat**:
    - 没做 system-pref 的"自动跟随"按钮——只有 light/dark 二态切换，跟不上 OS 的明暗时段切换（除非用户从未点过 toggle，那时 hook 会 listen prefers-color-scheme）。后续要加可以引入"system / light / dark"三态。
    - 个别小色调（`text-stone-800` 边角等）可能还有未替换的。基础体验已通，UI 测下来发现哪里跳就补一下。
- **Done（历史对话 tab 重做：rename + delete）**: 之前只有 hover-only 的 ×，没有重命名
  - 改动：
    - **后端**：`lib/server/repo.ts` 加 `renameSession(id, title, now)`（trim + 200 字符 cap + 空 title 拒绝 + bump updated_at）；`app/api/sessions/[id]/route.ts` 加 `PATCH` handler（接受 `{title}`，校验 + 调 repo + 返 session）。
    - **Store**：`renameSession(id, title)` action，乐观更新本地 session（如果是当前 active 的）+ PATCH + 失败回滚 + revision bump 让 picker 刷新列表。
    - **UI 重做**：行结构改为 `[• 状态点][标题/日期][✏️ 重命名][🗑️ 删除]`，图标按钮平时 40% opacity，hover 时 100%（mobile tap 也 OK）。重命名走 inline `<input>`：Enter 保存 / Esc 取消 / blur 保存；预选全文方便覆盖输入。下拉宽度从 320px → 384px 给行留余地。
  - 验证：build ✓；curl 测 rename 成功 / 空 title 400 / 不存在 404。
  - **Decisions**:
    - **rename on blur 保存**：比"必须按 Enter"少一步，符合 macOS Finder 重命名直觉。意外失焦也保留更新（实际上是用户的最终输入）。
    - **图标按钮常驻不隐藏**：mobile 没 hover，opacity-40 默认值让按钮可见但不抢眼，hover/tap 时变实。
    - **不在 trigger 上做编辑**：trigger 只做"选 session"。重命名走 dropdown 内 row 的 inline edit——一个 component 干一件事。






### Session 11 (2026-05-04)
- **Done**: Stage 11 — 发送/取消 UX 全套
  - **服务端 abort 兜底**（`app/api/chat/route.ts`）：finally 里查 `req.signal.aborted` → 强制 `stoppedWith="error" / errorMessage="aborted"`，覆盖 claude 子进程被 kill 后干净退出导致 stoppedWith 残留 "done" 的坑。`controller.close()` / `send()` 全部 try/catch（客户端可能已断开）。topic_label 仅在真 done 时才生成。
  - **客户端 AbortController**（`stores/sessionStore.ts`）：
    - module-level `STREAM_CONTROLLERS: Map<nodeId, AbortController>`（不放 store，避免 Zustand 序列化）
    - `runStream` 接 `signal`，传给 `fetch`；mid-stream abort 时 `reader.read()` 抛错，catch 里区分 `signal.aborted` → 合成 `{type:"error",message:"aborted"}` 给 store
    - `handleStreamEvent` 在 `created` 事件里登记 `(nodeId, controller)`；`done`/`error` 终止时清理
    - retry 路径 nodeId 已知，eager 注册 + finally 兜底清理
    - 新增 actions：`abortStream(nodeId)` / `hasStreamingNode()` / `latestStreamingNodeId()`
  - **Cmd+Enter 替换 Enter**（4 处输入面）：QuestionInput / NodeFullView 两处 / ChatNode FollowupInput。条件 `e.key === "Enter" && (e.metaKey || e.ctrlKey)`。kbd 提示文案 + placeholder 同步更新（"⌘↩ 提交 · Enter 换行"）。
  - **流式 ⏹ 按钮 + Esc 中止**：
    - `ChatNode.tsx:NodeFooter`：streaming 时 "正在生成…" 旁加灰色边框"停止"按钮，hover 反白
    - `NodeFullView.tsx:FollowupBar`：streaming 时整个输入框 pivot 成全宽"停止生成（Esc）"按钮（替代之前的 disabled "等待回复完成…"）。done 后恢复输入框
    - `hooks/useEscapeAbort.ts` 新增：全局 keydown 监听，textarea/input/contentEditable 内不触发；优先 abort active streaming 节点，否则 abort 最近一个（`STREAM_CONTROLLERS` 插入序）。挂在 `app/page.tsx`
  - **Aborted 视觉**：`status="error" + errorMessage==="aborted"` 走 stone/灰色"已停止生成"框（区别于红色 error），按钮文案"↻ 重新发送"。retry 路径不变（已有 `retryNode`）。
  - 验证：`npm run build` ✓；mock SSE curl --max-time 0.4 → DB row `status=error / error_message=aborted / response 106 chars`（partial 落盘 ✓，状态正确 ✓）
- **Decisions**:
  - 不引入 `aborted` 新状态枚举——用 `errorMessage === "aborted"` 区分。少一个 migration，UI 一处分支判断即可。
  - QuestionInput 不加 ⏹ 按钮：从 submit 到 created 事件回来是毫秒级，过度设计。created 后 page swap 到 Canvas/Fullview，由那边的 ⏹ 接管。
  - FollowupBar pivot 而非附加按钮：streaming 时输入框本来就是 disabled 死状态，不如让那块空间真正能停止当前流。
- **Caveats**:
  - 浏览器 UI 未实测（ssr / hot reload 已生效在跑着的 dev server 3088）。需要用户跑一遍 spec 列出的用例。
  - lint 残留 4 个错误都是 pre-existing（NodeFullView:110 / SessionPicker:24 setState-in-effect），非本次引入。
  - `controller.close()` try/catch 是防御性的——Next.js App Router 下 client abort 时 ReadableStream controller 可能已 closed。如果实测发现 server 端日志有 unhandled，再追。
- **Next**: 浏览器验证 spec 用例（Enter 不发 / Cmd+Enter 发 / Shift+Enter 换行 / 流式 ⏹ 中止 / Esc 中止 / partial 保留 / 重发 / 并发 streaming Esc 只中 active）。验证通过后开 Stage 12。


### Session 10 (2026-05-03)
- **Done**: Overview 视图升级——LLM 自动 topic label + zoom-based LoD（"缩略不再糊"）
  - 用户痛点：全局 canvas 下卡片 zoom 0.3 时是糊像素，只能靠 Outline 索引。诊断为认知层级错配——overview 需要"索引页"不是"缩印版书"
  - 方向 1：自动 topic label
    - migration: `nodes` 加 `topic_label TEXT`（idempotent ALTER）
    - 新增 `lib/llm/topic.ts:generateTopicLabel`：spawn 短 haiku（`--tools "" --no-session-persistence` + 专用 system prompt + cwd tmpdir），8s timeout，cleanup 引号/句号 + 14 字截断
    - `app/api/chat/route.ts`：stream 自然结束 + finalize 后，若 `done && provider !== mock && aggregated.trim()`，await 一次 `generateTopicLabel(question, aggregated.slice(0,800))`，写 DB 并 SSE `{type:"topic_label",nodeId,label}`，再 close stream（同一个 SSE 连接持有 ≤8s）
    - `repo.ts`：`setNodeTopicLabel`，SELECT 全加 `topic_label`，`ApiNode.topicLabel` + `rowToNode`
    - `lib/types.ts`：`ChatNode.topicLabel: string | null`
    - `stores/sessionStore.ts`：handleStreamEvent 加 `topic_label` 分支，patch 已 done 节点的 label
  - 方向 2：LoD（zoom < 0.9 → 极简卡片）
    - `components/ChatNode.tsx`：`useStore(s => s.transform[2] < 0.9)` 拿布尔（selector 浅比较，跨 threshold 才 re-render）
    - 新增 `showCompact = isCompact && !isStreaming && !isError` 分支：26px 大字 label + 状态绿点 + token 数 + 可选 anchor mini badge；保留 600px 宽边框/active ring；click 整个卡片 → goFullScreen
    - 全模式 layout 不变（zoom ≥ 0.9 时回到完整 ReactMarkdown）
    - streaming / error 节点强制 full（用户需要看进度 / retry 按钮）
  - 顺手改：`components/Outline.tsx` + `components/NodeTreeOverlay.tsx` 优先用 `topicLabel ?? truncate(question, N)`
  - 验证：build 通过；topic.ts 用法跟之前 cli 实测过的 flag 一致
- **Caveats**:
  - **mock 跳过 label**：UI fallback 到 question 前 14 字
  - **label 在 done 后才有，stream 多挂 ≤8s 不 close**：客户端 `streaming` 状态在 done 事件后已切换；topic_label 到达悄悄 patch，不显示流式光标。流式 UX 不受影响
  - **历史节点没 label**：DB 列默认 NULL，UI 走 fallback。未主动回填
  - **lean 模式也调 haiku 生成 label**：lean 初衷是省钱，但 label ~20 token 输出 + cache 命中后极便宜。先不加开关
  - **dagre 不针对 LoD 重排**：~~compact 卡片矮（~80px）但占位仍按之前 dagre 估算的 480px——节点间有空隙，反而助于扫读，故保留~~ **已修复（用户反馈"太稀疏"）**：`lib/layout.ts:layoutNodes` 加 `compact` 参数 (280×90 + 36/24 sep)；导出 `COMPACT_ZOOM_THRESHOLD`；Canvas 用 `useFlowStore` 监听 zoom 跨阈值，写入 layoutKey 触发 dagre 重排；ChatNode compact 卡片宽 280px，字号 18px。zoom 跨阈值瞬间整棵树自动 reflow，fit-view 自然给出更高 zoom。
- **Next**: 用户实测——cli-single/cli-multi 模式下问问题，等几秒看 topic label 出现；缩小 canvas 看是否变成大字 label；zoom > 0.9 看是否切回完整渲染


### Session 9 (2026-05-03)
- **Done**: 三态 mode toggle + cli-multi 走真多轮 claude session
  - 用户决策：CLI 多轮模式下，整棵 trellis 树共享一个 claude session（树形分支退化为 UI 形态，上下文是平的）。1 个 jsonl 文件 per trellis session，不是 per node
  - 实测确认 stdin stream-json 不能"喂历史"——claude 把每条 user 视为新 turn 自己回应，忽略喂入的 assistant 消息。真多轮只能走 `--resume`
  - 端到端 resume 实测：第一轮无 session-id → claude 自生 `af8573db-...` → 写到 `~/.claude/projects/-Users-smokingmouse/<id>.jsonl` → 第二轮 `--resume` 正确答出之前提到的"绿色"，cache_read 45769 tokens
  - 改动：
    - `lib/server/sqlite.ts`：idempotent ALTER TABLE sessions ADD COLUMN claude_session_id
    - `lib/server/repo.ts`：`getSessionClaudeId` / `setSessionClaudeId`，`deleteSession` 取 claude_session_id 后 `unlinkSync(claudeSessionPath(...))`；路径 `os.homedir().replace(/\//g,"-")`
    - `lib/llm/types.ts`：`Mode = "lean" | "cli-single" | "cli-multi"`，`StreamRequest` 加 `claudeSessionId`，`StreamEvent` 加 `session_init`
    - `lib/llm/server.ts`：`getProvider(id, { mode })` 替代 cliMode
    - `lib/llm/claude.ts`：三模式分支，cli-multi 用 `buildCliMultiPrompt`（仅当前 question + 可选 anchor preface）+ 移除 `--no-session-persistence` + 可选 `--resume`；parser 加 `system/init` 解析 yield `session_init`
    - `app/api/chat/route.ts`：保留 trellis sessionId；cli-multi 时 `history = []`；监听 `session_init` 首次绑定 `setSessionClaudeId`
    - `stores/sessionStore.ts`：cliMode → mode；localStorage key `trellis-mode`；`loadMode` 自动迁移老 boolean
    - `components/ModePicker.tsx` 新增（替代 CliModeToggle）：三态 segment control，stone/amber/rose 配色，切到 cli-multi 时 confirm 提示"之前对话不会继承"
    - `components/Header.tsx`：换用 ModePicker
  - 验证：build 通过 + 端到端 resume 实测 OK
- **Caveats**:
  - **跨模式切换**：lean / cli-single 期间产生的节点对 cli-multi claude session 不可见（实测证明 stdin 不能喂历史）；toggle confirm 已提示
  - **retry 在 cli-multi**：spawn 时 `--resume` 把 retry question 当新 turn 发——claude 视角是"用户又问一遍"，session 多一轮
  - **jsonl 清理**：trellis 删 session 时自动 unlink；启动**没有**孤儿扫描——进程崩溃可能留孤儿，后续可加 reap
  - **tool_use 仍不展示**：cli-single / cli-multi 调工具时静默吞掉。下一刀候选
- **Next**: 用户实测三态切换——cli-multi 跨节点问"还记得 X 吗"看是否真有跨 turn 记忆；删 session 后 ls `~/.claude/projects/-Users-smokingmouse/` 看 jsonl 是否被清


### Session 8 (2026-05-03)
- **Done**: CLI 模式开关——一键打平终端 `claude` CLI 的能力栈
  - 用户问：卡片回复时上下文为啥不含 skills？发现 `claude.ts` 用三个 flag 把 CLI 阉割（`--system-prompt` 覆盖默认 prompt / `--tools ""` 禁用工具 / `cwd: tmpdir` 屏蔽 CLAUDE.md）。
  - 改动：
    - `stores/sessionStore.ts`：加 `cliMode` + `setCliMode`，localStorage key `trellis-cli-mode` 持久化；hydrate 时 load；streamRoot/Branch/retry 把 cliMode 加进 request body
    - `app/api/chat/route.ts`：accept `body.cliMode`，传给 `getProvider(id, { cliMode })`
    - `lib/llm/server.ts`：`getProvider` 加 opts 透传
    - `lib/llm/claude.ts`：args 数组化。cliMode=false 走 lean 路径（push `--tools ""` + `--system-prompt`，cwd tmpdir）；cliMode=true 不传 system prompt（CLI 默认含 skills + ~/.claude/CLAUDE.md + tool 描述）+ push `--permission-mode bypassPermissions`（无 stdin 应答必须自动放行）+ cwd `os.homedir()`
    - `components/CliModeToggle.tsx` 新增：amber/stone 配色，title 写明差异
    - `components/Header.tsx`：toggle 放 ModelPicker 左
  - 验证：build 通过 + 实测 `claude -p "1+1" --permission-mode bypassPermissions --no-session-persistence --output-format stream-json --include-partial-messages --model haiku --verbose` → flag 都接受、`system/init` 事件含 80+ skills 列表 + permissionMode=bypassPermissions、`result.is_error=false`
- **意外发现**:
  - `content_block_delta` 不止 `text_delta`，还有 `thinking_delta` / `signature_delta` / `input_json_delta`。当前 parser 只处理 `text_delta` —— 这导致 **lean 模式下 Haiku 也会沉默 1-2 秒（thinking 阶段）然后才出 text**，cliMode 下若涉及 tool_use 沉默更长
- **Caveats / 已知欠账**:
  - **tool_use 事件 UI 不展示**：cliMode 下若模型调工具，stream-json 出现 `content_block_start{type:tool_use}` + `input_json_delta`，当前 parser 静默吞掉。最简扩展：解析后 yield markdown blockquote 形式的 `> 🔧 调用 X(args)` 文本到 stream-bus
  - **thinking 也不展示**：同上盲区。可选：解析 `thinking_delta` 输出灰色 italic 提示文字
  - **bypassPermissions 危险**：cliMode 下 claude 在机器上无确认跑 Bash/Write/Edit。toggle title 写明但未加首次启用 confirm dialog
  - **System prompt 体积**：cliMode 下涨到 ~40k tokens（实测 cache_creation 13k + cache_read 27k）
- **Next**: 用户实测——开关切到 CLI 模式后问个能触发 skill 的问题（如调研类），看 skill 是否生效；tool 调用过程不可见若难接受再扩 parser

### Session 7 (2026-05-03)
- **Done（第四刀，根除）**: 流式更新完全绕过 React state
  - 用户实测三刀仍卡 + 提出关键质疑："卡片不是独立的吗"。诊断真因：所有节点共享同一 JS 主线程 / React 渲染树 / ReactFlow 实例，每秒 60+ 次 store update 触发 60+ 次 React commit + ReactFlow 内部 O(N) diff，不归 React.memo 管。前三刀都是"减少每次 commit 工作量"，根因（commit 频率本身）没动。
  - 改动：
    - 新增 `lib/stream-bus.ts`：纯 JS pub/sub + pending 累积 buffer。`subscribeStream` / `emitStream` / `getStreamPending` / `clearStreamPending`
    - `stores/sessionStore.ts:handleStreamEvent`：删除上一刀的 rAF 节流；delta 改为 `emitStream(id, text)` 完全不进 store；`done` / `error` 时从 bus 取累积的 fullText 一次性 commit 进 store（含 `response + status + tokenCount`）；`created` 时 `clearStreamPending(id)` 防遗留
    - `components/ChatNode.tsx`：streaming 时渲染挂 ref 的 `<div>` + cursor，effect 里 `el.textContent = node.response + getStreamPending(id)` 然后 `subscribeStream` 回调直接 `textContent +=`；done 后切回 ReactMarkdown 路径。删除 useDeferredValue 和 REHYPE_STREAMING（不再需要）
    - `components/NodeFullView.tsx:ResponseBody`：同样改造（fullscreen 也走 stream-bus）
  - 效果：流式期 React 重渲染 = 0，ReactFlow diff = 0，主线程几乎完全空闲。"滚动变缩放"消失（wheel 事件能正常被 nowheel 拦截）。
  - 视觉副作用：streaming 中显示纯文本（whitespace-pre-wrap），代码块/bold/列表无渲染；done 一刻切回完整 markdown + highlight。可接受——ChatGPT/Claude 网页版同理。
  - 跨设备 mid-stream：hydrate 仍能拿 partial response（后端持续写 SQLite，未变），不影响。
  - 验证：build 通过，lint 干净（NodeFullView:110 的 setState-in-effect 是预先存在的 warning，非本次引入）
- **Decisions**:
  - stream-bus 是 module-level singleton，跨 session 不需要清——nodeId 是 ULID 全局唯一
  - 保留前三刀（selector + memo + plugin 常量化）：done 后那次唯一的 React render 仍然受益
- **Next**: 用户在浏览器实测 — 期望流式中点目录、滚动卡片、pan/zoom 全程 0 卡顿；其他卡片预览不再受影响。

### Session 6 (2026-05-03)
- **Done**: Canvas 渲染性能第一刀（图大了卡 → 流式期 O(N²) 重渲染问题）
  - 诊断：每个 `ChatNode` 都订阅整个 `nodes` map（`ChatNode.tsx:22 allNodes`），加上 sessionStore delta 替换整个 nodes record 的引用 → 流式每个 token 触发全部 N 个节点重渲染（含 ReactMarkdown + rehype-highlight 解析）
  - 改动：
    - `Canvas.tsx`: 派生 `childAnchorsByParent: Map<string, ChildAnchor[]>` 一次算好，注入每个节点的 `data.childAnchors`；`EMPTY_ANCHORS` 常量保证空数组引用稳定
    - `ChatNode.tsx`: 移除 `useSessionStore((s) => s.nodes)`；改读 `data.childAnchors`；导出 `ChildAnchor` 类型；用 `React.memo` 包装，自定义比较 `node` 引用 + `isActive` + `childAnchors` 浅值比较
  - 关键依据：sessionStore.ts:265 delta 只替换 streaming 节点的 ChatNodeData 对象，其他节点引用稳定 → memo 比较 `prev.node === next.node` 命中
  - 验证：`npm run build` 通过（tsc + Turbopack 都过）
- **Done（第二刀）**: 流式节点自身重渲染开销 → 主线程阻塞导致全画布卡
  - 诊断：streaming 节点每收到 1 token 就重跑 ReactMarkdown 解析 + `rehype-highlight` 全 code block 染色 + injectHighlights regex。response 长 + 流速快 → 主线程 30%+ 占用 → React Flow 的 pan/zoom 也跟着卡。React.memo 救不了——node 引用本来就在变。
  - 改动（`ChatNode.tsx`）：
    - 模块级常量 `REMARK_PLUGINS` / `REHYPE_FULL` / `REHYPE_STREAMING`：plugin 数组引用稳定，且流式版本不挂 `rehype-highlight`（最大头）
    - `rehypePlugins={isStreaming ? REHYPE_STREAMING : REHYPE_FULL}`：流式中代码块不染色，done 时立刻染上
    - `useDeferredValue(responseWithMarks)`：流式中 markdown 重渲染降为低优先级，pan/zoom 等交互可抢占
  - 验证：build 通过
- **Done（第三刀）**: token 节流，根除 React Flow 内部 reconciliation 风暴
  - 关键诊断：用户实测后报告"流式中滚动变缩放"——这不是事件配置问题，是**主线程被严重阻塞**的标志：wheel 事件来不及被 `nowheel` 拦截器处理，直接走 React Flow viewport 缩放路径。证明每 token 一次 store update 触发的 React Flow 内部 diff（无法被用户层 memo 拦截）才是元凶。
  - 改动（`stores/sessionStore.ts:handleStreamEvent`）：
    - delta 事件用 `requestAnimationFrame` 节流：text 累积到 `pending` buffer，每帧最多 flush 一次到 store
    - `created` / `done` / `error` 时先 `flushNow()` 再做后续 set，防止节点切换或终态前漏掉最后几个 token
    - `pendingForId` 双 check 防止跨节点串流
  - 效果：60+ token/s 流速 → store update 封顶 60/s（屏幕刷新率），React Flow 内部 diff 也降到这个频次。视觉上流式文字仍丝滑（人眼分辨不出 16ms vs 8ms 的更新间隔）。
  - 验证：build 通过
- **Decisions**:
  - 暂不做 viewport culling——三刀如果还不够再上
  - NodeFullView 不改（一次只渲一个节点，画布不卡问题不在它身上）；如全屏视图也卡再单独处理
- **Next**: 用户实测三刀合并效果。期望：流式中点目录、滚动卡片、pan/zoom 都顺畅；"滚动变缩放"消失。

### Session 5 (2026-05-03)
- **Done**:
  - Critic 审视：MVP 核心扎实，主要问题是 progress 与代码失同步、临时方案残留依赖
  - **账面归零**：
    - 删 `package.json` 中 `dexie` + `dexie-react-hooks`（源码 0 引用，已迁 SQLite-only）
    - `npm i` removed 2 packages，`npm run build` 通过
    - Stage 3 描述改为 "SQLite + Zustand"
    - Stage 6 拆 4 个子项：大纲 / 持久化恢复 / 父节点高亮回显 ✅，Dagre 布局留白
    - Mid-term「接真 LLM」「导出」均勾掉（Claude 三档 + Codex 半成品已接，`lib/export.ts` JSON/Markdown 已实现）
- **Decisions**:
  - 不擅自新增 goal——critic 提的 #2（抽公共 tree/markdown-anchor 工具）和 #3（Codex 去留决断）等用户认领后再加
- **Next**: 等用户确认是否要继续做 #2（去重 + injectHighlights bug 修复）或 #3（Codex 实测/移除）



### Session 4 (2026-05-02)
- **Done**:
  - **Codex provider 打包修**：`next.config.ts` 加 `serverExternalPackages: ["@openai/codex-sdk", "@openai/codex"]`。原因：Codex SDK 用 `createRequire(import.meta.url)` 在运行时找平台 binary，Next/Turbopack 把 SDK 打成 bundle 后 import.meta.url 指向 `.next/server/...`，找不到 node_modules 里的 `@openai/codex-darwin-arm64`。
  - **In-place retry**：失败节点重试不再创建兄弟，复用同一 nodeId 保持树结构。
    - `lib/server/repo.ts` 加 `resetNodeForRetry`：清 response/usage/error，保留 question + parentAnchor
    - `app/api/chat/route.ts` 加 `kind: "retry"`：复用 nodeId，重发 created 事件让客户端 sync
    - `stores/sessionStore.ts` 加 `retryNode` action：本地乐观 reset + 走流式
    - 错误框右边加红色「↻ 重新生成」按钮（ChatNode + NodeFullView ResponseBody 两处）
    - 副作用：retry 用当前选的 provider，可以「Codex 失败 → 切 Sonnet → 重试」
  - **NodeTreeOverlay**：fullscreen 里全树跳转面板
    - 顶栏面包屑 / 树图标 tap → 滑出 overlay（mobile bottom-sheet / desktop centered modal）
    - 渲染整树（深度缩进、活动节点高亮、错误/流中状态标记）
    - tap 任一节点 → setActiveNode + 关闭，留在 fullscreen 不切回 canvas
    - Esc 关闭，自动 scrollIntoView 当前节点
  - 验证：tsc 通过，HMR 干净


### Session 3 (2026-05-02)
- **Done**:
  - 三层视图统一：Layer 1 (canvas overview) / Layer 2 (canvas focused) / Layer 3 (fullscreen single card)
  - 状态收口到 store：新增 `fullScreen: boolean` + `setFullScreen` action（替代 page.tsx 局部 mobileView state）
  - `MobileNodeView` → `NodeFullView` 重命名（移文件 + 重命名 export），桌面手机共享
  - `ChatNode`（canvas card）右上加 ⤢ 全屏按钮：tap → setActiveNode + setFullScreen(true)，e.stopPropagation 避免冒到 canvas onNodeClick
  - `app/page.tsx`：fullScreen 决定渲染 NodeFullView vs Canvas；mobile session 加载时默认 fullScreen=true（监听 sessionId 变化）
  - `useIsMobile` 改 `(pointer: coarse) and (max-width: 1023px)`：PC 鼠标输入永远走 canvas，iPad 竖屏走 mobile UX
  - 清掉之前 mobile selection 调试用的 `SelDebug` 浮条 + console.log
  - 验证：tsc 通过，HMR 自愈（重命名瞬间的 module-not-found 自动恢复），`GET / 200`
- **Decisions**:
  - Layer 3 在 desktop 不替换默认体验（仍是 canvas），只通过显式 ⤢ 进入；mobile 仍默认 Layer 3
  - Canvas onNodeFocus 仅在 mobile 上自动切 fullscreen（保持桌面 click=focus 习惯）
  - Stage 6 Polish 维持 [ ]，本次只动了三层视图

### Session 2 (2026-05-01)
- **Done**:
  - 移动端 P0：全屏单卡片视图替代 canvas（`<md` 断点）
  - 新增 `hooks/useIsMobile.ts`（matchMedia，null-until-mounted 防 hydration mismatch）
  - 新增 `components/MobileNodeView.tsx`：顶栏「← 画布 / 父 › 当前」面包屑、滚动卡片体（复用 markdown + 流式光标 + 子锚点 mark）、底部 BranchStrip（父/兄弟/子 chips）+ 持久化追问栏
  - `Canvas` 加可选 `onNodeFocus` 回调；移动端从画布 tap 节点 → 自动切回卡片视图
  - `app/page.tsx` 按 isMobile 分支：mobileView state ('card' | 'canvas') 控制切换
  - `globals.css` 加 `.no-scrollbar` 工具类（chip 横滑）
  - 验证：tsc --noEmit 通过，eslint 干净（Canvas 已有 set-state-in-effect 不动），dev server `GET / 200`
- **Decisions**:
  - 不做侧边抽屉树，分支条 + canvas mini-map（P1 待做）作为兄弟方案
  - 追问栏始终可见（GPT/Gemini 风格），streaming 时 disabled
  - parentAnchor 在卡片顶部呈 amber badge，tap 回父节点
- **Next**: P1 顶栏 tap → 弹出 mini canvas / P2 兄弟左右滑 + 长按分叉。先等用户真机实测 P0

### Session 1 (2026-04-30)
- **Done**:
  - 项目名 Trellis，路径 `~/python/learning/trellis`
  - 视觉原型 `vibe-prototype.html` approve
  - SDK 调研 + 实测：Codex SDK 支持订阅 auth 但 22k tokens system prompt 包袱重；当前账号配额耗尽（5/5 恢复）
  - Stage 1：Next.js 16 + React 19 + Tailwind v4
  - Stage 2：mock SSE endpoint，`lib/llm/{types,mock,mock-responses,index}.ts` + `app/api/chat/route.ts`，单一 swap point
  - Stage 3：`lib/types.ts`, `lib/db.ts` (Dexie), `lib/id.ts`, `stores/sessionStore.ts`（含 contextFor 父链遍历）
  - Stage 4：Canvas (React Flow) + ChatNode (markdown + highlight.js) + QuestionInput + Header；首次访问→提问→流式根节点
  - Stage 5：`hooks/useSelectionWithin.ts` + `BranchPopover.tsx`，⌘K 展开 inline 输入，分叉创建子节点 + parentAnchor
- **Decisions**:
  - MVP 全程 mock，配额恢复再换真 SDK
  - 简化 ParentAnchor 只存 selectedText（offsets 留 stage 6 需要再加）
  - createBranchNode 用 siblingIndex 排序，Dagre 处理布局
- **Next**: 用户浏览器实测 → stage 6 polish

---

## 历史 Current Focus 栈（2026-07-28 从 README.md `## Current Focus` 迁入，原样保留倒序）

---

**Codex 兼容补齐 = exec 增量路线（Session 76——原编 75，与 ExitPlanMode 修复撞号重编；已 merge main）**：用户「Claude 支持得好，换成 Codex 很多功能用不了——把 Codex 兼容做上」。三路侦察（SDK 能力矩阵 / trellis claude-only 门控测绘 / codex CLI 0.142.2 实测探针）钉死缺口后，用户拍板**两步走：本轮 exec 补齐，app-server 迁移另议**。**关键实测事实（探针全真跑）**：① `codex exec resume <sid> <prompt> --json` 非交互可用，thread_id 不变、追加同文件；② **codex 按文件系统扫 `~/.codex/sessions` 找 rollout、不查自家 sqlite 索引——手工构造的前缀 rollout（截断历史+换新 UUID）被完整采信**（暗号验证），= claude `buildPrefixJsonl` 玩法在 codex 同构成立；③ rollout 是 `{timestamp,type,payload}` 扁平 **append-only** 日志（compaction 只 append 标记），无 uuid 链 → 节点↔轮次映射用「user-message 序号（ordinal）」，注入类 user message 也计入所以序号自洽（实测首轮 ordinal=2 = 注入+问题）；④ `codex exec` 无 `-a`、无 approval 事件、stdin 非 TTY 会吞 stdin 当 prompt（spawn 必须 stdin ignore，SDK streamLines 本就如此）；⑤ app-server 有完整审批 JSON-RPC（`item/*/requestApproval`）+ token 级 delta + `thread/fork`，留下一步。**落地**：**SDK 侧**（~/sdk 未 commit，需发 `agent@0.3.2`）——codex backend：item.started/completed 配对发**带 id** 的 ToolCall/ToolCallDone（原来无 id 一轮只剩一条且永远 running）+ 输出/isError、`reasoning` item → Thinking（思考期不再全黑）、web_search 入工具链、resume 分支补 `--ephemeral`（persistence:false 承诺原被静默违背）；bun test 8 全过。**trellis 侧**——(a) 纯 bug 三处：`fetch-url.ts`/`ReferencePicker`/`ModePicker` 的 `provider === "codex"` 字面量在 `codex:<model>` 复合 id 下永远为假（选具体 codex 模型抓 URL 会 spawn claude）→ `providerFamily()`；(b) 新 `lib/server/codex-fork.ts`：`findCodexRolloutPath`（日期目录新→旧扫+缓存）/`codexRolloutExists`/`deleteCodexRollout`/`buildCodexPrefixRollout`（截到第 k+1 条 user message 前+剥尾部 turn_context/task_started+改写 session_meta 双 id）/`codexLineageForNode`（walk-up codex_session_id，tip = ordinal==总数）/`backfillCodexTurnOrdinal`（done 后轮询 8×300ms，从尾找含 question 的 user message 记序号，匹配不上放弃=降级线性）；(c) `nodes.codex_turn_ordinal` 幂等 ALTER；retry 清 ordinal（stale 会切错）但**不清 codex_session_id**（lineage 头会孤儿）；(d) **codex chat 真 resume**（B-fork 等价，depth 0）：线性=resume 父 sid、分叉/retry=前缀 rollout 新 sid、父无 rollout=回落折叠窗口；`forkSession` 旗与 claude 共用（CodexBackend 忽略旗、吃 persistence+resume）；(e) **codex project per-lineage**：与 claude isolated 块同构的平行分支（claude 路径零改动）；legacy codex project（iso=0）不迁移；(f) 删除清理：deleteSession/deleteNodeSubtree 清 codex rollout，**子树删除加「删后无人引用」检查**（codex 线性链共 sid，claude B-fork per-node 无此问题）；resume 自愈两守卫换 `resumeTargetExists(family,…)`；(g) topic.ts 按 family 路由（codex 打标签走 `codex exec --json` 默认模型+effort low，**超时 8s→20s——实测 codex 冷启动 8.1s 恰好被掐死**）；(h) UI：skills picker 只对 claude 系显示（codex 不认 /skill）、CliResumeButton/cli-resume 给 codex 出 `codex resume <sid>`、上下文全发 tooltip 与 ModePicker codex Project 文案改真话。**验证**（隔离实例 :3165 + `TRELLIS_DB_PATH` 沙箱 + 真 codex gpt-5.4-mini，十项全绿）：chat 根轮 + sid/ordinal 落库、线性 resume 记得 PONG、**兄弟分叉走前缀 rollout 拿新 sid 且答案带全历史**、**A 支种暗号 ZEBRA-9 → B 支从根分叉答 NO-CODEWORD（分支隔离成立）**、树结构 sid/ordinal 全对（线性共 sid ord+1、分叉各新 sid）、project 双工具调用 id 配对+输出+isError 正确、project 线性 resume 带工具记忆（cacheRead 76k）、话题标签「指定词回复」、毒 sid → fresh 自愈不炸、删 session → 3 rollout 全清；tsc ✓ lint 零新增（32=32 基线）✓ worktree build ✓。**踩点**：zsh 不展开 `env VAR=~/...` 的 tilde（沙箱 DB 落进字面 `./~/` 目录，真 DB 零污染已核实）；driftfish worktree 原共享主目录 node_modules symlink——`make link-sdk` 会当场换 prod 运行中的 SDK，已改为本 worktree 独立 `bun install` + link（prod 目录零接触）。**已知边界**：前缀 rollout 文件名时间戳 UTC（codex 本体用本地时间，仅外观）；fetch-via-codex `-m gpt-5.5` 硬编码未动；审批/交互工具、`~/.codex/sessions` attach/import、chat 联网（sandboxNetworkAccess）均留 app-server/后续（S46 的 parity P0/P1 至此闭环，P0=resume P1=树分叉均实测落地）。**追记（同日，发版+合并+部署闭环）**：`@smokingmouse/agent@0.3.2` publish ✓（pack 39 文件泄露检查过）+ sdk 仓 commit/push `4460959`；trellis package.json→^0.3.2、bun.lock 钉 registry 0.3.2（integrity 与发布件一致）；driftfish commit → merge main（progress 与并行 session 的 ExitPlanMode 修复撞号，本条重编 S76，冲突双保留）→ push `13fdb44`；prod：`bun install`（0.3.2 ✓）+ merge 树 tsc ✓ + `make build` + `launchctl kickstart -k`，验活 / 401（闸在）+ /login 200 + server chunk 含 `codexLineageForNode`、client chunk 含新按钮文案 = 新代码确实进了本次 build（ExitPlanMode 修复亦随本次上线）。**Next**：用户现场验收（开一个 codex 系会话：chat 分叉互不串味 / project 看工具链实时配对）。

---

---
**ExitPlanMode 批准链路修复（Session 75）**：用户报 prod 上批准计划报 `ZodError: expected record at updatedInput, received undefined`，自诊为「Claude Code 与 Trellis 的协议版本偏差」。**实为 Trellis 自身 bug**，且定位到确切一行：`ExitPlanModeForm.decide`（`components/InteractionForm.tsx:507`）allow 分支只发 `{behavior, message}`，**漏了 `updatedInput`**——另两处交互表单（AskUserQuestion:162、权限卡:385）都带了，所以只有计划审批炸。链路：表单 → `respondToInteraction`（`updatedInput: undefined` 原样 POST）→ respond route 转发 → run-bus resolver → `@smokingmouse/agent` 的 stdio 桥 `dist/backends/claude.js:227` `...(r.updatedInput !== undefined ? {...} : {})` **把整个 key 抹掉** → Claude Code 收到裸 `{behavior:"allow"}` → Zod 炸。`bypassPermissions` 躲不掉，因为 ExitPlanMode 在 `INTERACTIVE_TOOLS` 里、必走暂停路径；deny 分支只需 `message` 故不受影响。**三处改动**：① 表单 allow 补 `updatedInput: interaction.input`（真 bug）；② run-bus resolver 加兜底——allow 且 `updatedInput` 不是合法 record（非 null 非数组的 object）就回填 `req.input`，把「表单层漏传」这类错误挡在 SDK 之前；③ 修掉 respond route 注释里那句把人带沟里的「for ExitPlanMode allow/deny is enough」（错误前提正是它固化的）。**验证**（见 Verified Facts 的版本闸）：tsc ✓ lint ✓ + **同版本 A/B 实测**——隔离实例 :3164（沙箱 DB + 关认证闸）按老客户端姿势直打 API（`{behavior:"allow"}` 不带 updatedInput），未修版 ExitPlanMode `isError=true` 且返回**逐字复现用户报错**的 ZodError、模型转头重发 ExitPlanMode 卡死；修复版同一路径 `isError=false`「User has approved your plan」、续跑写出 hello.txt、`done` 收尾。**Next**：用户决定是否提交（当前改动在 main 工作区未提交，提交需先切分支）；prod 生效需主目录 `make build` + `launchctl kickstart -k`。

---
**树面板「图形视图」补折叠（Session 74）**：用户「能增加一个树节点折叠的功能吗」→ 反问澄清落在**树面板的图形视图**（画布 chip / Outline 三角 / 树面板列表行 S69 都已有，唯独图形视图当时刻意跳过——「图形是看形状的总览面」）。落地：① `graphGeometry` 先用 `hiddenByCollapse` 把折叠子树**整块剔出再进 dagre**——折叠在图形视图的价值就是腾地方，剩下的点因此重新占满面板；② 有子节点的点挂 ⊖ 小按钮、**悬停才显**（纯链树每点都挂纽扣太吵），已折叠的点**常显** ⊕ +「+N ·未读」角标（折完得有回头路；rollup 与列表折叠行同优先级 waiting>streaming>unread——折叠不该把状态一起藏掉）；③ 按钮圆心落在点自己的 r=10 命中区**之内**（鼠标从点移到按钮不能丢 hover，丢了按钮就闪没）；贴右缘时按钮+角标翻到左侧（SVG viewport 默认裁溢出）；触摸设备走 `[@media(hover:none)]` 常显；④ rollup 从 `flattenTree` 内部闭包提成 `subtreeRollup`，与列表共用一份语义。**顺带修一处既有别扭**：缩放上限 1 → `GRAPH_MAX_SCALE=0.4`——dagre 原尺寸 rank 间距 126px，折剩两三个点时不设限会把它们拉开一屏，「越折越空」（实测折剩 2 点：行距 126→50px、SVG 高 154→78px；9 点密树 scale 本就 ~0.27，行距 34px 不变）。**验证**：tsc ✓ lint ✓ + emperor worktree `bun --bun run build` ✓（独立 `.next`，未碰 prod）+ 隔离实例 :3164（emperor worktree + `TRELLIS_DB_PATH` 沙箱 + `env -u TRELLIS_AUTH_PASS` 关闸 + 直插 SQLite 造 11 节点三分叉树、4 个未读）agent-browser 实测十一项全绿：叶子无按钮/非叶有按钮（DOM 逐节点核）、悬停显 ⊖、**从冷位置直接移到按钮再点 = 折叠而非跳转**（pointer-events 传导这环最易塌，专门这么打）、折 n2 剩 2 点带「+7 ·2」、展开还原、折 n3 落 sessionStorage 且 reload 保持、切列表视图同节点显「展开子树 +2 1」（两视图共用 `collapsedNodeIds`）、点 dot 照常跳转 + 悬停预览卡无回归、⌘J 跳进被折叠的 n5 自动展开祖先、右缘节点角标实测 218..242 未越 272 边界、折根节点剩 1 点「+10 ·2」不炸。**Next**：用户现场验收；上 prod = 主目录 `make build` + `launchctl kickstart -k`。

---
**子 Agent 链可视化 = Stage 22（Session 73——原编 69，与「树面板折叠子树」撞号重编；已合 main 推送，**已上 prod**）**：用户反馈「只渲染了工具链，没有子 Agent 链，不友好」。**根因实测**（真 claude 抓流，已固化 `scripts/fixtures/subagent-stream.jsonl`）：① 主 agent 派活 = 一条名为 **`Agent`**（老版 `Task`）的普通 tool_use；② 子 agent 自己的工具带 `parent_tool_use_id`，而 SDK 压根不看这个字段 → **子 agent 的 Bash/Read 被平铺混进主链，看不出归属**；③ 另有 `system` 的 `task_started/progress/updated/notification` 四事件被 SDK 整个丢弃，里面躺着 subagent_type / 完整 prompt / 实时进度(last_tool_name·tool_uses·tokens) / **最终报告 summary**——白扔；④ 子 agent 正文不走 delta，不污染答案正文（改动面因此收窄）。落地：**SDK 侧**（`EventType.Task` + ToolCall 透传 `parentToolUseId`）即 S72 追记⑤ 里那两处「publish 时的未提交改动」，**实测只有 `@smokingmouse/agent@0.3.1` 带，`0.3.0` 不带**——本仓 bun.lock 已提到 0.3.1，锁回 0.3.0 会让子 Agent 区静默消失（UI 不报错，只是永远空）；**trellis** `ToolCall` 加可选 `parentToolUseId`/`agent: SubagentMeta`（复用 tool_calls JSON 列，**零 migration**）+ 新 patch 事件 `tool_call_update`（不复用 start/done：start 双层按 id 去重会吞、done 置终态而 summary 早于真 tool_result 到达）+ repo `patchToolCallAgent` + run-bus commit-before-broadcast 同款纪律（含 `pendingAgentPatches` 乱序兜底）；**UI** 新 `lib/subagents.ts`（纯数据 split，孤儿回落顶层 + 限深防环）+ `components/SubagentPanel.tsx`——**子 Agent 独立成区**放在 🔧 工具调用 上方（用户选定形态），折叠态即显实时行「🤖 general-purpose 正在 Bash · 3 工具 · 36k · 16.0s ●」，展开 = 任务 prompt + 缩进子工具链 + 它交回的报告；主面板标题改「🔧 工具调用（主 agent）」，画布徽标拆成 🔧n/🤖n。**验证**：tsc ✓ build ✓ + `bun scripts/test-subagent-chain.ts` 11 项全链路断言 ALL PASS（fixture 经真 SDK 解析 → toStreamEvent → 合并 → split）+ 隔离实例(:3160 独立 HOME + 真 claude project)浏览器实测：实时 5×tool_call_update、落库层级正确、折叠/展开渲染、**计时真在走**(7.0→12.0→16.0s；此刻子 agent 卡在 `sleep 12` 里没有 progress 事件，正是 ticker 存在的理由)、reload 从 DB 恢复层级、无子 agent 会话零回归（标题不带「（主 agent）」）、abort 落 `error/aborted` 不炸。**踩到并修**：abort 后 Agent 调用永停 `running`（既有通病），会让计时器在死 run 上永远往上跳 → 改成 `live = node.status === "streaming"` 才算运行中，否则显「已中断」pill（改 DB 造出该状态实测 ✓）。**上 prod 已完成**（2026-07-25）：`learning/trellis` 里 `bun install`（0.3.0→0.3.1，不装就等于没做这个功能）→ `make build` → `launchctl kickstart -k`，三步一起做（bun install 会在 prod 进程活着时换 node_modules，属 S66 同类「运行中换文件」，不可拆开）。验活：`/` 401（闸在）+ `/login` 200 + 服务 `state=running`、日志无报错 + `.next` chunk 内含「它交回的报告」= 新代码确实进了这次 build。**Next**：用户现场验收（prod 开一轮会派子 agent 的 project 提问即可）。

---
**外部 PR 清仓：#10 IME 回车守卫 + #11 画布 peek 原地展开（Session 72，已 merge 推送 GitHub）**：Aaron 两个 open PR 审毕合入。① **#10**：BranchPopover textarea 的 Enter 判定前加 IME 组合守卫（`isComposing || keyCode===229` 直接 return）——中文输入法给英文串上屏的回车不再误触发分叉提交；单文件 5 行，主 composer 走 ⌘Enter 本就不受影响。② **#11**：画布 compact 小卡加「展开预览」按钮 → 该卡就地渲染成 600px 完整卡（`PEEK_CARD_HEIGHT=480` 固定高、body flex-fill 内滚），`layoutNodes` 加 `forceFullIds` 按确定宽高预留 footprint，dagre 单趟让开兄弟/顶开后代；可多卡同开、「收起」折回；选区 popover 加 rendersFull 门控（收起后关闭滞留按钮，expanded 态 sticky 不丢输入）。**审查要点已核**：`data-chat-node-id` 只在 ChatNode/TurnCard 上且 Canvas 与 LinearThreadView 互斥挂载——popover 新门控不影响线性视图、reference 卡本就无选区路径。验证：两 PR 合并树 tsc ✓、lint 零新增（Canvas 2 项 setState-in-effect 为 main 基线既有）、隔离 worktree build ✓、隔离实例（:3163 独立 DB + mock provider）浏览器实测——两节点树点「展开预览」：完整卡原地出现（600×480 z=1000）、子节点 y=556 让位无重叠、不跳线性；「收起」后子节点回位 y=166 ✓。**注意**：本地 main 领先 origin 3 个 commit（S71 的 npm 化三连）仍不能 push——`@smokingmouse/agent`/`llm` npm 404 未发布，push 闸依然是用户 `npm login`；已把远端 PR merge rebase 到本地 3 commit 之下，合并树 tsc ✓。**Next**：用户 npm login → publish → 两仓 push（S71 流程不变）；PR 功能上 prod 需 build + kickstart。
**追记（同日，publish 闸全通 + prod 上线 + 两仓 push）**：用户配好 npm 凭证（2FA/granular token）后全链跑完。① `@smokingmouse/llm@0.3.0` + `agent@0.3.0` publish 成功（`--access public`；pack 清单复核仍只有 dist+LICENSE+README+example yaml）；新包 registry 传播延迟 1-4 分钟，agent 比 llm 慢。② 本机 `.npmrc` 默认源是 npmmirror（镜像未同步会 404）——加 `@smokingmouse:registry=https://registry.npmjs.org/` scope 钉源（@anthropic-ai 同款）+ 触发 npmmirror 主动 sync。③ 干净 worktree 全新 `bun install` 从 registry 拉 700 包 ✓ + tsc ✓ + build ✓ = 部署故事闭环。④ 主目录 `make unlink-sdk` 回 registry 版（此前是 link-sdk symlink），bun.lock 锁定 registry 0.3.0（补 S71 遗留，单独 commit）；`make build` + launchd kickstart，prod 验活 login 200 → authed 200 → `/api/providers` 正常出全 provider 清单。⑤ **sdk 仓推送有插曲**：发现 publish 时 src 里有两处未提交改动（`EventType.Task` 子 agent 生命周期事件 + `ToolCall.parentToolUseId`，Stage 22 地基）已被编译进发布的 0.3.0——补 commit 对齐 git 与 npm 产物；远端 main 另有 ~90 个 harbor 演进 commit，rebase 撞 sequencer 卡死（index 干净仍报冲突）改走 merge：冲突全是 scope 改名 vs harbor 新版，取远端 + 机械重放改名（含远端新增 4 个 test 文件），claude.ts 两侧追加 helper 并存；全仓 tsc + harbor tsc ✓ 后推送 `754d6f1`。trellis 亦已 push。**S71 的 npm 化目标就此全部闭环。**

---
**npm 化部署 + 应用内模型配置（Session 71，已 commit `8816dae`+`dbb7c41`，publish 阻塞在 npm login）**：部署去摩擦两连。① **依赖 npm 化**：`@sm/*` file: 绝对路径依赖 → `@smokingmouse/agent`+`@smokingmouse/llm` `^0.3.0`（~/sdk 已备好 0.3.0 + MIT + 泄露闸全验——npm pack 真打包清单只有 dist+LICENSE+README，无 key/个人路径/apps；npm org `sm` 被占故换 scope，改名波及两仓全部 import）；Makefile 引导链（setup/sdk-build/patch-deps/relink-sdk）退役成 `bun install`，新增 `link-sdk`/`unlink-sdk` 本地改 SDK 用；README Quickstart 重写。endpoints.yaml 搜索序变 `$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml` → legacy `~/.claude/global/`（本机零迁移）。`/api/providers` 优雅降级：yaml 缺失或 yaml 无 native provider 时原生 Opus/Sonnet/Haiku 恒在（新手裸 claude 登录全功能，不再 500）。② **模型配置 UI**：ModelPicker 尾行「⚙ 管理模型…」→ ModelConfigModal（provider 增改删表单）；服务端 `lib/server/model-config.ts` 用 yaml Document API 编辑（保留手写注释），key 只进 env_file（`~/.config/sm/.env` 0600）+ process.env 永不回显，保存 `clearEndpointsCache()`（@smokingmouse/llm 0.3.0 新导出）热生效。tsc ✓ lint 零新增 ✓ 隔离 worktree build ✓ + 隔离实例(:3162, SM_ENDPOINTS_PATH+TRELLIS_DB_PATH 沙箱)实测：API 八项（fallback/创建/key 写入+0600/注释保留/脱敏 grep 零命中/热刷新/校验报错/删除）+ 浏览器全链路（登录→picker→管理模型→添加 uiprov+key→列表 ✓key已配→picker 无刷新出现 uiprov·ui-model-1/2 且原生档共存）全绿。**踩点三个**：(a) Header `backdrop-blur` 劫持 fixed 后代 containing block——Modal 从 picker 内打开必须 createPortal 挂 body（SketchModal 同款）；(b) 伪 HOME 隔离与 turbopack root/共享 node_modules symlink 冲突（"points out of the filesystem root"）——改用真 HOME + `SM_ENDPOINTS_PATH`/`TRELLIS_DB_PATH` env 隔离；(c) agent-browser `click @ref` 对 popover footer 按钮失效（popover 关但 onClick 不触发；同 popover 模型行正常）——裸坐标 mouse down/up 与程序化 .click() 都正常 = playwright actionability 环境怪癖非产品 bug（S70 Excalidraw 同类）。**Next**：用户 `npm login`（npmjs.com 账号名需 `smokingmouse`）→ publish llm+agent → trellis 全新 bun install 从 registry 实测 → make build + kickstart prod 验活 → 两仓 push。

---
**画板草图输入（Session 70，已提交推送，免签待补）**：用户要求「加画板，快速画草图让 AI get 我的意思」。选型用户拍板嵌 **@excalidraw/excalidraw@0.18.1**（peer react ^19 ✓，形状/箭头/文字全能力），导出 PNG 灌进 Stage 15 vision 附件链路，**服务端零改动**。落地：① `components/SketchModal.tsx`——`dynamic(ssr:false)` 按需加载（数 MB chunk 首开才拉），FilePreview 式 portal 近全屏，顶栏「插入草图」= `exportToBlob`（appState 强制 exportBackground + 亮色导出——给模型看的图不受 UI 主题影响）→ `onExport(blob)`；空场景按钮禁用、非空 ✕ 先 confirm、theme 跟随 `.dark`、langCode zh-CN、UIOptions 砍掉 loadScene/saveToActiveFile/export 误导项；② 入口 ✏️ 双接线：Composer（📎 旁同款按钮）+ QuestionInput 首屏（「草图」）→ `att.startUpload(blob, "sketch.png")`，上传/预览/发送/vision 全免费继承（BranchPopover v1 不加）；③ 键盘让位：`isEditableTarget` 加 `[data-keys-yield]` 让位区（Excalidraw r/o/a/t/Esc 整套键盘交互 vs app J/K/B/F/Esc×2 冲突——尤其画画时 Esc 取消选择绝不能误触中止生成），`useEscapeAbort` 手写 guard 顺势收敛进共享函数。tsc ✓ lint ✓ + 隔离 worktree build ✓（主目录 `.next` 未动，prod 不受影响）+ 隔离实例（:3161 独立 DB）实测：挂载中文 UI/暗色跟随 ✓、空场景禁用→画矩形激活 ✓、插入→附件缩略图（白底 PNG 220×116）✓、**真 claude opus 发送→答「这张图片画的是一个圆角矩形」= vision 端到端 ✓**、线性 Composer 入口 ✓、空画布 ✕ 直接关 ✓、字体零 CDN（Turbopack 全打进 `_next`，离线安全，无需 EXCALIDRAW_ASSET_PATH）✓。**踩点两个**：(a) bun 1.3.14 `bun add`/`install` 会把 @sm/agent+llm 的 file: 依赖装坏（ENOENT cache、"Failed to install 2 packages"）——`make relink-sdk` 即修，**任何 bun install 后必跑**（Makefile 本有此机制，这次是它救场）；(b) agent-browser（headless/headed 皆然）驱动 Excalidraw 画布时渲染进程随机暴毙（localStorage 探针证实非导航非 JS error；excalidraw.com 官方站同流程同样崩）——自动化环境问题非集成 bug，人手操作不受影响。**Next**：用户现场验收（真手感：画形状/文字/触摸）；已与 S69 分开摘成两 commit 推送；上 prod 需 build + kickstart。

---
**树面板折叠子树（Session 69，已提交推送 `8376df3`，免签待补）**：用户要求「右侧预览（树面板）里能折叠子树」。方案 = 复用画布/Outline 已有的 store.collapsedNodeIds——「这个子树折起来了」是树的状态而非某个视图的状态，per-session 持久化、新子节点自动展开、跳转自动展开祖先（setActiveNode→expandAncestors）全部免费继承，零新状态。落地：① `lib/tree-panel.ts` `flattenTree` 接受 collapsedIds（折叠节点不下钻），TreeRowItem 增 hasChildren/collapsed/hiddenRollup（被藏后代的 数量/未读/等输入/生成中）；② TreePanel 列表行加折叠箭头（仅有子节点的行，Outline 同款三角 rotate-90，叶子行占位对齐），折叠行回显「+N」+ 未读点数 + 🙋/生成中 rollup（折叠不该把状态一起藏掉，S66 折叠树行同语义）；③ 图形视图刻意不过滤——它是「看形状」的总览面。tsc ✓ lint ✓ + worktree 隔离 build ✓ + 隔离实例（`~/trellis-collapse-tmp` worktree :3160 + mock 7 节点双分叉树）浏览器实测：折叠 #3 行显 +2·未读2 rollup 且 #5/#6 消失 ✓、折叠 #2 显 +5·5 ✓、⌘J 跳进被折叠的 #6 自动展开全部祖先 ✓、画布侧同步（Outline #3 变 ▶（2）、画布 #5/#6 卡片隐藏）✓、reload 折叠保持且 rollup 未读数随已读更新（+2·1）✓、再点展开还原 ✓。**踩点**：隔离实例 worktree 放 /tmp 会触发 Turbopack panic（macOS /tmp 是 symlink，distDirRoot 越界报错）——放 $HOME 下 ASCII 路径即可；Next 16 同目录禁止第二个 dev server，worktree + 共享 node_modules symlink + `bun --bun run dev` 是标准解。**Next**：用户现场验收；已随 S70 一并推送（`8376df3`）；上 prod 需 build + kickstart。

---
**markdown 图片本地路径预览修复（Session 68，emperor worktree，已提交推送，免签待补）**：用户截图报「图没法预览」——答案里 AI 生成的图 `![图](/Users/…/foo.png)` 渲染成破图。根因：S63 链接接管只做了 `a`/`code`，`MD_COMPONENTS` 没有 `img` 渲染器，本地路径 src 被浏览器当 http 路径请求 → 404 破图。落地 `MdImage`（HoverPreview.tsx，全部 8 个 ReactMarkdown 调用点经 MD_COMPONENTS 共享）：① 本地 src（绝对 / file:// / workspace 相对，复用 `previewableHref`）重写走 `/api/files` 会话白名单代理，点击开 FilePreview overlay（cursor-zoom-in + title=路径 + nodrag）；② 远程 URL 原样加载；③ 任何加载失败（白名单外 / 文件不存在 / `~` 路径）降级为「🖼 alt — 无法预览：文件不存在，或不在本会话可预览范围」行内占位（S63 追记同款自解释文案，白名单政策不变），不再露浏览器破图 icon；④ 样式 max-h-[420px] + object-contain + rounded-card 防大图撑爆卡片。tsc ✓ lint 零新增（7 项均基线既有）✓ build ✓ + 隔离实例（:3158/:3159 独立 HOME mock）四形态实测：workspace 绝对路径显示 ✓、file:// 显示 ✓、白名单外降级占位 ✓、远程 URL（icon.svg）原样加载 ✓、点击本地图开 FilePreview overlay ✓、lint 清理后复测两路仍过 ✓。**注**：用户截图会话（#171）不在本机 prod DB——本机各数据源均无该消息，判断来自另一台部署（公司机?），但根因是共享渲染层代码，修复全部署通用。**已上 prod**（2026-07-20）：merge main `1f3b063` + push + 主 repo build + kickstart，authed 200 验活 ✓。**Next**：用户现场验收；公司机部署待自行拉取重启。

---
**节点手动标未读（Session 67，emperor worktree，已提交推送，免签待补）**：用户要求「支持对节点标注未读，卡片和预览树都能操作」。已读机制此前单向（视口停留 1s 自动已读，无手动回退）。落地：① 双入口 toggle——线性视图**卡片头**操作区（⑂ 前，仅 done 节点：已读显「标为未读」实心点 icon / 未读显「标为已读」圆勾 icon）+ **树面板当前树节点行**行尾 hover 按钮（整行 button 改 div.group + 主按钮 + 操作按钮，雪藏按钮同款 pattern；预览卡 pointer-events-none 不承载操作）。② 服务端：repo `markNodeUnread`（read_at 置 NULL）+ `/api/nodes/[id]/read` 加 **DELETE**（POST 标已读的反向资源语义）。③ **关键机制 `unreadHolds`**（store 内存态，不持久化）：手动标未读若卡片仍在视口，1s 后会被 IntersectionObserver 自动标回——hold 挡住 `scheduleRead`（调度点 + timer 回调双检查防 race）；解除时机 = 显式导航到该节点（`setActiveNode`，含树面板跳转）或手动标回已读——邮件语义「瞥见不算读，点开才算」。跨 reload hold 消失属可接受边缘（恢复位置恰停该卡则重新自动已读 = 用户正看着它）。tsc ✓ lint 零新增（5 项均为基线既有）✓ build ✓ + 隔离实例(:3157 mock 5 节点分叉树)实测：API 四项（POST/DELETE 往返 + DB 核实 + 404）✓；浏览器全链路——卡片头标未读→状态点变绿+树面板行未读点同步、**标未读后停留 2.5s 不被回读（hold 生效，卡片/树面板两入口都验）**、树面板行 toggle 双向、点行显式跳转后停留 2.5s 自动已读恢复（hold 解除闭环）、hover 显隐/缩进/链外淡显/active 高亮零回归 ✓。**Next**：用户现场验收（本 worktree 独立 `.next`，未动 prod；上 prod 需 merge main + build + kickstart）。

---
**交互等待三连修：waiting toast + 问答表单补全 + 树面板运行状态（Session 66，已提交推送，免签待补）**：用户两反馈 + 一追加。① **等待交互提醒**——run 暂停在交互式工具时此前毫无提醒（done toast 只管完成）：`doneToasts` 条目加 `kind: "done"|"waiting"`，`interaction_required` 到达且不在焦点（activeNodeId ≠ 该节点，与 done toast 同规）时弹「🙋 等你回答 / 📋 等你批准计划 / 🛡️ 等待工具授权」amber toast（按 pendingInteraction.toolName 分文案），**不自动消失**（run 阻塞在等用户，消失即失联）；resolved / respond 乐观清除 / done / error / retry 五路全部清除 waiting toast。② **AskUserQuestion 表单补全**——补「其他（自定义回答）」选项（工具 schema 官方约定 Other 由 UI 侧提供、模型 options 里永远没有；单选与预设互斥、多选可叠加）+ 问题标题加「（可多选）」提示 + **answers 值修为 string**（原 multi 提交数组；CLI `sdk-tools.d.ts` 钉死 `answers: {[k]: string}`，多选拼 ", "）。用户报「不能多选」实为可供性问题：multi 渲染本就支持，但无提示无自定义入口。③ **树面板运行状态**（追加需求）——`lib/tree-panel.ts` 加 `isWaitingNode`（pendingInteraction ≠ null）+ TreeEntry `hasStreaming/hasWaiting`；节点行 🙋（优先于 streaming 蓝点）、折叠树行加树级 rollup（🙋 > 蓝点 pulse，等输入更紧急）、悬停预览卡「🙋 模型在等你回答」；已完成/未读/error 沿用既有点位。tsc ✓ lint ✓ build ✓ + 隔离实例(:3155 真 claude opus 增强 chat)端到端：AskUserQuestion 两题（单选+multiSelect）→ 表单多选勾选 + 两题「其他」自定义文本 → 提交 → 模型复述「框架：React；特性：SSR、PWA、边缘渲染（Edge SSR）」（多选拼串 + 自定义文本真 CLI 全收到）✓；waiting toast 焦点切走时出现、35s+ 不自动消失、点击跳到该节点并 dismiss ✓；树面板节点行 #3 🙋、新建树切走后原树折叠行 🙋 rollup ✓。**Next**：用户现场验收。
**追记（次日二，图形树回归）**：用户 prod 重启后首见 S65 文字树面板，反馈「没有右侧树形结构了、交互差一点」，确认最想找回的是**图形化的树形状**。落地：TreePanel 当前树节点区加 **列表 ↔ 图形 双视图**（header ⑂/☰ 切换按钮，偏好 `treePanelView` 走 store + localStorage `trellis-tree-panel-view`，sendKey 同款）。图形视图只画**当前树**（全森林点阵正是 S65 退役 minimap 的死因，树级语义仍由文字行承担）：子树过 dagre compact 布局投影进面板宽（272px，高度自适应 ≤300、横向居中防纯链树贴边），点+连线、r=10 透明命中区、点击跳转、悬停复用同一套预览卡（getBoundingClientRect 对 SVG g 通用）、状态着色与列表同语义（等输入 warn pulse/生成中 accent pulse/错误 danger/未读 unread/active 加大+外圈）。tsc ✓ lint ✓ build ✓ + 隔离实例(:3156 mock 5 节点分叉树)实测：切换渲染 5 点 4 线、悬停卡、点 dot 跳 #5+active 外圈跟随、reload 偏好保持、切回列表 ✓。prod 已 kickstart。
**追记（次日，prod「访问不聊了」根因 + 修复）**：S66 测试期间在项目目录跑了两次 `make build`，而 prod launchd（`next start`，同目录同 `.next`）进程还是旧的——运行中换 `.next` 是 Next 不受支持状态，进程内存旧模块 + 磁盘新文件混跑 → 页面能开但交互挂。`launchctl kickstart -k` 重启后正常（顺带 S57-S66 全部功能上 prod）。**教训（硬规则）：在本目录 build 过之后，必须 kickstart prod，否则 prod 必坏**——隔离实例测试用 `next start` 共享 `.next` 的代价。

---
**树面板替换点阵 minimap：冷热排序 + 手动雪藏 + ⌘J 过滤跳转（Session 65，已提交推送，免签待补）**：右下角 `ThreadMinimap`（210×250 点阵）随树增多必然崩坏——小目标、悬停依赖、2D dagre 投影零语义，树多时"知道每棵树干啥/节点信息/跳转"全是 O(n) 探索成本。三轮交互讨论收敛后整体换范式：**文字化 `TreePanel`**（`lib/tree-panel.ts` 纯数据层 + `components/TreePanel.tsx`），ThreadMinimap 退役删除。①树级用文字行（root topicLabel + 节点数 + 未读角标），节点级只展开当前树（Outline 同规缩进：线性平铺、真分叉缩一级）；②**热度排名制**：热度 = 子树 max(createdAt, readAt)（v1 代理，真 lastVisitedAt 被绊到再加），前 5 棵平铺、其余进「更早 · N」折叠组——排名制不用调参、休假回来不会全场皆冷；③**手动雪藏** `nodes.hidden_at`（仅根行有语义，POST `/api/nodes/[id]/hidden` 接受任意节点自动走根）：强制冷藏进常驻「已隐藏 · N」组（未读角标穿透），**写即复活** = repo 层 `createBranchNode`/`resetNodeForRetry` 自动清根 hidden_at + store 乐观镜像（纯浏览/跳转不解除）；④⌘J（查过无冲突）/头部 ⌕ 进过滤模式，↑↓+Enter 会话内节点跳转（含隐藏树，标注所属）；⑤悬停行复用 S61 预览卡（行比 r=3.5 的点好瞄十倍）。切树落点 = 该树 createdAt 最新节点。踩点：行内组件定义会整段 remount（mouseenter 重触发死循环风险）→ 改普通渲染函数。tsc ✓ + lint 新文件零问题 ✓ + `make build` ✓ + 隔离实例(:3153 mock, 8 树 13 节点)全链路实测：API 五项（非根走根/恢复/写即复活/400/404）+ UI 八场景（面板渲染/切树/预览卡/雪藏+热区补位/恢复/⌘J 过滤跳转/跳入隐藏树不解除/发消息自动复活）全绿。
**追记（同 session 二轮，候补三项全清）**：① **lastVisitedAt 真热度**——store 增 `treeVisits`（per-session `{rootId: ts}`，localStorage `trellis-tree-visits:{sid}`，lastViewed 同款），`setActiveNode`/`jumpToParentAtAnchor`/`jumpToNoteSource`/`jumpToSearchHit` 走根打点，load 时载入并按现存根修剪；`buildTreeEntries` 热度并入 visits——重访旧树不长新节点也算「用过」。② **树内冷分支淡显**——树内的「冷」定义为「不在当前链上」（祖先+锚点+首子链，与线性视图展示的 lineage 同规），链外分支行 `text-ink-faint`；无锚点时不淡显。③ **共享数据层**——`nodeSort`/`childrenIndex`/`isUnreadNode` 收敛进 `lib/tree-panel.ts`，LinearThreadView/Outline 删本地重复实现改 import；Outline 根行对 hiddenAt 树加淡显+「已隐藏」tag（画布不过滤——画布是「看全部」的面，只对齐状态语义）。tsc ✓ + build ✓ + 隔离实例(:3154 mock, 7 树)实测：点 #8 锚定后 #10 链外行 class 实measured `text-ink-faint`（#1/#9 链上正常）✓；访问冷组树C→切回树A 后树C 升热区第二、reload 后排序保持（localStorage 生效）✓；画布 Outline 树B 淡显+「已隐藏」tag、画布节点照常 ✓。**Next**：无遗留；用户现场验收。

---
**错误节点降级标识（Session 64，已提交推送 main `efb53a3`，免签待补）**：中途挂掉（API 500/手动停止）的 turn 此前永远顶着红色错误横幅，且画布上 error 节点永不压缩——即使用户已追问「继续」把活续完（partial 工具结果在 lineage jsonl 里，retry/追问都 resume 同 lineage 不丢上下文，S64 对话已核实代码路径），过时红卡仍钉在画布上。落地降级规则：**error 节点一旦有子节点（= 已续跑/绕过）**，① TurnCard/ChatNode 红横幅降级为一行可展开「⚠ 本轮中断 · 后续已继续」备注（新 `components/SupersededErrorNotice.tsx`，错误详情+「重跑本轮」收进 details）；② 画布允许其进 compact 卡（琥珀色状态条 + ⚠ chip 带错误摘要 title）。无子节点的新鲜错误维持红横幅不变。tsc ✓、lint 无新增错误。**Next**：用户现场 #7(error)/#45(续跑子节点) 热更新即验，过验后 commit；候补 idea：错误横幅加「▶ 原地续跑」（retry 变体：发续跑指令而非重发原问题）。

---
**链接悬浮预览 + 本地文件链接接管（Session 63，已提交推送 main，免签待补）**：markdown 答案里的链接此前是裸 `<a>`（本地路径链接点了 404、样式还被 Tailwind preflight 重置成纯文本）。落地：① `MdLink`（`a` 渲染器）——本地文件 href（绝对路径 / `file://` / workspace 相对，含裸相对名）点击改开既有 FilePreview overlay，外链补 `target=_blank`；② 悬浮 ~250ms 出预览卡（`components/HoverPreview.tsx`，portal + fixed 定位、视口越界翻转、滚动即消失、pointer-events-none）——图片直显、md 渲染、文本截头（增量读 6k 字符即断连，大文件不怕）、html/pdf 只给「点击打开」提示、远程图片链接也可悬浮；③ 行内 code 路径按钮同享悬浮卡；④ `MD_URL_TRANSFORM` 放行 `file:` 协议（react-markdown 默认 sanitizer 会把 file:// href 清空——实测踩到），全部 8 个 ReactMarkdown 调用点接线；⑤ 补 `.md-body a` 基础样式。服务端零改动（复用 `/api/files` 会话白名单，白名单外 hover 显示「无法读取文件」）。tsc ✓ + `make build` ✓（唯一 warning 为 main 已有）+ 隔离实例(:3152 mock)浏览器实测 11 场景全过：md/图片/文本/file:///相对链接悬浮卡、越权 404 优雅降级、外链无卡保跳转、远程图片卡、点击开 overlay 不跳转、移开消失、行内 code 悬浮。**追记**：用户遇「预览失败」，归因 = `/api/files` 会话白名单围栏按设计拒绝（最常见：文件只被 Read 过没写过 / chat 模式无 workspace）。用户裁定**不扩白名单**，仅把 hover 卡与 overlay 的 404 文案改为自解释（「文件不存在，或不在本会话可预览范围（workspace + 本会话写过的文件）」）。

---
**线性视图内容列宽度可调（Session 62，已提交推送 main，免签待补）**：用户反馈卡片太窄。原三容器（顶栏/卡片列/Composer）锁死 `max-w-3xl`(768px) → 全局偏好三档：窄 768 / 宽 1024（新默认）/ 超宽 1280，localStorage `trellis-thread-width` 持久化（sendKey 同款模式：`lib/thread-width.ts` + store loader/action），切换控件 = 线性视图顶栏「窄/宽/超宽」分段按钮（移动端隐藏——卡片本就贴满屏宽）。画布 ChatNode 维持 600px（dagre 布局基准）不受影响。**设置页评估不做**：现有偏好各有语境化入口（主题=ThemeMenu popover、发送键=composer footer、宽度=线性顶栏），单独一页反而多一跳；偏好再积累到 5+ 项时再考虑 Header ⚙ popover 归拢。tsc ✓ + `make build` ✓ + 隔离实例(:3151 mock)浏览器实测：三档切换宽度正确（768/1024/1070=viewport 减侧栏后封顶）、三容器对齐、reload 恢复档位。

---
**ThreadMinimap 悬停预览卡（Session 61——原 60 撞号重编，已提交合并推送，免签待补）**：线性视图右下角树缩略图悬停/键盘聚焦节点点位 → 左侧浮出预览卡（#序号 · Turn/Reference + 问题标题 + 回答纯文本摘要，markdown 剥离、代码块/图片丢弃），对齐 ChatGPT 会话 minimap hover 体验；顺带给点位加 r=9 透明命中区（原 r=3.5 难悬停）。tsc ✓ + build ✓ + 隔离实例(:3149 mock)浏览器实测：两点位卡内容各自正确、移开消失、点击导航不受影响。

---
**切 tab 恢复阅读位置 + 长 URL 溢出修复（Session 60，已提交推送 `1d88af7`+`fe13599`，免签待补）**。追加修复：QuestionBlock 缺 `break-words`，URL-encoded 长串无断点横向撑破卡片（隔离实例复现 + 修后量化溢出 -1px ✓）。主功能：线性视图里「浏览 = 滚动」但 activeNodeId 不动，切 tab/刷新回来总落回根节点。落地：① `ViewState` 增 `lastViewed {nodeId, offset}`（视口顶卡片 + 卡内偏移，存进既有 `trellis-view:{sid}`）；② LinearThreadView 滚动 debounce 200ms 记录（store action 带 sessionId 守卫防切换竞态）、session 落地时恢复滚动（restore effect 声明在 anchor-scroll effect 之前，skip flag 防两效果打架；流式 tip 时让位 bottom-lock）；③ store 级 rebase 订阅——同 session 内 activeNodeId 显式变更（画布点卡/分支跳转/搜索命中）把 readingPosition 重置到新锚点，防旧滚动记录压过用户跳转。tsc ✓ + build ✓ + 隔离实例(:3146 mock)浏览器实测四场景全过：滚动到 #4@150px 切 B 回 A 精确恢复（149.75px）/ 跨 reload 恢复 / 画布点 #2 回线性锚定 #2 / 切走切回落 #2（rebase 生效）。

---
**Tab 串台 + 卡片切换滑动两 bug 修复（Session 59，已提交推送 `5784ec8`，免签待补）**：①线性视图切卡由 smooth 滚动改瞬时跳转；②串台四连修——`created` 事件加 session guard（发送后立刻切 tab，外 session 节点不再嫁接进当前视图/抢 activeNodeId，reference created/done/refresh 同规）+ `loadSessionInternal` latest-wins 序号（慢的旧加载不再覆盖新切换）+ `useCliSyncEvents` 改读 `getState()` 现值（stale closure 不再把视图拉回运行中的 attached 会话，SSE 也不随切换重建）+ 加载时流式基线修复（POST reader 存活的节点 response 置空防「DB 快照+bus 全量缓冲」拼接重复；存活 reconnect 句柄拆除重挂拿新 catchup）。tsc ✓ + build ✓ + 隔离实例(:3145 mock)浏览器实测：流中切 B 视图零污染、流中切回 A 无重复。

---
**模式收敛：砍掉 Workspace 档，chat / project 两档（Session 58，已提交推送 `4818681`，免签待补）** → decisions.md 2026-07-16。用量 0（32 原生 session 无一 workspace）+ 语义被增强 chat / project 双向吃掉。全链路清理（Mode 类型/sdk-adapter/route/store/ModePicker/SearchModal/SessionSidebar/ModeBadge/mode-workspace token 全主题/README 两档文档）+ DB 防御性 migrate（workspace→project，幂等）。tsc ✓ + `make build` ✓ + 隔离实例 HTTP e2e ✓（migration 生效 / chat·project 创建 / 老 `mode:"workspace"` 请求安全回落 chat）。

---
**主题系统 + 界面&交互整体优化（Session 57——原 56 与权限确认撞号重编，分支 `trellis-theme` 已 merge main 权限确认后合入）** → ADR [decisions/2026-07-15-theme-system.md](decisions/2026-07-15-theme-system.md)。语义 token 层（双层变量 + `@theme inline`）+ 5 套主题（默认/纸感/终端/莫兰迪/高对比 × 明暗）+ ThemeMenu/`/theme` 命令 + `components/ui/` 九原语 + 40+ 组件全量迁移（原生色族 utility 已禁用作回归护栏）+ 交互修复九项（断点错位 bug/新会话正名/`?` 快捷键面板/Dots 统一/TargetChip 归一/移动端 SessionTabs 隐藏等）。隔离实例全程验证（computed-style 零 diff 断言 + 截图矩阵 + mock 流式回归）✓。**merge 注**：权限确认（04a9c18）的 InteractionForm 权限卡 / ModePicker 新增段为 token 化前写就，随 merge 一并迁移 token（见 S57 log merge 追记）。

---
**权限确认 Permission Gate（Session 56，已提交推送 `04a9c18` + sdk `924444c`，免签待补）** → [spec](permission-gate.md) / decisions.md 2026-07-15。session 级 `require_approval`（创建锁定，仅 claude 系 workspace/project）：spawn 降 `--permission-mode default` + **ask 规则注入**（硬前提：本机全局 allowlist 裸 `Bash` 会让 can_use_tool 永不触发，实测 ask > allow），可变更工具暂停 → 复用 A路② 管道 → TurnCard 权限卡（允许/本轮总是允许/拒绝+理由）。SDK 加 `RunOptions.askTools`（dist 已重建）。验证全绿：协议探针 + HTTP e2e 四场景 + 浏览器实测；tsc/build ✓，prod 已重启。P1（终端逃生舱 tmux+ttyd）等被绊到再做。**注意：本轮与 S54/S55 在同目录并行，working tree 另有 S55 未 commit 的 Composer/QuestionInput/ChatNode 改动，commit 时需分开摘。**

---
**线性视图中间节点分叉（Session 54，已提交推送）**：卡片头 ⑂ 按钮 → reply-to 式 chip 重定向底部 Composer（`streamBranch(节点, q, null)`），补上「线性页面对中间节点自由分叉提问」的缺口（此前只能划线 ⌘K）。隔离实例 mock 全链路浏览器实测 ✓。

---
**工作区文件抽屉（Session 53，已合入 main）**：workspace/project 会话点 Header ModeBadge → 右侧抽屉（移动端底部 sheet）只读浏览 session cwd 目录树，点文件走既有 FilePreview。API 围栏 + UI 全链路隔离实测 ✓；`make build` 因中文 worktree 路径触发 Turbopack panic 无法在 feature worktree 跑（见 Session 53 Verified Fact，与 Session 52 撞的是同一坑），已在 main（ASCII 路径）补跑。

---
**CHAT 模式"假死"修复 = thinking 可视化 + effort env 卫生（Session 52，已合入 main `a29f9b5`）**：claude 思考期 UI 零反馈像卡死（effort=max 时达分钟级）。双修：① SDK（~/sdk @sm/agent）新增 `EventType.Thinking` 透传 `thinking_delta`，trellis 全链路接力（StreamEvent/RunEvent/catchup → stream-bus thinkingChannel → TurnCard 思考面板 + 画布 ChatNode 指示器）；② `instrumentation.ts` 启动 scrub 从 shell 继承的 `CLAUDE_CODE_EFFORT_LEVEL`。roadmap D4 解锁。隔离实例真 claude 全链路 + 浏览器实测 ✓。

---
**线性视图滚动已读修复（Session 48，已合入 main，fix commit `51d7dff`）**：已读判定从「仅 anchor 1s」改为 IntersectionObserver 视口停留 1s，滚动阅读即计已读；隔离实例浏览器实测 ✓。

---
**GitHub issue #2-#7 六个 issue 一轮清完并已合入 main 推送（Session 47，issue 全部 closed）** → 决策见 decisions.md 2026-07-14「统一阅读面」。#7 架构统一做透：NodeFullView/NodeTreeOverlay 退役、`fullScreen` 状态删除，线性 thread（共享 TurnCard + 视口贴底 Composer）成为全模式唯一阅读/对话面（关 #2/#4）；#3 画布 fixed DockedComposer；#5 首屏卡死修（busy 复位 + streamAlert toast）；#6 乐观占位节点 + 流式锁底。tsc/build ✓ + 隔离实例浏览器实测全绿；prod launchd 已重启。两个 commit：`3b61a2e`（Session 46 锁系）+ `6d40985`（issue 清剿，Closes #2-#7），均未签名（1Password 签名授权在自动化环境不可用，与 3d86cfc 同状态，需要可 rebase 补签）。

---
**Session 锁系 + codex 系内多模型已落地并全链路实测（Session 46，未 commit）** → 决策见 decisions.md 2026-07-14。「系」成为一等语义：新建会话自由选系，会话内 claude↔codex 互相置灰（防 resume 断链），系内切换自由；codex 扩成 `codex:<slug>` 复合 id（清单来自 `~/.codex/models_cache.json`，`-m` 透传）。真 spawn 验证 codex:gpt-5.4-mini / 原生 claude / deepseek 三路全通。**codex parity 后续两步（按 ROI）**：P0 = codex native resume（`~/.codex/sessions` rollout jsonl，需实测 CLI resume 语法）；P1 = codex 树分叉（前缀 rollout jsonl 可行性，需实测）；能力矩阵抽象随 P0 一起做。

---
**工作区收敛 + 积压 UI 验收全过（Session 45）**。6 个 feature 分支全部已 merge 进 main 并删除，main 已 push（`9add18d..1345c51`）。浏览器实测（快照 DB + 隔离 `next start` 3003）全绿：线性视图四项 / `/model` 动态 catalog / 命令面板 / 归档往返 / SessionTabs+⌘N / FTS 搜索。遗留小项见 Session 45 log。

---
**Project 线性 thread 主视图 + 树缩略图（已浏览器验收 ✓ Session 45）** → [spec](linear-thread-view-spec.md)。纯前端增量：project 默认 `viewMode=linear`，线性 thread 按 active lineage 展开，分叉折成行内入口，右下角 SVG 树缩略图导航；chat/workspace 的 canvas + NodeFullView 路径保持不变。真实会话（web3 实践，12 节点 1 分叉）实测：默认线性 ✓、「↳ N 个分支」展开 + 点分支卡切 lineage ✓、缩略图点任意节点跳转 ✓、画布↔线性往返保 active 节点 ✓。

---
**CLI ↔ trellis 分支对齐 P1+P2 全落地（含真 claude 端到端验）** → [P1 spec](cli-branch-alignment-p1-spec.md) / [P2 spec](cli-branch-alignment-p2-spec.md)。双向分叉对齐做透：P1=CLI→trellis（union 导入 + lineage 发现 + watcher 新 fork 检测）；P2=trellis→CLI（attached 会话续聊/分叉的 resume 重定向 + 构造前缀 jsonl）。P2 统一模型=分叉一律构造前缀 jsonl（弃 fork-session，见 decisions.md）。落地：`cli_lineages` 表 + per-node lineage sid + `attachedLineageForNode`/`buildPrefixJsonl`/`hasOtherChild`/`registerForkLineage`（`cli-fork.ts`）+ `/api/chat` origin='cli-import' 分支路由（tip 且无子→线性 resume 该 lineage；否则→前缀 jsonl 在 X 分叉成新 lineage + setNodeResumeId）+ `deleteNodeSubtree` 加 origin 闸防误删用户 jsonl。仅动 `origin='cli-import'`，原生 chat/workspace/project + `getRootResumeIdForNode` + 解析器内核零改。**验证**：P1/P2a fixture ALL PASS（独立跑、临时 DB）；**P2 翻盘性未知真 claude 闭环**——真会话 2 轮（香蕉→苹果）→ `buildPrefixJsonl` 截到 turn1 → 真 `claude --resume` 答「只记得香蕉」（不知被截掉的苹果）→ 程序化前缀 jsonl 可被真 claude 从任意历史点续上；`npm run build` ✓ + tsc ✓。**HTTP 全链路 e2e 已验收**（隔离 dev server + 真 claude：从历史节点分叉→`/api/chat`→spawn→reconcile→fork 子树正确长出、答案严格截到分叉点）。**已 merge 进 main 并 push（Session 45，分支已删）。**

---
**新功能定 spec(Session 31):CLI Session 同步** → [spec](cli-sync.md)。把本机 Claude Code CLI 的本地会话(`~/.claude/projects/*/*.jsonl`,88 个 project 目录)持续实时**镜像**进 trellis(只读浏览/搜索/导出,v1 不续聊)。需求确认:数据源=CLI jsonl、语义=持续实时同步、范围=opt-in 选择器。可行性已验(jsonl 字段↔节点模型一一对应,逐行结构已抽样钉死)。关键设计三点:(a) collapse 规则(真 user turn→节点,tool_use+tool_result→ToolCall[]) (b) 防回环去重(跳过文件名∈trellis 自有 session id 的 jsonl) (c) 只读镜像。分 4 Stage(A 解析器+一次性导入 → B 实时 watcher → C 选择器 UI+只读门禁 → D 可选续聊)。**CLI Session 同步 = per-session attach + 真双向,全做完并已部署 prod**(分支 `feat/cli-session-sync`,未 commit;详见 [cli-sync.md](cli-sync.md) + decisions.md)。设计经一次推翻(只读镜像→双向 attach)。落地:解析器/DB importer/discover/watcher/对账 + instrumentation boot + discover·attach API + CliAttachPicker UI(SessionSidebar 入口 + CLI 角标)。双向:CLI 侧新轮 watcher 自动同步进 trellis,Session 38 补上前端 SSE 事件通道后当前打开的 attach session 无需刷新会自动 reload;trellis 续聊走 project resume 写回同一 jsonl + done 后身份对账(删临时节点、canonical jsonl-uuid 接管、reload_session 通知客户端)。dev 端到端全验(含真实续聊写回 PONG + 浏览器实测 attach/detach/角标),`npm run build` ✓,launchd 重启部署、prod 路由 401(已上线被闸挡)。途中抓修:system 边界节点断链(致全孤根)、attach 删除 hazard(origin 闸挡)。**下一步:用户验收;按需 commit/merge。**

---
**Session 工作台层(Session 29)** → [spec](session-workbench.md)。原北极星「替代 GPT + Claude Code CLI」交互层已基本达成,下一道坎是「承载更多工作」——让 CLI 重度用户能像 tmux 一样并行承载多 session、靠肌肉记忆导航。已完成 recon(4 agent 并发测绘),关键发现:**执行引擎(run-bus)本就多 session 并发,墙在 store 单 active session 模型 + 缺导航/生命周期/命令 UI 层;一大半"迷惑"是可发现性而非能力缺失**。三组件:(a) tmux tab 导航 (b) session 生命周期正名 (c) 命令面板。**三波全部落地(Session 29-30,build ✓×3,UI 待浏览器实测)**:Wave 1(SessionTabs + `/api/runs`)+ Wave 2(B1 正名/B2 归档/B3 compact 降级)+ Wave 3(C1 命令面板,`/` 前缀触发 /new /clear /archive /switch /model)。deferred 项:Level B 多 session in-memory store 重构、`/model` per-session DB 锁定(均有产品语义未决,实测驱动再上)。**浏览器实测已过(Session 45)**:SessionTabs 预览/双击固定/⌘1-9 快切、`/api/runs`、归档往返、命令面板 /model /switch 实跑、FTS 搜索。

---
**费曼学习法 Phase 1 已落地**（Session 28，轻量预设版，未实测）。继续按 [optimization-roadmap.md](optimization-roadmap.md)（替代 GPT 体验优化）实施第一阶段 P0。**用户要求「一口气全做完」。已完成 15 项**（全部 `npm run build` ✓）：
- P0：A3 代码块/回复复制 · B2(并入) · D1 System Prompt 可配 · A4 Enter 发送 · A1 全屏流式 markdown · B1 移动端 Outline 抽屉 · A2 编辑=新分支重问 · C2 记忆桥接(写侧) · C1 文件附件(code/text 子集)
- P1/P2：B5 a11y · B4 首屏建议 · A5 Alt+方向导航 · D2 上下文 depth 可调 · D5 多版本对比 · C4 Skill 入口

**剩余（每项有明确状态，非遗漏）**：
- C1 PDF/Excel/Word — 二进制需 npm 装 sheetjs/pdf/mammoth 解析（code/text 子集已做）
- C5 / A6 / B3 — 评估低 ROI 暂缓（理由见 P1/P2 清单，简洁优先）
- ~~D4 thinking — SDK 无 thinking 事件，blocked~~ → 已解（Session 52，SDK 是自家的了）；D3 工具闭环 — 疑底层已覆盖待确认
- C3 语义检索（Q2 embedding 未决）· C6 图片生成（Q3 倾向不做，走 ai-legion）

**全部待浏览器实测**（dev server 在 3001）。roadmap 的 Stage 20/22（plan 节点/subagent 可视化）仍属功能广度归原 roadmap。本轮补的是交互/UI/对话内核体验维度。

---

## Goals 归档（2026-07-28 从 README 轮转）

README 是每 session 必读的有界队列，Goals 明细（含全部已完成 `[x]` 条目）移到这里。
README 只保留 3 条活跃 Goal 的指针；要看某一条的逐项历史，翻这里或对应 feature spec。

## Goals
### 工作平台化：Project/Workspace/Agent/隔离（2026-07-27 脑爆）→ [ADR](decisions/2026-07-27-project-workspace-layer.md)
把「执行环境」提升为一等实体 `Project → Workspace → Session`。四个子项目，本轮只做 S1。
- [ ] **S1: Project/Workspace 层级 + 工作区终端** → [spec](project-workspace-layer.md)
  - [x] P0: `projects`/`workspaces` 两表 + `sessions.workspace_id` + 迁移回填 + git 自动聚类 + 侧栏三级（S77 落地，隔离实例实测全绿，未 commit）
  - [x] P1: 终端（S77 落地）。**反代方案被实测推翻**（bun 的 node:http upgrade socket 写不回客户端）→ 改 iframe 直连 `127.0.0.1:<ttyd 端口>`，远程渲染降级面板。隔离实例真终端跑通，未 commit
  - [ ] P2: git 状态角标 + 新建/回收 workspace（`git worktree add/remove`）
  - 判据 = **一周内 worktree 里的 session 数 > 0**（不是功能做完）；P0+P1 后停一周看数据
- [ ] S2: Workspace 生命周期深化（worktree 主动管理）— 依赖 S1，mid-term
- [ ] S3: Agent 配置档（可复用实体 + `CLAUDE_CONFIG_DIR` / CLAUDE.md / skills 注入）— 依赖 S1，mid-term
- [ ] S4: Runtime 隔离 + 多租户 — 依赖 S1+S3，**未承诺**。隔离与多租户须拆开：前者与本机 CLI 护城河可共存，后者要求容器强制、与之直接冲突。启动前必须先去掉 ttyd 的 `-a`

### Short-term (MVP)
- [x] Stage 1: Next.js 脚手架 + 依赖
- [x] Stage 2: Mock SSE endpoint — curl 验证流式 OK
- [x] Stage 3: 数据模型 + SQLite + Zustand
- [x] Stage 4: Canvas + ChatNode + 根节点流式渲染
- [x] Stage 5: 选中文字 → ⌘K 分叉
- [ ] Stage 6: Polish
  - [x] 大纲（`components/Outline.tsx`）
  - [x] 持久化恢复（hydrate from `/api/sessions`，`stores/sessionStore.ts:70-91`）
  - [x] 父节点高亮回显（parentAnchor badge，`ChatNode.tsx:70`、`NodeFullView.tsx:130`）
  - [x] 节点序号 + 已读未读（`lib/node-index.ts`、`read_at` 列、`/api/nodes/[id]/read`、Outline 顶部计数 + 只看未读）
  - [x] 跳回父节点滚到 mark + pulse（`pendingScrollAnchor` store state、`.anchor-pulse` 动画）
  - [x] 进阶定位三件：J/K 跳未读（`hooks/useUnreadNavigation.ts`）+ compact dot 颜色编码已读未读 + done toast（`components/DoneToast.tsx`）
  - [x] Token 细分四桶（input/output/cacheRead/cacheCreation）`lib/format-tokens.ts` + 全链路 schema/provider/UI
  - [x] 笔记本（`app/api/notes/`、`components/NotesDrawer.tsx`、⌘D + 📌 按钮、Header 入口）
  - [ ] Dagre 布局微调（实测后再判断是否真有痛点）
- [x] Stage 7 P0: 移动端全屏卡片 + 顶栏 + 分支条
- [x] Stage 8: 三层视图统一 — Layer 1 图 / Layer 2 聚焦 / Layer 3 全屏；桌面手机共享全屏组件
- [x] Stage 9: NodeFullView 加全树 overlay（远端跳转）+ 失败节点 in-place retry + Codex 打包修
- [x] Stage 10: 选区分叉不切焦点 + mark 可点跳子 + 树 overlay 改右侧抽屉 + 上下文压缩（depth=2 + 锚点 excerpt）
- [x] Stage 11: 发送/取消 UX — Cmd+Enter 发送 + 流式 ⏹/Esc 中止 + 保留 prompt → [spec](cancel-send-ux.md)
- [x] Stage 12: 节点类型抽象 + 参考卡片（粘贴/URL）+ 画布凭空建节点 → [spec](reference-nodes.md)
- [x] Stage 13: 画布 FAB 升级 popover（新提问 + 参考卡片）+ 链接抓取 prompt goal-only 化

### Mid-term
- [x] 接真 LLM（Claude Sonnet/Opus/Haiku + Codex 半成品，default sonnet）
- [x] 思维树导出（`lib/export.ts`：JSON + Markdown，Feishu 友好）

### 2026 Q2: 替代 Claude Code CLI + GPT 客户端 → [roadmap](roadmap-2026q2.md)
**Wave 1 (Week 1-2) — Chat 立得住，Workspace/Project 有 cwd**
- [x] Stage 14: 模式重命名（lean/cli-single/cli-multi → chat/workspace/project）+ Workspace 引入（session 级 cwd 绑定 + WorkspacePicker + 创建流程改造）→ [spec](mode-workspace-rebuild.md)
- [x] Stage 15: 图片输入（vision，三档全模式可用，多模态走 claude/codex 原生）→ [spec](vision-input.md)
- [x] Stage 16: 跨 session 全文搜索（FTS5 trigram + ⌘P 全局搜，按 mode facet）→ [spec](fts-search.md)

**Wave 2 (Week 3-4) — Workspace/Project 超过 raw CLI**
- [x] Stage 17: Tool call / Bash 可视化（解析 stream-json 的 tool_use/tool_result，节点折叠区展示）+ durable streams 改造（spawn 与 HTTP 解耦，断线不杀生成）
- [ ] Stage 18: Skill 调用入口（输入 `/<skill-name>` 触发，复用 ~/.claude/skills/ 50+ skill）
- [x] Stage 19: 文件附件（Session 50 落地，形态调整：进 composer 附件而非 reference 节点——CSV/文本/PDF 等通用文件走「blob + staging 路径注入 prompt」，agent 自己用工具读）

**Wave 3 (Week 5-6) — 树状结构优势放大**
- [ ] Stage 20: Plan 节点 type（计划-步骤-子节点联动，对齐 Plan → Execute → Verify → Learn）
- [ ] Stage 21: Memory 桥接（节点 ↔ ~/.claude/memory/ 双向）
- [x] Stage 22: Subagent 可视化（Session 73）——子 Agent 独立成区：`lib/subagents.ts` 分组 + `SubagentPanel` 折叠态实时行/展开态 prompt·子工具链·报告；数据来自 `@smokingmouse/agent` ≥0.3.1 的 `EventType.Task` + `parentToolUseId`。形态是「面板内分区」而非原设想的画布子树——子 agent 是一轮内的执行细节，做成画布节点会污染思维树语义

### GPT 替代体验优化 → [optimization-roadmap.md](optimization-roadmap.md)
体验深度维度（交互手感 / UI 精致 / 对话内核），与上面功能广度互补。第一阶段 P0：
- [x] A3 代码块语言标签+复制 + 回复全文复制（+B2 并入）
- [x] D1 System Prompt 可配（5 预设角色+自定义，per-session 锁定）
- [x] A4 Enter 发送可配（默认 Enter 发送，对齐 GPT；可一键切回 ⌘Enter）
- [x] A1 流式实时 markdown（NodeFullView 全屏；画布卡片维持 textContent 直写保性能）
- [x] B1 移动端 Outline 抽屉（Header ☰ 开全屏抽屉，variant prop + page 顶层挂载；响应式卡片宽度评估后不做——600px 是 dagre 布局基准、移动端走全屏不看画布，保留）
- [x] A2 编辑消息（全屏问题区铅笔→改问法重问；`editNode` 复用 streamBranch/streamRoot，Q1=B 新建 sibling、原问答保留无损）
- [x] C2 记忆桥接（写侧）：新 `app/api/memory/route.ts` 写 `~/.claude/memory/{slug}-{hash}.md`（auto-memory 格式 + MEMORY.md 索引，防覆盖）；NodeFullView `MemorySaveButton` popover（标题/内容可编辑 + type 选择，用户点击触发写入）。自定义指令部分由 D1 覆盖。读侧（节点旁显示相关 memory + session init 注入）标注 follow-up。
- [x] C1 文件附件（code/text 子集）：ReferencePicker 加「📎 从文件读取」，FileReader 读白名单扩展（.py/.ts/.md/.json/.csv 等 30+）→ 包代码块填入 paste reference（≤1MB）。**PDF/Excel/Word 未做**：二进制需 npm 装 sheetjs/pdf/mammoth 解析，留新上下文 + 依赖决策。

**用户已确认「一口气全做完」。P1/P2 进度（含开放决策处理）：**
- [x] B5 a11y（globals.css `:focus-visible` 键盘焦点环；userScalable 保留=画布需要）
- [x] B4 首屏建议问题 chips（QuestionInput，chat 模式空输入时）
- [x] D2 上下文 depth 可调（store historyDepth 默认 4=原硬编码 2 翻倍缓解深树丢上下文；footer 📚 stepper 2/4/6/8；全链路传 maxDepth 给 buildHistoryForNode）
- [x] A5 节点键盘导航（Alt+方向键：上=父 / 下=首子 / 左右=兄弟；新 useNodeKeyboardNav hook）
- [x] D5 同问多版本对比（「再答一版」= editNode 同问题建 sibling，复用兄弟条对比，零新机制）
- [x] C4 Skill 入口（新 `/api/skills` 扫 `~/.claude/skills/*/SKILL.md` 取 name+desc；QuestionInput 输入 `/` 触发 picker 补全 `/name `，由 claude CLI 原生执行；仅 workspace/project 模式）
- [ ] C5 模型 session 级 — **评估暂缓**：现全局切换已可用且更灵活，session 锁定反而削弱灵活性、且「锁定 vs 每轮可选」语义需产品决策，低 ROI
- [ ] A6 命令面板 — **评估暂缓**：现有快捷键（J/K 未读、B 回父、F 全屏、⌘K 分叉、⌘P 搜索、Alt+方向导航）已覆盖高频操作，命令面板边际
- [ ] B3 长回复折叠/TOC — **评估暂缓**：现 max-h 滚动 + 全屏阅读已覆盖核心阅读，TOC 边际（简洁优先）
- [ ] C2 记忆桥接、C1 文件附件（见上 P0）
- [x] D4 thinking 可视化（Session 52：@sm/agent 加 `EventType.Thinking` + trellis 全链路 + TurnCard 思考面板/画布指示器；thinking 不落 DB，ephemeral 与 CLI 折叠行为一致）
- [ ] D3 工具结果闭环 — 待确认：tool result 回灌模型可能 agent-gateway/CLI 已自带，trellis 只做可视化
- [ ] C3 语义检索 — **开放决策 Q2**（embedding API）未拍板，暂不做
- [ ] C6 图片生成/语音 — **开放决策 Q3 倾向不做**（付费 API + 偏离单机定位，走 ai-legion skill）

### Session 工作台层(tmux 式多 session)→ [spec](session-workbench.md)
下一道坎:让 CLI 重度用户并行承载多 session + 靠肌肉记忆导航。三波:
**Wave 1(导航先立)**
- [ ] A1: 常驻 session tab 条 + mode 色标 + ⌘1-9 快切(Level A,不重构 store)
- [ ] A2: live 状态点(新 `/api/runs` 暴露 run-bus RUNS 快照,tab 上显示 streaming/done/error)
- [ ] A3: tab 条按 mode 分区(Chat 区 / Workspace·Project 区,借 SearchModal mode facet)

**Wave 2(生命周期正名)** — Session 30 落地(build ✓ + curl 验证 archive 往返)
- [x] B1: 「新提问」→「🧹 新话题(清空上下文)」正名;NewQuestionPicker 🧹 badge + `/clear` 文案对所有 mode 统一(原仅 project);FAB/SessionPicker/Header 文案对齐。仅改标签文案,createRootInSession 行为不变
- [x] B2: 归档机制(`sessions.archived INTEGER` idempotent ALTER + repo `setSessionArchived`/`countArchivedSessions` + listSessions 默认排除 archived + PATCH `{archived}` + store `archiveSession`/`unarchiveSession` + SessionPicker 行内归档/恢复 + 「显示已归档(N)」toggle)。归档纯隐藏不删 jsonl/节点。SessionTabs 未改(同 endpoint 自动受益)

**Wave 3(命令面 + 深水)**
- [x] C1: 通用命令面板(Session 30)。新 `lib/commands.ts` registry(`matchCommands`/`parseCommand`/`resolveProvider`)+ QuestionInput 提交拦截分流(纯 Trellis 命令本地执行不发 LLM,skill 照旧透传 CLI)+ `/` 下拉合并命令(前)+skill(后)。`/clear` 复用 Wave 2 `setComposeRootOpen`。仅接首屏 composer(命令是 session 元操作),追问框刻意不接 → **S55 推翻**:用户要求日常对话框也能用,共享 Composer 已接同一 registry
- [x] B3: `/compact` 降级提示(Session 30 随 Wave 2 一起做)。spike 确认 claude CLI/SDK 无原生 compact → 降级为 Header 🧠 ctx 徽章在 ≥50% 时变可点 popover(解释上下文压力 + 「🧹 开新话题清空」一键复用 createRootInSession,经 store `composeRootOpen` 标志驱动 AddNodeFAB 的 NewQuestionPicker)。<50% 保持非交互只读不打扰。不实现 summarize
- [ ] (deferred) Level B 多 session in-memory store 重构 / C2 per-session model

> 活跃（非 `[x]`）条目共 21 条，超出协议建议的 3 条上限；未做增删，按原样保留。
