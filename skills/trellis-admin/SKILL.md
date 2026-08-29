---
name: trellis-admin
description: 操作与配置 Trellis 平台。两个面：①平台操作——列会话、看某棵树/某个节点的运行情况（在跑/停着等回答/失败）、读它的回答正文、在某个节点下追问（分支）、在某会话里开平行新树、开全新会话（可带工作目录）、守着一个节点跑完、叫停、回答它停下来等的审批卡/提问卡；②后台配置——建/改自定义 Agent（人设、模型、工具白名单、绑本机技能、隔离度），建自动化任务并挂 cron / 文件变更 / git 推送 / 会话结束触发器，手动跑一次任务，查运行历史与失败原因。凡是用户说「看看 trellis 上那棵树/那个会话跑得怎么样」「在那棵树上接着问一句」「给 trellis 开棵新树/新会话」「替我盯着它跑完」「它停在审批上了帮我处理」「把那个 run 停了」「给 trellis 建个 agent」「加个定时任务」「每天早上自动跑 X」「这个跑完之后自动做 Y」「这个任务上次为什么失败」，都用这个 skill——即使没提到 trellis 三个字，只要意图是「读写这台机器上 Trellis 里的会话/树/节点」或「让某个 agent 定时地、被事件触发地替我干活」就触发；**「长任务跑完后接着做 X」的接续编排也归这里**（正解是触发器，不是让 agent 口头承诺）。触发词：trellis、trellisctl、那棵树、隔壁的树、开新树、树的运行情况、盯着跑完、停掉那个节点、建个 agent、配 agent、自定义 agent、自动化任务、定时任务、cron、每天自动、定时跑、跑完之后、完成后接着、任务失败、run 历史、看看任务。它同时是 Trellis 的平台内置技能：enhanced chat / project 会话里的 agent 默认就有，且被注入 TRELLIS_ENV/TRELLIS_SESSION_ID/TRELLIS_NODE_ID 而能自我感知——「我是哪个会话的哪个节点」（whoami）、「看我这个画布上别的树」（sessions get .）、「在我自己的会话里开棵平行树」（ask --session .）这类平台内自指操作也归它。边界：操作 Trellis 的会话/节点与 agents / tasks 配置，不改 Trellis 自身代码（那是普通仓库改动）；跨设备派活给别的机器是 harbor skill，不是这个。
---

# Trellis 平台操作与后台配置

界面上能点的东西——画布上的树和节点、管理台 `/settings/agents` `/settings/tasks`——这里用一句话就能做完。两个面：**平台操作面**读写会话/树/节点（trellisctl 之于 Trellis 画布，如 herdr 之于终端 pane），**后台配置面**管 agents / tasks / triggers。

所有操作都走 `scripts/trellisctl.ts`：

```bash
bun <skill目录>/scripts/trellisctl.ts health      # 先探这一下，确认连上的是哪个实例
```

裸 `trellisctl` 不带参数会打完整用法。下文只讲**语义和坑**——那些是光看用法看不出来的。

## 你可能就跑在 Trellis 里：先分清立场

这个 skill 有两种持有者，动作语义完全不同：

- **终端 / 外部 claude**：你在平台**外**替用户遥控 Trellis——老用法，全部命令照旧。
- **Trellis 会话里的 agent**：本技能是**平台内置技能**（随部署走，任何 enhanced chat / project 会话默认自带，管理台给 agent 配技能也能选到）。平台 spawn 你时注入了 caller context——如 herdr 之于 pane：

```bash
test "${TRELLIS_ENV:-}" = 1   # 过 = 你在 Trellis 会话里
bun <skill目录>/scripts/trellisctl.ts whoami   # 我是哪个会话的哪个节点、树位置
```

注入的变量：`TRELLIS_SESSION_ID`（你所在画布）、`TRELLIS_NODE_ID`（你当前这轮问答）、`TRELLIS_URL`（API 地址，trellisctl 自动认）。在平台内，**所有收 `<会话id>` / `<节点id>` 的地方都可以写 `.`** 指当前会话 / 当前节点：`sessions get .` 看自己所在的整个画布，`ask "..." --session .` 在自己画布上开平行树（给用户留下持久可见的工作线），`node read <隔壁树的id>` 读平行树的产出。

平台内的三条纪律（trellisctl 会硬拒，这里讲清为什么）：

