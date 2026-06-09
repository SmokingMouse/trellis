# Session 工作台层(tmux 式多 session 工作台)

> 北极星延伸:`roadmap-2026q2.md` 的"替代 Claude Code CLI + GPT 客户端"已基本达成交互层。本 spec 解决下一道坎——**让一个 CLI 重度用户能像用 tmux 一样,并行承载多个 session 的工作、靠肌肉记忆导航**。

## 动机(用户原话拆解)

用户提了两个真实痛点 + 三个具体点:

1. **想把 Chat 任务 + Claude Code 执行任务收敛到一个平台**(替代日常在 CLI 上的操作)。
2. **不同 session 间切换不友好**,想要类 tmux 的「常驻 tab + 点击切换」。
   - 点 1:Chat 和 CC 任务混在一个扁平池子里,切换乱。
   - 点 2:开/清/关一个 session 在 Trellis 里**不知道怎么做**(CLI 里很自然)。
   - 点 3:很多 CLI 命令在 Trellis 里没法执行。

**根因**:Trellis 用「树」抽象换掉了 CLI 的「session」抽象,赚了分叉,但丢了 session 那套**清晰、可发现、有肌肉记忆**的生命周期(开 / `/clear` / `exit` / `/resume`)+ 命令面。

## 关键架构发现(来自 recon,决定 plan 形状)

| 发现 | 证据 | 对 plan 的影响 |
|---|---|---|
| **执行引擎已是多 session 并发** | `lib/server/run-bus.ts:122` per-nodeId RUNS Map,A/B 任务独立 RunState 同时跑;`subscribe()` late-join 拿 catchup | tmux 并行的引擎不缺,run-bus **零改动** |
| **store 是单 active session 模型** | `stores/sessionStore.ts:149` `session: Session\|null`;`loadSession` 抹掉前一个(443-446) | 真 tmux「多 session 同时活在内存」要重构 store(~30% action 加 sessionId),**MEDIUM-HIGH**。→ 先做 Level A 绕开它 |
| **很多"迷惑"是可发现性,不是能力缺失** | `/clear`=「新提问」fresh-context root(`repo.ts:499` createRootInSession,只 project 有 🧹 badge);resume 已按 mode 自动(`sdk-adapter.ts:26-62`) | 生命周期组件大头是**正名 + 露出**,不是造新能力 |
| **slash 机制可复用为通用命令面板** | `hooks/useSkillSuggestions.ts:22-28` 通用 prefix-match;`SkillPickerList.tsx` dropdown UI | 命令面板有现成地基,只补 registry + dispatcher |
| **SearchModal 已有 mode facet,SessionPicker 没有** | `SearchModal.tsx:228-243` 分 chat/workspace/project/all;`SessionPicker.tsx:113-130` 列表混排无分组 | 分区逻辑可从 SearchModal 借 |
| **真正从零要造的** | — | tab 条 / 归档机制 / 命令面板 / `/compact` |

## 现状速查(file:line)

- **数据模型**:`sessions(id,title,root_node_id,created_at,updated_at,context_mode,workspace_path,system_prompt,~~claude_session_id~~)` `sqlite.ts:25-31`;`nodes.claude_session_id` per-root(Stage 24)`sqlite.ts:70-94`。**无 archived 列**。
- **创建**:`createSessionWithRoot`(新 session+root,锁 mode)`repo.ts:439`;`createRootInSession`(同树新 root=「新提问」,继承设置,claude_session_id=NULL→fresh)`repo.ts:499`。
- **删除**:`deleteSession` 硬删 + 清 jsonl `repo.ts:308`。**无归档**。
- **切换 UI**:SessionPicker = Header 标题下拉(`SessionPicker.tsx`,无分组、无 streaming 状态);⌘P SearchModal 是最强切换入口(有 mode facet + 跳转)。
- **快捷键**:仅 session **内**节点导航(Alt+方向 `useNodeKeyboardNav.ts`、J/K 未读、⌘K 分叉、⌘D 笔记、⌘P 搜索、Esc 中止)。**无 session 级 ⌘1-9 切换**。
- **入口混淆**:「新提问」(Canvas FAB `AddNodeFAB.tsx:42`)vs「新对话」(SessionPicker `:95`)概念分散 🔴。
- **model 切换**:全局非 per-session(`sessionStore.ts:154` provider 全局;C5 曾搁置)。
- **token**:Header 显示 input/output/cache + project 模式 context%(`Header.tsx:200-228`),无 cost。

---

## 设计:三个组件

### (a) tmux 式 tab 导航 ★ 用户最痒,引擎已就位,先做

**Level A(推荐先行,绕开 store 重构)**:常驻 tab 条只是「更快、永远可见的 session 切换器」,点击仍走 `loadSession`(单次 fetch,快)。拿到 tab 条 + 色标 + 快捷键 + live 状态点,**不需要多 session 同时在内存**。run-bus 已保证切走任务不死,所以客户端不必持有多份。

