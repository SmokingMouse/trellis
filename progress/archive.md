# Trellis Archive

历史 session log（按时间倒序）。

## Session Log

### Session 112（2026-08-21，树隐藏修复：彻底移出非隐藏区 + 焦点自动切换 + 已隐藏组展开自适应）
- **触发**: 用户反馈树隐藏问题——当前树或只剩一棵树时点击隐藏，该树仍旧出现在非隐藏区，或者说只要停留在当前树该树就不在隐藏区里，且存在双重渲染。
- **根因**: `TreePanel.tsx` 存在 `{activeEntry?.hidden && renderActiveTree(activeEntry)}` 强制把被隐藏的当前树再次渲染在热区下方；同时点击隐藏时未自动把活跃焦点切换到下一棵可见树；activeRootId 回退时未优先选择首棵可见树。
- **Done**: ① `TreePanel.tsx` 删去 `activeEntry?.hidden` 在非隐藏区的强制渲染；② 隐藏当前树时（无论是在展开树头还是折叠树行点击），若存在其他可见树则自动将焦点切至下一棵可见树（`nextVisible.latestNodeId`）；若恢复隐藏树且当前无可见活跃树，自动恢复其活跃状态；③ `activeRootId` 缺省 fallback 优先选择第一棵未隐藏树（`entries.find(e => !e.hidden)`）；④ `renderTreeRow` 补全 `entry.hidden` 下当前被选树的 active 样式；⑤ `hiddenOpen` 支持全树被隐藏时默认展开 `已隐藏` 组，便于用户快速恢复；⑥ 新增 `lib/tree-panel.test.ts` 覆盖分组、雪藏过滤、热度排序及单树雪藏等场景。
- **验证**: `bun test` 9 pass ✔；`node_modules/.bin/tsc --noEmit` 0 错 ✔；`eslint` 0 错 ✔；`bun --bun run build` 成功通过 ✔。
- **Next**: 提交分支、提交 PR 并合并至 master/main。

### Session 111（2026-08-21，打标/起题模型可配：app_settings kv + 设置页卡片）
- **触发**: S110 交付后用户追问「别人用但没有这些模型呢」→「能不能在设置里配」。此前 claude 路写死 `--model haiku`（官方 alias，正常安装都认，但只路由部分模型的网关/自建 cpa 类环境会静默失败）。
- **Done**: ① `app_settings` kv 表（服务端 app 级偏好的通用归宿——localStorage prefs 服务端读不到，spawn 路径要读的偏好从此有家）+ repo `getAppSetting/setAppSetting`（空值=删行回默认）；② `/api/settings` 白名单路由（GET 全量 / PATCH 单键，key 白名单制防长尾垃圾键）；③ topic.ts 读 `label_model_claude`（默认 haiku）/ `label_model_codex`（默认不传 `-c model=` 走本机默认），topic+title 两用途共用；④ `LabelModelCard` 挂 settings/models 页（与 AuthHealthCard 同级，不进 ModelConfigPanel——那组件被 modal 复用且管的是 endpoints.yaml 跨应用共享配置，起题模型是 trellis 私有偏好不该混入）。
- **验证**: tsc/eslint/`bun --bun run build` 零错；隔离 dev（副本库 :3891）**双向对照**——kv round-trip ✔；配 `no-such-model-xyz` 发一轮 chat → SSE 无 topic_label/session_title（证明配置真进 spawn、失败静默不伤对话）；清除后再发 → 两事件恢复（「并发编程活锁」/「活锁现象解析」）✔；agent-browser 实测设置页卡片渲染 + UI 保存 → API 回读 `sonnet` 落库 ✔。
- **Next**: 与 S110 同批**未提交未部署**，用户过目后一起提交；后续想给别的服务端偏好用 kv 直接进 `/api/settings` 白名单。

