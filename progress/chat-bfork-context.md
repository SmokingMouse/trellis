# Chat 上下文:窗口截断 → B-fork（append-only + caching）

> Handoff 文档。分支 `feat/chat-bfork-context`(trellis + agent-gateway 两仓都在此分支)。
> 状态:**代码改完、typecheck 通过,但端到端验证未确认**(被工具污染 + dev 端口混乱打断)。

## 一、为什么做(背景 + 实测依据)

chat 模式原用 **depth 窗口截断**(默认 4 层祖先)折叠历史进 prompt。实测证明这是**双输**:

- **失忆**:窗口外早期对话归零(树最深到 depth 14)。
- **高成本**:窗口每轮滑动 → prompt 开头(prefix)变 → prompt cache 命中触底。实测 chat depth 6+ 层 cache_read 仅 1334,且**随深度反降**(命中的全是固定 system 块,历史一点没进 cache)。

同系统天然对照:**project 模式**(append-only via `--resume`)cache 命中 **89.8%**、cache_read 随深度涨到 50 万;chat(窗口)仅 **36.1%** 且随深度降。

### 关键实测(决定方案形态)

- **形态 A 否决**:把历史拼成单条 user message 做 append-only —— 实测 claude CLI **按 message 块缓存,不按 token 前缀**,单条 message 追加内容使整块 cache 失效。对照实验:promptB(含 promptA 前缀)与 promptC(历史全不同)cache_read **完全相等(16660)**,证明 user message 历史不进 cache 命中。
- **形态 B-fork 采纳**:`claude -p "新问题" --resume 父session --fork-session`。实测 fork 出的新 session **完整继承并命中父历史 KV**(cache_read 34993 = 全部历史,fresh 仅 73,命中率 99.8%)。fork 产生独立 session id → 树形分支不串话。
- **彩蛋**:claude CLI 默认 `ephemeral_1h` cache(不是 5min),TTL 风险消除。

### 成本定价(诚实)

B-fork **不比当前失忆的 chat 更便宜**(它真的多带了有效历史);它让"不失忆"从全价变 ~10% 价(cache read)。痛点里**失忆根治、成本是"把不失忆开销降到最低"**。

## 二、架构决策(绝不丢)

1. **B-fork = 每 node fork 的 project 模式**:历史由 CLI 维护成不变 message 块(缓存友好),`--fork-session` 保证每 node 独立 session(树形不串话)。复用 project 已验证的 resume 路径。
2. **per-node vs per-root**:project 是 per-root(整树共享 root 的 session id,`getRootResumeIdForNode`/`setRootResumeIdForNode`);chat B-fork 是 **per-node**(每 node 存自己 fork 的 id,子 node resume 父 node 的 → 新增 `getParentResumeId`/`setNodeResumeId`)。
3. **cwd 解耦(本次重构核心)**:agent-gateway 的 `workspace` 字段原本耦合了「文件工具可达范围」+「进程 cwd(决定 session jsonl 落盘路径)」。chat 纯对话需要稳定落盘路径却不要文件工具 → 无解。解耦成独立的 `cwd` 字段。
4. **sessionCwd 收敛(B2 失忆根因的修复)**:spawn / resume 校验 / 清理三处**必须用同一个 cwd**。原 bug:chat 纯对话无 workspace → claude spawn 在进程 cwd(trellis 项目目录),但 `claudeJsonlExists` 用 `claudeSessionPath(id, null)` 算的是 home → 路径不匹配 → resume 自愈检查判 jsonl 不存在 → 全部 fresh session → 失忆。修复:`sessionCwd(mode, wp)` 统一返回 chat→CHAT_SCRATCH / ws·proj→bound path,三处都用它。
5. **回退**:`historyDepth` 0=B-fork(默认),≥1=窗口模式(旧拼字符串 `buildPrompt`)。UI 一个旋钮切回。`claude.ts` 用 `req.forkSession` 判断走 `buildProjectPrompt`(只发问题)还是 `buildPrompt`(拼历史)。
6. **codex**:chat 模式 fallback 拼字符串(forkSession=false,无缓存红利)。codex CLI 其实有 `fork`/`resume`,但 trellis 连 project 模式都没给 codex 传 session id(`sdk-adapter` 写死 `resume: req.claudeSessionId`)——codex 对称优化留作**独立后续任务**。
7. **纯对话 settingSources:false**:cwd 改成稳定目录后会向上找到 `~/.claude/CLAUDE.md`(global Guabot 指令)污染。纯对话本就该干净(只 DEFAULT_SYSTEM_PROMPT + web),关掉 settingSources 既防污染又省 token。

