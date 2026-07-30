# Session Log

最近 5 条，倒序（Session 86 / 85 / 84 / 83 / 82）。更早的见 `archive.md`。

### Session 86（2026-07-30，部署流水线跨平台：devbox 上 `make deploy` 死在 launchctl）
- **触发**: 用户只贴了一张 BOE devbox 的部署日志截图 —— `switch: current → 20260730T111814-bffeda99b` 之后紧接着 `× Executable not found in $PATH: "launchctl"` → `failed`。没有一句文字。
- **根因两层，第二层比第一层更坏**：
  - `scripts/deploy.ts` 的 `kickstart()` 写死 `launchctl kickstart -k`，Linux 上 `Bun.spawn` 直接抛 ENOENT。**抛错点在 `switchTo()` 内部** —— 软链已经翻到新 release、服务却没重启，恰好落在整套设计唯一承诺「switch 之前失败 = prod 一根汗毛没动」的**缝**里。devbox 事后状态：跑着 `$HOME/trellis` 原地 build 的旧码，`.trellis/current` 指向一个建好但没人用的新 release（**S85 的修复因此压根没上线**）。
  - 就算重启修好也白搭：BOE 的 systemd unit 的 `WorkingDirectory` 仍是 `$HOME/trellis`（`update-trellis.sh` 原地 build 那套留下的），而旧代码的 WorkingDirectory 检查只读 mac 的 plist，Linux 上返回 null → 那句「本次切换不会真正生效」的警告压根没机会打出来。**「看着成功、其实跑的是无关版本」比失败更坏**，所以这条从警告升级为**拒绝**（`--force` 可越过）。
- **Done**:
  - `lib/deploy-supervisor.ts`（新）：launchd / systemd user unit 两套实现，收口 `probe / restart / unitFile / workingDirectory / setWorkingDirectory / reload / restartShell / detachPrefix`；unit 名默认取 label 最后一段（`com.smokingmouse.trellis` → `trellis.service`，与 BOE 现存 unit 对齐），`TRELLIS_DEPLOY_UNIT` / `TRELLIS_DEPLOY_SUPERVISOR` 可覆盖。**deploy.ts 里不再有一个 platform 分支**。
  - **preflight 加重启通路探针**（根因修法）：探不通就在碰任何东西之前 abort，失败重新落回「prod 没被碰过」那一侧。
  - `install-launchd` → `install-service`（旧名留作别名）：改 plist 还是改 unit、reload 走 bootout+bootstrap 还是 daemon-reload+restart，都交给 supervisor；失败**真的还原备份**（S79 的纪律照搬）。`deploy-status` 现在把认到的 supervisor 与它当前的工作目录一起打出来。
  - `lib/server/update.ts`：**systemd 下 `detached: true` 不够** —— 默认 KillMode=control-group 按 cgroup 杀，换会话不换 cgroup，`systemctl restart` 会把正在跑部署的进程一起带走，verify 与自动回滚双双失效（launchd 上 S82 修过一次，这是 Linux 上的新一份）。改经 `systemd-run --user --collect --quiet --scope` 换 cgroup，探针**真起一个空 scope**（systemd-run 在位但 dbus / XDG_RUNTIME_DIR 不对时照样跑不起来），不过就明说「改用命令行 make deploy」。顺带把 `startUpdate`/`startRollback` 两份 95% 重复的 spawn 合成 `spawnDeploy`。
