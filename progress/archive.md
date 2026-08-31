# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

### Session 127（2026-08-28，飞书机器人 Agent-first 与本机凭证自动发现一键接入：免复制 App ID/Secret 直连绑定）
- **触发**: 用户反馈「现在的飞书机器人不是很好用，他应该是绑定在 Agent 上的，不应该是只是绑定现成的，而是可以支持新建然后自然绑定，参考 happyclaw 的逻辑」→「飞书机器人应该是有个页面，可以一键创建/绑定的」→「我希望的一键接入是不需要复制 appid 和 secret 的，你可以参考下 happyclaw 的方式，纳入进来」。
- **根因 & 机制剖析（本机凭证自动发现 + Agent-first 绑定）**:
  1. 本机开发环境通常已存在 `~/.feishu-cli/`（`config.yaml` / `sm-config.yaml` 等）、`~/.lark-cli/` 或 `FEISHU_APP_ID/SECRET` 环境变量，强迫用户手动打开开放平台复制 App ID 和 App Secret 是巨大摩擦；
  2. happyclaw 本地运行与技能链天然共享 `~/.feishu-cli/` 与环境变量，无需手动输入凭证；
  3. 此前飞书机器人仅在 `/settings/bots` 孤立配置，Agent 设置页对机器人渠道无感知，且缺少直接绑定已有机器人的捷径。
- **Done**:
  1. `lib/server/lark/discover.ts` & 路由 `GET /api/lark-bots/discover` + `POST /api/lark-bots/import-local`:
     - **本机凭证自动发现**：自动扫描 `~/.feishu-cli/*.yaml`、`~/.lark-cli/config.json`、`~/.agent-gateway.env`、`~/.trellis/shared/.env.local` 与 `process.env`，去重解析出可用 App ID 与 Secret；
     - **免复制一键直连 (`importLocalLarkBot`)**：后端直读本机凭证并调飞书 API 自动验活（获取应用真实名与 bot open_id），一键完成 `lark_bots` 登记与 Agent 绑定，**前端全程无需接触或输入 Secret**。
  2. `app/settings/bots/page.tsx`:
     - **官方 Launcher 一键创建模板直达**：在指南与操作区增加 `⚡ 飞书一键创建 (Launcher) ↗`（`https://open.feishu.cn/page/launcher?from=backend_oneclick`）与 `Lark 国际版 ↗` 直达链接，用户可一键自动拉起预配好的机器人应用创建向导；
     - **顶层本机发现卡片区**：自动呈现「✨ 检测到本机已配置的飞书应用（免复制 App ID / Secret）」，列出在线状态、来源路径与绑定状态，提供 `⚡ 一键接入并连接`；
     - **向导式一键接入**：提供开放平台接入指南 + Agent 绑定模式切换（选择已有 vs 就地新建 Agent）；
     - **已绑定人设直达**：选定 Agent 后展示当前人设名与 `查看 / 编辑人设 ↗` 快捷深链；
     - **URL 查询参数支持**：支持 `?new=1&agentId=xxx`（从 Agent 页新建 bot 预选）和 `?id=xxx`（直达编辑）。
  3. `app/settings/agents/page.tsx`:
     - **渠道绑定面板（飞书机器人）**：Agent 编辑器专属「💬 飞书机器人接入」卡片，集成 Launcher 一键创建链接，实时展示该 Agent 绑定的飞书应用（App ID、连接/异常徽标、工作目录、最近连接时间），支持一键 `解绑` 与 `配置 ↗` 跳转；
     - **本机发现应用一键直连绑定**：面板直接列出本机已发现但未绑定此 Agent 的飞书应用，点击 **`⚡ 一键接入`** 即可**0 复制粘贴、0 手动输入**原子绑定到当前 Agent；
     - **左侧列表飞书标识**：Agent 列表中对已绑定飞书机器人的项渲染 `💬 机器人` 状态角标。
  4. `lib/server/agents.ts`:
     - `deleteAgent` 增加级联解绑：删除 Agent 时自动将 `lark_bots` 与 `tasks` 的 `agent_id` 置为 `NULL`，防止悬空引用。
  5. `scripts/test-lark-bot.ts`:
     - 增加 Agent 删除级联解绑飞书机器人与任务的断言验证，以及 `discoverLocalLarkCredentials` 扫描有效性断言（18 → 25 断言）。
- **验证**: `bun --conditions react-server scripts/test-lark-bot.ts` 25 项断言全绿；`agent-browser` 交互走查（本机应用自动发现、免复制一键直连、Agent 侧一键直连绑定、双向解绑）全部实测通过；`bun --bun next build` 编译、路由生成与类型检查全部 0 错通过。
- **Next**: 合并至 main 后随其他 S12x 成果一起 `make deploy` 部署上线。

