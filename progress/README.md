# Trellis Progress

## Current Focus
Stage 17 完成 — Tool call / Bash 可视化全链路落地。同 session 顺手做了三件中间事：手机搜索入口（Header 🔍 按钮）+ Chat 配色对比修复 + 画布 80/20 居中（lastEditedNodeId）+ **durable streams 改造**（spawn 跟 HTTP 解耦，client 断连/切后台/网络抖动不再杀生成）。`npm run build` ✓；端到端 curl 实测 `pwd` 单 Bash 调用被完整捕获，reconnect endpoint catchup 含 toolCalls。等浏览器实测。下一步进 Stage 18（Skill 调用入口）。

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

## Session Log
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

（Session 1–20 已归档，见 `archive.md`）

