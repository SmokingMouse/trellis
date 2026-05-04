# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

### Session 10 (2026-05-03)
- **Done**: Overview 视图升级——LLM 自动 topic label + zoom-based LoD（"缩略不再糊"）
  - 用户痛点：全局 canvas 下卡片 zoom 0.3 时是糊像素，只能靠 Outline 索引。诊断为认知层级错配——overview 需要"索引页"不是"缩印版书"
  - 方向 1：自动 topic label
    - migration: `nodes` 加 `topic_label TEXT`（idempotent ALTER）
    - 新增 `lib/llm/topic.ts:generateTopicLabel`：spawn 短 haiku（`--tools "" --no-session-persistence` + 专用 system prompt + cwd tmpdir），8s timeout，cleanup 引号/句号 + 14 字截断
    - `app/api/chat/route.ts`：stream 自然结束 + finalize 后，若 `done && provider !== mock && aggregated.trim()`，await 一次 `generateTopicLabel(question, aggregated.slice(0,800))`，写 DB 并 SSE `{type:"topic_label",nodeId,label}`，再 close stream（同一个 SSE 连接持有 ≤8s）
    - `repo.ts`：`setNodeTopicLabel`，SELECT 全加 `topic_label`，`ApiNode.topicLabel` + `rowToNode`
    - `lib/types.ts`：`ChatNode.topicLabel: string | null`
    - `stores/sessionStore.ts`：handleStreamEvent 加 `topic_label` 分支，patch 已 done 节点的 label
  - 方向 2：LoD（zoom < 0.9 → 极简卡片）
    - `components/ChatNode.tsx`：`useStore(s => s.transform[2] < 0.9)` 拿布尔（selector 浅比较，跨 threshold 才 re-render）
    - 新增 `showCompact = isCompact && !isStreaming && !isError` 分支：26px 大字 label + 状态绿点 + token 数 + 可选 anchor mini badge；保留 600px 宽边框/active ring；click 整个卡片 → goFullScreen
    - 全模式 layout 不变（zoom ≥ 0.9 时回到完整 ReactMarkdown）
    - streaming / error 节点强制 full（用户需要看进度 / retry 按钮）
  - 顺手改：`components/Outline.tsx` + `components/NodeTreeOverlay.tsx` 优先用 `topicLabel ?? truncate(question, N)`
  - 验证：build 通过；topic.ts 用法跟之前 cli 实测过的 flag 一致
- **Caveats**:
  - **mock 跳过 label**：UI fallback 到 question 前 14 字
  - **label 在 done 后才有，stream 多挂 ≤8s 不 close**：客户端 `streaming` 状态在 done 事件后已切换；topic_label 到达悄悄 patch，不显示流式光标。流式 UX 不受影响
  - **历史节点没 label**：DB 列默认 NULL，UI 走 fallback。未主动回填
  - **lean 模式也调 haiku 生成 label**：lean 初衷是省钱，但 label ~20 token 输出 + cache 命中后极便宜。先不加开关
  - **dagre 不针对 LoD 重排**：~~compact 卡片矮（~80px）但占位仍按之前 dagre 估算的 480px——节点间有空隙，反而助于扫读，故保留~~ **已修复（用户反馈"太稀疏"）**：`lib/layout.ts:layoutNodes` 加 `compact` 参数 (280×90 + 36/24 sep)；导出 `COMPACT_ZOOM_THRESHOLD`；Canvas 用 `useFlowStore` 监听 zoom 跨阈值，写入 layoutKey 触发 dagre 重排；ChatNode compact 卡片宽 280px，字号 18px。zoom 跨阈值瞬间整棵树自动 reflow，fit-view 自然给出更高 zoom。
- **Next**: 用户实测——cli-single/cli-multi 模式下问问题，等几秒看 topic label 出现；缩小 canvas 看是否变成大字 label；zoom > 0.9 看是否切回完整渲染