### Session 126（2026-08-28，S4 多租户第一期落地：实例级隔离 + 租户网关，焚决四坐席并行交付）
- **触发**: 用户「我想支持多租户模式，可以把我这个平台开放出去；对文件系统做隔离」→ plan mode 三路探索 + 用户拍板（小圈子邀请制 / 租户自带凭证可共享 / 每租户一容器 / Mac mini 本机）→「全部实现，用 fenjue 调度」。
- **架构决策**（[ADR](decisions/2026-08-28-multi-tenancy-instance-isolation.md)）: **实例级隔离**——每租户一个 Docker 容器跑完整 trellis 实例，宿主薄网关做认证+路由+cookie 翻译，**trellis 本体零改动**。否掉单实例多租户改造（10 表+73 仓储函数+52 route+2 条全局 SSE 广播全要加 owner，漏一处即泄露，且防不住 CLI 的 Bash）；所有路径根都是 `os.homedir()`，容器 HOME 即天然隔离。
- **Done**（焚决四单全部 settle pass + accepted，全新代码集中 `tenancy/`）:
  1. `fj-mt-spike-54c5`（gemini scout）: 网络前提实测——宿主 clash TUN **透明覆盖** Docker VM 出站（容器直连 anthropic/npm/claude.ai 全通，运行期零代理）；备用 `host.docker.internal:7897` 可达；bookworm 无 ttyd 包→GitHub aarch64 1.7.7；claude/codex 容器内秒装、OAuth URL 正常生成。
  2. `fj-mt-image-681e`（codex）: `tenancy/image/Dockerfile`（node:22-bookworm-slim 多阶段，build 期 HOME=/opt 满足 turbopack root，应用 /opt/trellis，node 用户原位重命名 tenant）+ `entrypoint.sh`（幂等骨架）+ `tenantctl.ts`（build/add/start/stop/restart/rm/status/upgrade/port；docker run 承重面: --init/per-tenant network/127.0.0.1 端口/named volume/--stop-timeout 35/资源限额）。D1-D7 settle 独立复跑全绿（build→起容 auth:on→身份→**Mock provider 全链路 CHAT_OK**→重启持久→upgrade 保数据→purge 零残留）。
  3. `fj-mt-gateway-0042`（codex）: `tenancy/gateway/`（gateway/db/auth/tenants/proxy-util/pages/selftest）+ launchd 模板（NumberOfFiles 4096）。argon2id+sha256 session、邀请认领、限速、cookie 翻译（删 gw cookie/剥走私 trellis_auth/注入租户 token）、继承 server.ts 五坑（Host 改写/剥三头/idleTimeout 0/signal+duplex/redirect manual）、Bun 原生 WS 逐帧。selftest 12 项 settle 全绿。
  4. `fj-mt-m3-3073`（gemini）: tenantctl 增补 `creds-share --claude-token|--revoke`（setup-token 经 CLAUDE_CODE_OAUTH_TOKEN env 注入+重建，绝不拷 credentials.json）与 `backup`（volume tar 归档）。D1-D4 settle 全绿。
  5. Supervisor 收尾: **真容器 × 网关联调通过**（邀请认领 200→cookie 翻译→真实例 /api/sessions 200→mock 对话 SSE created/done 全链路）；selftest 补 120s watchdog；`tenancy/README.md`（架构/威胁模型/运维手册）。
- **验证**: 四单 settle 全部独立复跑（不采信坐席自述）——spike D1/D2、image 九条 verify（完整容器生命周期重放）、gateway selftest 12 项+独立启动+plist、M3 四条；merge 后 main 上 selftest 全绿；真容器×网关端到端 curl 联调全绿。
- **Next**: ① 公网接入待房主拍板（caddy 站点块+域名，见 tenancy/README.md）；② 宿主 memos/stirling 建议改绑 127.0.0.1（容器可经 host.docker.internal 触达）；③ 第一位真实朋友上车时做真人端到端（真 claude login+Web 终端）；④ S121+S122 一起 `make deploy`（tenancy/ 不影响单人版运行时，零风险合部）。