- **不 `wait` / `abort` / `retry` 自己的节点**（`$TRELLIS_NODE_ID`）——你就是那个 run：等自己 = 死锁到超时，停自己 = 这轮当场被砍。
- **不 `ask --node` 自己**——想补充直接写进回答；同画布另起一线用 `--session .`。
- **不 `sessions rm` 自己所在的会话**——那会连你一起删。

## 平台操作面：会话 / 树 / 节点

概念对齐（拿错层级是这个面唯一的高频错误）：

- **会话（session）** = 一块画布 = UI 顶栏的一个 tab。有稳定 id、有标题（自动命名，手动改过就不再被覆盖）。纯对话，或绑一个工作目录（project 模式，能读写文件）。
- **树** = 会话画布里的一个根节点。一个会话可以有多棵平行树。**树没有独立 id——树就是它的根节点**，拿 nodeId 当树柄。
- **节点（node）** = 一轮问答。状态三值 `streaming / done / error`，外加一个更要紧的横切态：`pendingInteraction` 非空 = run 被交互式工具挂起、**停着等人回答**（输出里的 ⏸）。

读随便跑：`sessions`（列会话，▶ 标在跑）→ `sessions get <id>`（树形大纲）→ `node get <id>` / `node read <id>`；`ps` 直接回答「现在谁在跑、谁停着等回答」；`search <关键词>` 全文检索所有会话的问题/回答/引用/笔记（找「上次聊 X 的那棵树」用这个，别翻列表）；`workspaces` 列最近工作目录（开 project 会话前先看，别凭记忆拼路径）。id 一律从上一条命令的输出里拿，别凭记忆拼。

写操作 = `ask`，它**真 spawn 一次 LLM run**（花钱；project 模式还真改文件），发之前把问题和目标给用户看一眼。三个目标形态的区别在**上文**：

| 形态 | 语义 | 上文 |
|---|---|---|
| `ask "..." --node <id>` | 在那个节点下追问（树上长分支） | 继承该链路的全部上文 |
| `ask "..." --session <id>` | 同画布开一棵平行新树 | 全新，与旧树无关 |
| `ask "..." --new [--workspace <dir>]` | 全新会话 | 全新；带 workspace 进 project 模式 |

「在那棵树上接着问」= `--node` 给它的**叶子**节点（给中间节点就是分叉，那是刻意动作）。`--new --workspace` 默认 YOLO（工具全放行、真改文件）；加 `--approval` 让可变更工具逐个弹卡，卡会变成 ⏸，用 `respond` 回——闭环成立，这是交互式路径上唯一的闸。

**默认发完即走**：拿到 `node=<id>` 就返回，run 在服务端继续（run 与 HTTP 解耦，断开不杀 run）。`--wait` 才守到终态；**`--wait` 超时不是失败**，`wait <nodeId>` 随时接着守。

等与接管：

- `wait <nodeId>` —— 守到 done / error，或它变 ⏸（此时会打出卡内容和回法）。
- ⏸ 的回法：`respond <nodeId> --allow / --deny`。AskUserQuestion 加 `--answers '{"<问题原文>":"<选项label>"}'`；allow 不带参数时脚本把原 input 原样回传（SDK 要求 record，前端同款行为）；`--deny --message "..."` 给理由。toolUseId 脚本现场从节点上取，不用抄。
- `abort <nodeId>` —— 叫停。**只停自己发起的 run**：画布是用户的工作台，别的 run 可能是他在界面上亲手点的，停之前先问。
- `retry <nodeId>` —— 失败节点原地重跑（复用同一节点，不新建）。

与任务面的分工：`ask` 是「现在、替我问一句 / 干一件」，`tasks` 是「反复、无人值守」。一次性的事不建任务。组合技：`ask --new` 跑长活拿到 sessionId，再建任务挂 `session_done` 触发器 = 「那个会话跑完后自动做 X」。

## 三个概念

- **Agent** = 冻成一个 id 的「人设 + 能力面」：提示词、模型、工具白/黑名单、绑哪些本机技能、隔离还是继承本机环境。会话可以选它，任务可以引用它。
- **Task** = 「agent + prompt + 工作目录」冻成一个按钮。任务的每次执行落在一个真实会话的平行根节点上，所以在界面上点进去看到的东西和你自己提问一模一样，还能就地分叉追问。
- **Trigger** = 触发器，一个任务可以挂多个（一对多，独立成表）。**没有触发器的任务永远不会自己跑**——这一点是下面那条纪律的基础。

