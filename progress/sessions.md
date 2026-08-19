# Session Log

最近 5 条，倒序（Session 109 / 108 / 107 / 106 / 105）。更早的见 `archive.md`。

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