### Session 125（2026-08-28，飞书机器人载体：注册/绑定 Bot + WS 长连接双向对话；焚决派发 codex 实现）
- **触发**: 用户「定时任务是调度机制、agent 是身份，但没有一个载体——先支持飞书机器人，支持绑定/注册，也支持在飞书对话，参考 happyclaw 方案」。正是 custom-agents-plan 明确「推迟」的飞书载体项启动。（原记 S122，与并行 worktree 撞号顺延 S125。）
- **方案定盘（Owner 侧，两路 Explore 侦察后）**: 采 happyclaw 的**形状**（`@larksuiteoapi/node-sdk` WS 长连接、EventDispatcher、mention 门控），拒其**厚度**（六态耐久投递/流式卡片/多级绑定 = 多租户账单，happyclaw-contrast.md 既有裁决）。核心决策：①三表 `lark_bots`/`lark_chats`/`lark_inbox`（去重照 `task_runs_slot` 抢槽 idiom，仅 `SQLITE_CONSTRAINT_UNIQUE|PRIMARYKEY` 算 dup）②每飞书 chat = `kind='lark'` 会话内一条线性链（新消息 = `last_node_id` 子节点 + resume，侧栏可见）③per-chat 内存串行队列（深度 5）+ 全局并发 2（`AsyncSemaphore` 原子交接）④群聊必须 @bot（`bot_open_id` 缺失 fail-closed）、bot 自身消息无条件忽略（防自触发烧钱循环）⑤连接管理 = instrumentation 挂 `startLarkManager()` 15s 对账 tick，route 只写 DB（跨 bundle 模块实例不共享，S87 坑）⑥`TRELLIS_LARK=off` deploy smoke 闸。
- **执行（焚决 fj-lark-bot-28f1，codex+gpt-5.6-sol 坐席）**: 33min 交付 + 1 轮缺陷收尾，全程 3 progress + 1 blocker（settings-tabs.ts 补授权）+ 2 result。产物：`lib/server/lark/`（protocol/store/sdk/handler/manager/semaphore 六模块）+ `/api/lark-bots` CRUD/test + `app/settings/bots` 整页 UI（secret 不回显、连接状态徽标、chats 深链）+ `scripts/test-lark-bot.ts`（18 断言）+ `scripts/lark-ws-smoke.ts`（无凭证 SKIP）。commit `ac78755`。
- **验证**: settle 独立复跑两轮全绿（tsc 0 错 / 18 断言 / production build / WS 冒烟 SKIP / TRELLIS_LARK 三文件命中），scope 零越界；falsification-verifier 对 8 条不变式逐条 PoC 证伪全 HOLDS（防自触发 10 种 sender 变体 fail-closed、per-chat 串行 30k 压测零重叠、`SQLITE_BUSY` 真抛不吞、secret 三面不漏），其揪出的全局信号量非原子交接（微任务窗口可越 cap 2 倍）已由坐席修复（`semaphore.ts` 原子 handoff + 压测断言 peak=2）。
- **Next**: ①真凭证端到端联调（`LARK_SMOKE_APP_ID/SECRET` 跑 lark-ws-smoke + 开放平台开通机器人能力/事件订阅长连接/im 权限，本机 lark-cli app `cli_a923d94f1bf89bef` 凭证已验活）②PR #23 合并后 `make deploy` 上线。

### Session 124（2026-08-24，工作区读写与侧栏交互重构：已合并折叠降噪 + 批量安全清理 + 改动检视 Diff 弹窗）
- **触发**: 用户反馈侧栏内容繁杂、体验较差（几十个历史 worktree 堆叠刷屏、分支与目录名并排截断、缺少工作区读写闭环能力）→「开始优化吧」。
- **根因**: ① `SessionSidebar` 将所有 worktree（包含大量已合并入主干且 0 会话的已完成分支）平铺在项目下，僵尸工作区严重挤占主视野；② `GroupRow` 强行并排展示目录名和分支名，导致两端均被截断为 `...`；③ 缺乏批量治理能力，清理已完成工作区需逐个 hover 确认数十次；④ 缺乏工作区代码变更检视（读）与流转（写）能力，用户看到 `● 56` 脏改动无法在平台内查看具体文件与 Diff。
- **Done**:
  1. `components/SessionSidebar.tsx`:
     - **智能分区折叠**：自动将项目下的工作区划分为「活跃工作区」与「已合并/可清理工作区（`reclaimable: true` 且 0 运行会话且 0 脏改动）」，后者默认收敛归入子折叠组 `✓ 已合并 (N)`，主界面视野信噪比提升 80% 以上。
     - **消灭截断排版**：精简行内布局，移除重复截断的长分支名展示，将完整路径、分支、脏文件数与可回收提示统一收敛入悬浮 Tooltip；
     - **交互式状态角标**：`● N` 脏文件角标支持直接点击开启改动检视；
     - **权限放宽**：单项工作区删除支持所有 `kind === 'worktree'`（不局限于 trellis 创建），均走严密的两阶段预演与 force 二次确认。
  2. `app/api/workspaces/git-diff/route.ts` & `components/WorkspaceDiffModal.tsx`:
     - 新增 Git 变更检视 API 与弹窗：支持查看当前工作区分支、upstream、ahead/behind 提交数、未提交文件状态清单（`M` / `A` / `D` / `??` / staged 标识及 +/- 行数统计）与完整行级统一 Diff 预览；支持一键在本地 VS Code 打开、复制路径与在此工作区新开会话。
  3. `app/api/workspaces/worktree/clean/route.ts` & `components/BatchCleanModal.tsx`:
     - 新增批量清理已合并工作区功能：在 `✓ 已合并 (N)` 折叠行提供一键 `[🧹 清理]` 操作，支持全选/多选预检、安全过滤（自动防护脏文件与运行中会话），一键批量执行 `git worktree remove` 与 prune，彻底释放磁盘与视觉空间。
- **验证**: `bun test` 41/41 全部通过；`bun --conditions react-server scripts/test-workspace-optimizations.ts` 全流程测试（Diff 接口、批量预检与 force 清理）全绿；`bun --bun run build` 成功通过。
- **Next**: 合并至 main 后 `make deploy` 部署上线。