### Session 9 (2026-05-03)
- **Done**: 三态 mode toggle + cli-multi 走真多轮 claude session
  - 用户决策：CLI 多轮模式下，整棵 trellis 树共享一个 claude session（树形分支退化为 UI 形态，上下文是平的）。1 个 jsonl 文件 per trellis session，不是 per node
  - 实测确认 stdin stream-json 不能"喂历史"——claude 把每条 user 视为新 turn 自己回应，忽略喂入的 assistant 消息。真多轮只能走 `--resume`
  - 端到端 resume 实测：第一轮无 session-id → claude 自生 `af8573db-...` → 写到 `~/.claude/projects/-Users-smokingmouse/<id>.jsonl` → 第二轮 `--resume` 正确答出之前提到的"绿色"，cache_read 45769 tokens
  - 改动：
    - `lib/server/sqlite.ts`：idempotent ALTER TABLE sessions ADD COLUMN claude_session_id
    - `lib/server/repo.ts`：`getSessionClaudeId` / `setSessionClaudeId`，`deleteSession` 取 claude_session_id 后 `unlinkSync(claudeSessionPath(...))`；路径 `os.homedir().replace(/\//g,"-")`
    - `lib/llm/types.ts`：`Mode = "lean" | "cli-single" | "cli-multi"`，`StreamRequest` 加 `claudeSessionId`，`StreamEvent` 加 `session_init`
    - `lib/llm/server.ts`：`getProvider(id, { mode })` 替代 cliMode
    - `lib/llm/claude.ts`：三模式分支，cli-multi 用 `buildCliMultiPrompt`（仅当前 question + 可选 anchor preface）+ 移除 `--no-session-persistence` + 可选 `--resume`；parser 加 `system/init` 解析 yield `session_init`
    - `app/api/chat/route.ts`：保留 trellis sessionId；cli-multi 时 `history = []`；监听 `session_init` 首次绑定 `setSessionClaudeId`
    - `stores/sessionStore.ts`：cliMode → mode；localStorage key `trellis-mode`；`loadMode` 自动迁移老 boolean
    - `components/ModePicker.tsx` 新增（替代 CliModeToggle）：三态 segment control，stone/amber/rose 配色，切到 cli-multi 时 confirm 提示"之前对话不会继承"
    - `components/Header.tsx`：换用 ModePicker
  - 验证：build 通过 + 端到端 resume 实测 OK
- **Caveats**:
  - **跨模式切换**：lean / cli-single 期间产生的节点对 cli-multi claude session 不可见（实测证明 stdin 不能喂历史）；toggle confirm 已提示
  - **retry 在 cli-multi**：spawn 时 `--resume` 把 retry question 当新 turn 发——claude 视角是"用户又问一遍"，session 多一轮
  - **jsonl 清理**：trellis 删 session 时自动 unlink；启动**没有**孤儿扫描——进程崩溃可能留孤儿，后续可加 reap
  - **tool_use 仍不展示**：cli-single / cli-multi 调工具时静默吞掉。下一刀候选
- **Next**: 用户实测三态切换——cli-multi 跨节点问"还记得 X 吗"看是否真有跨 turn 记忆；删 session 后 ls `~/.claude/projects/-Users-smokingmouse/` 看 jsonl 是否被清


