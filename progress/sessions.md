# Session Log

最近 5 条，倒序（Session 122 / 121 / 120 / 119 / 118）。更早的见 `archive.md`。

### Session 122（2026-08-28，飞书机器人载体：注册/绑定 Bot + WS 长连接双向对话；焚决派发 codex 实现）
- **触发**: 用户「定时任务是调度机制、agent 是身份，但没有一个载体——先支持飞书机器人，支持绑定/注册，也支持在飞书对话，参考 happyclaw 方案」。正是 custom-agents-plan 明确「推迟」的飞书载体项启动。
- **方案定盘（Owner 侧，两路 Explore 侦察后）**: 采 happyclaw 的**形状**（`@larksuiteoapi/node-sdk` WS 长连接、EventDispatcher、mention 门控），拒其**厚度**（六态耐久投递/流式卡片/多级绑定 = 多租户账单，happyclaw-contrast.md 既有裁决）。核心决策：①三表 `lark_bots`/`lark_chats`/`lark_inbox`（去重照 `task_runs_slot` 抢槽 idiom，仅 `SQLITE_CONSTRAINT_UNIQUE|PRIMARYKEY` 算 dup）②每飞书 chat = `kind='lark'` 会话内一条线性链（新消息 = `last_node_id` 子节点 + resume，侧栏可见）③per-chat 内存串行队列（深度 5）+ 全局并发 2（`AsyncSemaphore` 原子交接）④群聊必须 @bot（`bot_open_id` 缺失 fail-closed）、bot 自身消息无条件忽略（防自触发烧钱循环）⑤连接管理 = instrumentation 挂 `startLarkManager()` 15s 对账 tick，route 只写 DB（跨 bundle 模块实例不共享，S87 坑）⑥`TRELLIS_LARK=off` deploy smoke 闸。
- **执行（焚决 fj-lark-bot-28f1，codex+gpt-5.6-sol 坐席）**: 33min 交付 + 1 轮缺陷收尾，全程 3 progress + 1 blocker（settings-tabs.ts 补授权）+ 2 result。产物：`lib/server/lark/`（protocol/store/sdk/handler/manager/semaphore 六模块）+ `/api/lark-bots` CRUD/test + `app/settings/bots` 整页 UI（secret 不回显、连接状态徽标、chats 深链）+ `scripts/test-lark-bot.ts`（18 断言）+ `scripts/lark-ws-smoke.ts`（无凭证 SKIP）。commit `ac78755`。
- **验证**: settle 独立复跑两轮全绿（tsc 0 错 / 18 断言 / production build / WS 冒烟 SKIP / TRELLIS_LARK 三文件命中），scope 零越界；falsification-verifier 对 8 条不变式逐条 PoC 证伪全 HOLDS（防自触发 10 种 sender 变体 fail-closed、per-chat 串行 30k 压测零重叠、`SQLITE_BUSY` 真抛不吞、secret 三面不漏），其揪出的全局信号量非原子交接（微任务窗口可越 cap 2 倍）已由坐席修复（`semaphore.ts` 原子 handoff + 压测断言 peak=2）。
- **Next**: ①真凭证端到端联调（`LARK_SMOKE_APP_ID/SECRET` 跑 lark-ws-smoke + 开放平台开通机器人能力/事件订阅长连接/im 权限，本机 lark-cli app `cli_a923d94f1bf89bef` 凭证已验活）②worktree 分支 merge 回 main ③`make deploy` 上线。

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
