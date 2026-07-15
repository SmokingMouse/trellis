# Trellis Progress

## Current Focus
**Project 线性 thread 主视图 + 树缩略图已落地（待浏览器验）** → [spec](linear-thread-view-spec.md)。纯前端增量：project 默认 `viewMode=linear`，线性 thread 按 active lineage 展开，分叉折成行内入口，右下角 SVG 树缩略图导航；chat/workspace 的 canvas + NodeFullView 路径保持不变。验证：`npx tsc --noEmit` ✓、`npm run build` ✓。**未 commit。下一步：浏览器实测真实 project 会话的线性默认、分叉切 lineage、画布往返、缩略图点击。**

---
**CLI ↔ trellis 分支对齐 P1+P2 全落地（含真 claude 端到端验）** → [P1 spec](cli-branch-alignment-p1-spec.md) / [P2 spec](cli-branch-alignment-p2-spec.md)。双向分叉对齐做透：P1=CLI→trellis（union 导入 + lineage 发现 + watcher 新 fork 检测）；P2=trellis→CLI（attached 会话续聊/分叉的 resume 重定向 + 构造前缀 jsonl）。P2 统一模型=分叉一律构造前缀 jsonl（弃 fork-session，见 decisions.md）。落地：`cli_lineages` 表 + per-node lineage sid + `attachedLineageForNode`/`buildPrefixJsonl`/`hasOtherChild`/`registerForkLineage`（`cli-fork.ts`）+ `/api/chat` origin='cli-import' 分支路由（tip 且无子→线性 resume 该 lineage；否则→前缀 jsonl 在 X 分叉成新 lineage + setNodeResumeId）+ `deleteNodeSubtree` 加 origin 闸防误删用户 jsonl。仅动 `origin='cli-import'`，原生 chat/workspace/project + `getRootResumeIdForNode` + 解析器内核零改。**验证**：P1/P2a fixture ALL PASS（独立跑、临时 DB）；**P2 翻盘性未知真 claude 闭环**——真会话 2 轮（香蕉→苹果）→ `buildPrefixJsonl` 截到 turn1 → 真 `claude --resume` 答「只记得香蕉」（不知被截掉的苹果）→ 程序化前缀 jsonl 可被真 claude 从任意历史点续上；`npm run build` ✓ + tsc ✓。**HTTP 全链路 e2e 已验收**（隔离 dev server + 真 claude：从历史节点分叉→`/api/chat`→spawn→reconcile→fork 子树正确长出、答案严格截到分叉点）。**未 commit。下一步：按需 commit/merge `feat/cli-session-sync`。**

---
**新功能定 spec(Session 31):CLI Session 同步** → [spec](cli-sync.md)。把本机 Claude Code CLI 的本地会话(`~/.claude/projects/*/*.jsonl`,88 个 project 目录)持续实时**镜像**进 trellis(只读浏览/搜索/导出,v1 不续聊)。需求确认:数据源=CLI jsonl、语义=持续实时同步、范围=opt-in 选择器。可行性已验(jsonl 字段↔节点模型一一对应,逐行结构已抽样钉死)。关键设计三点:(a) collapse 规则(真 user turn→节点,tool_use+tool_result→ToolCall[]) (b) 防回环去重(跳过文件名∈trellis 自有 session id 的 jsonl) (c) 只读镜像。分 4 Stage(A 解析器+一次性导入 → B 实时 watcher → C 选择器 UI+只读门禁 → D 可选续聊)。**CLI Session 同步 = per-session attach + 真双向,全做完并已部署 prod**(分支 `feat/cli-session-sync`,未 commit;详见 [cli-sync.md](cli-sync.md) + decisions.md)。设计经一次推翻(只读镜像→双向 attach)。落地:解析器/DB importer/discover/watcher/对账 + instrumentation boot + discover·attach API + CliAttachPicker UI(SessionSidebar 入口 + CLI 角标)。双向:CLI 侧新轮 watcher 自动同步进 trellis,Session 38 补上前端 SSE 事件通道后当前打开的 attach session 无需刷新会自动 reload;trellis 续聊走 project resume 写回同一 jsonl + done 后身份对账(删临时节点、canonical jsonl-uuid 接管、reload_session 通知客户端)。dev 端到端全验(含真实续聊写回 PONG + 浏览器实测 attach/detach/角标),`npm run build` ✓,launchd 重启部署、prod 路由 401(已上线被闸挡)。途中抓修:system 边界节点断链(致全孤根)、attach 删除 hazard(origin 闸挡)。**下一步:用户验收;按需 commit/merge。**

