# happyclaw × trellis 对照剖析

## 一句话结论

23 条建议里活下来 4 条，且**没有一条来自 happyclaw**——真正可复用的不是它的机制，是它的**尸检报告**（同一个 symlink 盲区三个月咬三次、"必须保持一致"的注释半衰期 6 周、至少 7 处"造了闸忘接门"的死代码）。本月唯一值得投的重活是把 `cli-fork.ts` / `cli-import.ts` 两份 jsonl 解析器合成一份并配回归测试，因为它是思维树分叉与 CLI 双向同步的交汇点，出错静默且复利。BOE 多人场景的真缺口是 per-user 身份 + 归属 + 审计，本轮 23 条一条都没碰到，需要单独立项——在此之前任何"投递保证 / 口令闸 / env 减法"都是给没有收件地址的管子加投递回执。

## 两个项目的形状

**happyclaw**（292k LOC TS，1217 commits，10+ 贡献者，316 个 `*.test.ts`，GitHub Actions 每 PR 跑）：自托管多用户 Agent 系统，入口是飞书/TG/QQ/钉钉/微信/Discord + Web，每用户一个 Docker 容器，RBAC + 计费。它的体量不是"harness 成熟度"，是它自己选的商业模式开的账单——`channel-reliability-store.ts` 2491 行 + `channel-outbox-delivery.ts` 412 行 + 六态状态机（含专防自动重放的 `uncertain`），存在的唯一理由是"IM 消息没落地 = 这一轮 agent 输出在世界上不存在"。

**trellis**（44.6k LOC，200 commits，1 人，0 个 `*.test.ts`、0 CI，但有 `scripts/test-*.ts` 四个 harness / 833 行）：单用户树状 AI 对话工作台。执行方式是 spawn 本机 claude/codex 子进程，transcript 真相源在 `~/.claude/projects/**.jsonl`，DB 是可重建的派生缓存（`lib/server/sqlite.ts:706-716` 的唯一一次 `user_version` 迁移做的就是作废游标、强制全量重导）。认证是 4 行共享密码 cookie（`lib/auth-cookie.ts`），全库 `rg 'userId|user_id' lib/ app/` = **0 命中**。

值得对照的不是"谁更成熟"，是**两条产品线在同一批技术问题上的分岔**：happyclaw 赌"IM 是入口"、必须自己重建 transcript（`conversation-history.ts` 把消息拼成 `<history_message>` 喂回去）；trellis 赌"本地 CLI 是入口，我是叠在它上面能看见整棵树、能双向续写的那层"。happyclaw 的 292k 里没有任何东西对应 trellis 的护城河——而 trellis 的 44.6k 里也没有任何东西需要长成 IM/多租户/计费。

## 白捡的坑：happyclaw 踩过而 trellis 正要踩

### 坑 1 · `Dirent.isDirectory()` 对 symlink 返回 false —— 此刻正在漏 trellis 自己的管家 skill

**happyclaw 证据**：三个月内被同一个盲区咬三次——`5203adb`「scanSkillDirectory 跳过 symlink 形式的 skill 目录」→ `2ab52ad`「listFiles 对指向目录的 symlink 类型判断不一致」→ `87a9369`「修复软链接到外部目录的 skill 内容无法展示」。最终写法固化在 `src/skill-utils.ts:29-40`：允许 symlink + 用 `stat`（穿透）确认目标是目录 + 悬空链接静默跳过。

**trellis 踩的行**：`app/api/skills/route.ts:37` 的 `if (!e.isDirectory()) continue;`。本机实测：`~/.claude/skills/` 下 106 个条目，恰好 1 个是 symlink——`trellis-admin -> /Users/smokingmouse/python/learning/trellis/skills/trellis-admin`。也就是说 **trellis 自己的管家 skill 在 trellis 的 UI 里隐形**，而 CLI 的 `slash_commands`（init 事件实测有它）、`trellisctl skills`（`trellisctl.ts:440-441` 用 `existsSync` 穿透）都看得见。物化侧不受影响（`agent-pack.ts:129/134` 的 `existsSync`/`symlinkSync` 都穿透），纯发现层 bug。

第二层后果更硬：`app/settings/agents/page.tsx:325` 的 chip 只从 `filteredSkills` 渲染（已核，`filteredSkills.map` 是唯一渲染源），而 `:315` 的计数读 `draft.skills.length`。从 API 侧写进 `skills_json` 会得到「已选 1、0 个 chip、点不掉」的**不可退出死状态**。

**改法**：`if (!e.isDirectory() && !e.isSymbolicLink()) continue;` + 对 symlink 用 `await fs.stat()` 穿透确认。孤儿 chip 单独标灰 + ⚠ + 仍可点掉。**明确不动** `app/api/workspaces/browse/route.ts:83-84` 与 `app/api/sessions/[id]/files/route.ts:106`——那两处跳 symlink 带着 "cycles / intentionally not listed" 注释，是有意决策。

### 坑 2 · SameSite=lax —— happyclaw 花了钱的地方 trellis 一个单词没花

这条被埋在一个**被毙掉的建议**（ttyd argv 服务端派生）的证伪材料里，四条存活建议一条都没捞。

**happyclaw 证据**：`src/auth.ts:86` 是 `SameSite=Strict`；`src/web.ts:1390-1394` 的注释原文——「**SameSite=Strict cookie 是当前的主防御**，origin 检查是纵深防御」。它为 WS 的 Origin 白名单反复返工 4 次（`ed775b8` → `2599989` → `cbbeacc` 一度把默认值改成 `'*'` 整体关停 → `c7fd0ff` #557 → `804a9e0` 收尾），三次破坏全是"合法用户连不上"——而这一整轮返工护的是它自己说的"纵深防御"那半条，主防御是那一个单词。

**trellis 踩的行**：`app/api/login/route.ts:34` `sameSite: "lax"`（已核）。Lax 放行跨站顶层导航，于是任何恶意页面能把用户浏览器导航到 `/term/?arg=...`，把"能开终端但驱动不了"升级成"能执行一条命令"——而 `lib/server/ttyd.ts:295` 起的是 `-W`（可写）、`:298` 是 `tmux new -A -s`，第 4 个 `arg=` 实测能执行（ttyd 1.7.7 + trellis 同款 flag，`sh -c "id > /tmp/x"` 落盘成功）。