## 纪律：先手动跑，确认了再挂触发器

顺序永远是 **建任务 → `tasks run` 手动跑一次 → 看 `runs` 的结果 → 满意了才 `triggers add`**。

理由不是谨慎，是**任务跑起来的时候没有人在场**：无人值守路径没有审批通道，工具调用一律放行（等价于 `--dangerously-skip-permissions`），它会真改文件、真发请求、真花钱。prompt 写歪一点，交互式会话里你当场就能 Esc，定时任务里你是第二天早上才知道。手动跑那一次的成本是几十秒，省下的是一整夜。

同理，**写操作之前先把要建的东西用人话摘要给用户看一眼**再执行——不是走流程，是因为「每个工作日 09:00 在 ~/foo 跑一个会改文件的 agent」这句话，用户扫一眼就能发现目录写错了，而 JSON payload 他不会逐字读。

## 建 Agent

```bash
bun .../trellisctl.ts agents create '{"slug":"pr-reviewer","name":"PR 审查","systemPrompt":"...","tools":["Read","Grep","Glob"],"inheritEnv":true}'
```

| 字段 | 语义与坑 |
|---|---|
| `slug` | `^[a-z0-9][a-z0-9-]{0,31}$`。它同时是 CLI 的 `--agent` 值、物化 pack 里的文件名、未来 @提及的名字，所以校验很严。 |
| `systemPrompt` | 人设正文。选了 agent 的会话，会话级 systemPrompt 会被删掉——**agent 赢，两者不叠加**。 |
| `model` | CLI 模型名，`null` = 跟随会话。**注意别和任务的 `providerId` 搞混**，那是两个东西。 |
| `tools` | `null` = 不限制；`[]` = 一个工具都不给；给了数组就是白名单。名字要和 CLI 的工具名字面一致（`Read`/`Write`/`Edit`/`Bash`/`Grep`/`Glob`/`WebFetch`/`Skill`…），**拼错不会报错，只会静默少一个工具**。 |
| `skills` | `[{"kind":"host","name":"<目录名>"}]`。目录逐根解析：本机 `~/.claude/skills/<name>` 优先，找不到再取 trellis 自带 `skills/<name>`（内置技能随部署走，`trellis-admin` 属于后者，不需要任何手工 symlink）。名字取**目录名**不是 frontmatter 里的 `name`。用 `trellisctl skills [关键词]` 查。注意：enhanced chat / project 会话**本就默认带全部内置技能**（平台 pack，`TRELLIS_BUILTIN_SKILLS=off` 可整体关掉）——给 agent 配 `skills` 是在此之上加选**个人**技能，不需要也不必把 `trellis-admin` 写进去。 |
| `inheritEnv` | **新建的 agent 默认是 `false` = 隔离**，而隔离是三件套：没有 CLAUDE.md、没有本机 skill、**也没有 MCP**。想让它像平时的 claude 一样什么都看得见，显式写 `"inheritEnv":true`。 |
| `permission` | `full` / `default` / `readonly` / `auto-edit`，`null` = 跟随会话。**这是无人值守场景下唯一真正起作用的闸**（见下面的失败模式）。 |
| `requireApproval` | 三态（`true`/`false`/`null`）。只在交互式会话里有意义。 |

内置的那几个 agent 改得动但删不掉（下次启动会被 seed 种回来），要让它消失用 `{"enabled":false}`。

自定义 agent **只对 claude 系 provider 生效**；会话切到 codex 之后它静默失效。

## 建 Task

```bash
bun .../trellisctl.ts tasks create - <<'JSON'
{"name":"每日仓库巡检","prompt":"看一下昨天到今天的 git log，用三句话总结改了什么，有风险的地方单独指出来",
 "workspacePath":"/Users/x/proj","contextMode":"project","notifyOn":"always"}
JSON
```

prompt 里几乎一定会有引号和换行，**用 `- ` 从 stdin 读**（或 `@文件`），别去和 shell 转义搏斗。