## 三、已改文件(都在 feat/chat-bfork-context 分支)

### agent-gateway(`/Users/smokingmouse/python/agent-gateway`)
- `src/backends.ts`:① RunOptions 加 `forkSession?`(→ `--fork-session`,仅 resume 存在时生效)② 加 `cwd?` 字段(与 workspace 正交)③ claude/codex 两个 spawn 点改 `cwd: opts.cwd ?? opts.workspace ?? undefined`
- `src/backends-gemini.ts`:line 73 修了 pre-existing 类型错误(`.file` on `{}`),它在 noEmitOnError 下**阻塞 tsc emit**(否则 dist 不更新)
- **已 `npm run build`,dist 干净(BUILD CLEAN)**。注:其余 agent-gateway 改动(events/gateway/index/mock/package.json/progress/untracked)是用户自己的未提交工作,非本次。

### trellis(`/Users/smokingmouse/python/learning/trellis`)
- `lib/paths.ts`(**新**):`CHAT_SCRATCH`(= ~/.trellis/chat-scratch)+ `sessionCwd(mode, workspacePath)` —— cwd 收敛点
- `lib/server/repo.ts`:加 `setNodeResumeId`/`getParentResumeId`(per-node);`deleteSession` 改 per-node 清理(去掉 `parent_id IS NULL`,清所有 node 的 session)+ 用 `sessionCwd`;import `sessionCwd` + `Mode`(from `@/lib/llm`)
- `lib/server/run-bus.ts`:`projectModeFirstTurn:boolean` → `sessionIdTarget:"root"|"node"`,session_init 按 target 调 `setRootResumeIdForNode`(project 首轮)或 `setNodeResumeId`(chat 每轮);import 加 `setNodeResumeId`
- `lib/llm/sdk-adapter.ts`:chat 分支 B-fork RunOptions(`forkOpts` = persist+resume+fork);纯对话加 `cwd: req.cwd ?? CHAT_SCRATCH` + `settingSources:false`;`toStreamEvent` session_init 放宽到 chat 也 emit;`CHAT_SCRATCH` 改 import from `@/lib/paths`(删本地定义 + 删 `path` import)
- `lib/llm/claude.ts`:prompt 分流 `mode==="project" || (mode==="chat" && req.forkSession)` → `buildProjectPrompt`;`ensureChatScratch` 改成纯对话也调(`if (mode === "chat")`)
- `lib/llm/types.ts`:StreamRequest 加 `forkSession?: boolean`
- `app/api/chat/route.ts`:`chatBFork = mode==="chat" && family==="claude" && reqDepth===0`;`clampDepth` 0=B-fork sentinel(范围 [0,12],默认 0);history 分流(chatBFork||project → []);`claudeSessionId` 用 `getParentResumeId`(chat B-fork)/`getRootResumeIdForNode`(project);`spawnCwd = sessionCwd(mode, resolvedWorkspacePath)` 喂给 resume 校验 + provider `cwd`;`sessionIdTarget`;factory 传 `forkSession: chatBFork`;import `getParentResumeId` + `sessionCwd`
- `stores/sessionStore.ts`:`DEFAULT_HISTORY_DEPTH` 4→0;`clampDepth` 允许 0
- `components/QuestionInput.tsx`:历史深度按钮循环 `全发(0)→2→4→6→8→0`,0 显示"上下文 全发"

## 四、验证状态

