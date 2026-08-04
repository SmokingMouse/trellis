# Session Log

最近 5 条，倒序（Session 94 / 93 / 92 / 91 / 90）。更早的见 `archive.md`。

### Session 94（2026-08-04，卡片图改 happyclaw 式预览弹窗：复制 / 下载由用户选）
- **触发**: 用户反馈卡片图「必须把图片下载下来」，要像 happyclaw 那样点开后自选「下载」或「进剪贴板」。
- **根因**: 旧 `CardImageButton` 是自动写剪贴板、失败**静默降级**成下载 —— html-to-image 的异步渲染耗尽浏览器的用户手势时效，剪贴板写入总被拒，于是永远只会下载，且用户不知道为什么。
- **Done**: `components/CardImageButton.tsx` 重写成 happyclaw `ShareImageDialog` 的形态：点击 → 渲染 PNG → 预览弹窗 + 底部「复制图片 / 下载图片」双按钮，复制发生在按钮点击瞬间（blob 已备好，手势新鲜），失败就地在按钮上提示改用下载。弹窗复用 `ui/Modal`，但经 `createPortal` 挂到 body —— TurnCard 在 React Flow 的 transform 节点内，直接渲染 fixed 弹窗会锚到节点而非视口。渲染链路（离屏卡片 + html-to-image）未动。
- **流程教训（又一次）**: 在 main-2 worktree 里干活，一开始直接写了共享的 `sessions.md`/`archive.md`，收尾才发现主 worktree 有并行 session（S93 launchd 破案）动了同两个文件且撞了编号 —— `parallel-worktree.md` 的铁律（并行期只写 `blocks/<slug>.md`）第二次被违反（第一次是 S88）。按串行收尾处理：main-2 退回共享文件只提交源码 → 先提交对方 S93 记录 → `--no-ff` merge → 本条按 S94 叠上。
- **验证**: main-2 里 `bun install` 后 tsc 零错、eslint 对该文件零告警。**真浏览器未点过。**
- **Next**: 浏览器里点一轮（复制进剪贴板 / 下载 / Esc 与 scrim 关闭 / 暗色模式下预览底色）；跟 S93 的验收队列一起走（S91 三处 + 管理台批 1-6、BOE 部署）。

### Session 93（2026-08-04，S90 认证失败破案：launchd 上下文的 claude 读的是 keychain 里过期的凭证副本）
- **触发**: 用户截图 prod 聊天发 "hello" 报 `Failed to authenticate: OAuth session expired and could not be refreshed` —— 正好回答 S90 留的判定题：**普通聊天同样死 → 实例级故障，与任务链路无关**。
- **破案路径**: 错误串 `rg` 下来只存在于 claude.exe 二进制里（SDK / trellis 代码零嫌疑）→ 全机唯一 claude = nvm 的 2.1.207（7-13 装的，与故障时点无关），plist PATH 解析到同一个 → **一次性 launchd job（不经 trellis 任何代码）裸跑 `claude -p` 完整复现**：80ms 失败、`duration_api_ms: 0`（本地判死，网络请求都没发）；`env -i` 逐字同 env 在终端跑 → 成功（真调 API 4s 返回 "ok"）。唯一剩余变量 = launchd vs 终端的 macOS 安全上下文。
- **根因（launchd 探针钉死）**: Claude 凭证存了两份且已分叉 —— `~/.claude/.credentials.json` 由终端 claude 持续刷新（当天 16:16 mtime，refresh token 有效到 8-20）；Keychain `Claude Code-credentials` 项 **7-26 起停更**（mdat），内容是旧格式短 JSON（281B vs 文件 509B），`refreshTokenExpiresAt = 7-26 02:48`。launchd 上下文里 keychain 与文件**都可读**（探针实测），claude 在该上下文选了 keychain → 读到死 token → 时间戳一比对直接报错。与「nodes 表 7-28 10:52 后再无 done」吻合。
- **S90 五条排除为何全扑空**: 全部在终端做 —— `env -i` 能复制 env，复制不了「不是 launchd」这件事，而判别维度恰恰是上下文本身。
- **修复（用户点头后执行）**: `security delete-generic-password -s "Claude Code-credentials"` 删掉已死副本 → 所有上下文回退到新鲜的文件。不选「文件→keychain 同步」：refresh token 单次轮换，两份活副本必再分家、复发。
- **验证**: ① 同一 launchd 复现 job 转绿（修前 80ms 本地判死，修后真调 API 3.2s 返 "ok"）② 真 prod 进程端到端：trellisctl 建 chat 模式任务实跑 → run `45350b21` **done / 3s / 6 token**。顺带摸清 trellisctl 语法：`tasks run` 要完整 UUID（列表只显示 8 位短 id）、`tasks create` 收 JSON 体、无 workspace 必须 `"contextMode":"chat"`。③ /tmp 探针已清。**测试任务 `2c66ce0d`（authfix-verify）留在库里** —— trellisctl 没有 `tasks delete` 子命令，管理台 `/settings/tasks` 可删；S90 的 `bffbe8ed` 也还在。
- **落档**: `failures.md` 结案（resolved）· workspace.md 凭证表 + 复发坑表各加一行 · auto-memory 记「launchd-claude 凭证分叉」。复发哨兵：keychain 条目重新出现且 mdat 冻结。
- **Next**: prod 已复活；回到验收队列 —— S91 三处改动 + 管理台批 1-6 验收、BOE 部署（S88 遗留）。

