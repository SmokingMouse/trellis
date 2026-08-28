# Session Log

最近 5 条，倒序（Session 127 / 126 / 125 / 124 / 123）。更早的见 `archive.md`。

### Session 127（2026-08-28，S4 二期统一门户:邀请码自助注册 + 管理员宿主路由 + 用户间模型共享;焚决双单并行交付）
- **触发**: 用户「现在的多租户模式不是我想要的:统一注册&登录入口、管理员占据宿主机、普通用户工作目录在 docker 文件隔离、支持不同用户间模型共享」→ 主 Agent 协调,AskUserQuestion 对齐四项拍板(邀请码自助注册 / 任意用户互享 / Claude token + 第三方 endpoint 双类 / 管理面板要在 trellis 里)。
- **方案定盘**（[二期 ADR](decisions/2026-08-28-multi-tenancy-unified-portal.md)）: 一期容器隔离与统一登录保留,真差距三点(自助注册 / 管理员入网关 / 共享系统化)。核心分层:**UI 在 trellis 本体(`TRELLIS_ADMIN_UI=1` 闸的 `/admin` + `/settings/shares`),控制面 API 在网关(`/__gw/api/*` 拦截自答,role 两级鉴权)**,docker/gateway.db 特权全集中网关进程;admin 经 tenants/*.json 三字段 host 记录路由到宿主实例(一期路由机制无容器假设,顺纹理);共享池发布/订阅,claude-token=env+容器重建(每租户单激活新换旧),endpoint=endpoints.yaml `# fj-share:<id>` 标记块(幂等可撤不碰自有条目);修订一期「本体零改动」原则为「只读 env 开关+调 /__gw/api 的薄层」(ADR 记收窄续期)。
- **执行**（焚决两单,接口先行:`tenancy/gateway/API.md` 由主控写死进两张契约作共同真理源;worktree 隔离并行,FENJUE_ROOT 指回主控信箱）:
  1. `fj-gw-portal-be6e`（codex）: `tenancy/gateway/` 新增 api.ts/endpoint-share.ts/orchestrator.ts——role/invites/共享池 additive 迁移、自助注册异步 provision(spawn tenantctl,状态可轮询)、admin API 全量、订阅注入编排(TRELLIS_GW_TENANTCTL 可替身)、selftest 12→21 项;endpoint payload 按 UpsertProviderInput 定稿回写 API.md。~50min 交付,1 blocker(build 命令口径,fallback 正确)。
  2. `fj-admin-ui-2029`（gemini）: `app/admin/`(用户表/容器态/禁用启用重启/邀请码管理/共享总览,无闸 404)+ `app/settings/shares/`(发布/撤销/订阅退订,willRestart 确认,「共享=交出」固定明示)+ `lib/gw-client.ts`/`gw-types.ts` + Header role 感知入口 + `scripts/selftest-admin-ui.ts`(双 next 实例+反代型 mock 网关,断言含网关不可达降级不白屏);settings-tabs.ts 未漏。1 轮 rework(selftest 冷启动)。
- **治理经验（实弹）**: ① 主控契约 verify 命令写错——`bun run build` 用 node 跑 next,`bun:sqlite` 顶层 import 即炸,本仓必须 `bun --bun run build`;且全仓 lint 存量脏(56 errors)——settle 误 fail 后先在主控树验基线分清存量/引入,修契约 verify(--bun + 定向 lint)再重判,坐席不背存量账。② 并行坐席 selftest 固定端口互踩:A 单 settle 复跑恰逢 B 返工起测试服务,瞬态 fail;手动复跑全绿定性后**串行 settle** 通过——并行单的 verify 涉起服务时端口需隔离或结算串行。
- **验证**: 两单 settle 独立复跑 pass + scope 零越界(不采信坐席自述);merge 后合并体三条全绿(`bun --bun run build` / gateway selftest 21 项 / admin-ui selftest 含降级态)。
- **Next**: ① 契约 C 接线联调:宿主实例开 auth gate + host 记录正式化 + 真容器端到端(注册→开容→admin→共享注入)——**涉重启宿主 prod trellis,时机待用户拍板**;② 公网接入仍待拍板(caddy+域名);③ 一期 S126 Next 的 memos/stirling 改绑 127.0.0.1 未动。

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
