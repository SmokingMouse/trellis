# Trellis Progress

## Current Focus
上线机制已换成 release 目录 + 原子切换 + 自动回滚（待用户确认后 `make install-launchd` 切 prod）；S1 工作平台化的 P0+P1 已上线，正停一周看行为判据。

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

## 指针区

- `facts.md` — 已验证事实（改代码前读）
- `failures.md` — 待查 / 已结案失败（排查 bug 前读）
- `sessions.md` — 最近 5 条 session log（Session 78/77/75/74/73）
- `archive.md` — 更早的 session log（Session 72–1）+ 历史 Current Focus 栈
- `decisions.md` · `decisions/` — 轻量决策日志 / 重量 ADR
- `blocks/` — 并行 worktree 独占进度块

Feature spec：
- `project-workspace-layer.md` · `project-lineage-isolation-spec.md`
- `cli-branch-alignment.md` · `cli-branch-alignment-p1-spec.md` · `cli-branch-alignment-p2-spec.md` · `cli-sync.md`
- `roadmap-2026q2.md` · `optimization-roadmap.md` · `session-workbench.md` · `mode-workspace-rebuild.md`
- `fts-search.md` · `vision-input.md` · `reference-nodes.md` · `cancel-send-ux.md` · `anchor-dom-inject.md`
- `chat-bfork-context.md` · `linear-thread-view-spec.md` · `permission-gate.md`