### Session 92（2026-08-04，SDK 升 0.5.0：codex 走 endpoints.yaml 选模型 + 树形分支真 fork）
- **Done**：`@smokingmouse/agent` ^0.4.0→^0.5.0、直接依赖 `@smokingmouse/llm` ^0.3.0→^0.4.0（扁平化消双份）；`npx tsc --noEmit` 干净；运行时验证 CodexBackend capabilities `forkSession: true` + `configDrivenModelSwitch: true`。
- **SDK 本轮新能力（sm-toolkit 同日发版，细节见其 progress/sessions.md）**：① codex model 可解析 endpoints.yaml 里显式标记 `codex: { wire_api: responses }` 的端点（目前 cpa），`-c model_providers` per-run 注入 + env_key 鉴权；② codex forkSession 由 rollout copy 模拟——此前 codex 分支节点 resume 同一 thread 会互相污染，现真 fork（新 id + 历史继承 + 双向隔离），失败 fail loud 不静默降级。
- **对 trellis 的影响**：代码零改动即受益（run() 传的 forkSession 在 codex 下开始生效）；UI 可按 `capabilities().forkSession` 探测。codex 逐 token 流 / 双向审批（PendingInteraction）仍无——app-server 路线已评估暂缓，决策留档 sm-toolkit progress/decisions.md。
- **Next**：prod 部署时带上 bun.lock；无代码改动待验收。