| 字段 | 语义与坑 |
|---|---|
| `name` `prompt` | 必填。 |
| `agentSlug` | 用哪个 agent 跑，省略 = 默认人设。写 slug 就行（脚本会换成 id），别去复制 uuid。 |
| `contextMode` | `project`（默认）跑在真实工作目录里、能改文件；`chat` 是不带目录的纯对话。**省略它等于选了 project**，所以 project 就必须给 `workspacePath`——脚本会替你挡住这个。 |
| `workspacePath` | 必须是**当下真实存在**的目录。spawn 前会硬挡（目录被删/worktree 被回收是常事）。 |
| `providerId` | provider 的 id（`trellisctl providers` 查），不是模型名。省略 = 默认。 |
| `timeoutMs` | 默认 30 分钟，到点 abort。 |
| `overlapPolicy` | `skip`（默认，上一次还在跑就跳过并留一条 skipped 记录）/ `queue`。 |
| `notifyOn` | `error`（默认）/ `always` / `never`。默认只在失败时通知是刻意的——成功是常态，每次都推，一周内你就会把通知关掉。 |
| `maxBudgetUsd` | 成本闸。时间闸永远在，这是第二道——一个陷进循环的 agent 能在 30 分钟里烧掉很多钱。 |
| `enabled` | **停用的任务连手动跑都会被拒**，别拿它当"先建好放着"的开关（那个开关是"先不挂触发器"）。 |

## 挂触发器

```bash
bun .../trellisctl.ts triggers add <taskId> '{"kind":"cron","config":{"expr":"0 9 * * 1-5"}}'
```

这一步之后任务才会自己跑。脚本会先回显人话描述和未来的触发时间，并拒绝触发间隔小于 5 分钟的表达式（要临时调试可以 `--force`）。

**cron**：五字段 `分 时 日 月 周`，支持 `*` `*/n` `a,b,c` `a-b`。**不支持**秒级、`L`、`W`、`#`、英文月份/星期缩写。时区一律服务器本地。

| 表达式 | 含义 |
|---|---|
| `0 9 * * *` | 每天 09:00 |
| `0 9 * * 1-5` | 每个工作日 09:00 |
| `30 8 * * 1` | 每周一 08:30 |
| `0 */2 * * *` | 每两小时 |
| `0 0 1 * *` | 每月 1 号 00:00 |

拿不准就先 `trellisctl cron "0 9 * * 1-5"`，它会回人话和未来三次触发时间。裸 cron 串的问题从来不是难写，是**写错了不知道**。

**其它触发器**：

- `{"kind":"fs","config":{"dir":"/path","ext":".md","debounceMs":2000}}` — 只 watch 单层目录（递归 watch 在大目录上很贵）。
- `{"kind":"git","config":{"repoPath":"/path","branch":"main","pollMs":60000}}` — 轮询 `git ls-remote`，远端有新 commit 就触发。想监听本地提交请改用 fs 触发器盯 `<repo>/.git/refs/heads`。
- `{"kind":"session_done","config":{"sessionId":"..."}}` — 某个会话跑完就触发。不能填这个任务自己的会话（那是无限烧钱的闭环，服务端会拒）。
- `lark` 这个 kind 建得出来但**全仓没有消费者**，建了就是永不触发的死配置。别建。

## 长任务与「完成后接续」：承诺必须物化成触发器

会话里的你是单 turn 进程——turn 结束进程就退出，`run_in_background` 的后台任务会被一起杀掉（实测：`claude -p` 退出即清理），裸 `nohup ... &` 的孤儿进程能活、但没有任何东西看着它。所以**「X 跑完之后我会触发 Y」这句话没有任何机制兜底**——说这话的进程在用户读到它时已经不在了。接续需求只有两条真路：

- **首选：收进同一个 run。** 依赖步骤直接写进任务 prompt 第一步（「先分批 rsync 同步 X，失败不阻塞、在报告里注明；然后…」）。无人值守 run 工具全放行，长命令唯一的约束是 Bash 单命令 10 分钟上限——在 prompt 里写明**按目录/批次拆开跑**，别教它放后台。
- **真要异步：标志文件 + fs 触发器。** 启动侧 `nohup bash -c '<长命令>; touch /path/flags/done' &`（孤儿进程活得过 CLI 退出），下游任务挂 `{"kind":"fs","config":{"dir":"/path/flags"}}`。这是触发器体系内唯一真正成立的「完成后触发」。

三条防呆，每条对应一种已发生的事故：

- **prompt 里一个调度词都不许有。** 任务 prompt 是每次触发时逐字重放的动作指令，「每天早上」「同步完成后」这类语义全部落在 trigger 上；把调度词写进 prompt，第一次触发时 agent 会试图再调度一遍而不是干活。
- **报给用户的 id 必须来自命令回显。** `tasks create` / `triggers add` 的输出才是事实；创建类命令超时或失败时先 `tasks list` 核实有没有建成，**不要直接重试**（可能重复建），更不要凭感觉报「已建好 ✅」——建没建成以库里查得到为准。
- **没有 once 触发器。** kind 只有 cron / fs / git / session_done；「就这一次，X 点跑一下」用手动 `tasks run`、或「cron + 跑完 `triggers rm`」顶上，别造不存在的 kind。