**改法**：`"lax"` → `"strict"`。UX 代价实测为零：入口是书签 / PWA（Strict cookie 对书签和直接输入照发），`lib/server/notify.ts` 走本机命令不发回链，全库没有从外站导航进来的深链。

**顺带**：如果还想拆掉 `?arg=` 这条通道本身，正解不是在网关加 40 行白名单 parser（那版会误伤且 `--check-origin` 会**当场打死所有终端**——bun 的 WS 客户端不发 Origin，ttyd 1.7.7 在无 Origin 时判拒，实测 `refuse to serve WS client from different origin`），而是把 shell-command 槽位从 argv 里拆掉：`ttyd.ts:298` 改成 `/bin/sh -c 'exec <tmux> new -A -s "$1" -c "$2"' trellis` + `TerminalPanel.tsx:438` 去掉 `&arg=-c`。实测通过：session 正常建、cwd 正确、第 3 个 arg 完全惰性。两行。

### 坑 3 · "必须保持一致"的注释，半衰期 6 周、命中率 0/3

这是全部材料里**最贵的一条教训**，而它恰好否掉了 [memory] 建议自己开的药方。

**happyclaw 证据**：`src/conversation-history.ts:41-42` 与 `container/agent-runner/src/session-history.ts:13-14` 互相点名「Must stay byte-for-byte aligned…both sides feed the same Anthropic API and must produce identical strings」。当前 HEAD（6ab7dad）**三个指针全部悬空**：
- `session-history.ts:13-14` 指 `src/index.ts (recoveryGroups path)` → 全库只有 2 处该正则，`index.ts` 一处都没有
- `tests/session-history.test.ts:204-206` 同样悬空
- `conversation-history.ts:41-42` 指 `container/agent-runner/src/index.ts:extractSessionHistory` → 该实现 `0341f45`（2026-04-12）就搬走了，而 `conversation-history.ts` 生于 `0d91c52`（2026-05-26）——**这条指针写下来的时候就是错的**

它宣称的不变量四条全假：产出结构不同（`<history_message>` + escapeXml vs 裸 `[User] text`）、limit 30 vs 20、截断 700 vs 500、转义只有一边有。零测试同时 import 两边断言相等。而 `0341f45` 本身就是"注释是事故之后才补的"——它没能预防它被发明出来要防的那次 bug（agent-runner 侧保留 emoji、主进程侧把 emoji 一起删，躲过 PR #387 review）。

**happyclaw 真在乎时怎么写**：`src/plugin-importer.ts:492`「byte-for-byte equivalent (**verified by the compat regression test**)」→ `tests/plugin-importer.test.ts:142` 真把 legacy 算法内联复现跑等价断言。以及 `Makefile:40 build: sync-types` + `:75-79 _check-sync`（`find shared/ -newer <target>` 的 staleness 闸）。**同一仓库里，「真在乎」= 写测试或写机械闸，「互相点名的注释」= 没在乎到那一档的那一类。**

**trellis 踩的行**：`lib/server/cli-fork.ts:50/62/67/79` 四份副本（`userText` / `isToolResultEntry` / `isCommandNoise` / `isTurnStart`），对应 `cli-import.ts:102/114/120/146` 的原件。import 那份在实测修 bug 时加了 5 道结构闸（isMeta / promptSource==='system' / interruptedMessageId / isCompactSummary / isVisibleInTranscriptOnly），fork 那份**一道都没跟上**。而 `cli-fork.ts:6` 已经写着 `import { parseCliSessionJsonl } from "./cli-import";`——同一个 module graph、同一份 tsconfig、同一次 build，**根本不存在 happyclaw 那个"编译期物理不能 import"的约束**（`container/agent-runner/package.json:2` 独立 package + `tsconfig.json` `rootDir: ./src` + `Dockerfile:123/204` 打进每用户镜像）。

**改法**：抽 `lib/server/cli-jsonl.ts`，两边 import，删 fork 的四份副本。**共享文件头不要写"必须走同一份"**——抽完之后执行者是编译器，给一个不存在的不变量写注释，正是 happyclaw 演示过的、腐烂最快的那类注释。要写就写 `scripts/test-cli-jsonl.ts`。

### 坑 4 · 造了闸忘接门 —— happyclaw 至少 7 处，trellis 已有 3 处、本轮提案还想再加 4 个

**happyclaw 证据**（全部零生产调用点 / 零消费者）：
| 构件 | 证据 |
|---|---|
| `claimNextChannelOutbox` / `renewChannelOutboxLease` | outbox 队列的取件原语，src/ 零调用，只在 tests 出现 7 次 |
| `turn_runs.inbox_id` | schema + FK + `UNIQUE INDEX` + 兜底查询全建好，生产代码从没传过 `inboxId`，恒 NULL |
| `missingManagedSkillIds` / `missingHostSkillIds` | `effective-skill-resolver.ts:220-235` 算出来，唯一消费者是测试 |
| `excludedReason`（'disabled'/'profile_filtered'/'shadowed'） | resolver 外部零消费者，整个 candidates 只喂给 hash |
| `advanceSkippedTask` / `getDueTasks` | 仍在 import，全仓零调用，`tests/task-restart-recovery.test.ts:92-175` 还在测它们 |
| `setCursors` | src/ 全库零调用点，只剩 `web.ts:742` 一句注释缅怀 |
| `workspaceSkillsDirOverride` | 声明在 `claude-context-resolver.ts:59`，4 个调用点没有一个传它 → host 模式装进工作区的 skill 永远不被 resolve |
| `checkApiRouteModuleIndex` | 只断言"一张 20 行的手写表有 20 行"；251 个真 endpoint 里 59 个（23.5%）在 API.md 里找不到，检查是绿的 |

