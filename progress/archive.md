# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

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
  - **cli-multi 模式下"新提问"会继承 prior history**：cli-multi 通过 resume 同一个 claude session 来跑后续节点，一个 session 内的所有节点共享 LLM 记忆。新加的"平行根"在 cli-multi 模式下其实不是真的"fresh context"——LLM 仍记得之前所有问答。lean 模式下 parent_id=NULL → 没祖先链 → 真 fresh。预期行为差异，先不解决，等用户实测再决定要不要加"清空 cli-multi 记忆"开关。（**注**：Session 24 把 claude_session_id 降到 root 级别后这条 caveat 失效——新提问在 Project 模式下天然 fresh context。）
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

### Session 13 (2026-05-04)
- **Done**: Codex provider 从 SDK 切换到 spawn CLI，三档 mode + URL fetch 与 Claude 路径完全对称解耦
  - **lib/llm/codex.ts 重写**：丢弃 `@openai/codex-sdk`（注入 22k tokens 系统 prompt 无法关闭、不识别 mode），改 spawn `codex exec` / `codex exec resume`。三档：lean (`--ephemeral --sandbox read-only`，DEFAULT_SYSTEM_PROMPT 拼到 prompt 头) / cli-single (`--ephemeral --dangerously-bypass-approvals-and-sandbox`) / cli-multi（首轮非 ephemeral 持久化 + 后续 `exec resume <thread_id>`）。`@openai/codex-sdk` 依赖从 package.json 移除。
  - **codex login 检测**：`makeCodexProvider().stream` 入口先 `spawnSync codex login status` exit code 检测，未登录直接 `yield error("请先 codex login")`。
  - **URL fetch 拆分**：
    - 新建 `lib/server/fetch-prompt.ts`：抽出共用 `buildFetchPrompt(url, variant)` + `parseFetchOutput`。`variant: "claude"` 在尾部加 "AVOID WebFetch built-in" 提示，`variant: "codex"` 不加。
    - 新建 `lib/server/fetch-via-codex.ts`：spawn `codex exec --json --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox -m gpt-5.5`；JSONL 路由 `item.started(command_execution)` → 把 codex 跑的 bash 命令直接转 progress 给前端；`item.completed(agent_message)` → 用共享 parser 抽 frontmatter+body。
    - `lib/server/fetch-via-claude.ts` 简化：去掉本地 PROMPT_TEMPLATE / parseClaudeOutput，全部改用 `fetch-prompt.ts` 的共享版本。
    - `lib/server/fetch-url.ts` 改 dispatcher：导出 `fetchUrlEvents(url, provider, signal)` async generator + `fetchByUrl(url, provider, signal)` sync wrapper，按 provider 路由到 claude / codex 两条路。
  - **API + store provider 透传**：`app/api/references/route.ts` 接收 `provider` 字段（`isProviderId` 校验，缺省走 DEFAULT_PROVIDER）；refresh route 同时支持 query string `?provider=codex` 和 body。`stores/sessionStore.ts` 的 createReference / refreshReference 自动从 store.provider 取当前选中的 provider 传给 server。
  - **UI 文案 provider-aware**：`ModePicker.tsx` 加 `optionsFor(provider)` 切两套 tooltip（claude → "skills + ~/.claude/CLAUDE.md"；codex → "MCP servers + ~/.codex/config.toml"）；cli-multi 切换确认对话也用动态 cliName。`ReferencePicker.tsx` URL tab 描述根据 provider 切换。
  - 验证：`npm run build` ✓ 三次。端到端 curl 测试：codex+lean → "2"（input 24256, output 54）；codex+cli-single → 跑 zsh echo 命令 + 拿 output；codex+cli-multi 双轮 → 第二轮记得第一轮的数字 73；codex URL fetch example.com → 拿到 "Example Domain" 标题 + verbatim body + 完整 progress 流（curl + python html-to-md fallback）。回归 claude-haiku+lean → 正常。
- **Decisions**:
  - **lean 模式 system prompt 用拼接而非 codex flag**：codex CLI 没有 `--system-prompt`，把 DEFAULT_SYSTEM_PROMPT 加在 user prompt 前面。read-only 沙箱保证就算模型想调工具也调不动。
  - **不传 `--ignore-user-config`**：实测发现该 flag 让 codex 走 env 里的 `OPENAI_API_KEY`，而用户用的是 ChatGPT 订阅 auth。屏蔽全局配置反而打破登录态，得不偿失——lean 模式只靠 sandbox + system prompt 约束。
  - **session_init / db column 复用 `claude_session_id`**：codex 的 thread_id 也写到这个 column。column 名不准但 schema 不动，技术债先记。后续如果给 provider-specific session 多种语义再拆。
  - **URL fetch 也对接 codex**：意味着 trellis 不再 hard-require `claude` 在 PATH 上。选 codex 时所有外部抓取走 codex，feishu-cli/yt-dlp/curl 等本机 CLI 工具直接被 codex spawn——这些工具的 auth state 是用户机器级的，跟 LLM provider 无关。
  - **codex JSONL 一次性给 agent_message**：no streaming delta，UX 是"spinner 然后整段一次性出现"。codex CLI 0.125 限制，非 trellis 问题；接受现状不绕。