- **验证**（本机造 systemd 桩环境实跑：`TRELLIS_DEPLOY_SUPERVISOR=systemd` + PATH 里放桩 `systemctl` + `TRELLIS_DEPLOY_ROOT=/tmp/…` + 复刻 BOE 现状的桩 unit）：① mac 真 launchd 路径 `deploy-status` 照旧认出 job 与工作目录 ✓；② WD 指着 `/data00/…/trellis` 时 deploy **在 preflight 就拒绝**、`current` 未动 ✓；③ `install-service` 正确改写 `WorkingDirectory=` → `daemon-reload` → `restart` → 查 `ActiveState` ✓；④ rollback 走完探针→翻软链→重启→验活（验活打本机真网关 3088，✓）；⑤ 桩收到的 11 条调用序列与预期逐条对齐 ✓；⑥ **复刻事故现场**（PATH 里既无 launchctl 也无 systemctl）→ 报错落在 preflight、`current` 一根汗毛没动 ✓；⑦ 两套 `rollback.sh` 从**真源码模板**渲染 + `sh -n` 通过 ✓。tsc 零错。
- **边界（诚实）**: **没在 BOE 上实跑过** —— 本机 ssh 不到公司 devbox（`~/.ssh/config` 里只有 bwg / vultr-tokyo）。systemd 分支的证据 = 桩环境 + `update-trellis.sh:74` 那串已被实践证明的命令，不是现场。`update-trellis.sh` 的 BOE 分支（原地 build）**先留着当退路**，等 deploy 在 BOE 上跑通一次再退役 —— 那才是「不留双版本」的时机。
- **Next**: BOE 上两步 `cd ~/trellis && git pull && bun scripts/deploy.ts install-service` → `make deploy`（跑前 export 代理，`bun install` 要出网）；本机 prod 也待重部。

### Session 85（2026-07-30，镜像会话的「永久正在生成…」— CLI 注入劫走回复）
- **触发**: 用户截图一条 attach 的 CLI 镜像 turn：6 个工具全标「完成」，底下却一直转「正在生成…」。问「为啥显示完成了，但实际卡在这个界面」。
- **两层病灶，都被实测坐实**：
  - **根因（解析器切错 turn 边界）**: `cli-import.ts:isTurnStart` 把 CLI 注入的 user 文本消息当成了真用户提问 —— skill 触发的 `Base directory for this skill: …`、`<task-notification>`、Stop hook 反馈、`Continue from where you left off.`、Esc 打断的 `[Request interrupted by user]`、`/compact` 摘要。这些假 turn 会把**后续 assistant 的最终回复整段劫走**，真 turn 只剩工具调用 + 空 response。**本机 400 个真实 jsonl / 1142 个 turn 实测：136 条这种僵尸。**
  - **UI 撒谎**: `TurnCard.tsx` / `ChatNode.tsx` 的兜底分支把「不在流式 + response 为空」一律画成脉冲点 +「正在生成…」，于是每一种「这轮本来就没文本」都伪装成永不结束的 loading，把上游问题全掩盖了。
- **判据用结构字段、不用文本前缀**（前缀会随 CLI 版本漂）：`isMeta` / `promptSource === "system"` / `interruptedMessageId` / `isCompactSummary` / `isVisibleInTranscriptOnly`。真用户消息（typed/sdk/queued）零命中，剩余以 `<` 开头的全被既有 `isCommandNoise` 覆盖。
- **Done**:
  - `cli-import.ts`：五道结构闸；**孤儿链兜底认领**（严格判据下 `claude --continue`/fork 出的 jsonl 上溯不到 turn-start，会整段丢 —— 实测 117 条消息 / 16030 字符；先严格后宽松，次序反了就退回 bug 本身）；认领跑到**固定点**；空壳兜底 turn 剪枝 + 子节点提升；新导出 `entryUuids`。
  - `cli-import-db.ts`：清理旧解析残留的假 turn 节点，四道闸（**id 出现在 jsonl entry uuid 集合里** / 非 streaming / 无子节点 / 无 lineage 失联）+ 循环到不动点（假 turn 串成链，一轮只剥一层）；`parseLineages` 区分「读不到」与「空」。
  - `sqlite.ts`：`PRAGMA user_version` 一次性迁移 v1，作废 `cli_lineages.synced_uuid`（否则 `allUnchanged` 快路径跳过重写，存量永远修不好）。
  - `EmptyResponseNotice.tsx`（新）：只有「镜像会话 + 正被实时写」才敢说「CLI 正在生成…」，否则据实说「暂无文本回复」。
  - `sessionStore.ts`：`LIVE_TTL_MS` 12s → 60s（实测真实 transcript 相邻条目间隔 13.78% 超过 12s，最长 3576s，12s 会让在跑的会话反复诈死）。
  - `cli-sync-watcher.ts`：`reimport` 的**空 catch 加日志** —— 它是镜像会话唯一的更新通道，静默失败 = 界面永久停更且零痕迹。