### Session 110（2026-08-21，体验 A/D 落地：发问相似检测 + 会话自动命名，顺带修 topic_label 超时暗伤）
- **触发**: 用户「树多了不知道在哪棵续聊还是新开」→ 痛点拆三层（①没想起来聊过——决策时机层，⌘P pull 式救不了 ②记得但搜不到——trigram 换措辞 miss，即 C3 ③找到树不知在哪节点续），方案 A（push 式相似检测）+ D（自动命名地基）拍板先做。
- **Done A（发问时相似检测，roadmap 记 C7）**: `repo.findRelated`——与 searchAll 整句 phrase 不同，草稿拆多 term（ASCII 整词 + CJK 3 字窗步 2 + 尾窗，会话腔停用表双向 includes 过滤）各查一次 FTS，按 session 聚合 term 覆盖度，门槛 ≥2 term（单 term 查询放宽 1）+ 排除 archived，宁漏报不误报；新路由 `/api/search/related`；`RelatedHints.tsx` 挂 QuestionInput 输入卡下——debounce 600ms、≥6 字才查、`/` `$` 前缀跳过、✕ 压制当前草稿（清空复位，react-hooks 新规不让 effect 内同步 setState → 渲染门控 + prev-render 对比实现）、点行走 jumpToSearchHit 直落原树线性视图命中节点。
- **Done D（会话自动命名，roadmap 记 C8）**: sessions 加 `title_source`（default/auto/user）迁移 + 存量回填（title ≠ 根节点首问前 60 字 → user；导入系派生规则不同天然 mismatch 也标 user = 保守正确）；renameSession 置 user 永久锁；run-bus 新增 `sessionTitle` post-done 钩子（**与 topicLabel 并发跑**——两钩子各一次 CLI spawn，串行最坏顶穿 30s grace window）+ `session_title` 事件广播/迟到订阅补发；chat route 闭包判定全走 DB（origin=native only——retry 路径不回填 resolvedOrigin 故不信 route 变量；doneCount==1 首答起题、%8==0 按最近 3 轮刷新「当前主题」）；`generateSessionTitle` 与 topic 共用 spawn 管道（haiku）；store 收事件就地改当前 session 标题 + bump sessionsRevision 让 sidebar/tabs 重拉；`applyAutoTitle` 的 `WHERE title_source != 'user'` 原子守卫防与手动改名竞态。
- **顺带破案（存量暗伤）**: topic.ts 的 claude 8s 超时一直在静默掐死打标——`claude -p --model haiku` 冷启动实测 10.6s（热 4.2s），历史 topic_label 命中率仅 49/493≈10%。超时提 15s（并发取 max，30s grace 内），topic_label 与 session_title 同受益。

### Session 109（2026-08-19，部署独立性审查 + 四项修复）
- **触发**: 用户「检查部署的独立性，是否存在对环境的依赖和耦合」→ 审查报告 → 「全部修复」。
- **审查结论**: 部署主链（release/原子切换/回滚/双 supervisor/端口可配/优雅降级）解耦做得扎实；问题集中在一个腐烂运维脚本、新机器 bootstrap 三处人肉缺口（服务定义无模板、shared/.env.local 不随 clone、宿主机 CLI 登录态）、两处小不一致。tmux「无 PATH 兜底」为误报（probeExecutable 内部本就扫 PATH），实际只有提示文案写死 brew。
- **Done**: ① 删 `scripts/update-trellis.sh`——已腐烂（引用 Makefile 已删的 SDK_REPO）、只在原主人两台机器可用、走的是 deploy.ts 明确取代的「原地 build + kickstart」老路，且把字节内网代理/BOE 路径含真实用户名推上了公开仓库（**git 历史里仍在，删除只是止血，代理地址与用户名按已公开对待**）；连带修 `deploy-supervisor.ts` 注释悬空引用。② `skills.ts` 的 `builtinSkillsRoot()` 改走 `deployPaths()`——原来硬拼 `os.homedir()/.trellis` 旁路了 `TRELLIS_DEPLOY_ROOT`。③ `ttyd-dependency.ts` 新增 `installHint()` 按平台给安装命令，ttyd/tmux 提示不再对 Linux 说 brew。④ README：Quickstart 补 tmux 依赖与 Linux 安装命令；新增「新机器从零部署」章节——7 步 checklist（含首次 `make deploy FORCE=1` 的鸡生蛋说明：服务工作目录还没切 current 时 preflight 必拦）+ launchd plist / systemd user unit 模板（以本机实测 plist 泛化；PATH 注释点名要含 claude CLI 的 bin）+ macOS keychain 凭证雷（launchd 会话读 keychain 死凭证，回退文件存储修复）。
- **刻意不动**: `next.config.ts` turbopack root = homedir——作者注释已决策 unconditional（link-sdk 场景依赖），当前部署布局（release 全在 `~/.trellis/`）下无实际问题，仅是将来容器化的已知阻断点。
- **验证**: tsc 零错；eslint 四个改动文件零输出；`bun --bun run build` 过；skills root 冒烟——默认根行为不变（回归安全）、`TRELLIS_DEPLOY_ROOT=/tmp/drill` 时正确解析 `/tmp/drill/current/skills`。**未部署、未提交**。
- **Next**: 用户过目 diff 后提交；下次 `make deploy` 自然带上（skills root 改动影响 prod 的内置技能解析，与 S108 多根解析同批上线正好）。泄露历史**不重写**已拍板（decisions.md 2026-08-19 条），无后续动作。