**trellis 已有的 3 处**：`notified_at`（`rg` 全库 4 处命中 = 2 处 UPDATE + 建表 + 文档，**零 SELECT、零前端引用**）、`task_runs.attempt`（`custom-agents-plan.md:286`「自动重试不做（列留着）」，全库无自增）、`max_retries`（`sqlite.ts:594` DDL-only 零读）。

**本轮提案想加的 4 个**：`notify_error` + `notify_attempt`（[tasks]/[delivery-notify]）、`agent_degraded_reason`（[agent-system]）、`orphan_runs` 表（[execution-isolation]）、`nodes.capabilities_json`（[plugin-skill]）。全部被毙。

**规则**（写进 `progress/decisions.md`）：**新增 DB 列 / 新增机制，必须在同一次改动里带一个真消费者（SELECT 或渲染），否则不加。**trellis 已经有"留列不实现"的明写惯例（`custom-agents-plan.md:131` 的 `kind:"inline"` 判别位同理），这条不是新纪律，是把它从"惯例"升级成"闸"。

### 坑 5 · 裸 `spawn("claude")` + launchd 的 PATH —— trellis 同一条纪律已经写对两遍，唯独最关键那条没接

**happyclaw 证据**：`src/node-resolver.ts:8-14` 的注释精确描述 trellis 的部署形态——「launchd / GUI launcher 起的宿主服务继承的 PATH 可能不含 nvm/fnm/volta，裸 `spawn('node')` 就 ENOENT」。

**trellis 踩的行**：`node_modules/@smokingmouse/agent/dist/backends/stream-lines.js:9` 是裸 `spawn(cmd, args, ...)`（已核），当前靠 plist 里硬编码的 `PATH=...:/Users/smokingmouse/.nvm/versions/node/v24.14.1/bin:...` 兜着——**写死了 node 小版本号**，nvm 一升级 `claude` 就从 PATH 消失。`scripts/deploy.ts` 不生成也不校验 plist（`plist|nvm` 只有 1 处命中，是 `:769` 一句「由 supervisor 决定」）。

有意思的是 trellis 自己在另外两条路上都做对了：`lib/server/update.ts:209-210`（已核，「`process.execPath` 就是当前 bun —— 比赌 PATH 里有 bun 可靠（launchd / systemd 给的 PATH 与登录 shell 不是一回事）」）、`lib/ttyd-dependency.ts:43-60`（候选绝对路径 + 扫 PATH + 真 spawn 探测）。

**改法**：给 claude/codex 加同款解析（候选绝对路径 + PATH 扫描 + 缓存成功不缓存失败），或至少让 deploy 在 preflight 里断言 `which claude` 在 supervisor 给的 PATH 下能解析。工作量极小，价值中高——它和 Current Focus 那条 OAuth 故障属于同一类"prod spawn 阶段死得莫名其妙"。

### 坑 6（证据链薄，标注在此）· 同一条 CLI lineage 上的并发 run

这是 9 个维度里唯一没被任何证伪碰过的新洞，也是 A 的四条完全没覆盖的。

**happyclaw 证据**：`src/group-queue.ts` 2972 行（按 jid 串行 + `pendingTasks`/`pendingMessages` 两级队列）、`src/steering-transition.ts:1-7`（注释原文：「SDK 会让已缓冲的 final result 和 interrupt() 赛跑，这个窗口里旧 result 不能变成第二条 assistant 回复」）、`src/run-stream-fence.ts:6-11`、`src/turn-outcome.ts:5-8`（`status:'closed'` 不自动算成功）。

**trellis 侧**：`lib/server/run-bus.ts:296-302` 的幂等**只按 nodeId**；run-bus/repo 里 `lock|mutex|inflight|Semaphore` 零命中。而 `app/api/chat/route.ts:639` 的旧路径是整个 session 的所有节点共用 `getRootResumeIdForNode` 的同一个 root sid——用户在树上点两个兄弟节点各问一句（**这正是思维树的核心用法**），就是两个 `claude --resume <同一 sid>` 并发 append 同一份 jsonl。`:535` 的 `lin.isJsonlTip && !hasOtherChild(...)` 是请求时刻的快照，`isJsonlTip` 在对端进程正在写 jsonl 时本身就是过期读。

**为什么标"薄"**：没人实测过 claude 并发 `--resume` 同一 sid 会怎样。而 [memory] 的证伪材料里也留了同一个问号——「那条 lineage 此刻若非 tip，claude 自己 `--resume` 一个非 tip sid 的行为（append 还是另开 jsonl）没实测过」。**两个未知是同一个未知**，见「存疑」第 1 条。

## 行动序列

### 立刻做

**L0 · 一行修正包（合计 < 10 行，从被毙建议里捞出的全部残值）**
| 改动 | 落点 | 来源 |
|---|---|---|
| `sameSite: "lax"` → `"strict"` | `app/api/login/route.ts:34` | 坑 2 |
| `stderr:"pipe"` 开了从不读 → 改 `"ignore"` 或在 `console.error`（`:43`）带上尾部 | `lib/server/notify.ts:88` | [tasks] 唯一残值 |
| 零渠道时不盖 `notified_at`（`notify.ts:76` 是 deliberate no-op，不该算送达） | `lib/server/tasks.ts:466/605` | 诚实修正 |
| `createTrigger` 的 `enabled` 硬编 `1` → `0`，UI 点一下才武装 | `lib/server/tasks.ts:238-243` | [agent-system] 口令闸的正解 |
| agent 被停用/删除时 `failRun` 而非静默降级（放在 `:489 ensureTaskSession` **之前**） | `lib/server/tasks.ts:485` 旁 | [agent-system] 2 行版 |
| pending 被 boot reap 写成 `'interrupted'` 但文案说反了 → `CASE WHEN status='pending' THEN '未执行：重启时仍在排队'` | `lib/server/sqlite.ts:737-741` | [execution-isolation] 唯一残值 |
| `stopTaskScheduler()` 零调用方；`shutdown` 的 `remaining` 算了没人读 | `server.ts:194-211` | [execution-isolation] 两个真 bug |
| `excerpt = contentMd.slice(start,end)` 可能切断 surrogate pair | `lib/server/repo.ts:1363` | [memory] 唯一卫生项 |
| ttyd 登记文件 `writeRecord` 默认 0644 → 0600 | `lib/server/ttyd.ts:170-177` | [auth-multiuser] 残值 |