## Known Failure Modes

- **`ask --wait` 超时 / 中途断开后以为消息丢了，又重发一遍**：run 与 HTTP 解耦，断开只是不看了，run 还在服务端跑、结果照落库。重发 = 同一个问题跑两遍、花两遍钱。规避：超时后 `node get <nodeId>` 看状态，`wait <nodeId>` 接着守——`created` 回显里的 nodeId 就是为这一刻打出来的。

- **`node get` / `node read` 对着确实存在的节点报 404 not_found**：`GET /api/nodes/[id]` 是 S118 才加的服务端 route，打到旧版本实例上就是 404。判据：`sessions get <sessionId>` 里明明看得到这个节点。修法：部署包含该 route 的版本；其余命令不受影响（走的都是老 API）。

- **`respond` 报 409**：`no_pending` = 卡已被别处（多半是用户在界面上）回掉了；`mismatch` 理论上不会出现——脚本每次现场从节点取 toolUseId，真遇到就是取和回之间卡换代了，`node get` 重看再回。

- **给 agent 勾了「需要审批」，但定时任务里它跑得毫无阻拦**：根因是审批闸要靠交互通道（`onCanUseTool`），而任务是无人值守的（`interactive:false`），那个条件永远不成立，于是整条降档逻辑被静默跳过，实际落到 `permission:"full"`。规避：**无人值守的限制只能靠 `permission:"readonly"` 或 `tools` 白名单**，别把 `requireApproval` 当保险；见 `lib/llm/sdk-adapter.ts:73` 与 `lib/server/tasks.ts:526`。

- **某个任务从某天起就再也不跑了，界面上一点异常都没有**：根因是 `overlapPolicy:"skip"` 撞上一条永远停在 `running` 的僵尸 run（进程被 SIGKILL、目录被删等），此后每次触发都被判成「上一次还没结束」。判据：`trellisctl runs <taskId>` 看有没有一条 `running` 挂了很久，或一串 `skipped`。修法：中止它 `runs abort <runId>`。

- **给 agent 配了技能，它却说没有 / 绕路自己硬写**：claude 的技能是靠 `Skill` 工具调起来的，工具白名单里没有 `Skill` 就等于技能静默失效。现在物化层会在有技能时自动补 `Skill`，但如果你在白名单里看到技能配了却调不动，先确认这一条。

- **隔离 agent 用不了 MCP**：`inheritEnv:false` 会连本机 MCP 一起砍掉，这是产品事实不是 bug——隔离 = 无 CLAUDE.md + 无本机 skill + 无 MCP 三件套。要 MCP 就 `inheritEnv:true`。

- **agent 配了但完全没生效，回答却一切正常**：先看会话/任务的 provider 是不是 codex 系——自定义 agent 只在 claude 系生效，切过去是静默失效。

- **`trellisctl health` 探不到，但浏览器能打开 Trellis**：环境里有 `http_proxy` 时 bun 的 fetch 可能被劫走。先 `unset http_proxy https_proxy` 再试，或显式 `TRELLIS_URL=http://127.0.0.1:<port>`。

- **平台内子进程的 trellisctl 打到了另一个实例 / 探不到**：裸 `next dev` 起的 dev 实例没有大门（server.ts），`TRELLIS_URL` 不注入，子进程的端口发现链会去探 3088——本机若同时跑着 prod 实例就会**错连**（判据：`whoami` 报的 session 拿去 `sessions get` 是 404）。修法：要完整的平台内闭环就经 server.ts 起（prod 部署本来就是），或临时显式 `TRELLIS_URL`。

- **会话里配了/应有内置技能，agent 却说没有**：纯对话（非增强）没有 Skill 工具，平台 pack 刻意不挂——切「增强」或用 project 会话；再查 `TRELLIS_BUILTIN_SKILLS` 是否被设成 `off`（部署冒烟闸，开着 = 内置技能整体摘除）。

- **在 A 机器上建的任务，B 机器上看不到**：两台实例不共享数据库，这是刻意的——`workspacePath` 本来就是机器本地路径，任务天然属于它该跑的那台机器。