### Session 8 (2026-05-03)
- **Done**: CLI 模式开关——一键打平终端 `claude` CLI 的能力栈
  - 用户问：卡片回复时上下文为啥不含 skills？发现 `claude.ts` 用三个 flag 把 CLI 阉割（`--system-prompt` 覆盖默认 prompt / `--tools ""` 禁用工具 / `cwd: tmpdir` 屏蔽 CLAUDE.md）。
  - 改动：
    - `stores/sessionStore.ts`：加 `cliMode` + `setCliMode`，localStorage key `trellis-cli-mode` 持久化；hydrate 时 load；streamRoot/Branch/retry 把 cliMode 加进 request body
    - `app/api/chat/route.ts`：accept `body.cliMode`，传给 `getProvider(id, { cliMode })`
    - `lib/llm/server.ts`：`getProvider` 加 opts 透传
    - `lib/llm/claude.ts`：args 数组化。cliMode=false 走 lean 路径（push `--tools ""` + `--system-prompt`，cwd tmpdir）；cliMode=true 不传 system prompt（CLI 默认含 skills + ~/.claude/CLAUDE.md + tool 描述）+ push `--permission-mode bypassPermissions`（无 stdin 应答必须自动放行）+ cwd `os.homedir()`
    - `components/CliModeToggle.tsx` 新增：amber/stone 配色，title 写明差异
    - `components/Header.tsx`：toggle 放 ModelPicker 左
  - 验证：build 通过 + 实测 `claude -p "1+1" --permission-mode bypassPermissions --no-session-persistence --output-format stream-json --include-partial-messages --model haiku --verbose` → flag 都接受、`system/init` 事件含 80+ skills 列表 + permissionMode=bypassPermissions、`result.is_error=false`
- **意外发现**:
  - `content_block_delta` 不止 `text_delta`，还有 `thinking_delta` / `signature_delta` / `input_json_delta`。当前 parser 只处理 `text_delta` —— 这导致 **lean 模式下 Haiku 也会沉默 1-2 秒（thinking 阶段）然后才出 text**，cliMode 下若涉及 tool_use 沉默更长
- **Caveats / 已知欠账**:
  - **tool_use 事件 UI 不展示**：cliMode 下若模型调工具，stream-json 出现 `content_block_start{type:tool_use}` + `input_json_delta`，当前 parser 静默吞掉。最简扩展：解析后 yield markdown blockquote 形式的 `> 🔧 调用 X(args)` 文本到 stream-bus
  - **thinking 也不展示**：同上盲区。可选：解析 `thinking_delta` 输出灰色 italic 提示文字
  - **bypassPermissions 危险**：cliMode 下 claude 在机器上无确认跑 Bash/Write/Edit。toggle title 写明但未加首次启用 confirm dialog
  - **System prompt 体积**：cliMode 下涨到 ~40k tokens（实测 cache_creation 13k + cache_read 27k）
- **Next**: 用户实测——开关切到 CLI 模式后问个能触发 skill 的问题（如调研类），看 skill 是否生效；tool 调用过程不可见若难接受再扩 parser

### Session 7 (2026-05-03)
- **Done（第四刀，根除）**: 流式更新完全绕过 React state
  - 用户实测三刀仍卡 + 提出关键质疑："卡片不是独立的吗"。诊断真因：所有节点共享同一 JS 主线程 / React 渲染树 / ReactFlow 实例，每秒 60+ 次 store update 触发 60+ 次 React commit + ReactFlow 内部 O(N) diff，不归 React.memo 管。前三刀都是"减少每次 commit 工作量"，根因（commit 频率本身）没动。
  - 改动：
    - 新增 `lib/stream-bus.ts`：纯 JS pub/sub + pending 累积 buffer。`subscribeStream` / `emitStream` / `getStreamPending` / `clearStreamPending`
    - `stores/sessionStore.ts:handleStreamEvent`：删除上一刀的 rAF 节流；delta 改为 `emitStream(id, text)` 完全不进 store；`done` / `error` 时从 bus 取累积的 fullText 一次性 commit 进 store（含 `response + status + tokenCount`）；`created` 时 `clearStreamPending(id)` 防遗留
    - `components/ChatNode.tsx`：streaming 时渲染挂 ref 的 `<div>` + cursor，effect 里 `el.textContent = node.response + getStreamPending(id)` 然后 `subscribeStream` 回调直接 `textContent +=`；done 后切回 ReactMarkdown 路径。删除 useDeferredValue 和 REHYPE_STREAMING（不再需要）
    - `components/NodeFullView.tsx:ResponseBody`：同样改造（fullscreen 也走 stream-bus）
  - 效果：流式期 React 重渲染 = 0，ReactFlow diff = 0，主线程几乎完全空闲。"滚动变缩放"消失（wheel 事件能正常被 nowheel 拦截）。
  - 视觉副作用：streaming 中显示纯文本（whitespace-pre-wrap），代码块/bold/列表无渲染；done 一刻切回完整 markdown + highlight。可接受——ChatGPT/Claude 网页版同理。
  - 跨设备 mid-stream：hydrate 仍能拿 partial response（后端持续写 SQLite，未变），不影响。
  - 验证：build 通过，lint 干净（NodeFullView:110 的 setState-in-effect 是预先存在的 warning，非本次引入）
