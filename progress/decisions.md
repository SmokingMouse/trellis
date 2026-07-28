# Decisions Log

轻量方向性决策追加日志（重量级走 `decisions/` ADR）。开新方向前查此处；冲突时 reference 对应条目。

---

## 2026-07-28 · 上线机制：release 目录 + 原子软链切换，不做零停机热切

**Decision**：部署换成 `~/.trellis/releases/<ts>-<sha>/` + `current` 软链原子切换（`make deploy`，
`scripts/deploy.ts` 十阶段）。新版本先在 release 目录里 `bun install` + `next build`，再用真 DB 的
`VACUUM INTO` 快照起临时实例做 smoke（/login、/、/api/providers、/api/sessions 四断言 + 「没杀掉
prod ttyd」回归断言），过了才备份数据库、换软链、kickstart、验活；验活不过自动回滚到 `previous`。
launchd 的 `WorkingDirectory` 指向 `current`（软链每次 spawn 重新解析），仓库目录退回纯开发用途。
**Why**：原来在运行目录里原地 build 是不可逆的——build 失败当场把 prod 打成半死，build 成功忘了
kickstart 就是「内存旧模块 + 磁盘新文件」混跑（S66 实测），且没有回滚路径。本仓库恰好适合搬运：
全仓 `process.cwd()` 零命中、状态全在 `~/.trellis` 与 `~/.claude`、`migrate()` 全是加法 DDL。
**Alternatives**：① **零停机热切**（网关常驻不重启、双 Next 并存、健康检查后切上游、排空旧连接）
—— 拒绝。两个 Next 同时活着会在共享 `~/.trellis` 上三处互撞：`migrate()` 里的 streaming→error 收尸
（`sqlite.ts:531`，每进程首次开库就跑，会判死另一实例正在跑的 run）、ttyd 互杀、cli-sync watcher
双写同一批 jsonl 行；三处都得先改造，而实测切换窗口只有 0.2s（且期间是维护页不是连接被拒），
不值这个复杂度。② **无人值守自动更新** —— 拒绝，用户明确要「更新要我批准」；检测与准备可以自动，
切换必须是显式动作。③ 跨 release 硬链接复用 `node_modules` —— 不做，bun 本来就从全局 cache 硬链，
实测 `bun install --frozen-lockfile` 0.6s，没有可优化的东西。

## 2026-07-16 · 砍掉 Workspace 档：上下文模式收敛为 chat / project 两档

**Decision**：`Mode = "chat" | "project"`，Workspace（一次性 CLI、每轮无状态）整档退役。
DB migrate 加一行防御性 `UPDATE context_mode='workspace' → 'project'`（本机全库实测 0 行，
零迁移负担）；localStorage 旧值（`cli-single`/`workspace`/legacy flag）折到 project；API 收到
老 `mode:"workspace"` 走 isMode 兜底安全回落 chat。UI（ModePicker 两 chip / SearchModal facet /
SessionSidebar 分组 / ModeBadge）、mode-workspace token（globals.css 全主题 + @theme 注册）、
README 三档文档全量清理。
**Why**：① 用量实锤为零（32 个原生 session：chat 21 / project 11 / workspace 0）；② 机制上
workspace ≡ project − resume，减掉的恰是仓库干活想要的跨轮记忆（trellis 折叠历史不含工具副作
用，agent 每轮忘记自己改过什么）；③ 原定位「一次性 CLI」已被 chat 增强模式吃掉（scratch +
full + skill 自动开启，S55）。
**Alternatives**：① 保留给 codex 树分叉用（codex project 是线性共享 session，分支上下文互染；
workspace 折叠 lineage 反而语义干净）—— 拒绝，为 0 使用率保一整档不值；真被绊到再把 codex
project 的历史构造降级成折叠 prompt。② workspace 合进 chat（可选 cwd）—— 拒绝，chat 增强已
覆盖，加 cwd 选择反而复杂化。

## 2026-07-15 · 权限确认（permission gate）= per-session 布尔 + ask 规则注入，还 skip-permissions 的债