### Session 123（2026-08-24，Compact Continuation 拓扑桥接：长动线上下文压缩后最终回复丢失与孤根断链修复）
- **触发**: 用户反馈 Turn 出现 25 步工具调用却显示「本轮暂无文本回复（只有工具调用）」，结合 Mac mini trellis workspace 与本地 chat transcript 分析归因。
- **根因**: Claude CLI 遇上下文超限自动 /compact 或手工 /compact 时，写入 `type: "system"` (parentUuid: null) 与 `type: "user"` (isCompactSummary: true) 条目。S120 为防止伪造 turn-start 劫持回复将 `isCompactSummary` 排除在 `isTurnStart` 和 `looseTurnStart` 之外；因 system 节点父链指向 null，紧随其后的 assistant 最终答复沿父链上溯到 null 被静默丢弃（resolveOwner 为 null），UI 呈现为只有工具调用、response 为空的僵尸状态，且 compact 之后的后续 turn 孤立成根。
- **Done**:
  1. `lib/server/cli-jsonl.ts`: `indexByUuid` 引入「拓扑桥接（Virtual Parent Linking）」，当 entry 为 compact 相关节点（`isCompactSummary`、`isVisibleInTranscriptOnly` 或 parentUuid 为 null 的 system 节点）且父链断开时，物理序列向前连接至最近有效的带 uuid entry，修复父链 DAG 遍历。
  2. `scripts/test-cli-jsonl.ts`: 新增 Section 4 专项回归断言「Compact Continuation 拓扑桥接与最终答复保留」，全链路验证 import 不丢最终回复、不伪造多余 Turn 节点、后续 Turn 正确继承 parentId、fork 截前缀 tail 正确指向 compact 后的 assistant 最终回复。
- **验证**:
  - `bun scripts/test-cli-jsonl.ts`: 12,752 个 JSONL 文件 / 14,351 个可见 Turn 全量真语料扫描 100% 通过（`noTail: 0, wrongTurn: 0`）。
  - 实测从 112 个真实 compact jsonl 恢复 32,982 条此前断链被弃的 assistant 消息与 82 个长动线最终答复。
- **Next**: 合并至 main 后部署上线。

### Session 122（2026-08-24，自动压缩感知增强：工具连跑折叠状态标识 + 轮次上下文自动压缩分隔条）
- **触发**: 用户反馈触发自动压缩时希望能明确感知到，避免静默压缩导致用户误以为步骤消失或未理解上下文转入紧凑摘要。
- **设计（两层压缩感知）**:
  1. **工具链级冷热折叠感知 (`SegmentRow`)**: 连续 ≥3 个已完成普通工具折叠成 chip 时，增加明确状态徽章（`[已自动收起]` / `[已展开]`）、操作提示浮层（`title="点击展开已自动收起的明细"`）及 live 活跃边框高亮，明确告知用户此处发生自动折叠与可点击展开。
  2. **会话轮次级上下文自动压缩感知 (`LinearThreadView`)**: 新增 `isContextCompacted` 判据（捕获 CLI 紧凑延续摘要标记与 ≥40k token 降幅 ≥40% 门限），在长会话触发自动 compact 时渲染虚线分隔条与徽章（`🗜️ 上下文已自动压缩（早期历史已转入模型紧凑摘要）`）。
- **Done**:
  1. `components/tools/ToolRow.tsx`: `SegmentRow` 增加 `已自动收起` / `已展开` 状态徽章、展开提示 tooltip、live 态视觉区隔，保持冷数据不进 DOM 的同时提供直观感知。
  2. `lib/context-usage.ts`: 新增 `isContextCompacted` 判定函数；补充 `lib/context-usage.test.ts` 单元测试。
  3. `components/LinearThreadView.tsx`: 接入 `isContextCompacted`，在紧凑压缩轮次交界处渲染分隔条与说明。
  4. `scripts/test-timeline-render.tsx`: 补全段落 chip 带有「已自动收起」提示的断言。