### Session 108（2026-08-19，「后台运行」空头支票破案 + trellis-admin 补接续姿势）
- **触发**: 用户截图 macbook-pro 上 trellis 会话——agent 声称「全量同步后台跑、完成后我会触发周报任务(bc5b37ff)」，问这种后台运行是不是真的。
- **破案（三层实测）**: ① `claude -p`（trellis 的 spawn 形态）退出时 **run_in_background 后台任务被杀**（sleep 90 实测无存活）；裸 `nohup &` 孤儿能活（实测存活）但无人看管。② 「完成后我会触发」必假——说话的进程 turn 结束即退，scheduler 只认 cron/fs/git/session_done 触发。③ 本机（=macmini）prod 库实核：无周报任务、零 trigger、日报 prompt 无 rsync 步骤——截图会话在 **macbook-pro 实例**（tailnet 档案确认本机是 macmini），任务数据在那台库里，agent 的「✅已建好」在够得着的库里查无实据。
- **社区对照（happyclaw 源码实读）**: 模式 A=常驻 warm runner + SDK task-notification 唤醒（`background-task-drain.ts` 331 行「完成债」状态机是 IM 单次送达语义的账单，trellis 不该抄）；模式 B=调度器 + prompt 逐字重放 + agent 自助 `schedule_task` 工具（工具描述强制「调度词不进 prompt」「超时先 list_tasks 核实防重复建」——值得抄的是这套防呆合同）；模式 C=OpenClaw 式 heartbeat 轮询（trellis 用一个 cron trigger 即可模拟，零代码）。
- **Done（`skills/trellis-admin/SKILL.md`）**: ① description 补接续场景触发词（跑完之后/完成后接着/后台跑完再触发/同步完成后），明确「接续编排归本 skill，正解是触发器不是口头承诺」；② 新增「长任务与『完成后接续』」一节：两条真路（收进同一 run 分批跑 / nohup+标志文件+fs 触发器）+ 三条防呆（调度词不进 prompt、id 必须来自命令回显+超时先 list 核实、没有 once 触发器用 tasks run 或 cron+rm 顶）。
- **Done ②（内置化，用户拍板「symlink 方案不行——新用户没东西可链」后落地）**: 技能源改多根解析，**零 schema 变更**（绑定仍 `kind:"host"`+目录名）——`skills.ts` 新增 `builtinSkillsRoot()`（cwd 在 `~/.trellis/releases/` 下 → 经 `current` 软链取 `current/skills`，pack symlink 不随 release 清理悬空、升级自动跟随；dev checkout → `cwd/skills`）+ `claudeSkillRoots()`（用户 `~/.claude/skills` 优先、内置兜底，byName 去重先到先得）；`agent-pack.ts` 的 writePack / codexAgentPrompt 改 `resolveSkillDir()` 逐根找，**PACK_FORMAT 2→3**（facts 纪律：writePack 产出变了必须 bump，否则存量 pack 命中老 hash 永不重建）。顺带发现 L1（symlink 发现层）**早已修**（`93c7c6c`，`skills.ts:38` statSync 穿透），contrast 坑 1 的发现层部分不用再做。
- **验证**: tsc 零错、eslint 两文件零输出；冒烟三场景（`bun --conditions react-server`）——A 假 HOME 模拟无 symlink 新机器：内置根发现 + 物化成功 + pack symlink 经内置目录可读 SKILL.md；B 本机双源：去重后 1 条且用户目录赢；C 在 `~/.trellis/current` 下跑：内置根正确解析为 `current/skills`（release 目录 `20260818T094242` 实核带 skills/trellis-admin）。**未部署**。
- **未做（候选，待用户定）**: ① `--append-system-prompt` 生命周期契约注入（`tasks.ts:472 launch()` 经 extraArgs，交互路径同理）——治「agent 不知道自己会死」的根因；② once 触发器 kind（产品 gap）。
- **Next**: `make deploy` 上线多根解析（存量 agent 首次 spawn 自动重物化）；macbook-pro 拉取部署后 trellis-admin 零配置可用，顺带在那台核实周报任务真伪并手动跑；决定候选 ①② 做哪个。

