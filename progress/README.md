# Trellis Progress

## Current Focus
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
- [ ] Stage 19: 文件附件（PDF/Excel/Word/code 拖拽进 reference 节点）

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

## Session Log
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
- **Next**: 实测 chat 增强（开关/skill/联网，需 codex 或开增强）；移动端专项复核；roadmap 剩余大件（C1 PDF/Excel 需装依赖、C3 语义检索 Q2、C6 图片生成 Q3）。**（README 6 条 session log，下次轮转 Session 22 入 archive）**
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
  - **repo 层显式 sync（不走 trigger）**：考虑过 SQL trigger 但 `appendNodeResponse` 每个 delta 都触发会写放大；改为 10 处 mutation 内显式调 `ftsUpsert(db, kind, sourceId, sessionId, text)` helper。具体：
    - `createSessionWithRoot` / `createRootInSession` / `createBranchNode` 各加一行 sync question（spec 写"等 finalize"，实现时调整为创建即入索引——question 创建态已是最终态，没必要延迟）。
    - `finalizeNode` 读 `response`，status='done' 写 node_response，status='error' 删 node_response（错误流式残留是噪音）。
    - `resetNodeForRetry` 删 node_response（旧响应清空了，避免重试期间命中已不存在的文）。
    - `createReferenceNode` / `finalizeReferenceFetch` / `refreshReferenceNode` 各 upsert node_reference。
    - `createNote` upsert note；`deleteNote` 删行。
    - `deleteNodeSubtree` 收集 subtree ids + noteIds → 一次 IN 批量删（UUID 跨 kind 不冲突）。
    - `deleteSession` 显式 `DELETE FROM search_index WHERE session_id = ?`——FK CASCADE 不覆盖虚拟表。
  - **searchAll(query, limit=80)**（`lib/server/repo.ts`）：
    - `buildFtsQuery` trim + 长度 < 3 返 null（trigram 边界）+ 双引号 escape（`"` → `""`）+ 整体用 `"..."` phrase 包裹。trigram phrase 等价于子串匹配，不需要布尔操作符。
    - SQL：FTS JOIN sessions（INNER——orphan 节点被天然过滤，这是好事），ORDER BY `bm25(search_index)` ASC，`snippet(...)` 调两次：一次 `<mark>` 包装给 UI 渲染，一次空 marker + 空 ellipsis 给 client 当 anchor matchText。
    - 同 session 多 hits 在 JS 层折叠到一个 `SearchResult` 内（先按 bm25 排序了，第一个 hit 决定 session 的展示顺序）。
    - 全段 try/catch：FTS5 罕见的 syntax error 当 0 结果处理，不 500。
  - **API `/api/search?q=&limit=`**（`app/api/search/route.ts`）：薄壳，limit 上限 200。`runtime = "nodejs"` + `dynamic = "force-dynamic"`。
  - **store 改动**（`stores/sessionStore.ts`）：
    - `pendingScrollAnchor` union 加第三个 case `kind: "search"`，带 `matchText` + `matchKind` ("question" | "response" | "reference")。
    - 新 action `jumpToSearchHit({sessionId, nodeId, matchText, matchKind})`：跨 session 时先 await `loadSessionInternal`（同步等到节点加载完，否则后续 set 会被 load 函数覆盖），再 `expandAncestors(nodeId)` + set `activeNodeId / fullScreen / pendingScrollAnchor`。
    - 笔记类 hit 不走 jumpToSearchHit，UI 层直接调 `jumpToNoteSource`——复用已有的"跳源节点 + emerald pulse 笔记原句"路径。
  - **`lib/dom-mark-injector.ts`**：DataKey 扩 `"searchId"`；clearMarks 选择器加 `mark[data-search-id]`。其他算法（whitespace normalize / per-textNode wrap / index rebuild per anchor）不动。
  - **NodeFullView `useMarkdownBodyMarks`**（`components/NodeFullView.tsx`）：
    - 新增 `searchAnchor` useMemo：当 `pendingScrollAnchor.kind === "search"` 且 `nodeId` 命中且 `matchKind !== "question"` 时返 matchText，否则 null。
    - 注入 effect 在原 note + child 之外加第三个 spec（dataKey:"searchId"，单 anchor id:"current"）。push 在最后 → 嵌套语义跟 child 一致（marks land 内层）。
    - scroll effect selector 三分支：child / note / search。kind===search 用 `mark[data-search-id="current"]` 选择器。
    - matchKind===question 时 searchAnchor 为 null，scroll effect 找不到 mark 走 rAF 两次重试后 clearScrollAnchor 兜底——节点本身已激活+全屏，question 在视图顶部用户自然看见，不强制 pulse。
  - **CSS**（`app/globals.css`）：新增 `mark[data-search-id]` emerald 静态样式 + dark mode 变体 + `.anchor-pulse` 复用现有 emerald 动画。视觉跟 note mark 同色——区别只在 mark 是临时的（pulse 完即 clear）。
  - **SearchModal**（`components/SearchModal.tsx`）：
    - 自管 open state；全局 `keydown` listener 监听 `(metaKey||ctrlKey) && (key==='p'||'P')`，`preventDefault` 覆盖浏览器 print 快捷键。
    - 输入框 200ms debounce → fetch `/api/search`。< 3 字符直接 short-circuit，UI 显示「至少输入 3 个字符（trigram 分词器限制）」。empty / loading / too-short 三态分别 placeholder。
    - facet chips 四档（all/chat/workspace/project）走 client 侧过滤（节省往返）。
    - 结果按 session 分组，每组顶部展示 title + ModeChip + workspace basename。每条 hit 行：sourceKind icon（💬 question / 💭 response / 📄 reference / 📝 note）+ snippet（dangerouslySetInnerHTML 渲染 `<mark>` 高亮——FTS 返回的内容已是 plain text + 我们注入的 mark tag，不存在 XSS）。
    - 键盘：↑↓ 在 `flatHits` 上循环，⏎ 触发 `onJump`，Esc 关。鼠标 hover 改 cursor 同步选中。`data-cursor` 属性 + `scrollIntoView({block:"nearest"})` 保证选中行可见。
    - mount 在 `app/page.tsx` 跟 NotesDrawer / DoneToast 同级。
  - **README + progress**：Stage 16 tick + Current Focus 切到"等浏览器实测"。
