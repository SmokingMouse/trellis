# Session Log

最近 5 条，倒序（Session 83 / 82 / 81 / 80 / 79）。更早的见 `archive.md`。

### Session 83（2026-07-30，动线渲染重做：三类 task 分家 + 工具渲染注册表）
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
- **Next**: 浏览器人工验收（尤其流式态：面板自动展开、运行中子 Agent 自动展开、LiveHeader 取最深运行节点）。上线**必须先发 `@smokingmouse/agent@0.3.3`**，否则 release 装回 0.3.2 → Workflow 面板降级成原始视图（分类不塌，前缀链兜得住）。

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

### Session 81（2026-07-28，工作区选择器加「新建文件夹」）
- **触发**: 用户「指定 Project 目录时，能增加一个功能，新建文件夹吗」。摸清现状：选择器已有三条造目录/选目录的路（空白沙箱 = 随机名、worktree = 分支名且必须在 git 项目下、浏览/最近/手输 = 只能选已存在的），**唯独缺「我说在哪、我说叫什么」**——开新项目正是这个形状。
- **Done**: 新 `app/api/workspaces/mkdir/route.ts`（`POST {parent,name}` → 非递归 `mkdirSync`）+ `components/WorkspacePicker.tsx` 浏览 tab 工具栏加「＋ 新建文件夹」，展开行内表单（前缀显示当前目录、回车提交、Esc 取消），成功即 `onPick` 新路径并关窗——**创建后直接选用**，因为在这个 modal 里造目录的唯一理由就是拿它当 workspace。
- **闸**: 名字必须是**单个路径段**（含 `/` / NUL / `.` / `..` / 首尾空白 / >255 全拒），parent 必须绝对路径且实为目录；非递归 mkdir 让 EEXIST 冒出来成 409 而不是静默复用别人的目录；EACCES/EPERM → 403。
- **验证**: tsc ✓ / lint 32 = 基线 ✓；API 八例 curl 实测（正常、重复 409、`../escaped` 被拒且磁盘上确实没逃出去、空名、相对 parent、parent 不存在、只读 fs、中文名 ✓）；dev 实例 :3099 **浏览器真跑**：切 Project → 浏览 tab → 按钮在 → 输 `ai-coding` 得行内红字「已存在」→ 改新名回车 → 磁盘目录出现 + modal 关闭 + 工具栏 chip 变 `trellis-mkdir-uitest` + 「开始探索」解禁。测试目录/browser session/dev 实例均已清理，prod :3088 未触碰。
- **Next**: 用户验收。未 commit（`components/WorkspacePicker.tsx` + 新 route 目录）。上 prod 走 `make deploy`。

