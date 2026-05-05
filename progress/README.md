# Trellis Progress

## Current Focus
笔记本 v2：跳回原文时滚到原句 + emerald pulse 高亮。复用 pendingScrollAnchor，把 anchor 升级成 union（child / note）。等浏览器实测匹配命中率。

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

### Mid-term
- [x] 接真 LLM（Claude Sonnet/Opus/Haiku + Codex 半成品，default sonnet）
- [x] 思维树导出（`lib/export.ts`：JSON + Markdown，Feishu 友好）

## Session Log
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


（Session 1–13 已归档，见 `archive.md`）