**依赖**：无。**工作量**：一次 commit。**理由**：全部是单行、零 schema、零新概念、各自有独立证据，攒在一起做完就再也不用回想。

**L1 · `/api/skills` symlink + 孤儿 chip**（坑 1）。`app/api/skills/route.ts:37` + `app/settings/agents/page.tsx:325`。0/3 反对，全票。触发概率 100%（此刻正在漏），成本 1 行 + 标灰渲染，直接服务 G1-A2/A3。**依赖**：无。

**L2 · 停止丢弃子进程死因**。`lib/server/run-bus.ts:571-598` 只认 throw / error 事件 / aborted 三种失败，其余落 `done`；`finalizeNode`（`repo.ts:1190-1247`）无空输出闸。补一条对称判断：`done && aggregated==='' && committedToolCalls.length===0 && usage.output===0` → 记 error。**这不是从 happyclaw 借的**——`fetch-via-claude.ts:86/137/219-246` 的 `resultEmitted` idiom 已在 fetch 两条路上跑了两遍（连兜底文案形状都一样：`tail || \`claude 退出（exit ${proc.exitCode ?? "?"}），无错误输出\``），`references/route.ts:240-244` 是它的持久化对称件。**这条只是把自家 idiom 接到第三条路上**，~20 行。`facts.md:12`（S88 ENOENT 事故）已经把「任何新增的无人值守 spawn 路径都要照抄这两道」写成纪律，run-bus 是唯一没照抄的。**依赖**：无（L0 的 notify 那半是同一个失败模式的另一个出口）。

### 本季度做

**Q0 · 15 分钟实验：并发 / 非 tip `--resume` 的行为**。起两个 `claude --resume <同一 sid>` 并发跑，看 jsonl 是交错、是另开文件、还是报错；再单独测 `--resume <非 tip sid>`。**这一个实验同时定两件事的优先级**：坑 6（并发）从"推断"变成"已知"，以及 Q1 的真实爆炸半径（`buildPrefixJsonlCore` 返回 null → `chat/route.ts:584-586` 降级线性 → 到底污不污染源 lineage）。**依赖**：无。**这是全报告杠杆最高的一条。**

**Q1 · 抽 `lib/server/cli-jsonl.ts`**（坑 3）。前置是 `scripts/test-cli-jsonl.ts` + 本机 jsonl 当 fixture，跑 import/fork 两侧 owner 判定一致性——**硬依赖，不是加分项**。仓内已有 `scripts/test-*.ts` 约定（cron 107 行/48 项、tool-tree 286 行带 3 个真 fixture、project-cluster 138 行、timeline-render 275 行/45 项真 `renderToStaticMarkup`），照它写。**strict→loose 两级必须一起搬**：`cli-import.ts:228-270` 的 `makeOwnerResolver` + `fallbackStartIds` 会为「开头没有真用户提问的 fork/continue jsonl」认领 loose 起点，fork 侧只搬 strict 会让 null 率**上升**。

**顺带（落点完全重合，成本近零）**：`cli-fork.ts:297` 与 `cli-import.ts:240` 的 `cur = ...parentUuid` 各加 `?? logicalParentUuid`（已核两行确切位置）。实测数据：同一个 compact 过的会话，fork 前缀 500→928 行、preservedMessages 命中 0/2→2/2；importer 侧 roots 3→1（两个"This session is being continued from…"的摘要假根消失）。**注意**：这来自被毙的建议（它援引的 happyclaw `8c94111` 是 casing 错配的死代码——盘上是 camelCase `compactMetadata.preservedSegment.headUuid`，happyclaw 读的是 snake_case `compact_metadata.preserved_segment.head_uuid`，分支恒不触发），但**修法本身是实测过的**，且落点跟 Q1 重合。频率极低（本机 1924 个 jsonl 只有 1 个含 compact_boundary，trellis 管辖的 12 个 jsonl 里 0 个），但一旦发生用户肉眼可见"树断成三棵 + 两个假根"。

**依赖**：`scripts/test-cli-jsonl.ts` → Q1 → `?? logicalParentUuid`。

**Q2 · notify 的配置 UI + 「发送测试通知」按钮**。`rg notify app/settings/` 零命中——`~/.trellis/notify.json` 至今**没有任何配置入口，只能手写 JSON**，这是原提案察觉到但没点名的真缺口。做法照抄仓内已有范式：`lib/server/ttyd.ts` + `TerminalPanel.tsx:170-171/396`（只缓存成功、「重试」按钮、「探测详情」折叠区、EACCES 与不存在分得开，见 `facts.md:47`）。设置页加一行「外部通知：未配置 / 已配置 `<argv>`」+ 一个按钮，前台跑一次，当场显示 exitCode 和 stderr 尾部。

**依赖 L0/L2**（按钮要显示的 exitCode/stderr 正是它们让 `notify()` 开始读回来的东西）。**排在 Q 而不是 L**：按 riba 的尺子量它下行有限、上行也有限——它不解当下任何已发生的故障，只是把验证从"每次 run 的回执"挪到"配置时的一次实测"。

**Q3 · claude/codex 的二进制解析**（坑 5）。仓内已有两份正确实现可抄（`update.ts:209-210`、`ttyd-dependency.ts:43-60`）。工作量极小。

### 记下但先别做