---
**Session 工作台层(Session 29)** → [spec](session-workbench.md)。原北极星「替代 GPT + Claude Code CLI」交互层已基本达成,下一道坎是「承载更多工作」——让 CLI 重度用户能像 tmux 一样并行承载多 session、靠肌肉记忆导航。已完成 recon(4 agent 并发测绘),关键发现:**执行引擎(run-bus)本就多 session 并发,墙在 store 单 active session 模型 + 缺导航/生命周期/命令 UI 层;一大半"迷惑"是可发现性而非能力缺失**。三组件:(a) tmux tab 导航 (b) session 生命周期正名 (c) 命令面板。**三波全部落地(Session 29-30,build ✓×3,UI 待浏览器实测)**:Wave 1(SessionTabs + `/api/runs`)+ Wave 2(B1 正名/B2 归档/B3 compact 降级)+ Wave 3(C1 命令面板,`/` 前缀触发 /new /clear /archive /switch /model)。deferred 项:Level B 多 session in-memory store 重构、`/model` per-session DB 锁定(均有产品语义未决,实测驱动再上)。下一步:浏览器实测全部交互。

---
**费曼学习法 Phase 1 已落地**（Session 28，轻量预设版，未实测）。继续按 [optimization-roadmap.md](optimization-roadmap.md)（替代 GPT 体验优化）实施第一阶段 P0。**用户要求「一口气全做完」。已完成 15 项**（全部 `npm run build` ✓）：
- P0：A3 代码块/回复复制 · B2(并入) · D1 System Prompt 可配 · A4 Enter 发送 · A1 全屏流式 markdown · B1 移动端 Outline 抽屉 · A2 编辑=新分支重问 · C2 记忆桥接(写侧) · C1 文件附件(code/text 子集)
- P1/P2：B5 a11y · B4 首屏建议 · A5 Alt+方向导航 · D2 上下文 depth 可调 · D5 多版本对比 · C4 Skill 入口

**剩余（每项有明确状态，非遗漏）**：
- C1 PDF/Excel/Word — 二进制需 npm 装 sheetjs/pdf/mammoth 解析（code/text 子集已做）
- C5 / A6 / B3 — 评估低 ROI 暂缓（理由见 P1/P2 清单，简洁优先）
- D4 thinking — SDK 无 thinking 事件，blocked；D3 工具闭环 — 疑底层已覆盖待确认
- C3 语义检索（Q2 embedding 未决）· C6 图片生成（Q3 倾向不做，走 ai-legion）

**全部待浏览器实测**（dev server 在 3001）。roadmap 的 Stage 20/22（plan 节点/subagent 可视化）仍属功能广度归原 roadmap。本轮补的是交互/UI/对话内核体验维度。

## Goals
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
- [x] Stage 19: 文件附件（Session 45 落地，形态调整：进 composer 附件而非 reference 节点——CSV/文本/PDF 等通用文件走「blob + staging 路径注入 prompt」，agent 自己用工具读）