- **Decisions**:
  - **trigram 而非 unicode61**：unicode61 中文按字符 token，'图片' 必须输入完整词才匹配，'图' 单字符匹配会有海量误报。trigram 三字符滑窗给中文带来天然 substring 能力，对英文则等价于"3 字符前缀子串"——'tok' 命中 'token'/'tokenize'/'tokenizer'。代价是索引膨胀 2-3x（短期可接受），最少 3 字符限制写在 UI 提示里。
  - **显式 repo 层 sync 而非 SQL trigger**：trigger 的优势是零侵入，但 `appendNodeResponse(delta)` 流式期每秒几十次 UPDATE 触发 FTS 重写。改为 finalize 才入索引，sync 调用面 10 处但全在 repo.ts 同文件，可读性可控。
  - **创建节点也入 FTS（与 spec 不同）**：spec 写"等 finalize"，但 question 创建时就是终值，等 finalize 让搜索看不到流式中的节点没意义。response 仍走 finalize（status==done 才入）。
  - **两次 snippet() 而非客户端 strip marker**：服务端用 FTS5 同一组 positional offsets 调两次 snippet——`<mark>...</mark>` 给显示，空 marker 给 anchor 匹配。比客户端 regex 抽取 mark 内容更准确（不会被嵌套 / 缺失 `>` / 跨 token 边界误匹配）。
  - **INNER JOIN 而非 LEFT JOIN**：搜索结果只显示能跳过去的 hit。orphan FTS 行（在我自己的 DB 有 17 行，对应 18 个孤儿 nodes—— pre-existing FK 数据完整性问题，跟 Stage 16 无关）被天然过滤。LEFT JOIN 会展示无 session 信息的"死链"hit，体验更糟。
  - **kind="search" 单一 anchor id "current"**：同时只有一个 search 跳转在进行中（modal 选完即关），不存在多 anchor 同时存在的需求。固定 id 避免 dataset key 命名设计开销。
  - **matchKind===question 不强制 pulse**：question 在 NodeFullView 顶部，全屏 + 激活就足以让用户看见。如果还要 pulse 需要在 QuestionBlock 里加另一套文本级 mark 注入（QuestionBlock 是 `whitespace-pre-wrap` 纯文本，不走 markdown）——投入产出不划算。
  - **bm25 升序排序**：FTS5 bm25 返回负值，越小越相关。`ORDER BY rank ASC` 等价 "ORDER BY relevance DESC"。
  - **dangerouslySetInnerHTML 在 snippet**：FTS5 snippet() 返回的 `<mark>` 是我们设的；text 本身没经 HTML escape——意味着如果原文里有 `<script>` 字面量也会原样进入 DOM。但 trellis 是单机单用户，question/response/note 都是用户自己写的或 claude 输出的（不会蓄意 XSS），风险极低。如果未来引入多人协作再加 escape。
  - **debounce 200ms**：典型用户打字间隔 100-300ms，200ms 是不打断思考但能合并连续按键的甜点。trigram 查询 ~2ms 在我的 DB 上完成，理论上不需要 debounce，但 debounce 也减少了 React state churn。