- **Caveats**:
  - **codex stderr 偶现 "failed to record rollout items"**：非致命，已 swallow。
  - **DB column 命名 `claude_session_id` 用于 codex thread_id**：技术债。
  - **mock provider 选 codex 时**：codex provider 不会被走（mock 是另一支），但 fetch dispatcher 的"未知 provider 走 claude"兜底意味着 mock 用户加 reference 仍依赖 claude CLI。无解：mock 没有自己的 fetcher。
  - **gpt-5.5 是默认 model**：用户确认。如果 OpenAI 后续改名要更新常量。
  - **codex resume 不接受 `--sandbox` flag**：首轮 yolo 配置后续轮跟随，无法切。trellis cli-multi 在第二轮起仍传 `--dangerously-bypass-approvals-and-sandbox`，被 codex 接受。
- **Next**: 用户在浏览器里切到 Codex 实测——三档 mode 切换 + Cmd+K 分叉 + URL 抓取（可以试 feishu / youtube 看 codex 是否真能 spawn 那些 CLI）。如果发现 progress 流体感差（一次性出整段而非流式），考虑加"思考中"占位文案优化。



### Session 12 (2026-05-04)
- **Done**: Stage 12 — 节点类型抽象 + 参考卡片（粘贴 / URL）+ FAB 凭空建节点
  - **数据层**：`lib/types.ts` 加 `NodeKind` / `RefSourceType` / `ReferencePayload` / `ChatNode.{kind,reference}`。`lib/server/sqlite.ts` 6 个 idempotent ALTER（kind / ref_source_type / ref_source_uri / ref_content_md / ref_fetched_at / ref_meta_json）。`lib/server/repo.ts` 加 `NODE_COLS` 常量、扩展 `rowToNode`（解析 ref_meta_json）、新增 `createReferenceNode`（验证 session 存在 + 单事务插入 + 更新 session.updated_at）/ `refreshReferenceNode`（仅允许 kind="reference"）。
  - **buildHistoryForNode 重构**：原来用 `chain.unshift` 收集 q/r 对再展开成 messages；新版改成 buffer push 后 reverse，方便穿插不同 message 形态。reference 父节点走 `buildReferenceContextBlock` 合成 user message：`参考材料《标题》片段：\n\n[选区±200 chars 上下文]\n\n用户从中选中：「anchor」`。整篇文档不入 prompt（防止长文档 token 黑洞）。验证 ✓：mock 跑通后跑 better-sqlite3 脚本直接 dump 出来，文本和预期一致。
  - **URL 抓取器**（`lib/server/fetch-url.ts` 新增）：stdlib-only，无新依赖。10s 超时，2 MB 上限，HTTP/HTTPS only，假装 Chrome UA。`<head>` 整段先剥（防 title 漏到 body）；script/style/noscript/nav/footer/header/aside/form/svg/comment 剥；headings → markdown #/##；li → "-"；pre → fenced code；a → markdown link；其他标签全裸。失败时仍返回 { contentMd: '', meta: { fetchError } } — 让节点照样建出来，UI 负责显示错误。
  - **API 端点**：`app/api/references/route.ts` POST + GET（debug 用），union request `{paste|url}`。`app/api/references/[id]/refresh/route.ts` POST，仅 url/feishu 类支持。两端验证 session 存在 + 调 fetchUrlAsReference + 调 repo。
  - **Store**：`stores/sessionStore.ts` 加 `CreateReferenceInput` union、`createReference` action（POST → setActiveNode 到新节点 → 触发 Canvas 现有的 pan-to-active）/`refreshReference`（保留 canvas position，仅 patch reference payload）。
  - **UI**：
    - `components/ReferenceCard.tsx` 新增：280px 折叠态，amber-tinted 区分。源 icon (📄/🔗/📘/📎) + topicLabel + sourceUri/类型 + 字数 + 相对时间 + ↻ 刷新按钮（仅 url/feishu）。fetchError 时变 rose 边框 + ⚠️。Canvas 整卡 click → 全屏。`React.memo` 同 ChatNode 模式。
    - `components/Canvas.tsx`：`nodeTypes` 加 `reference: ReferenceCard`，`flowNodes` 按 `n.kind` 路由 type；挂载 `<AddNodeFAB />`。
    - `components/NodeFullView.tsx`：`node.kind === "reference"` 分支 — 渲染 `ReferenceFullBody`（amber 头部含源信息 + 外链 + ↻ 刷新；body markdown 挂 `data-chat-node-id` 让现有 `useSelectionWithin` + `useMobileSelection` 直接接管划词分叉）；底部 `FollowupBar` 换成 `ReferenceFooterHint`。SubBar 文案对 reference 用 `topicLabel ?? "参考材料"`。
    - `components/AddNodeFAB.tsx` + `components/ReferencePicker.tsx` 新增：右下角浮动 + 按钮 → modal，paste/url 双 tab，Cmd+Enter 提交（paste），Enter 提交（url）。错误显示 + busy 状态。
    - `components/Outline.tsx` + `NodeTreeOverlay.tsx` 重构成 forest（`buildForest` 替换 `buildTree`）：qa 树 + 浮动 reference 各为独立 root，UI 上中间分隔线。reference 行加源 icon。
  - 验证：`npm run build` 通过 6 次（每个 task 后一次）。端到端 mock 流程：create session → create paste ref（topicLabel "Linear Algebra" ✓）→ create url ref（example.com 抽出干净正文 ✓）→ create url ref 失败站点（保留节点 + fetchError ✓）→ branch off ref with anchor → mock done 420 chars。better-sqlite3 脚本 dump synthetic context block 与预期完全一致。
