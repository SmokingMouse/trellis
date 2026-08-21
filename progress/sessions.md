# Session Log

最近 5 条，倒序（Session 111 / 110 / 109 / 108 / 107）。更早的见 `archive.md`。

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
- **验证**: tsc/eslint 零错、`bun --bun run build` 过（裸 `bunx next build` 挂 `bun:sqlite` 属已知，Makefile:5-9 有载）；真库副本冒烟（`TRELLIS_DB_PATH=/tmp` 隔离）——迁移回填 33 default/16 user/2 import ✔、findRelated 该中的中（trellis 权限、jsonl 分叉）该静默的静默（React 没聊过 → 0 hit）、user 锁行拦截 ✔；隔离 dev（:3891）E2E——POST /api/chat 真跑 opus 一轮，SSE 依次 done → topic_label → **session_title**（「B树与B+树的核心差异」），DB 落盘 `title_source=auto` ✔；agent-browser 实测——sidebar 显示生成标题（旁边就是超时年代的失败对照「用一句话解释什么是虚拟内存」）、首屏敲草稿 1.8s 后提示条浮现（3 命中带 mark 高亮 + 相对时间）、点行直落原树命中节点 + 底部续聊框。
- **未做/边界**: 树内 DockedComposer 不挂相似检测（新开树时刻才是决策点）；attach/import 会话不自动命名（标题归 importer/watcher）；B4 首屏最近入口、「续聊前沿可见化」（方案 C）未动。
- **Next**: **未部署未提交**——用户过目后提交，下次 `make deploy` 自然带上；上线后观察召回精度（误报烦就提门槛/扩停用表）与自动标题质量；C3 语义检索（Q2 倾向本地 bge-small）排期不变，落地后 findRelated 换召回底座。

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