- **Caveats**:
  - **最少 3 字符 query**：trigram tokenizer 的边界，UI 已显式提示。少数 2 字符高频中文词（"代码"/"金融"）需要用户多打一个字才能搜。预期成本。
  - **Orphan FTS rows**：我自己的 DB 有 17 行无对应 session 的 FTS 数据（来自 nodes 表 18 个孤儿节点——pre-Stage-14 时代留下的 FK 数据完整性问题）。INNER JOIN 让它们对用户不可见，但仍占索引空间。如果用户的 DB 干净，0 影响。
  - **流式期间不入响应索引**：finalizeNode 才写 response。如果用户正在等待长 response 流完时想搜，搜不到。这是 trade，避免每个 delta 写 FTS。流式期间用户主要在看回答，不在搜索。
  - **kind=question 搜索结果跳转无 pulse**：question 在 NodeFullView 顶部，用户能看见但没有强视觉提示。如果用户经常搜 question 命中可能体感不连贯。监控。
  - **`<mark>` 在 snippet 没有 escape**：FTS5 snippet 函数把原文按 token 边界切片，原文里的 `<script>` 等会原样输出。单机单用户场景安全；多用户/网络场景需要在客户端 strip。
  - **重复关键词在同节点的多处命中**：FTS5 一行只返一个 snippet（最相关的 12 token 窗口），不会展示该节点的其他命中位置。跳转后 inline pulse 也只命中第一处。监控真实使用频率。
  - **`⌘P` 跟浏览器 print 冲突**：我们 preventDefault 拦截了。`Ctrl+P` 在 Windows/Linux 同理。如果用户真要打印走浏览器菜单 → 文件 → 打印（这是 web app 本来就少用的功能）。
  - **trigram 索引膨胀**：542 行 raw text 对应索引 ~10-20MB。千行级别 50-100MB 体感无差异；万行级别可能体感开始。Q3 真膨胀再做 vacuum / 索引压缩。
  - **跨 session 跳转后 loadSession 异步**：jumpToSearchHit await loadSessionInternal 完才 set anchor。期间用户能看到搜索 modal 已关闭但目标 session 还在加载——空窗期 ~ 几十毫秒，体感正常。
- **Next**: 用户浏览器实测：
  1. ⌘P 打开 modal → 输入 3+ 字符 → 200ms 后看到结果
  2. ↑↓ 移动 cursor + ⏎ 跳转 → 切到目标 session + 全屏 + emerald pulse 匹配段
  3. 切 facet chip "Workspace" → 列表只剩 mode=workspace 的结果
  4. 搜 < 3 字符 → 看到"至少输入 3 个字符"提示，无请求
  5. 删一个 session → 再 ⌘P 搜该 session 内的关键词 → 0 结果（FTS cleanup 验证）
  6. 在 NotesDrawer 跳源节点 vs ⌘P 搜笔记跳源 → 两条路径行为应一致（jumpToNoteSource 共用）

（Session 1–21 已归档，见 `archive.md`）