### Session 80（2026-07-28，侧栏三级层次重排 + workspace 空层平铺）
- **触发**: 用户贴侧栏截图，只说了五个字「显示效果很差，层次结构」。
- **根因（量出来的，不是审美判断）**: 三级树的视觉权重**倒挂** —— Project `12.5px/medium/ink-strong`、Workspace `11px/normal/ink-muted`、Session `12.5px/normal/ink-muted`，**子级比父级还重**；行高同向倒挂（group 24px < session 28px）。三个放大器叠上去：① 缩进只有 6/16/20px，三级几乎共线；② group 行通栏而 session 行是内缩 pill，宽度打架；③ 每行一个 8px 满色 mode dot，成了整栏最强视觉元素，把层次压平。
- **Done ①（视觉层）**: 层次改由「缩进 + 引导线 + 字重」承担，**字号退出**（三级统一 `text-ui`）。新增 `ROW_H`/`PAD()`/`CHEVRON_MID()` 几何常量 + `IndentGuide`（子树左侧竖引导线，对齐父行三角中心 —— 这是三级树能被一眼分组的关键）；行高统一 26px、全部改通栏 pill（高亮不再随层级越缩越窄）；权重阶梯 `semibold/ink-strong` → `medium/ink` → `normal/ink-muted`；mode dot 8px 满色 → 6px `opacity-55`；分组间距 `mb-1.5` → `mb-3`。
- **Done ②（信息架构，用户看完第一版后拍板「展开平铺吧」）**: **workspace 那一层显不显示，取决于它携不携带信息**，而不是层级图上画了几层。三种零信息情形折叠成两级：`trellis:scratch`（`mellow-lynx-90` 这类名字从随机词表拼出）、`trellis:home`（workspace 名就是项目名「主目录」的另一种说法）、唯一 workspace 且与项目同名（`.claude` → `.claude`）。**刻意排除 `kind === 'worktree'`** —— 那说明项目在多工作区并行，层级是真的，所以 trellis 自己保持三级。规则**可逆**：多出第二个 workspace 自动恢复。两个兜底：平铺后 path 没别处可看 → 挪进 project 行 tooltip；**零会话不平铺**，否则剩个底下空无一物的项目行。
- **顺带**: 两个 cluster key 提到 `lib/types.ts` 共享（`project-cluster.ts` 带 `server-only` 不能给客户端 import，原先是字面量散在两处）。
- **验证**: `tsc --noEmit` 零错 ✓；lint 无新增（1 项既有 `set-state-in-effect` 基线）；**真 DB 起 dev 实例 :3199 浏览器实测**：明暗两套主题各截图核验（两级引导线均渲染、权重不再倒挂）；平铺后暂存区/`.claude`/主目录三个项目变两级而 trellis 保持三级；折叠开关在平铺项目上仍正常（折叠隐藏 / 展开还原，行数对得上）；点平铺出来的会话正常加载且 header 仍显示 workspace 名（信息未丢）。实例与 browser session 已清理。
- **注**: `scripts/test-project-cluster.ts` 在 worktree 裸 `bun` 下跑不起来（`server-only` 解析报错），**stash 后基线同样失败 = 预存在的环境问题**，非本次引入。
- **合并与上线（同日）**: `madtom` → `main`（`--no-ff` 合并 `56eb54b`，保住工作线形状），推送 `8f03bf9..56eb54b`；主 checkout tsc ✓ + build ✓ 后 `make deploy` 上线 `20260728T100813-56eb54b45`。**上线后核验**：`/` 401 · `/login` 200 · `/__gate/health` `{gate:up, next:ready, auth:on}`；release 目录里源码带新符号（`IndentGuide`/`isFlat`/`HOME_CLUSTER_KEY` 共 13 处）、构建产物含 `opacity-55`；真 DB 44 会话 / 517 节点 / 6 项目 / 13 工作区 / 0 streaming（与上线前一致）；**tmux 终端跨部署存活**。进程形态 launchd → `bun server.ts -p 3088` → `next start -p 3187`（只绑 127.0.0.1）。
- **自己踩了一次已记录在案的坑**: 核验时 `tmux list-sessions | wc -l` 得 0，差点写成「终端清零」——`tmux` 被 oh-my-zsh 函数遮蔽（facts.md 早有此条），走 `/opt/homebrew/bin/tmux` 才看到那个活着的 session。**验证命令也得挑真源**。
- **顺带记一笔（非本次引入）**: build 有两类既有告警，构建本身通过：① `globals.css` 里 `::highlight(branch-source)` 的 `color-mix(in lab, …)` 解析告警；② `next.config.ts` ← `lib/server/blobs.ts` ← `/api/uploads/[hash]` 这条链触发 NFT「whole project traced」告警（blobs 里有动态 fs 路径）。两者都在我改动之外，暂未处理。
- **Next**: 用户现场验收侧栏（浏览器强刷一次拿新 chunk）。

### Session 79（2026-07-28，上线机制重做：release 目录 + 原子切换 + 自动回滚 + 网关维护页）
- **触发**: 用户「现在自动更新机制做的不太友好，失败了平台就用不了了，并且更新过程中平台就不受控了」。查下来**根本不存在自动更新机制**——上线就是在 launchd 正在跑的那个目录里手工 `bun install` + `make build` + `kickstart`。用户四条痛点全选（失败不能致命 / 更新期间可控 / 可观测 / 要我批准），拍板接受确定停机窗口、**不做零停机热切**（理由见 decisions.md 2026-07-28）。
- **落地**:
  - **`scripts/deploy.ts`（新，十阶段）**：preflight（只读查活跃 run，有就拒绝，`--force` 才过）→ stage（`git archive` 到 `~/.trellis/releases/<ts>-<sha>`）→ install → build → **smoke**（真 DB 的 `VACUUM INTO` 快照起临时实例，四断言 + 「没杀掉 prod ttyd」回归断言）→ backup → switch（原子换软链 + kickstart）→ verify → 失败自动 rollback → gc。全程写 `deploy-state.json` + 日志。
  - **`lib/deploy-state.ts`（新）**：部署脚本与网关之间的共享面。刻意不进 sqlite——网关要在「数据库那份代码本身可能就是坏的」时候还能工作。
  - **`server.ts`**：先占端口再拉 Next；Next 挂了退避重启而不是 `process.exit`（原来靠 launchd KeepAlive 无限 respawn，外面只剩 connection refused）；未就绪出 503 维护页（未认证只显示「正在更新」，sha/日志/回滚命令要认证——这台机器挂着公网隧道）；新增 `/__gate/health`；转发时改写 Host（见 facts.md 的潜伏坑）。
  - **`app/api/internal/shutdown`（新）**：排空钩子。做成**路由**而不是进程内 SIGTERM handler，因为 run-bus 的 `RUNS` 是模块级 Map，`instrumentation.ts` 里注册的 handler 未必和 route handler 处在同一个模块实例，拿错实例就是对着空 Map 排空。
  - **`lib/server/ttyd.ts`**：修 `reapOrphans` 误杀（facts.md 已改写原条目）+ 新增「接管自己上一条命留下的 ttyd」。
  - Makefile 加 `deploy`/`rollback`/`deploy-status`/`releases`/`install-launchd`；README 补「长驻部署与升级」。