**Decision**：session 级 `require_approval`（创建时锁定，仅 claude 系 workspace/project 可开，
默认 0=YOLO 现状）。开启后 spawn 从 `--dangerously-skip-permissions` 降为 `--permission-mode
default` **+ `--settings '{"permissions":{"ask":["Bash","Write","Edit","MultiEdit","NotebookEdit"]}}'`**，
可变更工具经 stdio can_use_tool 暂停 → 复用 A路② 全套管道（PendingInteraction/catchup/respond
API）→ TurnCard 弹权限卡（允许 / 本轮总是允许 / 拒绝+理由）。「总是允许」记忆存 RunState
（per-run，每轮 spawn 重置）。
**Why（两层）**：① 动机 = botmux attach 模式对照后确认的 P0——远程/手机场景需要「重要操作过我
一眼」，且权限确认**不需要终端**，stream-json control protocol 是结构化正解（SDK `onCanUseTool`
已预留，管道 A路② 已全在，本次纯增量）。② **ask 规则是硬前提**：实测（2026-07-15，claude
2.1.207）本机全局 settings.json 裸 `Bash` 全放行，权限规则优先于 stdio 回调——不注入 ask 则
can_use_tool 永不触发、审批形同虚设。ask > allow 的优先级已实测坐实。
**Alternatives**：① 尊重本机 allowlist（不注入 ask）—— 拒绝，等于功能不存在；本机 allowlist
反映的是「人在终端旁」的信任姿态，远程审批是另一种信任语境。② `--setting-sources=` 砍掉用户
settings —— 拒绝，连 CLAUDE.md/skills 一起砍，workspace/project 不可接受。③ per-session 三档
（+acceptEdits）—— 暂缓，布尔够用，要再演化。④ 「总是允许」持久到 session —— 拒绝，per-run
成本为零且语义干净（每轮新进程本就是新权限上下文）。
**SDK 配套**：`RunOptions.askTools?: string[]`（纯机制，policy 名单留在 trellis sdk-adapter）。

## 2026-07-14 · 统一阅读面：NodeFullView 退役，线性 thread 成为唯一「阅读/对话面」（issue #7）

**Decision**：三种界面收敛为两个正交面——**画布 = 看结构/分叉操作，线性 thread = 阅读/续聊**，
所有 mode（chat/workspace/project）通用、可自由切换（顺带关 issue #4/#2）。NodeFullView（全屏
单卡阅读器）与其专属 NodeTreeOverlay 删除；其全部能力迁入共享 `TurnCard`（可编辑问题 / marks
锚点注入+跳转 / 再答一版 / 卡片图 / CLI resume / InteractionForm / GeneratedFilesBar）+
LinearThreadView（⌘K 选区分叉复用 BranchPopover、B 键回父锚点、1s 标记已读、sticky composer）。
store 的 `fullScreen` 状态整体移除，所有入口（卡片点击/DoneToast/搜索跳转/笔记跳转/移动端）
改「线性 + 锚定节点」；持久化 ViewState 兼容迁移（旧 fullScreen=true → viewMode linear）。
**Why**：卡片内阅读 = 线性 thread 锚定单节点的特例；两套 ResponseBody/QuestionBlock/流式管线
已在重复维护，#4 照旧做会出第三份。删一个面，能力集中一处。
**Alternatives**：① 保留 NodeFullView、只抽共享组件 —— 拒绝，双入口双状态（fullScreen ×
viewMode）继续组合爆炸；② chat 模式单独做第三套线性 —— 拒绝，就是重复的来源。
**配套**：#3 = 画布加 fixed DockedComposer（对 active 节点续聊，不随 dagre 重排跳动）；
#6 = streamBranch/streamRoot(attach) 乐观占位节点（`optimistic-*`，created 到达换真 id，
created 前错误回收占位 + 全局 streamAlert toast）+ 线性视图流式锁底（上滚暂停/回底恢复）；
#5 = QuestionInput busy finally 复位 + created 前错误经 streamAlert 出口（原先被静默丢弃）。