- **外派 falsification-verifier 打了一轮，落库那一半被打穿（解析器一半全量对抗下不动摇）**，两条**可复现的数据丢失**路径，且「迁移作废游标」恰好保证它们升级后首次启动必然各跑一遍：
  - **致命①**：清理判据 `claude_session_id IS NOT NULL` 不等于「import 建的」—— `app/api/chat/route.ts:512` 在 attached 会话**从非 tip 分叉**时会给 trellis 临时节点写 sid，而 `run-bus.ts:648` 的 `reconcileAttachedTurn` **只在 `stoppedWith==='done'` 时跑**；用户打断的那一轮（含他敲进去的问题）正好命中三道闸被删。
  - **致命②**：`parseLineages` 把「文件读不到」和「文件是空的」静默当成一回事 → `turnIdSet` 缺整条 lineage → 清理从叶子逐层剥光整棵子树。**全失败有 early-return 护栏，唯独部分失败没有**，而这是最常见的情况（transcript 过期 / 用户清 jsonl）。
  - 修法：判据换成**「节点 id 是否出现在 jsonl 的 entry uuid 集合里」** —— import 建的节点 id 恒等于某条 entry 的 uuid，trellis 自建节点是本地 v4 绝不在里面；比 `cli_turn_uuid` 强（那列这次才开始写，存量没有），比 `claude_session_id` 安全。另加 `anyUnreadable` 闸。
- **验证**: 全量 400 个 jsonl —— **僵尸 136 → 0**、假 turn 236 → 14（兜底认领的孤儿链头）、文本 1021806 → **1023718（不减反增**，兜底把原本就丢的孤儿也捞回来了）、断链 0、多次解析 hash 一致。端到端：旧代码导入复现病症（4 个假 turn + 1 条空回复僵尸）→ 切修复版**一次 reimport** 即 0/0，总文本 37152 **与纯解析精确一致**（无重复）。两条致命路径**回归测试**：trellis 分叉被中止节点 ✅ 幸存、jsonl 失联时节点数 21 → 21 ✅ 未销毁。四象限安全闸（线性续聊 / 分叉被中止 / 分叉跑着 / 分叉 done）全部幸存。lint 32 problems/23 errors = 基线，tsc 零错。
- **两次自摆乌龙**: ① 第一版 guard 报「非 import 节点被误删」是虚惊 —— 我重写脚本时把 INSERT 删了，那两个节点压根没被放进去过。**测「东西还在吗」之前先确认它进去过。** ② lint 从 28 涨到 34 以为是回归，其实是我遗留在仓库根的临时验证脚本被 eslint 扫了。
- **边界（诚实）**: 截图那条会话在 devbox 上，本机 DB 最新只到 7-28，**没拿到现场直接证据** —— 诊断靠本机语料复现同形态（136 例）建立。另：**源 jsonl 已失联的镜像会话走不到修复路径**（`parseLineages` 早返回 `empty`），本机两个 attached 会话的 jsonl 都已不在磁盘，那 2 个坏节点不会自愈，只是 UI 文案不再谎称「正在生成」。
- **Next**: 两台实例（本机 prod + devbox）都要重新部署才生效；重启后首次 `getDB()` 跑 v1 迁移，watcher 自动全量重导一次。