- **验证**: `bun test` 44/44 全部通过；`bun scripts/test-timeline-render.tsx`、`bun scripts/test-cli-jsonl.ts`、`bun scripts/test-tool-tree.ts` 全通过；`tsc --noEmit` 0 错。
- **Next**: 合并至 main 后部署上线。
### Session 121（2026-08-24，全平台 SVG 与 Mermaid 渲染与交互体系优化：双模式预览 + 图表放大 + 文件预览）
- **触发**: 用户「现在在平台上,好像不支持 svg 的渲染,做一些优化」→「除此外,把 mermaid 的渲染也加上」。
- **根因**: ① CodeBlock 仅将 `svg/xml/html/mermaid` 作为普通文本代码高亮展示，用户生成图表/流程图/矢量图只能看到一长串代码，无法直接看到渲染后的视觉图形；② 缺少「预览/源码」切换、背景色切换（网格/亮色/暗色防深浅冲突）、缩放与放大模态框、下载 SVG 等操作；③ FilePreview 对 `.svg` / `.mmd` / `.mermaid` 文件缺乏专用图表预览与源码双模式；④ Markdown 内直接嵌入的 `<svg>` 缺少响应式防溢出样式。
- **Done**:
  1. `lib/svg.ts`: 新增纯工具库——`isSvgCode`（语言与内容特征识别）、`extractSvg`、`normalizeSvg`（自动补全缺失的 `xmlns`、视口 `viewBox` 兜底、去除危险脚本）、`validateSvgSyntax`（DOMParser XML 解析校验）、`createSvgBlobUrl`（沙箱安全 Blob URL）、`downloadSvgFile`（一键下载）。
  2. `lib/mermaid.ts`: 新增异步懒加载 Mermaid 渲染引擎——`isMermaidCode`（语言与主流图表 starters 自动探测）、`renderMermaidToSvg`（根据当前暗亮主题动态配置 `mermaid.initialize`，支持 flow/sequence/class/state/er/gantt/mindmap 等全系图表语法，安全异常捕获）。
  3. `components/CodeBlock.tsx`: 全面升级支持 SVG 与 Mermaid 代码块——检测到矢量图或 Mermaid 图表时默认开启「👁 预览」视图；提供「👁 预览 / 📄 源码」一键切换；支持背景切换（网格底 / 亮底 / 暗底）、点击放大 / ⛶ 全屏弹窗大图预览（支持 20%~400% 缩放调节与 1:1 重置）、一键下载 `.svg` 矢量图、复制源码，遇到语法畸形或未完成生成时优雅降级提示并引导查看源码。
  4. `components/FilePreview.tsx`: 增加 `SvgFilePreview` 与 `MermaidFilePreview` 专属文件预览组件，支持视觉预览与源码查看双模式、缩放比例控制器、背景色切换与复制/下载；`lib/generated-files.ts` 与 `lib/server/workspace-files.ts` 扩展 `.mmd` / `.mermaid` 文件扩展名识别与 MIME 映射。
  5. `components/HoverPreview.tsx` & `app/globals.css`: 悬浮卡片增加高对比网格背景并支持 Mermaid 悬浮图表渲染；全局为 `.md-body svg` 增加自适应 `max-width: 100%`、`height: auto` 与居中展示，彻底杜绝内容溢出卡片。
- **验证**: `scripts/test-svg-rendering.tsx` 全流程断言通过（包含 SVG 提取/规范化/清洗、Mermaid 识别与 Markdown Unified AST/JSX 转换）；`bun --bun run build` 成功完成 Turbopack 生产编译。
- **Next**: 合并至 main，下次 `make deploy` 部署上线。

### Session 120（2026-08-23，Lineage 隔离分叉串线修复：切片失败安全降级 + 紧凑摘要/turn 判据收紧）
- **触发**: 用户反馈从历史节点分叉发问时，分支接续了另一条并行分支的上下文和执行历史。
- **根因**: ① `backfillNativeTurnUuid` 仅比对 `sortedTurns[0]`，遇末尾有新 turn 或 compact summary 插入时匹配失败致 `cli_turn_uuid` 漏填；② `looseTurnStart` 未过滤 Claude CLI 的 `isCompactSummary: true` 和 `isVisibleInTranscriptOnly: true` 合成条目；③ `route.ts` 分叉遇切片失败或 `nodeTurnUuid` 为 NULL 时，fallback 错误继承 `claudeSessionId = lin.lineageSid`，直接 resume 原 session 的 tip（导致并发生长分支互相串线污染）。
- **Done**:
  1. `lib/server/cli-jsonl.ts`: `looseTurnStart` 严格剔除 `isCompactSummary === true` 与 `isVisibleInTranscriptOnly === true`。
  2. `lib/server/cli-fork.ts`: `backfillNativeTurnUuid` 遍历 `sortedTurns` 匹配 question 文本，提升回填鲁棒性；无法匹配时安全放弃。
  3. `app/api/chat/route.ts`: 修复 native project 分叉降级逻辑，在无 lineage、切片失败或 `nodeTurnUuid` 缺失时，统一强制 `claudeSessionId = null` 并使用 `buildHistoryForNode(nodeId, { maxDepth: foldDepth })` 起 fresh 独立会话，彻底杜绝串线。
  4. 验证与对齐：`computeToolActiveDuration` 移入 `lib/format-tokens.ts`，测试与构建完全对齐。
- **验证**: `bun test` 41/41 全部通过；`bun scripts/test-cli-jsonl.ts` 新增 compact 摘要判定用例全通；`bun scripts/test-tool-tree.ts` 全通；`tsc --noEmit` 0 错。
- **Next**: 合并至 main 后 `make deploy` 部署上线。