### Session 107（2026-08-18，权限确认升级全拦：agent@0.8.0 + READONLY_AUTO_ALLOW 免审名单）
- **触发**: PR #15（并行会话的 askTools "all" + mcpServers 一等协议）review 合并、SDK 发 0.8.0 后，trellis 接力吃下全拦。
- **Done**: ① bump `^0.8.0`；② `sdk-adapter` 的 `APPROVAL_ASK_TOOLS` 名单换 `"all"`（CLI `permissions.ask:["*"]`）——旧名单外的可变更工具（MCP 工具是最大的洞，`mcp__*` 名字穷举不完）此前被全局 allowlist 静默放行；③ 「哪些免审」的判断挪进 run-bus dispatcher：新增 `READONLY_AUTO_ALLOW`（Read/Glob/Grep/LS/WebFetch/WebSearch/TodoWrite/NotebookRead/BashOutput/Task/Skill/SlashCommand），权限确认下只读/编排类自动放行、其余一律弹卡；Task/Skill 外壳放行不漏审——内部可变更调用各自再进回调逐个弹卡。
- **验证**: 真机 claude 走 trellis provider 层 + requireApproval：回调收到 `["Read","Bash"]`（Read 旧名单下直接绕过、现在进回调）、放行后回答 DONE；tsc 零错、eslint 改动文件零输出。agent@0.8.0 由干净 main 构建发布（PR #15 内容 58/58 复核）。
- **版本归属澄清**: maxTurns/skills 两项实际已随 0.7.0 出包（并行会话在 0.7.0 发布前落的 main）；0.8.0 增量 = askTools 全拦 + McpServerConfig。
- **部署**: `make deploy` 上线 `4a6bbb4cf`（连带 PR #17 响应分层，prod node_modules 实核 0.8.0）。
- **Next**: 真机权限确认会话验弹卡范围（Bash/Edit/MCP 弹、Read 不弹、「总是允许」仍生效）；cpa codex 上游故障（failures.md）恢复后复验 codex 注入路径。

