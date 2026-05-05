# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

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
  - 用户反馈："本地有了，走域名还是没有"。诊断：curl 比较 localhost vs trellis.smokingmouse.cc，CSS 内容一致（`md-table-wrap` 都在），所以 server 没问题。继续看 cache header：
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