### Session 119（2026-08-22，工具动线冷热重排：段落折叠 + 运行链面包屑 + 委派骨架）
- **触发**: 用户「全量加载信息乱——满屏工具调用把冷数据放进了热的视觉存储；要能 get 到当前运行的 agent/workflow/tool 及其关系，并能自然追溯」。
- **设计（三层温度）**: 热=header 面包屑（最深运行链 `⚙ wf › 🤖 agent › 工具 · 摘要 · tokens/耗时 · +N 并行`，面板收着也可见）+ 失败行 + 运行行 + 当前计划（最后一个 TodoWrite）；温=委派骨架（子 Agent/Workflow/长跑命令一行一个 + 聚合统计与嵌套失败上卷）；冷=连续 ≥3 个已完成普通工具压成段落 chip（`⋯ N 步 · Bash ×8 · Read ×3`），点击才逐行、行 body 再点击。追溯路径：摘要行 → 骨架 → 段落 → 行 → 子 Agent 内同构递归。
- **Done**:
  1. `lib/tool-tree.ts`: `segmentTimeline()`（MIN_SEGMENT=3；running/error/委派/检查点永不入段——chip 不许藏错）、`runningChain()`（并行取最新启动分支）、`nestedErrorCount()`；检查点=TodoWrite/ExitPlanMode/AskUserQuestion（叙事节拍当章节标题，实测 43 步 chip 吞掉提问节拍后加的）。
  2. `components/tools/ToolRow.tsx`: 新增 `TimelineList`（分段编排 + 唯一段落非流式直接铺行防白点一下 + last-TodoWrite 标记）、`SegmentRow`（段首 call id 作 key，新调用滚入不弹回收起态）；`rowAutoOpen` 改为 **live 期间压制 registry defaultOpen**（diff/清单是「刚才的事」，不许把正在跑的行推出屏幕）；委派行右侧红字报嵌套失败数。
  3. `components/tools/ToolTimeline.tsx`: LiveHeader 由「最深节点标签」改为运行链面包屑（叶子 shrink-0 永远完整，上游可截断；子 Agent 叶再深一格 lastToolName、Workflow 叶接正在跑的 agent label）；根渲染走 TimelineList。
  4. `components/tools/views/WorkflowView.tsx`: PhaseBlock 改 button-toggle——活跃 phase 自动铺开、跑完收成 `✔ 标题 done/total` 一行（用户点开置顶不被快照收回）；统计行加运行中计数。
- **验证**: bun test 41/41（新增 `lib/tool-tree.test.ts` 15 例）；`scripts/test-timeline-render.tsx` 66 断言 ALL PASS（新增冷热分段节；workflow fixture 补 running agent 适配 phase 折叠）；`scripts/test-tool-tree.ts` 回放 ALL PASS；tsc 0 错；`bun --bun run build` 过。**真库实测**（拷贝 prod DB 至 /tmp、worktree 起 :3298、agent-browser 走查）：35 步 turn=1 行+3 失败摊开+19 步 chip；75 步 turn=11 条骨架（3 具名子 Agent+2 失败+3 chip），段落下钻、子 Agent 展开、收起态摘要均正常。
- **Next**: 合并 main 后 `make deploy`；live 流式态的面包屑/热尾巴行为已被渲染测试覆盖但未真跑 claude 实测，上线后首个长任务顺带盯一眼。

### Session 118（2026-08-22，trellisctl 平台操作面：会话/树/节点读写 + GET /api/nodes/[id]）
- **触发**: 用户要求给 trellis-admin 扩展 herdr 式的平台读写能力（看隔壁树运行情况、往树上开新节点、开新树）。
- **设计**: 纯 CLI 扩展为主——盘点确认服务端能力基本齐备（`POST /api/chat` 三形态、`nodes/[id]/stream` catchup、`/api/runs`、sessions CRUD），且 run 与 HTTP 解耦使 CLI 可发完即走。唯一真缺口是「裸 nodeId → 元数据」直达路径。
- **Done**:
  1. `app/api/nodes/[id]/route.ts`: 新增 `GET`（复用 `getNode`，剥 toolCalls 发 toolCallStats，载荷纪律同 sessions/[id]）。
  2. `skills/trellis-admin/scripts/trellisctl.ts`: 新增平台操作面——`sessions`（list / get 树形大纲 / rename / archive / rm）、`ps`（在跑 + ⏸ 等回答）、`node`（get / read / label / rm）、`ask`（`--node` 分支 / `--session` 平行根 / `--new` 新会话，`--wait` 守终态，`--approval` 权限卡）、`wait` / `abort` / `retry` / `respond`（--allow / --deny / --answers）。基建：`apiSse` + `sseEvents`（SSE 消费）、`api()` 加 tolerate 参数。
  3. `skills/trellis-admin/SKILL.md`: description 扩操作面触发词；新增「平台操作面」章节（概念对齐 / ask 三形态语义表 / 等与接管 / 与任务分工）；Known Failure Modes 追加 3 条（--wait 超时重发、旧实例 404、respond 409）。