| 项 | 判据 |
|---|---|
| SDK 侧改 `streamLines` 透出 exitCode + `sawResult` | L2 的 trellis 侧兜底落地后**仍观察到**「done + 空回答」再做。三个宣称的触发场景在 trellis 结构性不可达（`environmentSkills` 全库 0 命中；`agentsJson` 唯二产地都是 `JSON.stringify`；`agent-pack.ts:225-226` 先物化后 sweep 且 `:182` 跳过 keepHash）。且跨仓 `~/sdk` 发版 + bump + prod/BOE 各重部一次——**排在 BOE 部署完成之后**。 |
| notify 的 receipt 协议 / sweeper 重发 | 需要先有真实的送达失败实例。`curl` 打 500 不带 `-f` 退出码是 0，`exitCode===0` 不等于「真送达」；10s 超时被 kill 时 `exitCode=null / signalCode=SIGTERM`（实测），判成失败 + 3 次重发 = 把"包装脚本慢了点"变成手机上三条重复告警。happyclaw 正是撞过这个才有 `uncertain` 态并**禁止自动重放**（`channel-outbox-delivery.ts:68-71`）。 |
| `lib/server/fetch-url.ts:53` 的 SSRF 面 | 只有 `new URL(rawUrl)` 一句格式校验，无 scheme 白名单（`file://` 能过）、无内网 / `169.254.169.254` 判定。当前威胁模型下（单用户、宿主机全权 spawn）基本无所谓——但 BOE 内网恰恰是"内网地址才有价值"的环境。**BOE 前置**。G2 的 worktree 一旦支持填 remote URL，happyclaw `safe-git-proxy.ts:24-27`「禁掉 global/system git config 以免 `url.*.insteadOf` 改传输层」的经验直接适用。 |
| **BOE per-user 身份 + 归属 + 审计（本轮 23 条零覆盖，需单独立项）** | 判据：BOE 上出现第 2 个日常使用者的当天。缺口清单：`tasks`/`nodes`/`sessions` 全表无 owner 列；`notify.json` 是服务进程 homedir 下的**单份**配置（`notify.ts:60`），同事的任务失败全推到部署者一个人手机上；`/term`（`server.ts:392`）在同一个 cookie 后面直接给宿主 tmux **可写** shell（`ttyd.ts:295` 的 `-W`）。**在此之前，任何「通知投递保证 / 口令闸 / env 减法」都是给没有收件地址的管子加投递保证。** |

### 依赖图

```
L0 (一行包)  ── 独立，一次 commit
L1 (skills route) ── 独立
L2 (run-bus 空输出闸) ──→ Q2 (notify 配置 UI)
                      ──→ [记下] SDK 发版（需先跑一段观察期）
Q0 (并发 resume 实验) ──→ 定 Q1 爆炸半径 + 坑 6 优先级
scripts/test-cli-jsonl.ts ──→ Q1 (抽 cli-jsonl.ts) ──→ ?? logicalParentUuid
BOE 部署完成 ──→ SDK 发版 / SSRF / per-user 立项
```

## riba 会怎么说

**「拿别人问题的账单来报销自己的问题。」** happyclaw 那 292k 不是 harness 成熟度标杆，是它自己选的商业模式（每用户独立 Docker、IM 唯一入口、按 userId 路由、计费）开出的账单。`channel-reliability-store.ts` 2491 行 + 六态状态机（专门拦自动重放的 `uncertain` 态）——这坨重量是「IM 消息没落地 = 这一轮 agent 输出在世界上不存在」这个问题本身要求的，不是「agent 系统该有的标配重量」。trellis 没有这个问题：一次 run 落进真会话 + 真节点、`error_message` 内联渲染、SSE toast、CLI 可 resume，**四个出口早就在**，`notify.json` 从设计意图上就是逃生舱（`notify.ts:53-56` 白纸黑字：「本机已经有 phone-push、飞书 CLI 等一堆现成出口，与其在 trellis 里再实现一遍认证和重试，不如让用户把已经能用的命令填进来」）。

**harness 不该继续加厚。** 四条建议没有一条在重复造 Claude Code 已经给的东西——trellis 早就做对了最贵的那个选择：不造 ReAct/RAG，直接 spawn 本机 CLI。四条争的都是 Claude Code 从不管的 product-layer harness（树的所有权判定一致性、通知投递语义、skill 发现层、错误分类）。所以"复用 vs 自建"这把尺在这四条里用不上，真正区分它们的是另一把：**造对了自己的处境，还是抄错了别人的形状。**

**「补齐」是这道题里最该拆穿的框架。** 它把四条粗暴归成一类，但盈亏比完全不同。②③不是补齐，是**护城河体检**——12.8% 的 turn 算错 tail、3.3% 静默降级去污染不是自己祖先的 lineage，这是护城河在悄悄腐烂；能不能在 UI 里把自己的 trellis-admin 挂给 agent，是最基本的自举能力，连 CLI 的 init 事件都看得见，唯独 trellis 的 web 发现层瞎。①才是风险信号，但风险不在"补齐 happyclaw 的能力"，在**误诊后开错药**：把 happyclaw 为"IM 是产物本身、按 userId 路由"攒出来的六态可靠投递协议，套进"单收件人、逃生舱、其余四个出口早就在报错"的 trellis。**如果真采纳了①，那才是"磨成又一个平庸 agent 平台"这句话会应验的地方**——不是因为它抄了 happyclaw 的能力，是因为它抄错了那能力背后对应的问题。

**只能选一件事，选②。** 下行有限——一次性抽共享模块、删重复代码，零 schema 变更、零新故障面，甚至是净减法（四份实现并一份）。上行巨大——一旦"树是错的"被用户撞见一次，两个差异化会**一起**破产，这不是缺个功能，是产品存在的理由被证伪。对比③：也便宜，但③的坏结果是**可见的死锁**（前端"已选 1"没 chip），用户当场能看见、能反馈；②的坏结果是**静默、复利式**的。可见的坏结果 vs 静默复利的坏结果，后者永远该排更前面。③几乎零成本，本月有余力顺手带上；①不参与排序，它是该拒绝的方向，不是"优先级较低"。

**「①里『DB 在撒谎』是场误报，②里『树可能在撒谎』才是真警报——这个月该堵的是后者。」**

**反面教材正好在②的证伪材料里**：happyclaw 那对互相点名的注释，三个指针全指错、宣称的"byte-for-byte"不变量四条全假、没有任何测试同时 import 两边断言相等。292k LOC 里也有扛不住量化检验的部分，这本身就是"抄它的厚度"最好的劝退理由。