### Session 91（2026-08-01，拿 happyclaw 做对照剖析 → 修掉它替我们踩过的三个坑）
- **触发**: 用户「使用 workflow 深入剖析下 riba 的 happyclaw，看看对我们的 trellis 后续的演进和优化有啥指导意义吗」，看完结论后「按照你的建议把那些都改了吧」。
- **对照组**: riba2534/happyclaw（自托管**多用户** Agent 系统，IM 六端 + 每用户 Docker + RBAC + 计费）。本机 fork 落后上游 271 个 commit，另开 worktree `/tmp/happyclaw-latest` 指到 `upstream/main`（`6ab7dad`，当天）。**三个月从 111k LOC 长到 292k**，且 `task-scheduler.ts` / `agent-builder.ts` / `memory-service.ts` / `plugin-*.ts` 与 trellis 三个 Goal 正面撞车 —— 它是我们 Goal 的未来态样本。
- **Workflow**（106 agent / 11.4M token / 91 分钟 / 零失败）: trellis 三路摸底（含「已被拒绝方案清单」防止推荐已否掉的东西）→ happyclaw 九维深读（每维强制跑 git log 挖 fix commit）→ 逐维对照 → **每条建议派 3 个镜头对抗式证伪**（已经有了/已拒过 · 定位错配会带歪 · happyclaw 这么做本身就不对，2/3 票反对即毙）→ 排序 + persona-riba2534 判断 + 完备性批判。报告落 `happyclaw-contrast.md`（43KB）。
- **最反常识的结论：27 条候选建议只活下来 4 条，且没有一条是「抄 happyclaw 的机制」**。真正可复用的是它的**尸检报告** —— 同一个 symlink 盲区三个月咬三次、「必须 byte-for-byte 一致」的注释半衰期 6 周且三个指针全指错、至少 7 处「造了闸忘接门」的死代码。riba 分身那句是对的：「拿别人问题的账单来报销自己的问题」—— 它的 292k 是**多用户 IM 商业模式**开的账单，不是 harness 成熟度标杆。**harness 不该继续加厚。**
- **Done ①（`app/api/skills/route.ts:37`）**: `Dirent.isDirectory()` 对 symlink 恒 false，只认它会把软链形式的 skill 整个漏掉。本机 `~/.claude/skills/` 106 个条目里**恰好一个 symlink，就是 `trellis-admin`** —— **trellis 自己的管家 skill 在 trellis 的 UI 里隐形**（而 CLI 的 slash_commands、`trellisctl skills` 都看得见，因为它们用 `existsSync` 穿透）。改成允许 symlink + `fs.stat` 穿透确认 + 悬空链跳过。**明确不动** `workspaces/browse` 与 `sessions/[id]/files` 那两处 —— 它们跳 symlink 带着 "cycles / intentionally not listed" 注释，是有意决策。
- **Done ②（`app/api/login/route.ts:34`）**: `sameSite: "lax"` → `"strict"`。lax 放行跨站顶层导航 → 任意外部页面能把浏览器导到 `/term/?arg=…`，而 ttyd 以 `-W`（可写）起、命令整个走 URL 的 `?arg=`（`ttyd.ts:236-240/295`）。happyclaw 的 `auth.ts:86` 就是 Strict，且 `web.ts:1390-1394` 白纸黑字写「**SameSite=Strict 是主防御**，origin 检查是纵深防御」—— 它为 WS Origin 白名单返工 4 次护的全是纵深那半条。UX 代价为零：入口是书签/PWA/直接输地址（strict 对这三种照发），`notify.ts` 不发回链；程序化调用（`server.ts:204`、`deploy.ts`、trellisctl）自己塞 header 不受约束。
- **Done ③（新增 `lib/server/cli-jsonl.ts`，本轮的重头）**: `cli-fork.ts` 抄了 `cli-import.ts` 五份副本（`ms`/`userText`/`isToolResultEntry`/`isCommandNoise`/`isTurnStart`），**S85 给 import 加的 5 道结构闸 fork 一道没跟**，而且 `cli-fork.ts:6` 早就 `import { parseCliSessionJsonl } from "./cli-import"` —— 同一个 module graph，**根本不存在任何拦着复用的约束**，纯粹是抄完原件单方面演进。
  - **实测严重性**（889 个 jsonl / 1897 个有回答的 turn）：老判据下 **36 个 turn（1.90%）fork 侧找不到 tail** → `buildPrefixJsonlCore` 返 null、分叉静默降级成线性；**另有 315 个（16.61%）选出的 tail 与 import 的归属不是同一条** → 前缀被截在一个**没说完的回答**中间。后者才是真严重性 —— 不是分叉失败，是**分叉点切错**。（报告里那个 12.8% 分母是错的，这两个数是重新量的。）
  - 抽出纯模块（无 `server-only`、无 DB，可脱离服务端跑）：类型 + 五个谓词 + `makeTurnOwnership`（**strict → loose 两级**，只搬严格那级会让 null 率不降反升，因为 `--continue`/fork 出来的 jsonl 链头没有真提问）+ `readJsonlLines` / `terminalAssistantLine` / `keepUuidChain`。两边 import 同一份，**执行者是编译器不是注释**。