### Session 84（2026-07-30，动线渲染重做：三类 task 分家 + 工具渲染注册表）
- **触发**: 用户贴截图「子 Agent 的动线展示还是很不友好，workflow 也没展示出来」，要求参考 riba / happyclaw 讨论一版方案。
- **先证伪了截图的表象**：那两个「子 Agent」**根本不是子 Agent，是慢 Bash**。根因单一 —— `lib/subagents.ts:57` 拿 `c.agent !== undefined` 当「这是子 Agent」的判据，而 CLI 对**三种**东西发同一套 `system/task_*`：`local_agent` / `local_bash` / `local_workflow`。判别位 `task_type` 被丢两次（SDK `taskData()` 没抽 + adapter `void phase`）。
- **实测拿的证据（不是读代码推的）**: 两次真跑 `claude -p … --output-format stream-json` 录流。① 后台 Bash 与**前台慢 `sleep 12`** 都发 `task_started{task_type:"local_bash"}`，且 `task_notification.summary` 就是描述回声 → 老代码 `report = summary ?? output` 短路掉真 stdout。② Workflow 发 `task_type:"local_workflow"` + `workflow_name`，**并且 `task_progress` 上挂着 `workflow_progress` 全量快照**（phase 列表 + 每个 agent 的 label/phaseTitle/state/model/tokens/durationMs/resultPreview）。二进制里 `strings` 也印证了三个字面量。
- **这条实测直接推翻了原方案的一个前提**：Workflow 面板**不需要读磁盘**。用户已批准的「磁盘 adapter」因此本轮不建（L3 才用得上，现在建就是空转抽象）。
- **Done L0（事件层）**: SDK 0.3.3 补抽 `task_type`/`workflow_name`/`workflow_progress`；adapter 停止丢 `phase`/`taskId`；`SubagentMeta` → `TaskMeta`（它描述的从来不只是子 agent）。
- **Done L1（视图模型）**: `splitToolChain → {main, groups}` 两个平铺列表换成一棵 `buildToolTree → ToolNode{call, kind, meta, children, report}`。kind 四级降级链：`taskType` → 工具名/有子节点 → **taskId 首字母 a/b/w** → tool。前缀那级是关键 —— 它让修复**不等 SDK 发版**就在存量数据上生效。
- **Done L2（渲染注册表）**: `lib/tool-registry.ts` 元数据表（30+ 工具各一行，不写 React）+ `components/tools/views/` 组件表（只有 Diff/Todo/Workflow/Subagent 四个）。抄了两条别人踩过的铁律：`canRender` 说不行就降级 RawView（注册表永远炸不了）、**错误永不隐藏**。
- **Done L3（动线布局）**: 单一时间线取代「🔧 主链 + 🤖 子 Agent」两个抽屉 —— 分区把时间顺序切断了，正是「动线不友好」的另一半。删 `ToolCallsPanel.tsx` / `SubagentPanel.tsx` / `lib/subagents.ts`，不留双版本。
- **实施中挖出两个计划外的**: ① SDK `stdout ?? content`，空 stdout 顶掉 content —— 和分组吞并叠加才是「命令结果彻底消失」的完整成因。② 失败的行必须默认展开，否则「错误永不隐藏」只是口号（渲染冒烟测试逼出来的）。
- **验证**: `test-tool-tree.ts` 34 项 + `test-timeline-render.tsx` 45 项 ALL PASS（三个真 fixture 各覆盖一种 task_type，后两个是本次录的）；**生产库回放** 21 条误判 Bash 全部归位、20 条输出恢复可见、4 个真子 Agent 不回归；tsc ✓ lint ✓ build ✓。
- **合并后在 main worktree（registry 版 0.3.2）实测，纠正一个我先前说轻了的判断**：分类确实全对（前缀链兜住）、report 不再吞 output，**但 `stdout ?? content` 那个修复也在 SDK 里** —— 0.3.2 上后台/无输出命令的输出仍是空串。所以「结果不可见」在 0.3.2 上只修好一半，发版不是锦上添花。`test-tool-tree.ts` 开头加了版本闸，装 0.3.2 时先打印提示再红。
- **收尾**: `@smokingmouse/agent@0.3.3` 已发 npm，trellis 依赖收紧到 `^0.3.3` + 解链回注册表版本，全套验证在真 registry 包上复跑通过（tsc / 79 项断言 / build 全绿，版本闸不再告警）。main 已推 origin。
- **Next**: **浏览器人工验收**（本 session 无浏览器工具，只能人跑）—— 尤其流式态：面板自动展开、运行中子 Agent 自动展开、LiveHeader 取最深运行节点。之后 `make deploy` 上 prod。