**追问（基于量化而非本能）**：合并 cli-jsonl 这条，你打算只对着这次抓到的 154 个 jsonl / 1045 个 turn 修完收工，还是把这个不一致率写成一条**挂在 CI 里、两份实现对跑同一批 fixture 断言 tail 相同**的回归测试？happyclaw 的 conversation-history / session-history 那对注释也曾信誓旦旦"byte-for-byte"，没有测试兜底，半年后三个指针全指错。**这次打算给它留一条注释，还是留一个测试？**

**外推（OS 隔离 > 应用层权限）**：部署给同事这件事，跟"要不要抄 happyclaw 的多用户架构"分开算。现在 0 个 userId、一个共享密码 cookie，这是"几个互相信任的同事在内网用同一个实例够不够撑住"的问题，不是"该不该建 per-user Docker + RBAC + 计费"的问题——后者是 happyclaw 为公开、互不信任、按量计费的用户解的，量级不匹配。**真出问题大概率是"workspace 之间会不会串"这种更小的隔离问题。别因为"要给多人用了"就条件反射去抄 happyclaw 那一层。**

**「trellis 不需要长成第二个 happyclaw，只需要在自己的交汇点上不撒谎。」**

## 不该动的地方

1. **CLI 双向同步是结构性护城河，happyclaw 没有对应物。** 它的 transcript 活在自己的 `db.ts`（14385 行）+ 容器卷里，`container/agent-runner/src/index.ts:2618 resume: sessionId` 只在容器内部闭环，用户没有任何路径用本机 CLI 接管同一段对话；它还得为此写 `conversation-history.ts` 把消息重新拼成 `<history_message>` 喂回去。trellis 直接以 `~/.claude/projects/**.jsonl` 为真相源（`repo.ts:530 claudeJsonlExists`、`cli-sync-watcher.ts`）。**任何"为了干净把 transcript 收进自己 DB"的重构都会杀掉这条。**

2. **「折叠历史 XOR 持久化」这条四态穷尽、零例外的铁律。** chat 折叠 → `sdk-adapter.ts:117 persistence:false`；chat B-fork → `:113 persistence:true` 且 `history===[]`；project → `:167 persistence:true` 且 `history===[]`；@提及 → `:89 persistence:false` + `delete base.resume`。磁盘上机械可验证：全机 1893 个顶层 session jsonl grep「以下是之前的对话历史」（`lib/llm/prompt.ts:12` 的标记）**命中 0**。别往权威源里灌合成历史——`cli-fork.ts:351-366 buildPrefixJsonlCore` 是逐行原样复制，一坨假历史会被**复制进每一条前缀分叉的后代 lineage，永久**。

3. **`resultEmitted` idiom 已是仓内成熟范式**（`fetch-via-claude.ts:86/137/219-246` + `fetch-via-codex.ts:92/161/189-212` + `references/route.ts:240-244`），比 happyclaw 的 `SdkFirstResponseWatchdog`（超时猜死）更直接——它读的是真 exitCode + stderr 尾部。L2 是把它接到第三条路上，不是引进新东西。

4. **`agentContentHash` 刻意只算技能名不算内容**（`agent-pack.ts:49-53`：pack 里是指向 `~/.claude/skills/<dir>` 的 symlink，「改了 skill 正文自动跟随，永远不需要重物化」）。别改成内容寻址——那会毁掉 symlink 免重建的性质，且 happyclaw 的 preview/runtime 双 hash 恰恰因为对**输入目录树**取指纹而必然不等，`classifyRunContextSnapshot` 在 `mode:'custom'` 下**恒返回 `stale_config`**、前端恒亮红徽章（已用它未修改的 `effective-skill-resolver.ts` 在沙箱复现：selected 完全一致，hash `9d4fe595…` vs `86abacb7…`）。

5. **`lib/tool-registry.ts:14` 的「Unknown tools are fine」开放宇宙立场**（`:194` 三层回退，`:183` 认 `mcp__*`）。`--tools` 的取值空间不归 trellis 管（CLI 升级会加、MCP 会动态注册、codex 叫 `shell`），把它焊成封闭白名单 + 400 保证会误伤。

6. **没有 shell / 没有 DMI 展开器。** happyclaw 为了在自家 SDK 路径上复刻 CLI 行为写了 `plugin-inline-bash.ts`(330) + `plugin-expander-core.ts`(686) + `plugin-expander-sentinel.ts`；trellis spawn 真 CLI，这三个文件对应的攻击面和维护面**都是零**。

7. **task-scheduler 的三条已记录决策**：不做进程租约（`:21-22`「索引已经保证正确性，租约只换来日志干净，代价是多一张表 + 心跳 + 过期判定 + 一类新故障」）、不做自动重试（`custom-agents-plan.md:286/342`）、catch-up 只补窗口内最近一次（`:30-32`「隔夜大停机不补……用户早上自己点 ▶ 更好。模块常量，不做配置项」）。happyclaw 的对照：可配置 `taskBackfillGraceMs` 上线 11 周后被 `105195d`（标题就叫 "simplify automation"）整个砍成进程启动布尔量，砍完还留下一坨死码和一组测死码的测试。

8. **`interrupted` 渲染成灰色而非红色**（`app/settings/tasks/page.tsx:577-578/594`，`custom-agents-plan.md:281`「否则一次例行部署就让整页变红」）。任何 sweep / 通知补发都必须排除它，否则每次 `make deploy` = 手机响 N 次。

9. **deploy 的 smoke 阶段**（`scripts/deploy.ts:399-417`）：`VACUUM INTO` 出真 prod 数据的一致性快照，用它起临时实例真跑新代码的 `migrate()`。注释原文「用**真数据的一致性快照**而不是空库 —— 这样顺带验证 migrate() 吃得下现网数据」。**happyclaw 全仓没有等价物**（`enforcePreMigrationBackup` 只复制文件，从不拿副本试跑迁移）。加"启动期 VACUUM 预备份"是降级复制到热路径。