## 2026-07-14 · Session 锁系（claude↔codex）+ codex 系内多模型

**Decision**：「系（ProviderFamily）」升为一等产品语义——session 活跃期间禁止 claude↔codex
跨系切换（ModelPicker 置灰 +「跨系 · 需新会话」、`/model` 命令同规则拦截），系内（原生
claude/deepseek/ark 互切、codex:<a>↔codex:<b>）自由；mock 调试豁免。同时 codex 从单一 id
扩成 `codex:<slug>` 复合 id（清单读 `~/.codex/models_cache.json`，`visibility==='list'`），
经 CodexBackend 既有 `-m` 透传选模型；裸 `codex` 保留（兼容存量 session，默认 gpt-5.5）。
**Why**：resume id 按 family 分列存储，跨系切换必然静默断上下文——与其靠文档警告，不如从
入口封死（选系只发生在新建会话时）。锁 = 派生语义（active session 的下一轮 provider 即
store.provider），零 schema 改动。
**Alternatives**：① 允许跨系但弹警告 —— 拒绝，用户会忘，断上下文不可逆。② session 表加
family 列硬锁 —— 拒绝，session.model 已锁具体模型，family 可派生，加列冗余。③ codex 模型
静态清单写死代码 —— 拒绝，models_cache.json 是 codex CLI 自维护的活清单，免手工同步。
**遗留**：codex native resume / 树分叉 parity（P0/P1 已排期见 README），能力矩阵抽象未做
（下一波）；commands.ts 的跨系闸当前是纵深防御（QuestionInput 仅首屏渲染，session 内实际
执法点只有 ModelPicker）。

## 2026-06-16 · CLI 分支对齐 P2 简化：trellis 发起的分叉统一构造前缀 jsonl

**Decision**：P2 不再分 tip→`--fork-session` / 非 tip→前缀 jsonl 两路；所有 trellis 发起的
attached 分叉都走「复制 root→X、复用 uuid、改 sessionId、写 `<newSid>.jsonl`、再 resume」。
**Why**：一条机制覆盖任意分叉点，`newSid` 由 trellis 同步生成，不需要从 `session_init` 异步捕获；
代价是放弃 fork-session 的 KV cache 复用，首轮稍慢但可接受。
**Alternatives**：沿用母设计 tip `--fork-session` 路径 —— 拒绝，多一条异步身份路径，且只覆盖 tip。
**取代**：上条 CLI 分支对齐母设计中的「trellis tip 分叉→`--fork-session`」映射；其余 union-by-uuid
和前缀 jsonl 支点不变。

## 2026-06-16 · CLI ↔ trellis 分支对齐（设计完成，待实现）→ [cli-branch-alignment.md](cli-branch-alignment.md)

**Decision**：让 CLI 的 rewind/branch 与 trellis 分叉双向对齐。统一模型 = **一棵 trellis 树 =
一组 CLI session（root + forks）按 jsonl message uuid 求并集**。
**关键实测支点**：① fork-session 复制祖先 uuid 不变 → union-by-uuid 自动合并零重复；②
`claude --resume` 对 in-jsonl 多叶子只走主链 → in-jsonl fork 不可靠 resume，可 resume 的分支必须是
独立 session（fork-session）；③ 从任意历史节点分叉用「构造前缀 jsonl（复制 root→X、复用 uuid、改
sessionId）+ resume」实现，已验证（绕过 `--fork-session` 只能从 tip 分的限制，也绕过 SDK 无 fork
父点选项）。
**映射**：CLI rewind/edit→trellis 兄弟节点（解析器已支持）；CLI /branch→新 fork jsonl→union 成
子树；trellis tip 分叉→`--fork-session`；trellis 任意节点分叉→构造前缀 jsonl。
**范围**：只动 `origin='cli-import'` attached 会话（project 模式那一支），原生 chat/workspace/
project 零改动，chat B-fork 机制复用不改。
**Alternatives**：① in-jsonl fork 写一个 jsonl —— 拒绝（resume 看不到非主链分支，实测证伪）。
② SDK 指定 fork 父点 —— 拒绝（RunOptions 只有 resume+forkSession，无此选项）。
**状态**：未实现，下一个 session 从 P1（union 导入）起。