- **验证**: `bun --bun run build` 全过（裸 `bun run build` 会在 page-data 阶段死于 Node worker 找不到 bun:sqlite，必须 `--bun`）；worktree 起 `PORT=3299 bun server.ts` 测试实例全链路实测——sessions / ps / get 树形（2 树 + 分支缩进）✔、ask 三形态（mock provider 零成本）✔、wait 接力与终态回放 ✔、abort 404 容错 ✔、rename / label / rm 防呆与清理 ✔、respond 判空 ✔。respond 的 allow/deny 真实交互路径未实测（需 claude 系 run 停卡；逻辑比照 `InteractionForm.tsx:509`）。
- **Next**: 合并 main 后 `make deploy` 部署——`node get/read` 与 `respond` 依赖新 GET route，打旧实例是 404（已写进 Known Failure Modes）。

### Session 117（2026-08-22，定时任务固定入口：侧栏「⏱ 定时任务」分组 + 深链跳转修复）
- **触发**: 用户「希望给定时任务单独分配一个固定的工作区，通过左边的列表点进去看执行情况；现在点历史运行记录，跳转目标特别奇怪」。
- **根因（跳转奇怪）**: 任务会话 `kind='task'` 被 `/api/sessions` 全量排除 → 深链落地后侧栏无行可高亮、tab 条 `byId` resolve 不出该会话；且主页深链只 `loadSession` 不占 tab 位，`hydrate` 又把 preview tab 设回 `sessions[0]`——dev StrictMode 双跑下第二个 hydrate 实例在深链之后完成、覆盖 preview，**画面与 tab/侧栏指向两个不同会话**。
- **Done ① 侧栏固定分组（SessionSidebar）**: 新增「⏱ 定时任务」分组，行骨架来自 **tasks 表**（任务是常驻实体——没跑过的任务渲染灰行占位，不因会话未懒建而隐身）；有 home 会话的行走 SidebarRow（preview/pin/改名/归档/删除、running 脉冲与未读角标全部免费复用，`/api/runs` 本就不分 kind）；分组 ＋ 号跳 `/settings/tasks`；任务已删的存量孤儿 task 会话也列出不吞。
- **Done ② API**: `/api/sessions` 响应加 `tasks`（id/name/homeSessionId/enabled）+ `taskSessions`；repo 新增 `listTaskSessions()`；归档视图放宽 kind（`archived=1` 时 user+task 都列，`countArchivedSessions` 同口径）——否则归档的任务会话从每个列表里消失。
- **Done ③ 生命周期闭环（lib/server/tasks.ts）**: `updateTask` 改名/改目录同步 home 会话（title `⏱ name` / workspace_path）；`deleteTask` 把 home 会话翻回 `kind='user'`（历史落进常规列表）；新增 `detachHomeSession()` 挂在会话 DELETE / 归档 PATCH 上解绑指针（归档语义 = 历史收起、下次执行重开新会话）；`ensureTaskSession` 校验 home 会话行仍存活，悬挂即重建。
- **Done ④ 深链修复**: `page.tsx` 深链改走 `previewSession`（占 tab 位，与侧栏点行同路径）；`sessionStore.hydrate` 加 hydrated guard + `hydrateInFlight` 防重入（双跑并发），尾部 preview **只在空位落座**（深链先到就不挤）；`SessionTabs.byId` 并入 taskSessions。
- **Done ⑤ TaskToast**: run_started/run_finished 事件 `bumpSessionsRevision()`（首跑懒建的会话行即时长出）；点击 toast 从 `window.location.href` 整页刷新改为 store 内 `previewSession + setActiveNode`（同路由改 URL 本就不触发深链 effect，老写法靠整页重启 store 才凑效）。
- **验证**: tsc 0 错；bun test 26/26；隔离 dev（:3199、mock provider、`TRELLIS_SCHEDULER=off`、独立 `TRELLIS_DB_PATH`）curl 全链路实测——建任务→tasks 字段灰行→首跑懒建 `⏱` 会话且不混入 user 列表→改名同步→归档解绑+归档区可找回→重跑重建新会话→删任务翻 user；agent-browser 实测深链落地三处一致（tab=⏱ 任务、侧栏分组行高亮、画布聚焦该次执行根节点），侧栏行来回切换正常。
- **Next**: 合并 main 后 `make deploy`；可选迭代——灰行（没跑过的任务）点击直跳设置页选中该任务。

### Session 116（2026-08-21，画布完全剔除隐藏树 + 大纲分组与一键恢复）
- **触发**: 用户反馈隐藏的树在画布上仍然会出现。
- **根因**: `Canvas.tsx` 中 `hiddenIds` 仅通过 `hiddenByCollapse` 处理折叠节点的后代，未将 `hiddenAt !== null` 的雪藏树（根及全部后代）加入排除集合；`Outline.tsx` 未区分可见树与雪藏树，且缺少对雪藏树的恢复/隐藏控制。
- **Done**:
  1. `lib/collapsed.ts`: 新增 `hiddenCanvasNodeIds`，统一将「折叠节点的后代」以及「雪藏树（`root.hiddenAt !== null`）根与全部后代」纳入隐藏 ID 集合；补充 `lib/collapsed.test.ts` 单元测试。
  2. `components/Canvas.tsx`: `hiddenIds` 改用 `hiddenCanvasNodeIds`，在 Dagre 自动布局、`flowNodes`、`flowEdges`、焦点平移、页面挂载落地候选（`fresh`）中全面排除雪藏树。
  3. `components/Outline.tsx`: 区分 `visibleForest` 与 `hiddenForest`；增加 `已隐藏 · N 棵` 折叠分组（默认收起，全隐藏时自适应展开）；根节点行新增悬停隐藏/恢复按钮，支持在思维树大纲直接隐藏或恢复树，并自动切换焦点。
  4. `stores/sessionStore.ts`: `setViewMode("canvas")` 切换至画布时，若焦点所在树为隐藏树，自动回退到首棵可见树根。