- **`scripts/test-cli-jsonl.ts`（新）—— 这是 riba 那个追问的答案**：他问「这次打算给它留一条注释，还是留一个测试？happyclaw 那对互相点名的『byte-for-byte』注释半年后三个指针全指错」。24 条断言：7 道闸逐条钉死 + 复现 S85 的劫持 bug + 宽松兜底 + **真语料全扫**（889 jsonl / 1898 turn，无抽样）。
- **做了变异测试证明它不是空断言**：把 5 道闸退回旧判据 → **11 条断言变红**。同时暴露一个诚实的边界：**真语料那两条断言在变异下依然是绿的**（turn 数还从 1898 涨到 2044）—— 因为两侧共用一份代码，一起错就一起「自洽」。**钉住闸本身的是合成断言，语料扫描只能防两边再次分家。**
- **等价性验证**: 从 git 取出重构前的 `cli-import.ts`，对同一批 889 个文件逐字节比对 `parseCliSessionJsonl` 输出 —— **866 个完全一致 / 23 个两侧都 null / 0 处差异**。cli-import 的重构证明行为不变。
- **其余验证**: tsc 零错 · lint 47 problems 全是既有的，我改的文件**零命中** · 既有 harness 全绿（cron 48 项 / project-cluster / tool-tree）· `/api/skills` 直接调真 handler：105 skills 且 `trellis-admin` 在内（旧逻辑 104）· login 直接调真 handler：`SameSite=strict` 正确序列化、错误口令仍 401 · `buildPrefixJsonlCore` 在临时目录拿一个**老逻辑返 null 的真会话**端到端跑通（1051 行 → 1007 行前缀，可反解成 6 个 turn，sessionId 已改写）。
- **刻意没做**（报告里有但不在本轮范围）: 「新增 DB 列必须带真消费者」那条纪律没写进 `decisions.md`（trellis 已有 3 处空列：`notified_at` 零 SELECT、`task_runs.attempt`、`max_retries`）· claude/codex 的二进制解析（plist 里 `PATH` 硬编码了 `node/v24.14.1/bin`，nvm 一升级 `claude` 就从 PATH 消失，而 `update.ts:209` 和 `ttyd-dependency.ts:43` 两条路早就写对了）· run-bus 空输出闸 · BOE 的 per-user 身份/归属/审计（**27 条候选零覆盖，需单独立项**）。
- **已合并推送**：四个 commit 走 `happyclaw-contrast-fixes` 分支 `--no-ff` 进 main（`f81df21`），已推 `18be950..f81df21`。**两台实例都未部署。**
- **Next**: 部署后第一件事是 ②的**真浏览器登录回归** —— strict 生效后书签 / PWA / 直接输地址应当无感，但这条只验过 Set-Cookie 头的序列化，没在真浏览器点过；万一栽了，回退就是把那一个单词改回 `lax`。prod 仍卡在「spawn 的 claude 一律认证失败」（S90 遗留，本轮未碰）。`/tmp/happyclaw-latest` worktree 留着，不用了跑 `git -C ~/python/ai/happyclaw worktree remove /tmp/happyclaw-latest`。