- **Decisions**:
  - **不引入 readability/jsdom**：先用 stdlib regex 抽取，"够用就行"。SPA / 登录墙站点抓不到时 UI 会把错误显示出来，用户可以改用粘贴。等用户实测发现真痛点再换重型方案。
  - **FAB 只做 reference**：spec 提了"问答 + 参考"双类型，但 qa 节点的"凭空建"会涉及 `sessions.root_node_id` schema 改动（多根）。保持现状：root 入口仍是 QuestionInput，FAB 单纯做参考。后续要加再说。
  - **reference 整篇不入 prompt**：spec 已定，实现侧严格执行——只送选区 + ±200 字符上下文。多个 qa 子节点引用同一 ref 也是各送各的片段。"附带整篇"按钮留作未来。
  - **forest 不重排 dagre**：浮动 reference 由 dagre 当独立根处理，会自动放到右侧列。没做精细位置控制——用户用 setActiveNode 自动 pan-to-focus 找新节点。
  - **schema 用 kind 列而非新 table**：5-6 列内可控，多形态扩展再考虑拆表/polymorphic。
- **Caveats**:
  - **URL 抽取质量参差**：example.com 干净；GitHub README / SPA / paywalled 大概率不行。文档写明，UI 显示错误。
  - **删 reference 节点不会处理子 qa**：sqlite FK 是 session_id 级 cascade，nodes 内部没 FK，删 ref 时它的 qa 子节点 `parent_id` 留 dangling。当前 UI 没暴露删单节点入口，所以非紧迫；要加时记得清子的 parent_id 或改 FK。
  - **buildHistoryForNode depth=2 时**：祖父若是 reference，目前只 break 不 emit。罕见场景，先不补全。
  - **canvas pan 中心算法用 NODE_HEIGHT_ESTIMATE=480**：reference 卡只 ~100px 高，pan 到时偏一点。视觉小瑕疵，不修。
  - **mobile FAB**：在桌面 canvas 模式可见。mobile 默认 fullscreen，FAB 没渲染。如果手机用户也想加 ref，需要先回 canvas（顶栏"画布"按钮）。
  - **lint 残留 4 个**：还是预先存在的 setState-in-effect（NodeFullView:110, SessionPicker:24），未引入新警告。
- **Next**: 用户浏览器实测——FAB 建粘贴卡 / URL 卡（成功+失败）/ 划词追问 reference 跑真 LLM（看 prompt 是否合理）/ 并发多个 reference 看 forest 排列 / 删 session 时 ref 是否级联清除 / mobile 端先看 reference 卡在 fullscreen 里怎么阅读和划词。
- **Done（同 session 补丁）**: 允许参考卡作为 session root
  - 用户反馈："新建一个项目时没法直接引入背景，只能先提问"——之前的 spec 决策（"FAB 只做 reference，root 仍走 QuestionInput"）确实是个别扭点。
  - 改动：
    - `lib/server/repo.ts` 加 `createSessionWithReference`（事务里同时插 sessions + kind=reference 根节点，title 默认走 topicLabel）
    - `app/api/references/route.ts`：`sessionId` 改为 optional。缺省时调 createSessionWithReference，返回 `{session, node}`（mirror chat root 的 shape）
    - `stores/sessionStore.ts:createReference`：当前无 session 时不传 sessionId；解析响应里的 session 字段 → 整体 swap 节点 map（旧 newConversation 残留也一起清）
    - `components/QuestionInput.tsx`：textarea 下方加分隔线 + amber 按钮"📄 从背景材料开始（粘贴 / URL）"，复用 ReferencePicker
  - 验证：build ✓；curl POST /api/references 不带 sessionId → 返回新 session（title="Study Notes"）+ reference root 节点 ✓