- **验证（全程零触碰 prod：沙箱 `TRELLIS_DEPLOY_ROOT=~/.trellis-deploytest` + 独立 launchd label + :3999）**：
  - 正路径 ✓：11s 走完，**不可用窗口实测 ≤0.2s**（104 次 200ms 轮询里只有 1 次非 200，且是 **503 维护页而非连接被拒**）。
  - build 失败 ✓ / smoke 失败（启动即崩）✓：`current` 未动、prod 全程 200。
  - 切换后验活失败 → **自动回滚** ✓（构造「只在 launchd 环境下 `process.exit(3)`」的 commit，过 smoke 栽在 verify，回滚后 200）。
  - 维护页 ✓：未认证视图对 sha / 绝对路径 / rollback.sh / Error **四项 grep 全 0**；认证后 sha×2、rollback.sh×1；健康面未认证只给粗粒度。
  - ttyd ✓：隔离实例走完整 reap 路径后 prod ttyd（pid 25990）存活；优雅停机收走自己那个 + 清登记；SIGKILL 后重启**接管同一 pid**（9321），不泄漏不漂移。
  - `install-launchd` 的 plist 改写在副本上 dry-run 过（diff 只动一行，`plutil -lint` OK）。tsc ✓ lint ✓ build ✓。收尾已拆除沙箱 job/plist/目录与三个测试 commit，prod 核对 517 节点 / 0 streaming / tmux 存活 / :3088 200。
- **翻车与真收获**: 沙箱第一次 smoke 失败追了很久——现象是网关 `/login` 超时但 Next 直连正常。**一度误判成 http_proxy**（A/B 曾支持该假设，实为端口被上一轮残留进程占住造成的假信号；教训：每次 A/B 前必须 `lsof` 验端口空、`pkill` 后要确认真的死了）。加探针看到**一次 curl 触发 260 次 fetch handler**，才钉死真因是 Host 透传导致网关自我循环。
- **切 prod（同日，用户「开始吧」）**：main 快进合并 arrowworm（纯 FF）→ `make deploy` → `make install-launchd`。**真上线又踩出两个自家 bug，都已修 + 已写进 facts.md**：
  - **① `git archive` 带不走未跟踪文件 → 认证闸静默关掉**。凭证在 `.env.local`（bun 从 cwd 自动加载）里，被 gitignore 忽略，release 里没有 → `auth OFF`，而本机配着 3088 的公网隧道。**症状极隐蔽：服务活得好好的、页面全能开、健康检查全绿，唯一差别是日志一行 `auth ON`→`auth OFF`**——原来那套全是 200 断言，一个都发现不了。修：真源挪 `~/.trellis/shared/` + `linkShared()` 软链进每个 release；`/__gate/health` 加 `auth` 字段；smoke 改认证感知（带 cookie 验闸后页面）+ **反向断言「无 cookie 的 `/api/sessions` 必须 401」**；verify 断言「闸不许 on→off」。
  - **② `launchctl bootout` 异步，bootstrap 撞上未消失的旧 job** 报 `Bootstrap failed: 5: I/O error`，而失败分支只打印「用备份还原」却没真还原 → **prod 停了约一分钟**（手工 bootstrap 救回）。修：轮询到 job 真查不到再 bootstrap（带重试），失败时真的回滚 plist 并重新拉起。
  - **终态**：prod 跑在 `~/.trellis/current` → `releases/20260728T091203-23099f885`，`auth ON`、`/` 无 cookie 401、517 节点 / 44 会话 / tmux 终端存活；修复后完整重跑一遍 deploy 全绿（含新增的两条闸断言），**457 次轮询里只有 1 次非 200（0.2s 的 503 维护页）**。顺手清掉失去主人的旧 ttyd 25990（tmux 不受影响）。
- **Next**: 现场验收（开一轮对话 + 开个终端）。可选：把已完工的 Goals 块轮转进 archive（README 仍 12.5KB，Goals 占 11KB）；P2 新版本通知（cron + phone-push）未做。