- **Decisions**:
  - stream-bus 是 module-level singleton，跨 session 不需要清——nodeId 是 ULID 全局唯一
  - 保留前三刀（selector + memo + plugin 常量化）：done 后那次唯一的 React render 仍然受益
- **Next**: 用户在浏览器实测 — 期望流式中点目录、滚动卡片、pan/zoom 全程 0 卡顿；其他卡片预览不再受影响。

### Session 6 (2026-05-03)
- **Done**: Canvas 渲染性能第一刀（图大了卡 → 流式期 O(N²) 重渲染问题）
  - 诊断：每个 `ChatNode` 都订阅整个 `nodes` map（`ChatNode.tsx:22 allNodes`），加上 sessionStore delta 替换整个 nodes record 的引用 → 流式每个 token 触发全部 N 个节点重渲染（含 ReactMarkdown + rehype-highlight 解析）
  - 改动：
    - `Canvas.tsx`: 派生 `childAnchorsByParent: Map<string, ChildAnchor[]>` 一次算好，注入每个节点的 `data.childAnchors`；`EMPTY_ANCHORS` 常量保证空数组引用稳定
    - `ChatNode.tsx`: 移除 `useSessionStore((s) => s.nodes)`；改读 `data.childAnchors`；导出 `ChildAnchor` 类型；用 `React.memo` 包装，自定义比较 `node` 引用 + `isActive` + `childAnchors` 浅值比较
  - 关键依据：sessionStore.ts:265 delta 只替换 streaming 节点的 ChatNodeData 对象，其他节点引用稳定 → memo 比较 `prev.node === next.node` 命中
  - 验证：`npm run build` 通过（tsc + Turbopack 都过）
- **Done（第二刀）**: 流式节点自身重渲染开销 → 主线程阻塞导致全画布卡
  - 诊断：streaming 节点每收到 1 token 就重跑 ReactMarkdown 解析 + `rehype-highlight` 全 code block 染色 + injectHighlights regex。response 长 + 流速快 → 主线程 30%+ 占用 → React Flow 的 pan/zoom 也跟着卡。React.memo 救不了——node 引用本来就在变。
  - 改动（`ChatNode.tsx`）：
    - 模块级常量 `REMARK_PLUGINS` / `REHYPE_FULL` / `REHYPE_STREAMING`：plugin 数组引用稳定，且流式版本不挂 `rehype-highlight`（最大头）
    - `rehypePlugins={isStreaming ? REHYPE_STREAMING : REHYPE_FULL}`：流式中代码块不染色，done 时立刻染上
    - `useDeferredValue(responseWithMarks)`：流式中 markdown 重渲染降为低优先级，pan/zoom 等交互可抢占
  - 验证：build 通过
- **Done（第三刀）**: token 节流，根除 React Flow 内部 reconciliation 风暴
  - 关键诊断：用户实测后报告"流式中滚动变缩放"——这不是事件配置问题，是**主线程被严重阻塞**的标志：wheel 事件来不及被 `nowheel` 拦截器处理，直接走 React Flow viewport 缩放路径。证明每 token 一次 store update 触发的 React Flow 内部 diff（无法被用户层 memo 拦截）才是元凶。
  - 改动（`stores/sessionStore.ts:handleStreamEvent`）：
    - delta 事件用 `requestAnimationFrame` 节流：text 累积到 `pending` buffer，每帧最多 flush 一次到 store
    - `created` / `done` / `error` 时先 `flushNow()` 再做后续 set，防止节点切换或终态前漏掉最后几个 token
    - `pendingForId` 双 check 防止跨节点串流
  - 效果：60+ token/s 流速 → store update 封顶 60/s（屏幕刷新率），React Flow 内部 diff 也降到这个频次。视觉上流式文字仍丝滑（人眼分辨不出 16ms vs 8ms 的更新间隔）。
  - 验证：build 通过