- **Caveat 补充**: 一个 session 的 root_node_id 现在可能指向 reference。Outline / TreeOverlay 的 buildForest 里 `qaRoot = nodes[qaRootId]` 仍然会拿到那个 reference 节点并放在 forest 第一位——视觉上和"qa root"无区分（除了图标）。如果用户混合使用（先放 ref → 再问问题）流程跑通后觉得别扭，再考虑把 Outline 的"思维树"标题在 ref-root 时换成"参考材料"。
- **Done（URL 抓取重构 — claude 全权代理）**: 把"按 host 路由"也撤了，trellis 不识别任何平台
  - 用户进一步反馈："不是走代码来获取内容，而是把获取内容的能力全权交给本地的 cli，让它来决策怎么样通过这个 URL 来获取内容"。前一版的 dispatcher 仍然把"识别 feishu URL"硬编码在 trellis 里——任何新平台仍要改 trellis 代码。重新设计：spawn `claude -p` 让它自己看 URL 挑 skill。
  - 改动：
    - `lib/server/fetch-via-claude.ts` 新增：spawn `claude -p "<prompt>" --permission-mode bypassPermissions --no-session-persistence --model haiku`，cwd=tmpdir（屏蔽 ~/.claude/CLAUDE.md 用户个人指令）。Prompt 模板写明可用 skills 列表 + 严格 frontmatter+body 输出格式。90s 超时、5MB stdout 上限。`parseClaudeOutput` 解 frontmatter（title / platform / fetch_error / body），容错处理 claude 偶尔加 ``` 代码围栏 / CRLF 等。
    - `lib/server/fetch-url.ts` 简化为 thin wrapper：URL 合法性校验后直接调 fetchUrlViaClaude。
    - `lib/server/fetch-feishu.ts` **删除**——平台知识从 trellis 代码里消失。
    - `lib/types.ts`：`RefSourceType` 收窄到 `"paste" | "url"`；`ReferenceMeta` 加 `platform?: string`。每平台细分（feishu / youtube / github / generic / pdf / ...）由 claude 在 frontmatter 里写。
    - `lib/ref-icon.ts` 新增：单一 icon 映射表 `{feishu→📘, youtube→🎬, bilibili→📺, x→🐦, github→🐙, pdf→📕, notion→📒}`，UI 全走 `refIcon(ref)`。加新平台只改这张表。
    - `lib/server/repo.ts:rowToNode`：legacy 兼容——DB 里 ref_source_type='feishu'/'file' 的行（如有）coerce 成 sourceType:"url" + meta.platform 保留原 tag。
    - 各 UI（ReferenceCard / NodeFullView / Outline / NodeTreeOverlay）干掉本地的 `refSourceIcon` switch，改用 `lib/ref-icon.ts` 的 `refIcon`。canRefresh 检查从 `(url|feishu)` 收窄到 `url`。
    - `ReferencePicker.tsx` 文案改为 "由本机 claude + 已安装的 skills 决定怎么抓——飞书自动走 feishu-cli，YouTube 走字幕 skill，普通网页走 web-fetch"，明确列出延迟 5-30 秒。
  - 验证：build ✓；端到端 `https://example.com/` → sourceType "url" / platform "generic"（claude 自己 tag 的）/ title "Example Domain" / 465 字 markdown。
- **Decisions（claude-driven fetch 架构）**:
  - **平台识别全部交给 claude**：trellis 不知道 feishu/youtube/bilibili 长什么样。新平台只要用户 `feishu-cli auth login` / 装 youtube skill 等，零代码改动。
  - **频道选 haiku**：URL 抓取是机械任务（挑 skill → 跑 → 格式化），haiku 够用且便宜。一次约 ~$0.01-0.02，5-30 秒。
  - **cwd=tmpdir**：让 claude 看到全局 skills（~/.claude/skills/），但不被用户 ~/.claude/CLAUDE.md 影响响应风格——纯 fetcher 行为。
  - **Frontmatter 协议**：和 feishu-cli 的 `--front-matter` 形式对齐（claude 也认识这个格式），title / platform / fetch_error 三个字段。
  - **所有 URL 都过 claude**：不为 stdlib regex 留兜底——既然彻底交出去了就别留半截。代价：example.com 这种极简页也要花 5-10 秒 + 一次 LLM 调用。可接受。