## 2026-06-16 · 【推翻】CLI 同步改为 per-session attach + 真双向（取代下方"只读镜像"决策）

**Decision**：用户反馈推翻"按目录批量只读镜像"。改为：① **per-session attach**——用户浏览
本机 CLI 会话清单、**手选**哪些 attach（不按目录批量灌）；② **真双向**——attach 后两侧都能
续聊，trellis 续聊走 project-mode `resume` 写回同一 jsonl，CLI 侧续聊由 watcher 导回。
**Why**：用户要"自己选 + 两侧同步"。recon 发现 project 模式本就 `resume + persistence`，双向
续聊底层现成；importer 已用 jsonl uuid 当节点 id，单一命名空间现成。
**关键解法（身份对账）**：SDK 流不暴露 turn 的 jsonl uuid，trellis 自建节点会和 watcher 导入
撞双份。解法 = **jsonl 为唯一真相源**：trellis 续聊完（Result 后）删临时流式节点 + 重导 jsonl，
让该轮以 canonical jsonl-uuid 节点落地，两方向收敛到 import 一条路。
**物理约束**：同一会话不能 CLI + trellis 同时各聊一轮（抢 append）；串行无碍。
**对 claude_session_id 的修正**：attach session 需设 `claude_session_id`（resume 必需），删除
hazard 由已加的 `origin='cli-import'` 闸挡（detach/删 trellis 侧不动原始 jsonl）。
**Alternatives**：① 维持只读镜像 → 用户明确否决。② 给 trellis 节点读 jsonl tail 取 uuid 后
re-key（不删建）→ 比"删临时+重导"更碎（要改 children/FTS/notes/root_node_id），且新建无 children
的 leaf 删了零风险，故选删+重导。
**取代**：下方 2026-06-16"只读镜像"决策作废，仅留作演化轨迹。

## 2026-06-16 · CLI Session 同步 = 只读镜像，不续聊（v1）【已被上条推翻】

**Decision**：本机 CLI 会话同步进 trellis 做成**只读镜像**——浏览/搜索/导出，v1 不在镜像
session 里续聊。
**Why**：续聊会和 CLI 进程抢写同一个 `<sid>.jsonl` → 写冲突 + 状态撕裂。只读镜像零冲突。
**Alternatives**：① 直接续聊同一 jsonl —— 拒绝，抢写。② 续聊走 `--fork-session` 复制一份
再聊 —— 是对的方向，但属增量功能，拆成独立 Stage D，不进 v1。
详见 [cli-sync.md](cli-sync.md)。

## 2026-06-16 · 防回环去重 = 按 session id 排除 trellis 自有 jsonl

**Decision**：同步时跳过「文件名（去 `.jsonl`）∈ trellis 自己 spawn 的 session id 集合」的
jsonl 文件。集合来自 `nodes.claude_session_id` / `codex_session_id`。
**Why**：trellis 自己 spawn claude 也往 `~/.claude/projects/` 写 jsonl；不排除会把 trellis
自有会话再导回来 → 重复 + 回环。jsonl 文件名恰好就是 session id，排除键天然现成、可靠。
**Alternatives**：① 在 jsonl 内容里嗅探 trellis 特征 —— 脆、无稳定标记。② 让 trellis spawn
时写到隔离目录 —— 改动大且破坏 CLI 兼容。

## 2026-06-16 · 同步范围 = opt-in 选择器，非全量

**Decision**：用户勾选要镜像哪几个 project 目录/会话，只 watch 这些。
**Why**：本机 88 个 project 目录，全量镜像会把 SessionPicker / SessionTabs 瞬间淹没。
**Alternatives**：全量自动镜像 —— 拒绝，列表噪音不可接受。