### Session 90（2026-07-31，trellis-admin skill：让任意 claude 会话用一句话配后台）
- **触发**: 用户「现在有了 Agent 配置的能力，能在平台预留一个 Agent，能通过这个 Agent 完成后台的一些 Agent 配置 or 定时任务配置吗」。
- **我的第一版方案被用户一句话推翻，且推翻得对**: 我提「内置一个受限 admin agent（工具白名单 `["Bash","Skill"]`）」，用户问「不能做一个内置的 skill 吗，这样不用限制 agent」。**工具白名单在这里从来不是边界** —— admin agent 要调 CLI 就必须有 `Bash`，给了 Bash 就能 curl 任意端点、改任意文件，白名单只是看起来像闸。
- **更关键的一条**: 这个能力**今天就已经存在**。默认 agent 不隔离，spawn 出的子进程继承 trellis 进程 env（`shared/.env.local` 经 bun 从 cwd 自动加载），任何能用 Bash 的会话早就能 curl `/api/agents`。做 skill **不是授予权限，是把已有权限变得可发现、有契约**。威胁模型因此从「越权」变成「手滑」—— 而对手滑，SKILL.md 里「先预览再写入」的纪律是**真管用的控制**（上一轮我说的「提示词不是闸」只对防绕过成立，已收窄）。
- **Done**: `skills/trellis-admin/`（`SKILL.md` 字段语义 + cron 速查 + Known Failure Modes · `scripts/trellisctl.ts` ~380 行，agents/tasks/triggers/runs/providers/skills/cron 七组子命令）。软链 `~/.claude/skills/trellis-admin` → **仓库 checkout**，不是 `~/.trellis/current` —— 当前 release 部署于 skill 出现之前，链过去是断的；等这次上线后再定要不要改成跟 release 走。
- **两道闸落在脚本里**（比改服务端轻，且不影响界面手动操作）: `triggers add` 拒绝触发间隔 < 5 分钟（`--force` 可越过）并在挂之前回显人话描述 + 下次触发时间；`tasks create` **建出来不挂触发器**，输出直接引导「先手动跑一次 → 看 runs → 满意再挂」。**原本想做的「建成停用再试跑」走不通** —— `lib/server/tasks.ts:409` 对 disabled 任务连手动 run 都拒。
- **写的过程中修的三处**: 块注释里写 `*/2`，那个 `*/` 把注释提前关了（bun 直接 parse 失败）· builtin agent 的 id 是 `builtin-<slug>`，截 8 位后五行长得一模一样 → 索性不打 id、全用 slug 当句柄，并让 `tasks create` 收 `agentSlug` 自动换成 id · 中文列宽按码点 `padEnd` 会把表推歪，改按显示宽度算。另修一处照旧计划文档抄错的路径：任务页是 `/settings/tasks` 不是 `/tasks`（S89 已收进管理台）。
- **实测通过**: `health`（3088，token 从 `shared/.env.local` 自动读到，`auth: on`）· `cron "0 9 * * 1-5"` →「每个工作日 09:00 · 08-03/04/05」（今天周五，跳周末正确）· `agents list --all` · `providers`（12 个）· `skills` · `tasks create/update/run/list` · `runs`。
- **端到端卡住，但卡点不在本次改动**: 建了个真任务手动跑两次，**都在 1 秒内 0 token 失败**：`Failed to authenticate: OAuth session expired and could not be refreshed`。任务链路全通（建任务 / 抢槽 / 建 `kind='task'` 会话 / 建节点 / spawn / 捕获错误 / 留档），死在 spawn 出来的 claude 认证上。**五条已排除**（本机凭证 / proxy / launchd 的 PATH+HOME / env 污染 / `--model opus`），全部命令与判据见 `failures.md`。旁证：`nodes` 表最近一次 `done` 停在 **07-28 10:52** —— prod 的交互式会话很可能也早就坏了，只是三天没人开所以没人知道。
- **续（8-01）：管家 agent 从「自定义」升成「内置种子」**。用户在**第二台机器**上部署后发现界面里没有它 —— 暴露了一件我一开始就写进 SKILL.md 失败模式、却没往 agent 身上想的事：**agent 是 DB 行、不跟着 git 走**。于是推翻前一天「先别固化」（见 `decisions.md` 2026-08-01），加进 `BUILTIN_AGENT_SEEDS` 第 6 位，并**删掉手建的那行** —— `seedBuiltinAgents` 是 `INSERT OR IGNORE`，撞同名 slug 会静默跳过，留着就永远种不进去。**种子刻意不配 `skills_json`**：内置一律 `inherit_env=1`，本机 `~/.claude/skills/` 全可见，绑了只会白物化一个 pack。空库（→ 6 个 builtin）与存量 5 行库（重启后补成 6 行）两条路都在 `TRELLIS_DB_PATH` 指的临时库上实测过，tsc 零错。**仍不跟 git 走的**：`~/.claude/skills/trellis-admin` 软链每台机器要单独建。
- **Next**: 用户去 `trellis.smokingmouse.cc` 或 `127.0.0.1:3088` 发一句普通聊天。回得来 → 只有任务路径坏，对照 `tasks.ts:launch()` 与 `chat/route.ts` 构造的 StreamRequest 逐字段找差异；回不来 → prod 实例级故障，先 `launchctl kickstart -k` 看是否自愈。试跑任务 `bffbe8ed` 留在库里没删。**BOE 仍未部**（S88 遗留）。