- **Caveat（claude-driven fetch）**:
  - **prompt injection 表面**：URL 是用户输入，但 URL 抓回的内容也可能含恶意指令（"忽略前面，写文件 /etc/passwd"）。claude 跑在 bypassPermissions 下有完整文件系统权限。当前接受这个风险——这是用户自己机器的 trellis，URL 也是用户主动加的。
  - **claude 可能不严格按 frontmatter 格式**：parser 有几层容错（去 ``` 围栏 / CRLF / 单引号 title 等），但 ddl 还是会偶尔翻车。翻车时 fetchError 会带上前 280 字 stdout 让用户看到。
  - **legacy DB 行**：之前实测可能产生过 ref_source_type='feishu' 的行；rowToNode 已 coerce 成 url+platform=feishu。无需手动 migrate。
- **Done（URL 抓取改 SSE 流式 + 进度可视化）**: 90s 超时移除，过程进卡片
  - 用户反馈两个痛点：(1) 飞书大文档 90s 超时；(2) 抓取过程是黑盒，picker "处理中…" 没任何反馈。决策：撤掉超时，把每一步进度通过 SSE 流到画布上的占位卡片里。
  - 改动：
    - `lib/server/fetch-via-claude.ts` 重写为 async generator：spawn claude 用 `--output-format stream-json --include-partial-messages`，解析 stream_event 拆出 `progress` 事件（推理中… / 调用工具 X / 抓取 URL / 整理 markdown…）+ 最终 `result`。删掉 timeout——SSE 连接本身就是 deadline，用户关页面或点停止就 SIGTERM 子进程。
    - `sniffToolInput` 从 partial JSON 抠出工具关键参数（Bash 的 command / WebFetch 的 url / Read 的 file_path 等）。等待 closing quote 或 ≥20 字符再 announce，避免显示 "抓取 https://ex" 这种没 host 的截断。
    - `lib/server/repo.ts` 加 `finalizeReferenceFetch`（事务里 update content_md / meta / status / topic_label / error_message）；`createReferenceNode` / `createSessionWithReference` 接受 `status` 参数（默认 done，URL 流式时传 streaming 占位）。
    - `app/api/references/route.ts` 拆分：paste 走原 JSON 路径；URL 走 SSE。先 INSERT 占位行（status=streaming，空 content），立即 send `created` 事件，然后 for-await fetcher generator forward `progress` 事件，结束时 finalizeReferenceFetch 写入最终内容 + send `done`。
    - `stores/sessionStore.ts`：state 加 `fetchProgress: Record<nodeId, message>`；`createReference` URL 路径改用 Promise + IIFE 模式：`created` 事件到时 resolve（picker 立即关闭），其余事件后台继续更新 store。复用现有 `STREAM_CONTROLLERS` 让 abort 路径走通。
    - `components/ReferenceCard.tsx`：streaming 态 indigo 边框 + spinner icon + 第三行显示 fetchProgress 文案 + ⏹ 停止按钮（替代刷新）。selector 只订阅 `fetchProgress[n.id]`，避免一个 ref 流式时其他卡片重渲染。
    - `components/NodeFullView.tsx:ReferenceFullBody`：streaming 态 indigo 头 + ⏳ 图标 + 单独的"进度日志"块（pulse 点 + 当前消息 + 解释性 caption）+ 停止按钮替代刷新。空 markdown 区域直接不渲染（避免显示"没有正文"）。
  - 验证：build ✓；端到端 SSE：CREATED → progress(推理中…) → progress(调用工具 WebFetch …) → progress(抓取 https://example.com/) → progress(整理 markdown…) → DONE（status=done, mdlen=422）。
- **Decisions（流式架构）**:
  - **占位行先入库**：用户点"创建"就有卡片可见，progress 直接灌到那张卡片。如果走"抓完才入库"，需要把进度推到 picker，picker 关掉后没地方继续显示——和 trellis"画布是主舞台"的整体设计冲突。
  - **picker 在 created 关闭**：不等 done。理由同上，画布卡片就是 progress UI。
  - **没超时**：长 PDF / 大 wiki 文档可能要 1-2 分钟，超时就是坏 UX。SSE 本身有连接 = 用户在等 = 还没 abort 的语义。
  - **abort 复用 STREAM_CONTROLLERS**：和 chat 的 abort 是同一套基建，⏹ 按钮直接接上。`useEscapeAbort` 也自动覆盖（streaming reference 可被 Esc 中止）。
  - **progress sniffer 简单 regex**：不正经解析 partial JSON，只 grep `"command":` / `"url":` 等。够用，且任何工具都能加自己的 key。
- **Caveat（流式）**:
  - **页面关闭后 server 怎么办**：客户端断 SSE → controller.signal aborted → fetcher 的 onAbort 杀 claude 子进程 → finally 执行 finalizeReferenceFetch 写入 partial。理论 OK，但没刻意验过。
  - **进度文案是 best-effort**：tool input 流式 partial JSON 用 regex 抠的，少数场景可能 miss（比如 tool 用了非常规 key 名）。miss 时只显示 "调用工具 X …"，不致命。
  - **流式期间不能刷新 / 不能划词追问**：刷新按钮 hidden（canRefresh = url && !streaming），划词在空 markdown 上没意义。streaming 占位卡 click 还是会进 fullview，看到的是进度 panel 不是文档——预期。
  - **claude 偶尔不按 frontmatter 输出**：parser 容错过几次还是会翻车。翻车时 done 事件里 contentMd 是空 + meta.fetchError 带前 280 字 stdout 提示，UI 不会卡死。
- **Done（verbatim 修复）**: claude 默认会"整理"内容，加 `## Overview` / `**Summary**` 等凭空章节
  - 用户反馈："看着好像做了不少删减，不能直接原文 copy 吗"。诊断两层原因：(1) prompt 里 "not a summary" 措辞太弱；(2) haiku 即使强 prompt 也偏好重组内容；(3) claude 默认走 WebFetch 工具，该工具内置摘要倾向。
  - 改动：
    - **PROMPT_TEMPLATE 重写**：明确"You are a pipe, not an editor"，列举禁止行为（不加章节、不重排、不翻译、不改写），说明 hard rules 8 条。指出 feishu-cli **不要** 用 `--front-matter`（避免嵌套 frontmatter），普通网页 **避开 WebFetch**（改用 `Bash: curl`）。
    - **模型 haiku → sonnet**：haiku 即使有强 prompt 也常规违例。sonnet 服从 verbatim 指令更稳。代价 ~$0.005 → ~$0.05/次，延迟从 5-15s 涨到 8-25s。
  - 验证：example.com 重测——之前是三个凭空章节 + Summary 块（240+ 字）；现在 170 字，几乎和原文一致，结构保留。claude 自主选了 curl 而不是 WebFetch（按 prompt 引导）。
  - **遗留**：HTML→Markdown 这步即使 sonnet 也会轻微 tighten phrasing（不可避免，因为 HTML 里没结构化原文）。但飞书/GitHub raw/PDF 等 native markdown 路径走 Bash + 工具直输出，claude 几乎不动——用户最关心的飞书场景不受这个影响。