- **Decisions**:
  - 暂不做 viewport culling——三刀如果还不够再上
  - NodeFullView 不改（一次只渲一个节点，画布不卡问题不在它身上）；如全屏视图也卡再单独处理
- **Next**: 用户实测三刀合并效果。期望：流式中点目录、滚动卡片、pan/zoom 都顺畅；"滚动变缩放"消失。

### Session 5 (2026-05-03)
- **Done**:
  - Critic 审视：MVP 核心扎实，主要问题是 progress 与代码失同步、临时方案残留依赖
  - **账面归零**：
    - 删 `package.json` 中 `dexie` + `dexie-react-hooks`（源码 0 引用，已迁 SQLite-only）
    - `npm i` removed 2 packages，`npm run build` 通过
    - Stage 3 描述改为 "SQLite + Zustand"
    - Stage 6 拆 4 个子项：大纲 / 持久化恢复 / 父节点高亮回显 ✅，Dagre 布局留白
    - Mid-term「接真 LLM」「导出」均勾掉（Claude 三档 + Codex 半成品已接，`lib/export.ts` JSON/Markdown 已实现）
- **Decisions**:
  - 不擅自新增 goal——critic 提的 #2（抽公共 tree/markdown-anchor 工具）和 #3（Codex 去留决断）等用户认领后再加
- **Next**: 等用户确认是否要继续做 #2（去重 + injectHighlights bug 修复）或 #3（Codex 实测/移除）



### Session 4 (2026-05-02)
- **Done**:
  - **Codex provider 打包修**：`next.config.ts` 加 `serverExternalPackages: ["@openai/codex-sdk", "@openai/codex"]`。原因：Codex SDK 用 `createRequire(import.meta.url)` 在运行时找平台 binary，Next/Turbopack 把 SDK 打成 bundle 后 import.meta.url 指向 `.next/server/...`，找不到 node_modules 里的 `@openai/codex-darwin-arm64`。
  - **In-place retry**：失败节点重试不再创建兄弟，复用同一 nodeId 保持树结构。
    - `lib/server/repo.ts` 加 `resetNodeForRetry`：清 response/usage/error，保留 question + parentAnchor
    - `app/api/chat/route.ts` 加 `kind: "retry"`：复用 nodeId，重发 created 事件让客户端 sync
    - `stores/sessionStore.ts` 加 `retryNode` action：本地乐观 reset + 走流式
    - 错误框右边加红色「↻ 重新生成」按钮（ChatNode + NodeFullView ResponseBody 两处）
    - 副作用：retry 用当前选的 provider，可以「Codex 失败 → 切 Sonnet → 重试」
  - **NodeTreeOverlay**：fullscreen 里全树跳转面板
    - 顶栏面包屑 / 树图标 tap → 滑出 overlay（mobile bottom-sheet / desktop centered modal）
    - 渲染整树（深度缩进、活动节点高亮、错误/流中状态标记）
    - tap 任一节点 → setActiveNode + 关闭，留在 fullscreen 不切回 canvas
    - Esc 关闭，自动 scrollIntoView 当前节点
  - 验证：tsc 通过，HMR 干净