- ✅ trellis `npx tsc --noEmit`:**0 错误**
- ✅ agent-gateway `npm run build`:CLEAN,dist 含 cwd(d.ts + js 都确认)
- ✅ **端到端通过(2026-06-11 干净重测,dev port 3099)**:root→B1→B2 三轮 `historyDepth:0`,judge 全绿:
  - **不失忆**:埋暗号 58206 → B1 答 `58206`、B2 答 `58206` 且复述了最初指令(跨分支记忆)。
  - **KV cache 命中**:root read0/create1163 → B1 **read1163**/create38 → B2 **read1201**/create38。每轮 cache_read ≈ 父全量 context,命中 ~97%(fork 真继承父 KV)。
  - **per-node fork**:三 node `claude_session_id` 各不同(724d/0bd7/7e82)。
  - **jsonl 落点**:全在 `-Users-smokingmouse--trellis-chat-scratch/`(不在项目目录);B1 jsonl 含 58206(fork 复制了父历史)。`~/.trellis/chat-scratch/` 被 ensureChatScratch 创建。

### ⚠️ 验证中发现并修复的真 bug(原"已修复"声明是错的)

**症状**:首次干净重测 root 的 jsonl 落在 **trellis 项目目录**(`-Users-...-trellis/`,即 dev 进程 cwd)而非 CHAT_SCRATCH,B1 失忆("我们之前没有约定过暗号")。

**根因**:`sessionCwd 收敛`只改了 route + repo(resume 校验 + 清理)侧,**漏了 sdk-adapter 的 spawn 侧**。`modeToRunOptions` 的**纯对话分支**既没设 `workspace` 也没设 `cwd` → agent-gateway 回退进程 cwd → jsonl 落项目目录。但 `getParentResumeId` 用 CHAT_SCRATCH 校验 jsonl 是否存在 → 错位 → 判不存在 → 回退 fresh、不带 `--fork-session` → 失忆。三处 cwd 仍不一致,方向与文档原以为的相反。(enhanced chat 因 `workspace:CHAT_SCRATCH` 被 agent-gateway 当 cwd 用,恰好没踩;只有纯对话踩。)

**修复**(`lib/llm/sdk-adapter.ts` 纯对话分支):加 `cwd: req.cwd ?? CHAT_SCRATCH` + `settingSources: false`(决策 #7,稳定 cwd 会向上找到项目/全局 CLAUDE.md 污染纯对话人设)。修复后端到端全绿(见上)。

## 五、未完成 TODO(下次接续)

1. ✅ **【已完成 2026-06-11】干净端到端验证** —— 见上"验证状态",judge 全绿。验证中发现纯对话 spawn cwd bug 并已修复。
2. ✅ **【已完成 2026-06-11】deleteNodeSubtree per-node jsonl 清理**:镜像 deleteSession,删前收集子树 `claude_session_id` → tx 删完用 `sessionCwd(session.mode, session.workspacePath)` unlink。实测:删 chat 叶子节点 → 对应 jsonl 从 CHAT_SCRATCH 编码目录消失。
3. ✅ **【已完成 2026-06-11】localStorage 旧值**:`migrateHistoryDepth()` 一次性迁移(版本标记 `trellis-history-depth-migrated` gated)—— 清掉旧 depth 值让老用户落到新 B-fork 默认 0,想要窗口模式再自行重设。
4. ✅ **【已完成 2026-06-11】两仓 commit + 合 main**(B-fork 部分)。

## 六、本次 session 的陷阱(下次注意)

- **工具输出污染**:本 session Bash/Read 反复出现污染(zoxide warning + 截断 + 乱码 + **Read 源文件出现 import 幻觉**)。可靠办法:**把内容 `sed`/`git diff`/`git show` 落临时文件再 Read 临时文件**;Edit 的 old_string 从临时文件拿精确字节;改完用 git diff 确认生效,**不信直接 Read 源文件**。
- **agent-gateway 是 dist 不是 src**:trellis 经 `node_modules/agent-gateway`(symlink)用 `dist/`。改 src 后必须 `npm run build`,且 dev server **重启**才加载新 dist。
- **dev 端口**:3000 被别的进程(3286)占,trellis 用 3001。重启验证前确认请求真打到新代码(查 dev log)。