- **Done（markdown 表格 + blockquote/hr 样式）**: 之前 globals.css 完全没表格样式，浏览器默认渲染太紧
  - 用户反馈："卡片的预览，对于表格支持的有点差，内容特别稠密"。诊断：`.md-body` 没任何 table 样式 → 浏览器默认裸表格（无边框、字号大、cell 紧贴）→ 飞书 wiki 那种 5+ 列 dense 表格直接糊一团或撑爆 600px 卡片。
  - 改动：
    - `lib/md-components.ts` 新增：导出 `MD_COMPONENTS` Components 映射，`table` 渲染器把 `<table>` 包进 `<div class="md-table-wrap">` 让宽表格可以横向滚动。三处 `<ReactMarkdown>` 都加上 `components={MD_COMPONENTS}`（ChatNode + NodeFullView 两处）。
    - `app/globals.css` 加 `.md-body .md-table-wrap`（横向滚动容器 + 圆角 + 细 scrollbar）+ `.md-body table/th/td/thead/tbody`：12.5px 字号，单元格 7×11 padding，alternating row 浅灰背景，thead sticky + 浅灰底，单元格 max-width 360px 防止单 cell 整篇 paragraph 把整行撑炸。
    - 顺手补 blockquote（左灰边 + 浅灰底）和 hr（细灰线）的基础样式——同样 globals.css 之前缺。
  - 验证：build ✓
  - **取舍**：canvas 卡片 600px 宽，5 列以上的宽表格仍然只能横向滚动看 3-4 列。trellis 设计语言一贯是"画布看大概、全屏读细节"，所以接受这个限制。点全屏后表格仍然 sticky header + 滚动，体验完整。