**Wave 3 (Week 5-6) — 树状结构优势放大**
- [ ] Stage 20: Plan 节点 type（计划-步骤-子节点联动，对齐 Plan → Execute → Verify → Learn）
- [ ] Stage 21: Memory 桥接（节点 ↔ ~/.claude/memory/ 双向）
- [ ] Stage 22 (可选): Subagent 子树可视化

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
- [ ] D4 thinking 可视化 — **疑似 blocked**：agent-gateway SDK 的 EventType 无 thinking 事件，需 SDK 支持，待确认
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
- [x] C1: 通用命令面板(Session 30)。新 `lib/commands.ts` registry(`matchCommands`/`parseCommand`/`resolveProvider`)+ QuestionInput 提交拦截分流(纯 Trellis 命令本地执行不发 LLM,skill 照旧透传 CLI)+ `/` 下拉合并命令(前)+skill(后)。`/clear` 复用 Wave 2 `setComposeRootOpen`。仅接首屏 composer(命令是 session 元操作),追问框刻意不接
- [x] B3: `/compact` 降级提示(Session 30 随 Wave 2 一起做)。spike 确认 claude CLI/SDK 无原生 compact → 降级为 Header 🧠 ctx 徽章在 ≥50% 时变可点 popover(解释上下文压力 + 「🧹 开新话题清空」一键复用 createRootInSession,经 store `composeRootOpen` 标志驱动 AddNodeFAB 的 NewQuestionPicker)。<50% 保持非交互只读不打扰。不实现 summarize
- [ ] (deferred) Level B 多 session in-memory store 重构 / C2 per-session model

## Session Log
### Session 45 (2026-07-15)
- **Done**: **临时文件上传（Stage 19 落地，形态调整为 composer 附件）**。动机：远程操作时快速给 agent 补充文件+上下文（CSV/日志/PDF 等截图之外的东西）。核心设计：**复用 Stage 15 blob 基座零 schema 变更**（`attachments_json` 原样，kind 由 mime 推断），通用文件**不进 provider vision 通道**——tool-capable 模式（workspace/project/chat增强，全是 `--dangerously-skip-permissions`）spawn 前物化到 `~/.trellis/uploads/<nodeId>/<原文件名>` + prompt 末尾注入绝对路径清单，agent 自己 Read/Bash 消费（CSV 能现场跑分析）；纯 chat 文本类 ≤128KB 内联 fenced block、二进制 UI 拦 + 服务端 prompt 注明。`~/sdk` 零改动、codex 路径零改动。
  - 新 `lib/attachments.ts`（客户端/服务端共享 ext↔mime 白名单 ~35 种 + 分类 helpers）；`blobs.ts` 泛化（storeBlob 按 ext、resolveBlobPath 全表、`materializeAttachments` 幂等 staging→retry 免费复用、`readTextBlob`）；uploads POST 收通用文件（multipart 必带文件名，ext 白名单 + 服务端钦定 canonical mime 防浏览器 junk mime）、GET 加 `?name=` Content-Disposition；chat route images/files 分流 + `questionForTopic` 隔离（内联大 CSV 不污染 topic label）。
  - 前端：新 `hooks/useAttachmentUploads.ts` 抽掉 QuestionInput/BranchPopover 各 ~80 行重复（顺手修多文件拖入 stale length 超上限），policy 感知（纯 chat=图+文本，tool-capable=全量）；AttachmentPreview 非图片渲染文件 chip（图标+文件名+大小，readonly 点击开 `?name=` URL），`PendingAttachment` 加 mime；**LinearThreadView 底部 composer 从零接上附件**（远程 project 主视图，此前连图片都不支持）+ QuestionBlock 只读渲染附件。
- **验证**（隔离 dev 3099 + 临时 DB + 真 claude haiku 全链路）：curl 上传 csv（含 junk mime→canonical）/415 拦截/Content-Disposition/图片 raw 回归全过；**workspace 真 claude 带 CSV → Read staging 路径 → 答对 3 行、均值 86.33**；纯 chat 内联答对 bob=92（无 tool call）；纯 chat PDF → 模型正确告知换模式；**retry 删 staging 后幂等重建再答对**；project 两轮 resume 不断链（turn2 答对 carol=79）；agent-browser 实测线性视图选文件→chip→发送→答对 3 列列名 + 纯 chat 传 PDF 弹拦截提示 + csv 放行。tsc ✓ + `make build` ✓。测试产物全清（临时 DB/blob/staging/jsonl/测试文件）。
- **边界**：export.ts 不动（图片附件本也不导出，保持一致）；staging/blob GC 沿用 P2 决策；文件路径只注入当轮 prompt 不回灌折叠历史（与图片对齐）。
- **Next**: 用户真机（手机远程）验收；按需 commit。

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