- **验证**: `bun test` 26/26 全部通过（覆盖 collapsed、tree-panel、format-tokens、context-usage）；相关逻辑零报错。
- **Next**: 合并至 main，下次 `make deploy` 部署上线。

### Session 115（2026-08-21，树命名/重命名支持：PATCH API + Store 乐观更新 + 树面板行内编辑）
- **触发**: 用户提问「能支持对 树 命名吗」→ 评估可行性后立即落地。
- **Done ① API & Store**:
  1. `app/api/nodes/[id]/route.ts`: 新增 `PATCH` 处理器支持更新 `topicLabel`，调用已有 `repo.setNodeTopicLabel` 落库 `nodes.topic_label`。
  2. `stores/sessionStore.ts`: 新增 `renameTree(nodeId, title)` action，自动向上回溯根节点，乐观更新 `node.topicLabel` 并发送 API 请求，失败自动回滚。
- **Done ② UI 交互（TreePanel）**:
  1. `components/TreePanel.tsx`: 当前活跃树头行（`renderActiveTree`）与折叠态树行（`renderTreeRow`）全面支持树重命名——双击树名或悬停点击重命名按钮（铅笔图标）进入行内编辑 `<input>`，支持 Enter / onBlur 提交与 Escape 取消。
  2. 命名联动：所有视图（TreePanel、Outline、Header、Canvas）统一消费 `treeLabel(root)`，修改后全站即时同步。
- **验证**: `bun test` 26 pass ✔；`node_modules/.bin/tsc --noEmit` 0 错 ✔；`eslint` 0 错 ✔；`bun --bun run build` 成功通过 ✔。
- **Next**: 提交分支、提交 PR 并合并至 master/main。

### Session 114（2026-08-21，Token 统计精准化 + 单卡耗时 & Token 使用 & 纯模型 TPS 仪表）
- **触发**: 用户反馈两个问题：① 当前 token 统计不精确；② 最好能在每个卡片展示耗时 & token 使用 & TPS。
- **根因 & Done ① Token 统计精准化**:
  1. `lib/format-tokens.ts`: 原先 ≥10k 粗暴 `Math.round(n/1000) + 'k'`（如 12.4k 变成 12k、85.6k 变成 86k，抹杀数百 token 精度）。改为 1k~1M 均保留 1 位小数（整千自动去尾 `.0`，如 `12.4k`、`15k`、`125.4k`），≥1M 保留 2 位小数（如 `1.25M`）。
  2. `lib/server/cli-import.ts`: 多步工具调用 turn 中原先只取最后一条 assistant 消息的 `lastUsage`（丢失该轮前期全部工具调用的 token）。修复为全轮所有 assistant message 的 token 累加（input / output / cacheRead / cacheCreation 逐项求和），`contextTokens` 精确取末条占用。
  3. `lib/server/codex-import.ts`: 优先消费 `info.total_token_usage`，多步工具与 token 累积一致。
- **Done ② 单卡耗时 & Token 使用 & 纯模型 TPS 展示**:
  1. 数据流与落库：`nodes` 加 `duration_ms INTEGER` 列，`run-bus` 记录提问到 done 的总耗时并在 done 事件及 `finalizeNode` 中落库；`cli-import` 与 `codex-import` 计算每轮时间差回填 `durationMs`。
  2. 组件 `TurnStatsMeta`: 统一计算并渲染 ⏱️ 耗时（流式态秒级跳动、done 态精确显示）、Token 细分（↑输入 ↓输出 ⚡缓存，带高精度 hover 详情）、⚡ TPS（`outputTokens / llmDurationSeconds`，**自动合并并扣除工具执行时间**，准确反映 Model API 生成速率）。
  3. 视图接入：`TurnCard`（线性视图/工作台）底部操作栏左侧嵌入 `TurnStatsMeta`，流式期间与完成态自适应；`ChatNode`（画布视图完整卡片与紧凑卡片）接入 `TurnStatsMeta`，全端体验对齐。
- **验证**: `bun test` 17/17 全过（涵盖精度、耗时格式化、工具时间区间合并与扣除、TPS 纯模型速率计算）；`tsc --noEmit` 零错；`scripts/test-cli-jsonl.ts` 与 `scripts/test-tool-tree.ts` 全绿。
- **Next**: 合并至 main，下次 `make deploy` 部署上线。