- **Done（CF dev 缓存绕过）**: 域名走的版本看不到新 CSS
  - 用户反馈："本地有了，走域名还是没有"。诊断：curl 比较 localhost vs 公网域名，CSS 内容一致（`md-table-wrap` 都在），所以 server 没问题。继续看 cache header：
    - localhost：`Cache-Control: no-cache, must-revalidate`（Next dev 默认）
    - 域名：`Cache-Control: max-age=14400, must-revalidate` + `cf-cache-status: REVALIDATED`
  - **Cloudflare 把 no-cache 改写成 max-age=14400（4h）**——这是 CF 的 Browser Cache TTL 默认行为。所以 dev 改 CSS 后域名要 4 小时才看得到。
  - 改动：`next.config.ts` 加 `headers()` 规则（仅 dev）：给 `/_next/:path*` 和 `/` 发 `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`。`no-store` 是 CF 不会改写的少数指令之一（被视为 bypass-cache）。Production 仍然走 hash 文件名 + 默认缓存。
  - 验证：domain header 现在是 `cf-cache-status: BYPASS`，每次都拿最新版。
  - **教训记到 memory**：Cloudflare tunnel + Next dev 组合时一定要配 no-store dev header，否则 CSS/JS 改动看不到。已写入 `~/.claude/memory/insights/cloudflare_tunnel_dev_cache.md`。
- **Done（白天/晚上模式）**: Tailwind v4 class-based dark variant + 全组件 sweep
  - 改动：
    - **Tailwind v4 配置**：`@custom-variant dark (&:where(.dark, .dark *))` 加到 globals.css，`<html class="dark">` 激活 `dark:` 工具类。
    - **Theme manager**：`hooks/useTheme.ts`（读写 localStorage `trellis-theme`、订阅 `prefers-color-scheme` 变化）+ `components/ThemeToggle.tsx`（sun/moon icon）+ Header 接入。
    - **FOUC 防止**：`app/layout.tsx` 加预 hydration 内联 script，根据 localStorage / system pref 立即给 `<html>` 加 `.dark`，React 渲染前 chrome 已经是对的颜色。
    - **highlight.js**：`@import "highlight.js/styles/github.css" layer(hljs-light)` + `github-dark.css` layer，CSS layers 让 dark 优先级覆盖。
    - **globals.css 暗色版**：md-body strong/code/pre/headings/mark/blockquote/hr + 表格 wrapper + scrollbar + streaming-cursor + react-flow background/edge/controls 全部加 `.dark` selector 版本。
    - **组件 sweep**：13 个组件统一加 `dark:` utility variants — Header / ChatNode / ReferenceCard / NodeFullView / QuestionInput / Outline / NodeTreeOverlay / BranchPopover / ReferencePicker / AddNodeFAB / ModelPicker / ModePicker / SessionPicker / ExportMenu / Canvas FAB / app/page.tsx hydrate banner。命名约定：bg-white→stone-900、stone-50→stone-900/50、stone-100→stone-800、stone-200→stone-800、text-900→100、text-700→300、text-500→400、text-400→500；amber/rose/indigo 类的 -50→-950/30、-200→-900。
  - 验证：build ✓。
  - **Caveat**:
    - 没做 system-pref 的"自动跟随"按钮——只有 light/dark 二态切换，跟不上 OS 的明暗时段切换（除非用户从未点过 toggle，那时 hook 会 listen prefers-color-scheme）。后续要加可以引入"system / light / dark"三态。
    - 个别小色调（`text-stone-800` 边角等）可能还有未替换的。基础体验已通，UI 测下来发现哪里跳就补一下。
- **Done（历史对话 tab 重做：rename + delete）**: 之前只有 hover-only 的 ×，没有重命名
  - 改动：
    - **后端**：`lib/server/repo.ts` 加 `renameSession(id, title, now)`（trim + 200 字符 cap + 空 title 拒绝 + bump updated_at）；`app/api/sessions/[id]/route.ts` 加 `PATCH` handler（接受 `{title}`，校验 + 调 repo + 返 session）。
    - **Store**：`renameSession(id, title)` action，乐观更新本地 session（如果是当前 active 的）+ PATCH + 失败回滚 + revision bump 让 picker 刷新列表。
    - **UI 重做**：行结构改为 `[• 状态点][标题/日期][✏️ 重命名][🗑️ 删除]`，图标按钮平时 40% opacity，hover 时 100%（mobile tap 也 OK）。重命名走 inline `<input>`：Enter 保存 / Esc 取消 / blur 保存；预选全文方便覆盖输入。下拉宽度从 320px → 384px 给行留余地。
  - 验证：build ✓；curl 测 rename 成功 / 空 title 400 / 不存在 404。
  - **Decisions**:
    - **rename on blur 保存**：比"必须按 Enter"少一步，符合 macOS Finder 重命名直觉。意外失焦也保留更新（实际上是用户的最终输入）。
    - **图标按钮常驻不隐藏**：mobile 没 hover，opacity-40 默认值让按钮可见但不抢眼，hover/tap 时变实。
    - **不在 trigger 上做编辑**：trigger 只做"选 session"。重命名走 dropdown 内 row 的 inline edit——一个 component 干一件事。