### Session 106（2026-08-18，agent 长任务正文一坨糊：分段 + 过程/结论分层，PR #17 已合并）
- **触发**: 用户截图「正文+思考+正文……会导致正文的阅读体验特别差」——TurnCard 把几十段过程叙述连成一坨。
- **根因**: SDK 逐 token 透传 `text_delta`、content block 边界零事件，run-bus `committedText += text` 无缝拼接；cli-import 路径早有 `join("\n\n")`，只有 live 流式路径中招。
- **Done（一个状态机两层；worktree `calm-river-7881` → PR #17 → main `30df25a`）**: ①**分段**——run-bus 在结构性中断（thinking / 主链 tool_call_start）后的下一个 delta 前把 `"\n\n"` 当普通 delta 走完整路径（commit + DB append + broadcast），流式端/落库/catchup 快照三方天然一致，claude/codex/mock 通吃；延迟到「确有新正文」才插，工具收尾的 turn 不留尾部垃圾。②**分层**——同一状态机维护 `finalStart`（最后一次中断之后的正文起点）落新列 `nodes.final_start`（NULL/0 = 不分层 → 存量/纯 chat 渲染逐字节不变），TurnCard done 态把过程叙述折叠成弱化 details（「🧭 过程叙述（N 字）」，小号墨色+左竖线），最终答复才是正文；分享卡片图只带最终段，复制全文仍全文。cli-import 按块结构精确算同一偏移（thinking 块仍丢内容但当中断信号），retry 重置清零，done 事件/DB-fallback 重连都携带 finalStart。
- **验证**: 新回归 `scripts/test-final-start.ts` 9/9（mock provider 驱动真实 startRun/subscribe + 手造 jsonl：分段串、落库偏移、done 携带、纯回答不分层、工具收尾指向末段）；真实数据最近 60 个 CLI jsonl / 369 turns → 243 分层、**0 越界/空最终段**，抽样最终段全是 TLDR/交付汇报类收尾；隔离 dev（`TRELLIS_DB_PATH` 临时库 + :3210）+ agent-browser 截图折叠/展开两态符合设计；tsc 零错、eslint 零新增（TurnCard 4 条既有基线）、`bun --bun run build` exit 0（裸 `bun run build` 无 `--bun` 会在 collect page data 阶段挂 `bun:sqlite`——Makefile:5-9 与 facts.md 早有记载，别绕过 make）。
- **边界（刻意不做，记 PR body）**: 锚点/搜索命中过程段时 details 不自动展开（锚点几乎都在答案区）；流式态不分层（有 thinking 面板与动线顶着）。
- **Next**: **未部署**（已进 main，下次 `make deploy` 自然带上）；部署后用户开一轮真 agent 长任务看 done 态「过程叙述折叠 + 结论正文」效果。

### Session 105（2026-08-18，codex 权限卡 + 子 agent Task 树：SDK 0.7.0 + trellis 三闸放开）
- **触发**: S104 交付后用户「开始做吧」——下一批：审批回调、turn/steer、子 agent Task 树。
- **Done ① SDK 0.7.0**（已发 npm，干净 worktree 构建发布防并行 WIP 混入）: 审批——`permission "default"` + onCanUseTool → codex `approvalPolicy untrusted`，`requestApproval` RPC 映射成 claude 形状回调（commandExecution→`Bash` 带裸命令 / fileChange→`Edit` 带 diff），allow→accept / deny→decline / abort→cancel；权限确认模式 preflight 失败 fail loud 不再静默回退 exec（安全语义降级）。multi-agent——**修 0.6.0 潜伏 bug**（子线事件同连接到达，不过滤则子线 turn/completed 提前终结 run、子文本混主答）；`subAgentActivity`→spawn_agent 工具卡 + Task started/completed（taskType local_agent，summary=子线终答），子线工具挂 parentToolUseId。SDK 单测 48/48、审批 e2e 3/3、回归 e2e 11/11。
- **Done ② trellis**: 三闸放开 codex——`approvalAvailable`（mock 除外）、route 创建钳制、`interactive = claude || codex`；AgentPicker / settings 文案同步（Codex 支持逐项审批）；InteractionForm 零改动（Bash 命令块 / 通用 JSON 兜底本就按 toolName 渲染）。tsc 零错。
- **Done ③ steer 推迟**: 树模型无消费位（一节点一问一答），决策记 `decisions.md` 2026-08-18 条。
- **验证与插曲**: trellis 全链（makeCodexProvider→SDK→codex）实测**审批回调触发 + accept 后命令真执行 + shell 工具卡到达**；但完整轮次撞上 cpa 的 codex 上游 `503 auth_unavailable` 间歇故障（当日内从间歇恶化为挂起，判别实验证明与本次改动无关：默认 provider 同轮次全通、exec 同注入同 503）→ 记 `failures.md` 待查（修复大概率在 cpa 服务端补池凭证）。
- **部署**: `make deploy` 上线 `66ebf0425`（smoke 全绿，prod node_modules 实核 0.7.0）。
- **Next**: cpa 池恢复后按 failures.md 判定命令复验注入路径；用户真机 project+需确认开 codex 会话点权限卡、multi-agent 提问看 Task 树；审批「总是允许」按 toolName 已复用 claude 机制无需改。