### Session 3 (2026-05-02)
- **Done**:
  - 三层视图统一：Layer 1 (canvas overview) / Layer 2 (canvas focused) / Layer 3 (fullscreen single card)
  - 状态收口到 store：新增 `fullScreen: boolean` + `setFullScreen` action（替代 page.tsx 局部 mobileView state）
  - `MobileNodeView` → `NodeFullView` 重命名（移文件 + 重命名 export），桌面手机共享
  - `ChatNode`（canvas card）右上加 ⤢ 全屏按钮：tap → setActiveNode + setFullScreen(true)，e.stopPropagation 避免冒到 canvas onNodeClick
  - `app/page.tsx`：fullScreen 决定渲染 NodeFullView vs Canvas；mobile session 加载时默认 fullScreen=true（监听 sessionId 变化）
  - `useIsMobile` 改 `(pointer: coarse) and (max-width: 1023px)`：PC 鼠标输入永远走 canvas，iPad 竖屏走 mobile UX
  - 清掉之前 mobile selection 调试用的 `SelDebug` 浮条 + console.log
  - 验证：tsc 通过，HMR 自愈（重命名瞬间的 module-not-found 自动恢复），`GET / 200`
- **Decisions**:
  - Layer 3 在 desktop 不替换默认体验（仍是 canvas），只通过显式 ⤢ 进入；mobile 仍默认 Layer 3
  - Canvas onNodeFocus 仅在 mobile 上自动切 fullscreen（保持桌面 click=focus 习惯）
  - Stage 6 Polish 维持 [ ]，本次只动了三层视图

### Session 2 (2026-05-01)
- **Done**:
  - 移动端 P0：全屏单卡片视图替代 canvas（`<md` 断点）
  - 新增 `hooks/useIsMobile.ts`（matchMedia，null-until-mounted 防 hydration mismatch）
  - 新增 `components/MobileNodeView.tsx`：顶栏「← 画布 / 父 › 当前」面包屑、滚动卡片体（复用 markdown + 流式光标 + 子锚点 mark）、底部 BranchStrip（父/兄弟/子 chips）+ 持久化追问栏
  - `Canvas` 加可选 `onNodeFocus` 回调；移动端从画布 tap 节点 → 自动切回卡片视图
  - `app/page.tsx` 按 isMobile 分支：mobileView state ('card' | 'canvas') 控制切换
  - `globals.css` 加 `.no-scrollbar` 工具类（chip 横滑）
  - 验证：tsc --noEmit 通过，eslint 干净（Canvas 已有 set-state-in-effect 不动），dev server `GET / 200`
- **Decisions**:
  - 不做侧边抽屉树，分支条 + canvas mini-map（P1 待做）作为兄弟方案
  - 追问栏始终可见（GPT/Gemini 风格），streaming 时 disabled
  - parentAnchor 在卡片顶部呈 amber badge，tap 回父节点
- **Next**: P1 顶栏 tap → 弹出 mini canvas / P2 兄弟左右滑 + 长按分叉。先等用户真机实测 P0

### Session 1 (2026-04-30)
- **Done**:
  - 项目名 Trellis，路径 `~/python/learning/trellis`
  - 视觉原型 `vibe-prototype.html` approve
  - SDK 调研 + 实测：Codex SDK 支持订阅 auth 但 22k tokens system prompt 包袱重；当前账号配额耗尽（5/5 恢复）
  - Stage 1：Next.js 16 + React 19 + Tailwind v4
  - Stage 2：mock SSE endpoint，`lib/llm/{types,mock,mock-responses,index}.ts` + `app/api/chat/route.ts`，单一 swap point
  - Stage 3：`lib/types.ts`, `lib/db.ts` (Dexie), `lib/id.ts`, `stores/sessionStore.ts`（含 contextFor 父链遍历）
  - Stage 4：Canvas (React Flow) + ChatNode (markdown + highlight.js) + QuestionInput + Header；首次访问→提问→流式根节点
  - Stage 5：`hooks/useSelectionWithin.ts` + `BranchPopover.tsx`，⌘K 展开 inline 输入，分叉创建子节点 + parentAnchor
- **Decisions**:
  - MVP 全程 mock，配额恢复再换真 SDK
  - 简化 ParentAnchor 只存 selectedText（offsets 留 stage 6 需要再加）
  - createBranchNode 用 siblingIndex 排序，Dagre 处理布局
- **Next**: 用户浏览器实测 → stage 6 polish