### Session 83（2026-07-30，worktree 可用性：能力不可达 + 侧栏说谎 + git 感知）
- **触发**: 用户「讨论下怎么把 workspace 这个功能完善一下」。先查真库判据（S1 定的是行为指标「一周内 worktree 里 session 数 > 0」）：上线 3 天，trellis 里只新建 1 个 session（暂存区，贴了个 X 链接）、**worktree 里 0 个**，同期 CLI 里 1204 个 jsonl。判据未达标。
- **用户给的根因**（比我预设的方向更准）: 「trellis worktree 不好用，感知和交互都很费劲」+「一个项目开多个 worktree 并行，但**不想在操作上特别感知这件事**」。据此拍板：新建会话时默认不开 worktree、一键可开；分支已合入主干就提示回收。
- **调查改写了诊断 —— 不是缺能力，是能力不可达**: 新建/删除 worktree 的入口 S1 早就做了（`SessionSidebar.tsx:222/247`），但 `workspaces.created_by='trellis'` 行数**实测为 0**，即上线至今一次都没被成功用过。根因是 `:730` 的 `hidden group-hover:flex` —— Tailwind 的 group-hover 自带 `@media (hover:hover)` 包装，而移动端抽屉与桌面 rail **复用同一份 renderPanel**，触屏上那条规则永不匹配 → 按钮**永远点不到**（用户挂公网隧道，手机访问是常态）。原计划要做的「新入口 + git 角标」全是在这个堵点之上加东西。
- **Done ①（可达性）**: 改成 `hidden group-hover:flex pointer-coarse:flex`。判据是「有没有 hover 能力」而不是「屏幕多宽」—— iPad / 触屏笔记本是大屏无 hover，按 `md:` 断点判会漏掉它们。
- **Done ②（侧栏说谎）**: `visible()` 加路径存在校验（带 5s TTL，防未挂载网络盘在 ~1.6 次/秒的热路径上阻塞 stat）；`registerSiblingWorktrees` 从只进不出改成**同时 prune**（「不在 git worktree list」+「目录确实不存在」双条件，缺后者则 git 一失败就会清空好行）；重扫从 boot-only 提取成 `rescanWorktrees` 并挂到 git 状态接口（原来 CLI 里新建的 worktree 要重启才现身）；`ensureWorkspaceForPath` 的 INSERT 加 `ON CONFLICT(path) DO NOTHING`（按需触发引入了并发）+ `created_by` 按 rank 只升不降（否则重建同名 worktree 后 trellis 自己建的也删不掉）。
- **Done ③（git 感知）**: 新增 `lib/server/git-status.ts` + `GET /api/workspaces/git-status`，出 `{branch, dirty, reclaimable}`，前端异步拉、渐进填角标（分支名 / 橙色 ●N 脏文件数 / 绿色 ✓ 可回收）。**刻意不并进 `/api/sessions`** —— 那条在流式期间是 ~1.6 次/秒（依赖 sessionsRevision ← cli-sync 600ms 合并窗口），塞 spawn git 会拖垮 SSE。全程 `execFile` promise 版，不照抄现存的 `spawnSync`。砍掉 ahead/behind：实测**只有 main 有 upstream**，任务分支全没有，`branch.ab` 结构性无输出。
- **Done ④（删除路径修脆点）**: `force=0` 改成**只预演绝不执行**（实测原实现对干净 worktree 点一下目录就没了，连问都不问，而按钮现在触屏常显）；预演回传 `--ignored=matching` 拿到的两类清单 —— dirty 是会丢的活，**ignored 是 `.env*` / `/.claude/` 这类会被静默删掉的东西**（S79 丢过一次 `.env.local` 导致认证闸静默关闭）；加「正在生成的会话」拦截闸；杀终端从 git remove **之前**挪到之后（原顺序在 git 失败时白杀终端）。
- **实测钉死的三条（都推翻了我的初版设计）**:
  - **`merge-base --is-ancestor` 判「已合并」会误删正在用的工作区** —— `main-2`（刚建、没提交、正在用）与 `wolffish`（真做完已合并）返回**同一个值**。改用 `origin/main` 当基准同样错：实测 `origin/main`(67e172b) ≠ 本地 main(edd3c4e)，fetch 一跑就发生。最终判据 = **分支 tip 是某个 merge commit 的第二父**（`rev-list --merges --parents --ancestry-path`）+ 基准用**本地**主干 + 工作区干净。已知漏报 squash/rebase 合并（方向安全，代码里写死了注释）。
  - **默认分支必须逐 repo 探测**：trellis → `origin/main`，`~/.claude` → `origin/master`。写死 "main" 会让后者全错。
  - **CSS 变体顺序陷阱**：第一版写 `flex pointer-fine:hidden group-hover:flex`，产物里 `pointer-fine:hidden`(55476) 排在 `group-hover:flex`(47049) **之后**且特异性相同（`:where()` 计 0）→ 隐藏反过来覆盖 hover 显示，鼠标设备上按钮再也出不来，**比原 bug 还糟**。改成「基础态 hidden + 两条互斥的显示规则」后谁先谁后都不影响。
