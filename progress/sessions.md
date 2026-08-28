# Session Log

最近 5 条，倒序（Session 122 / 121 / 120 / 119 / 118）。更早的见 `archive.md`。

### Session 122（2026-08-28，S4 多租户第一期落地：实例级隔离 + 租户网关，焚决四坐席并行交付）
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
