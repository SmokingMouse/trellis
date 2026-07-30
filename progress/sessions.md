# Session Log

最近 5 条，倒序（Session 84 / 83 / 82 / 81 / 80）。更早的见 `archive.md`。

### Session 84（2026-07-30，镜像会话的「永久正在生成…」— CLI 注入劫走回复）
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