- **砍掉的一个功能（实测逼的）**: 一度做了「从列表移除」（只摘记录不删磁盘）给 CLI 建的 worktree 用。实测发现摘掉一个目录仍在的行，**下一次 rescan 就把它加回来了**（`added:1`）—— 点了等于没点，比没有更糟。于是删掉前后端，改由 rescan 的自动 prune 兜底，清理范围扩到所有 `kind='worktree'`。
- **验证（隔离实例 :3399 + 真库 VACUUM INTO 副本，prod 零触碰已复核）**: tsc ✓ / lint 32 = 基线 ✓ / build ✓。**僵尸自动清理 + 隐身修复端到端成立**：boot 后 `arrowworm`/`madtom`/`trevally` 三行消失，`main-2`/`main-3`/`main-4` 出现（后两个是本 session 期间别处新建的真 worktree，等于在动态变化的环境里验了一次）。**reclaimable 黄金对拍集 6/6 全过**（`wolffish`→可回收；`main-2`/`main-3`/`main-4`/主 checkout/`.claude`→不可回收）。删除四路径：force=0 只预演不删 ✓、`.env.local` 被正确列进 ignored 清单 ✓、正在生成的会话拦住 ✓、force=1 真删且**会话未连坐**（workspace_id→NULL）✓。浏览器层：桌面态 5 个按钮容器 `display:none`、hover 目标行后变 `flex`(w=19) 且其余行不受影响 ✓；侧栏渲染 `main-2 ●6`（正是本次改的 6 个文件）/ `main-3 ●2` / `trellis` 显示分支 `main` ✓。收尾：实例与 browser session 已关、测试 worktree 已清、prod DB 修改时间仍是 7-29、`:3088` 401、`current` 软链未动、tmux 会话未被误杀。
- **两个未能实测的边界（工具限制，已知）**: ① `pointer-coarse` 的真实触屏行为 —— `agent-browser` 的 `set device` 只改 viewport/UA，不设置 pointer/hover media 特性，故只做到「产物 CSS 规则 + 条件 + 顺序」三层确证 + 桌面路径实测；② dev 模式下页面卡在「加载中…」（既有的 `::highlight` PostCSS 告警所致，S80 已记录，非本次引入），验证全程走 production 模式。
- **Next**: 用户验收 —— 手机上打开侧栏，项目行的「＋」应当直接可见可点；桌面 hover 行为不变。改动未 commit（6 个文件：`SessionSidebar.tsx` / `worktree/route.ts` / `workspaces.ts` / `git-status.ts`🆕 / `git-status/route.ts`🆕 / `types.ts`），在 `main-2` worktree。上 prod 走 `make deploy`。