10. **`-a` + ttyd 只绑 127.0.0.1 = 已登记并显式接受的风险**（`decisions/2026-07-27-project-workspace-layer.md:108-111`：「不新增攻击面。**但 S4（多租户）一旦启动，`-a` 必须去掉**」+ `archive.md:1592` 的 Goal 级前置闸）。别把它当"没人想过的盲区"，也别把这条触发条件降级。

11. **PACK_FORMAT 进 hash** 比 happyclaw 的外置 `@happyclaw-runtime-markers/` 省一整套目录协议。

## 已排除

| 建议 | 一句话理由 |
|---|---|
| [tasks] notify 回执 + `notified_at` 真送达才盖章 | 它引的实证（两条带 `notified_at` 的 OAuth 失败 run）走的是 `notify.ts:76` 的 deliberate no-op，修完①②③④后一模一样还在——提案误诊了自己的证据。 |
| [tasks] catch-up 搬进 tick 的 gap 检测 | 前提是"宿主是会合盖睡眠的 MacBook"；实测本机是 Mac mini M4 Pro、`pmset sleep 0`、`pmset -g log` 零次 Sleep、uptime 20 天，BOE 是 Linux systemd；且全库 `task_triggers` = 0 行，失败场景零实例。 |
| [tasks] boot reap 区分排队/中断 + attempt 自增 | 实测 attempt+1 会在第二次重启时 `UNIQUE constraint failed: task_runs.trigger_id, scheduled_for, attempt`，而这条 UPDATE 住在 `migrate()` 里、`getDB()` 无 try/catch → 打死的不是任务，是整个工作台。 |
| [agent-system] agent 停用/删除的 effective 解析 + 降级审计列 | happyclaw 的 `resolveEffectiveAgentProfile` 解的是"owner 还是不是活跃 admin"（三样配料 trellis 一样没有）；可交付核心 = 2 行 `failRun`，已收进 L0。 |
| [agent-system] agent 造 agent 的口令 + 二次确认闸 | 机制③建在不存在的 schema 上（`nodes` 表无 `role` 列，18 次 ALTER 从没加过）；真跑通的版本会**挡住真人、放行会写文件的 agent**（CLI 同步导入的节点从不进 RUNS）；正解是"无人值守直接不给这能力"+`createTrigger enabled=0`（已收进 L0）。 |
| [agent-system] `/api/agents/effective` + 写路 400 + 共用 hash | happyclaw 的 8 层 merge 是多租户产物，trellis 是零层 45 行；hash 语义相反（cache key ≠ 指纹）；封闭工具名集合与 `tool-registry.ts:14` 直接冲突。 |
| [memory] transcript 消失 → 折叠历史兜底 | 会打破第 2 条铁律，把中位 4053 字符（p90 12528）的合成历史写进 CLI 可读的 jsonl；根因（`cleanupPeriodDays` 没设）一个键就能无损消灭；实测危害率 462 个相邻 turn 间隔里 >30 天的只有 2 个（0.43%）。 |
| [memory] 复现 happyclaw 的 preservedSegment 机制 | 那段代码是 casing 错配的死代码（读 snake_case，盘上是 camelCase），从未执行过一次；正解是两行 `?? logicalParentUuid`（已收进 Q1）。 |
| [plugin-skill] 接住 init 的能力清单做 per-node 面板 | 实测继承档 init.skills 是与 agent 无关的 116 条机器常量、隔离档给 `trellis-<slug>:<dir>` 而 agent.skills 存裸名 → 建议的 `⊆` 闸在隔离档**每次健康运行都判 error**；答案在 `agent-pack.ts:128-131` 的 `existsSync` 里，200ms 前同进程就算出来了。 |
| [plugin-skill] `/api/skills` 加 `?cwd=` 工作区层 | 实测 23 个 project session / 12 个 workspace_path，`.claude/skills` 全部不存在（零触发）；同文件真缺口是 symlink（41 条缺口里它只补 1 条）。 |
| [execution-isolation] 终端 argv 服务端派生 + `--check-origin` | `-O` 实测会 100% 打死终端（bun WS 不发 Origin，ttyd 1.7.7 无 Origin 判拒）；cwd 派生已由 `app/api/terminals/route.ts:21-26` 做了；正解是 SameSite=strict + 拆 shell-command 槽位（已收进 L0 / 坑 2）。 |
| [execution-isolation] / [sdk-streaming] / [auth-multiuser] spawn 边界 env 减法（3 条同题） | 同 uid：`~/.trellis/shared/.env.local` 实测 0600 但属主就是 agent，`cat` 一句照拿；happyclaw 自己的 `WEB_SESSION_SECRET` 一次都没被 scrub；ttyd 那处实测无效（tmux pane 的 env 来自 tmux **server 启动那一刻**，本机跑着的 server 建于 07-28）。 |
| [execution-isolation] 停机排空双趟 + `orphan_runs` fail-closed | happyclaw 自己的停机是单趟无标记（`index.ts:19807` 五个 Phase）；`getActiveRuns()` 纯同步，`beginDrain(); getActiveRuns();` 之间插不进 startRun → 第二趟目标集恒空；确定性解是 `process.kill(-pgid)`（实测三层同一 pgid，SDK spawn 无 `detached`）。 |
| [sdk-streaming] run 归属栅栏（runId + 6 处 isCurrent） | `RUNS.set` 全库 1 处（`:318`）、`state.status` 赋非 streaming 值全库 1 处（`:634`）、6 个注入点全在 `:634` 之前 → 闸恒真，死代码；`:728-729` 已经用**对象同一性**判身份，比 runId 字符串更强。真 bug 是 retry 的 reset 排在门禁之前，2 行修完。 |
| [auth-multiuser] ttyd 加 `-O` + `-c` | 同上 `-O` 打死终端；`-c` 的凭证按建议存 `~/.trellis/ttyd/<port>.json`（实测 0644）等于交给它要防的人；`curl -u ... /token` 实测把 base64(user:pass) 原样吐回。 |
| [auth-multiuser] `/api/login` 退避 + timingSafeEqual | 实测口令是 16 位混合字母数字（PASS_LEN=16），40 bit 下 1000rps 要 35 年；`await sleep()` 在并发下不收敛还钉住 SSE 主进程；happyclaw 的对应实现是**远程无认证锁死 admin** 的开关（`clearLoginAttempts` 故意不清全局桶，480 req/天）。 |
| [delivery-notify] `notified_at` 投递游标 + sweep | sweep SQL 不排 `error_message='interrupted'` → 每次 `make deploy` 手机响 N 次；`!task` 分支因 `ON DELETE CASCADE` 物理不可达；`notify_attempt` 在被 SIGKILL 时两个分支都不跑 → cap 永久失效。 |
| [delivery-notify] fs/session_done 走 `slotOf` | `catchUp()` 只遍历 cron，fs/session_done 无 replay 路径→索引没有东西可去重；改完后同分钟第二个事件 `claimSlot` 返 null → **不写行不打日志**，正是 `tasks.ts:416-417` 点名要防的静默黑洞。 |
| [delivery-notify] `/api/tasks/events?since` 重放 | 机制自相矛盾：`lastSeenRef` 初值 `Date.now()` → 冷启动（"没开着页面"这个场景本身）一条都不补；且 live publish 不带 `endedAt`，游标永不推进 → 重复 toast 随重连线性增长；更轻的路是挂载时读一次 `/api/tasks`（`lastRun` 全字段都在，15 行）。 |
| [engineering] `migrate()` 角色闸 + VACUUM 预备份 | `lib/server/sqlite.ts:1` 的 `import "server-only"` 已是硬闸（实测 `bun` 直接抛）；点名的四类辅助进程全不走 `getDB()`；deploy 的 smoke + backup 两道已在正确位置且更强。 |
| [engineering] `scripts/check-docs.ts` 挂 `make build` | 实测不是 34 条是 **77 条**，其中 17 条是纯误报（`facts.md:12 tasks.ts:launch()` 这类符号锚点比行号更抗腐蚀，却被判错）；happyclaw 那版是 **7 文件白名单**不是全量扫，且它的绿是同一个 commit 里砍掉 778 行 CLAUDE.md 换来的；deploy 走 `bun --bun run build` 不经 Makefile。 |
| [engineering] `bun test` 锁 DDL + applyAgent 铁律 | `applyAgent` 那条是可证明的空断言（`out = {...base}` + `AgentSpawn` 根本没有那 8 个字段，真破规时新 fixture 不带新字段 → 全绿）；正解是把返回改成 `Partial<Pick<RunOptions, ...>>` 让越界成为**编译错误**，由已有的 `next build` 执行。happyclaw 的 `reproducible-build-contract.test.ts` 被同一作者在同一 commit（`a61cfab`）里把每条断言反向重写，文件名一字未改。 |