**Level B(deferred)**:真·多 session in-memory、零延迟切换。需 store 重构(`session`→`sessions: Record<id,Data> + activeSessionId`)。**只有当 Level A 的切换延迟实测痛才做**。

- **A1 常驻 tab 条**:替/补 SessionPicker 下拉为一直露着的 tab 条。每 tab = 一个 session(=一棵树),带 mode 色标(chat/workspace/project 三色,沿用 ModeBadge 配色)。`⌘1-9` 快切(注意避开已占键)。
- **A2 live 状态点**:新 `GET /api/runs`(报当前有 active run 的 nodeId→映射 session),tab 上显示 streaming/done/error 点 + 完成未读 badge。复用 run-bus 的 RUNS Map 暴露只读快照。
- **A3 mode 分区**:tab 条按 mode 分组(Chat 区 / Workspace·Project 区),治"chat 和 CC 混在一起"。分组逻辑借 `SearchModal.tsx:228-243` 的 mode facet。

### (b) 清晰的 session 生命周期(开 / 清 / 关 / resume)

CLI 肌肉记忆 → Trellis 映射:

| CLI | Trellis 现状 | 该变成 |
|---|---|---|
| 开 session | mode picker;但「新提问」≠「新 session」概念打架 | **B1**:厘清 + 正名,给明确「开新 session」入口 |
| `/clear` | 「新提问」=fresh root(只 project 有 🧹) | **B1**:所有 mode 一致的「清空上下文」露出 + 🧹 标识 |
| `exit`/收起 | 只有硬删 deleteSession | **B2**:归档机制(archived ≠ delete) |
| `/resume` | project 自动 resume | 已有,B1 顺带把语义讲清 |

- **B1 开/清/关正名 + 一致 clear 入口**:统一散落的「新提问/新对话」概念;清空上下文在 chat/workspace 也给可见入口 + 🧹(现仅 project)。
- **B2 归档机制**:`sessions.archived INTEGER`(idempotent ALTER)+ UI「收起」。归档的从主 tab 条隐藏,picker 可翻出。治"session 越积越乱"。
- **B3 `/compact` 等价**:project 长 session 撞 context window 前的上下文压缩入口。**⚠ 需 spike**:确认 agent-gateway SDK / claude CLI 是否暴露可调用的 compact(选型必附实测,不凭记忆断言)。

### (c) 命令面板 / slash 命令面

把高价值 CLI 命令变成 Trellis 原生动作。复用 `useSkillSuggestions` 的 prefix-match 引擎 + `SkillPickerList` UI。

- **C1 通用命令面板**:把 session 操作做成命令 `/new /clear /compact /archive /switch /model /resume`。补 command registry + dispatcher(现仅 `/skill` 路由给 CLI)。**触发键待定**(⌘K 已占分叉)。
- **C2 CLI 命令映射**:`/model` per-session(重提 C5)、`/cost` 显示、`/resume` 选历史。

---

## 三波节奏

- **Wave 1(导航先立,最痒+最独立)**:A1 tab 条 + 色标 + 快捷键 → A2 live 状态点 → A3 mode 分区
- **Wave 2(生命周期正名)**:B1 开/清/关正名 + 一致 clear → B2 归档
- **Wave 3(命令面 + 深水)**:C1 命令面板 → B3 compact(先 spike)→(deferred:Level B store 重构 / C2 per-session model)

## 开放决策

1. **tab 导航 Level A vs B**:推荐 A 先行(避开 store 重构,80% 价值)。B 看实测延迟。
2. **命令面板触发键**:⌘K 已占(分叉)、⌘P 已占(搜索)、⌘D 已占(笔记)。候选:扩现有 `/` 前缀(输入框内,复用 skill picker 机制,最省)vs 新全局键(⌘J?)。倾向**扩 `/` 前缀**——和 CLI 肌肉记忆一致,零新键。
3. **归档语义**:archived 只是隐藏 + 可恢复,不动 jsonl;硬删仍走 deleteSession。
4. **`/compact` 可行性**:Wave 3 前必须 spike,SDK 不支持则降级为「提示开新 fresh root」。
5. **per-session model(C5)**:随 C1 命令面板一起做 `/model`,还是继续全局。

## 验收标准

- **Wave 1**:开 5 个 session(混 chat/workspace/project)→ tab 条一眼分清类型 + 看到哪个在跑 → ⌘数字秒切,不用打开 SessionPicker。
- **Wave 2**:新手能在 UI 上明确找到「清空上下文」和「归档」,不再迷惑;归档后主 tab 条清爽。
- **Wave 3**:输入 `/clear` `/archive` `/switch xxx` 直接执行 session 操作,CLI 肌肉记忆迁移成功。

## 不在 scope

- 多人协作 / 用户系统(永不,单人单机定位)。
- 真·终端嵌入(不做;CLI 命令映射成原生动作,不嵌 pty)。
- Level B 多 session in-memory(deferred,实测驱动)。