### Session 82（2026-07-29，设置页 + 点击更新 · 右下角重叠 · ttyd 探测脆点）
- **触发**: 用户「之前的设置页面的那波更新好像不见了……搞了一个设置页，支持自动更新，也把终端移到了顶部，不和树预览图冲突」。
- **先证伪了前提**：那一版**在这个仓库里从不存在**。查了 git 全 ref + 悬空对象 + 所有 reflog、另外两个 clone（`~/ai-coding/trellis`、已被清空的 Harbor worktree `harbor-worktrees/trellis-c_pi9krbkm5y`）、`~/.claude/projects` 全部 CLI 历史、`~/.codex/sessions` 306MB 全部 rollout、Harbor 控制面 DB、GitHub 全部远端分支与 PR —— 零命中。反而查到两条**明确不做**的旧记录：`archive.md` 的「设置页评估不做」(S62) 与 `decisions.md` 的「无人值守自动更新——拒绝」(S79)。**但用户记的那个冲突是真的**，而且一直没修。
- **Done ①（右下角重叠）**: 机制本来就有 —— `TerminalPanel` 早就在发 `--trellis-term-h`，只是 `TreePanel` 写死 `bottom-24` 没订阅。新增 `--trellis-term-stack`（终端在右下角占到多高，覆盖把手/浮层/钉住三态），`TreePanel` 改 `clamp(6rem, calc(var(--trellis-term-stack,0px) + 0.5rem), 50vh)`。clamp 上界是硬保证：终端拖到 720px 高也不许把树面板顶出视口。**没有把终端搬到顶部**——贴底是 VS Code/devtools 的通用语法，搬顶反而怪。
- **Done ②（ttyd 探测）**: 根因不是「没装」（实测 `/opt/homebrew/bin/ttyd` 探得到、prod 日志也没有 boot 期告警），而是 `ttydBin()` **把失败也缓存了** —— 一次瞬时失败就焊死到进程重启。改成只缓存成功 + PATH 兜底 + 逐候选记失败原因（`EACCES` 与「不存在」必须分得开）+ 面板加「重试」按钮和「探测详情」折叠区。
- **Done ③（设置页 + 点击更新）**: 新 `/settings`（Header ⚙）+ `lib/server/update.ts` + `/api/update`。**不重新实现部署**，只是 detached 派生 `scripts/deploy.ts`。三个机关见 decisions.md 与 facts.md。
- **验证（隔离实例 :3299 + 沙箱 deploy root，prod 零触碰）**: tsc ✓ / lint 32 = 基线 ✓ / build ✓；**重叠前后对照**（浏览器真 rect）：写死 `bottom-24` 时重叠 20px，改后三态 gap 均 8px 且 `overlap=false`（收起 stack=116 / 浮层 348 / 钉住 260，`termH` 只在钉住态为 260 ✓）；ttyd 探测四例（候选命中 / PATH 兜底找到只在 `~/.bun/bin` 的二进制 / 不存在 / **无执行位报 EACCES** ✓）；真开终端 → ttyd 起在隔离端口 7950、iframe 挂载正常；**detached 存活实测**：父进程 `kill -9` 后子进程 `ppid=1` 并在父死后 6 秒写出结果；**扳机端到端**：POST 后 preflight → stage → install → build 全过，release 真 stage 进沙箱，界面实时显示阶段与进度条、运行中「更新到最新」按钮自动禁用，**到 build 即掐断，绝不让它走到 switch**（沙箱 label 是不存在的 `...-UITEST-nonexistent`，双保险）。收尾：实例/ttyd/browser session/沙箱目录全清，prod 复核 517 节点 / 44 会话 / 0 streaming、`current` 未动、`auth ON`。
- **一次自摆乌龙**: 第一次量重叠时同步改 `style.bottom` 立刻读 rect，得到「改前也不重叠」的假结论 —— 是我自己加的 `transition-[bottom]` 让读到的是动画起点。关掉过渡 + 等一帧才拿到真值。**给元素加过渡后，同步测几何就不可信了。**
- **合并与上线（同日）**: `wolffish` → `main`（`--no-ff` 合并 `e67e0d7`），推送 `56619dd..e67e0d7`；`make deploy` 上线 `20260728T185244-e67e0d729`。**上线后核验**：`/` 401 · `/login` 200 · `/settings` 401 · `/api/update` 401（后两条正是 RCE 入口该有的样子）；`{gate:up, next:ready, auth:on}`；release 里三个新文件都在、构建产物含 `--trellis-term-stack`；**tmux 两个终端跨部署存活且 `created` 时间戳未变**；517 节点 / 44 会话 / 0 streaming；`previous` 指向 `...-56eb54b45` 可回滚。smoke 六条断言全过（含「无 cookie 的 `/api/sessions` → 401」与「prod ttyd 未受影响」）。用户已把 `TRELLIS_REPO_DIR` 写进 `~/.trellis/shared/.env.local`，**实测新进程 env 里读到了**（`ps -E` 核）→ 设置页按钮可点。
- **注**: build 仍有两类既有告警（`globals.css` 的 `color-mix(in lab, …)` 解析告警、`next.config.ts ← lib/server/blobs.ts` 触发的 NFT「whole project traced」），S80 已记录，非本次引入。
- **Next**: 用户现场验收 —— 打开 ⚙ 设置页看版本与更新，右下角树面板与终端把手不再叠。下次上线可以直接在界面上点。