## 存疑

1. **claude `--resume` 一个正在被写 / 非 tip 的 sid，行为是什么？** 这一个未知同时挡住两件事：坑 6（同 lineage 并发 = 思维树核心用法）的严重性，和 Q1 的真实爆炸半径（`buildPrefixJsonlCore` 返回 null → `chat/route.ts:544/586` 把 `claudeSessionId = lin.lineageSid` → 到底是 append 污染源 lineage，还是另开 jsonl）。[memory] 建议把它断言成"污染"，引的是 `cli-fork.ts:302-303` 的**注释**而非实测。**Q0 就是这个实验**。

2. **12.8% / 3.3% 的分母是错的，正确分母没人算过。** 那两个数是在全部 154 个 jsonl × 1045 个 strict turn 上跑的，而 `buildPrefixJsonlCore` 只在 `app/api/chat/route.ts:535`（attached，`!isJsonlTip || hasOtherChild`）和 `:579`（native isolated，同条件）两处被调——**只有真分叉才走**，线性续聊压根不碰 `terminalAssistantLine`。正确分母是 `cli_lineages WHERE is_root=0` 的实际行数。另一个口径：trellis 实际管辖的只有 22 个 distinct `claude_session_id` / 盘上 12 个 jsonl。**Q1 该做，但别拿 12.8% 当决策依据。**

3. **`~/.claude/skills/` 的 `user-invocable: false` 假阳性。** `/api/skills` 的 `parseFrontmatter` 不读这个字段，实测 `session-broker` 在 picker 里有、在 CLI 的 `slash_commands` 里没有——点了填 `/session-broker `，发出去 CLI 不认、当字面文本喂给模型。假阳性比假阴性更伤（用户以为调起来了）。几行的修法，但没人核过还有几个这样的。

4. **`SkillPickerList.tsx:98` 的 `onPick(s.name)` 应该是 `s.dir`。** CLI 按目录名解析（`facts.md:15` 已实测，`agent-pack.ts:skillDirName` 也是这么存的）。本机当前 0 处 name≠dir，是潜伏 bug 不是活 bug——但它和 L1 同一个文件族，做 L1 时顺手核一下。

5. **C 说的「Makefile 无 typecheck/test/check-docs 是工程化维度唯一真该补的」与 E 的证伪直接冲突。** E 实测证明 check-docs 那半是负价值（77 条 / 17 条误报 / 与 progress-protocol「每条必带来源指针」正面冲突 / deploy 不经 Makefile），且 trellis 已有 `scripts/test-*.ts` 四个 harness（833 行，断言项数被当上线验收判据引用）+ deploy smoke 阶段的真数据 migrate 彩排。**C 在这一条上是材料里质量最低的判断**——但它剩下的部分（`typecheck` target 缺失、`test-*.ts` 从不自动跑、deploy 十阶段一个都不调）是真的，值得一条 `make check: tsc + 四个 test-*.ts` 的聚合 target，且**不要挂 build 前置**。

6. **A 的 L3（notify 配置 UI）与 B 的尺子不一致。** A 把它放在"立刻做"，理由是它是原提案察觉到但没点名的真缺口；但 A 自己也承认它"不解当下任何已发生的故障"。按 B 的两条判据（通用 Agent 会不会做 / 不做的下行是否复利扩大）它两条都不满足。本报告把它降到 Q2 并标注依赖 L0/L2——**如果本季度时间紧，这是第一个该砍的。**