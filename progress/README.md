# Trellis Progress

## Current Focus
mark 注入从源 markdown regex 改成渲染 DOM textContent + Range wrap，修代码块/表格/链接/加粗/列表/跨段所有富文本场景的命中率。等浏览器实测六类 case。

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

## Session Log
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
  - **cli-multi 模式下"新提问"会继承 prior history**：cli-multi 通过 resume 同一个 claude session 来跑后续节点，一个 session 内的所有节点共享 LLM 记忆。新加的"平行根"在 cli-multi 模式下其实不是真的"fresh context"——LLM 仍记得之前所有问答。lean 模式下 parent_id=NULL → 没祖先链 → 真 fresh。预期行为差异，先不解决，等用户实测再决定要不要加"清空 cli-multi 记忆"开关。
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

（Session 1–15 已归档，见 `archive.md`）