### Session 104（2026-08-18，codex 逐 token 流上线：SDK 0.6.0 app-server transport + trellis bump）
- **触发**: 用户问「codex provider 不支持 stream？工具和子 agent 也没有？」。调研（两 research agent 挖 openai/codex 0.147 源码 + 本机协议探针）：exec --json 的 delta 是输出层**有意丢弃**且无 flag 可开；0.147 起 v1 协议移除、v2 唯一默认，官方全生态（TUI/exec/VS Code 扩展/Python SDK）已收敛到 app-server；实测 app-server `thread/resume` 直接续 exec 录的 rollout（同一存储、id 互通）。SDK 侧 08-04 推迟决策的重启条件「v2 收敛」已满足 → 解除。
- **Done（全在 ~/sdk，trellis 零代码改动）**: `@smokingmouse/agent@0.6.0` 发 npm——CodexBackend 默认 app-server transport（per-run spawn stdio JSON-RPC v2）：`item/agentMessage/delta`→TextChunk 逐 token、reasoning→Thinking、item 生命周期→ToolCall/Done（**含 collabAgentToolCall 多 agent**，S99 时代「codex 子 agent 不可见」随之闭环）、原生 `thread/fork` 替代 rollout copy、abort→`turn/interrupt`；preflight 失败零事件回退 exec（prompt 绝不跑两遍），`environmentSkills=false`/`extraArgs`/ephemeral resume 预分流 exec。trellis 仅 bump `^0.6.0`（package.json + bun.lock）。
- **验证**: SDK 单测 40/40 + 真机 e2e 10 项（流式 100 chunks vs 强制 exec 1、fork 隔离、readonly 拒写/workspace-write 圈内/full 圈外逐档=exec 语义、abort 5.5s 收尾）；trellis node_modules 冒烟：capabilities `streaming:"token"`、真跑 app-server 23 chunks。sm-toolkit 三 commit 合并推送 + release commit（`9eff060`、`25b5cc0`）。**本机已部**：`make deploy` 上线 `85fd082e4`（smoke 全绿，f106885→85fd082 连带 S99–103 改动一起上线），prod node_modules 实核 0.6.0。
- **边界**: 审批回调（dynamicPermissionCallback）仍未接——S99 边界里「Codex 不能弹逐项审批卡」只解了 transport 层，approval RPC 映射是下一个独立 phase；`turn/steer`、`subAgentActivity`→Task 树渲染同理。S101 遗留 ③（登录闸假阴性）未动。
- **Next**: 用户真机开 codex 会话看打字机效果（顺带 S100 Tab 切换体感 / S103 长树图形视图两项待验收）；devbox 侧下次 `make deploy` 自动带上 0.6.0（bun.lock 已锁）。

### Session 103（2026-08-18，树面板图形视图长树密到糊：缩放下限 + 滚动 + 锚点跟随）
- **触发**: 用户截图「BOE GPU部署sub2a」82 节点树的图形视图——点全挤成一串珠子，「这个节点也太密集了」。
- **根因**: `TreePanel` graphGeometry 把整树等比压进 `GRAPH_MAX_H=300px`。dagre compact 层距 126px（90+36），长链树布局总高数千 px → scale 被压到 ~0.03，层距 3-4px < 点直径 7px，必然重叠。
- **Done（`components/TreePanel.tsx`）**: 纵横分开缩放——`scaleX` 仍贴合面板宽（272px，不出横向滚动条），`scaleY` 优先塞进 300px、塞不下时守住下限 `GRAPH_MIN_SCALE_Y = 12/126`（层距 ≥12px），高度溢出交给外层 body 的 `overflow-y-auto` 滚动。配套：锚点节点加 `data-graph-active`，切图/跳转后 `scrollIntoView({block:"nearest"})` 跟随，否则长树切过去看到的是树顶一屏灰点。
- **验证**: tsc 零错、eslint 该文件零输出。真机视觉效果待用户看。已合并推送（`39ff175` → merge → push origin/main），**未部署**。
- **Next**: 用户在真机开同一棵 82 节点树的图形视图确认：点间距可读、滚动顺、当前点在视口内。