### Session 11 (2026-05-04)
- **Done**: Stage 11 — 发送/取消 UX 全套
  - **服务端 abort 兜底**（`app/api/chat/route.ts`）：finally 里查 `req.signal.aborted` → 强制 `stoppedWith="error" / errorMessage="aborted"`，覆盖 claude 子进程被 kill 后干净退出导致 stoppedWith 残留 "done" 的坑。`controller.close()` / `send()` 全部 try/catch（客户端可能已断开）。topic_label 仅在真 done 时才生成。
  - **客户端 AbortController**（`stores/sessionStore.ts`）：
    - module-level `STREAM_CONTROLLERS: Map<nodeId, AbortController>`（不放 store，避免 Zustand 序列化）
    - `runStream` 接 `signal`，传给 `fetch`；mid-stream abort 时 `reader.read()` 抛错，catch 里区分 `signal.aborted` → 合成 `{type:"error",message:"aborted"}` 给 store
    - `handleStreamEvent` 在 `created` 事件里登记 `(nodeId, controller)`；`done`/`error` 终止时清理
    - retry 路径 nodeId 已知，eager 注册 + finally 兜底清理
    - 新增 actions：`abortStream(nodeId)` / `hasStreamingNode()` / `latestStreamingNodeId()`
  - **Cmd+Enter 替换 Enter**（4 处输入面）：QuestionInput / NodeFullView 两处 / ChatNode FollowupInput。条件 `e.key === "Enter" && (e.metaKey || e.ctrlKey)`。kbd 提示文案 + placeholder 同步更新（"⌘↩ 提交 · Enter 换行"）。
  - **流式 ⏹ 按钮 + Esc 中止**：
    - `ChatNode.tsx:NodeFooter`：streaming 时 "正在生成…" 旁加灰色边框"停止"按钮，hover 反白
    - `NodeFullView.tsx:FollowupBar`：streaming 时整个输入框 pivot 成全宽"停止生成（Esc）"按钮（替代之前的 disabled "等待回复完成…"）。done 后恢复输入框
    - `hooks/useEscapeAbort.ts` 新增：全局 keydown 监听，textarea/input/contentEditable 内不触发；优先 abort active streaming 节点，否则 abort 最近一个（`STREAM_CONTROLLERS` 插入序）。挂在 `app/page.tsx`
  - **Aborted 视觉**：`status="error" + errorMessage==="aborted"` 走 stone/灰色"已停止生成"框（区别于红色 error），按钮文案"↻ 重新发送"。retry 路径不变（已有 `retryNode`）。
  - 验证：`npm run build` ✓；mock SSE curl --max-time 0.4 → DB row `status=error / error_message=aborted / response 106 chars`（partial 落盘 ✓，状态正确 ✓）
- **Decisions**:
  - 不引入 `aborted` 新状态枚举——用 `errorMessage === "aborted"` 区分。少一个 migration，UI 一处分支判断即可。
  - QuestionInput 不加 ⏹ 按钮：从 submit 到 created 事件回来是毫秒级，过度设计。created 后 page swap 到 Canvas/Fullview，由那边的 ⏹ 接管。
  - FollowupBar pivot 而非附加按钮：streaming 时输入框本来就是 disabled 死状态，不如让那块空间真正能停止当前流。
- **Caveats**:
  - 浏览器 UI 未实测（ssr / hot reload 已生效在跑着的 dev server 3088）。需要用户跑一遍 spec 列出的用例。
  - lint 残留 4 个错误都是 pre-existing（NodeFullView:110 / SessionPicker:24 setState-in-effect），非本次引入。
  - `controller.close()` try/catch 是防御性的——Next.js App Router 下 client abort 时 ReadableStream controller 可能已 closed。如果实测发现 server 端日志有 unhandled，再追。
- **Next**: 浏览器验证 spec 用例（Enter 不发 / Cmd+Enter 发 / Shift+Enter 换行 / 流式 ⏹ 中止 / Esc 中止 / partial 保留 / 重发 / 并发 streaming Esc 只中 active）。验证通过后开 Stage 12。


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
