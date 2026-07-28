# Session Log

最近 5 条，倒序（Session 80 / 79 / 78 / 77 / 75）。更早的见 `archive.md`。

### Session 80（2026-07-28，侧栏三级层次重排 + workspace 空层平铺）
- **触发**: 用户贴侧栏截图，只说了五个字「显示效果很差，层次结构」。
- **根因（量出来的，不是审美判断）**: 三级树的视觉权重**倒挂** —— Project `12.5px/medium/ink-strong`、Workspace `11px/normal/ink-muted`、Session `12.5px/normal/ink-muted`，**子级比父级还重**；行高同向倒挂（group 24px < session 28px）。三个放大器叠上去：① 缩进只有 6/16/20px，三级几乎共线；② group 行通栏而 session 行是内缩 pill，宽度打架；③ 每行一个 8px 满色 mode dot，成了整栏最强视觉元素，把层次压平。
- **Done ①（视觉层）**: 层次改由「缩进 + 引导线 + 字重」承担，**字号退出**（三级统一 `text-ui`）。新增 `ROW_H`/`PAD()`/`CHEVRON_MID()` 几何常量 + `IndentGuide`（子树左侧竖引导线，对齐父行三角中心 —— 这是三级树能被一眼分组的关键）；行高统一 26px、全部改通栏 pill（高亮不再随层级越缩越窄）；权重阶梯 `semibold/ink-strong` → `medium/ink` → `normal/ink-muted`；mode dot 8px 满色 → 6px `opacity-55`；分组间距 `mb-1.5` → `mb-3`。
- **Done ②（信息架构，用户看完第一版后拍板「展开平铺吧」）**: **workspace 那一层显不显示，取决于它携不携带信息**，而不是层级图上画了几层。三种零信息情形折叠成两级：`trellis:scratch`（`mellow-lynx-90` 这类名字从随机词表拼出）、`trellis:home`（workspace 名就是项目名「主目录」的另一种说法）、唯一 workspace 且与项目同名（`.claude` → `.claude`）。**刻意排除 `kind === 'worktree'`** —— 那说明项目在多工作区并行，层级是真的，所以 trellis 自己保持三级。规则**可逆**：多出第二个 workspace 自动恢复。两个兜底：平铺后 path 没别处可看 → 挪进 project 行 tooltip；**零会话不平铺**，否则剩个底下空无一物的项目行。
- **顺带**: 两个 cluster key 提到 `lib/types.ts` 共享（`project-cluster.ts` 带 `server-only` 不能给客户端 import，原先是字面量散在两处）。
- **验证**: `tsc --noEmit` 零错 ✓；lint 无新增（1 项既有 `set-state-in-effect` 基线）；**真 DB 起 dev 实例 :3199 浏览器实测**：明暗两套主题各截图核验（两级引导线均渲染、权重不再倒挂）；平铺后暂存区/`.claude`/主目录三个项目变两级而 trellis 保持三级；折叠开关在平铺项目上仍正常（折叠隐藏 / 展开还原，行数对得上）；点平铺出来的会话正常加载且 header 仍显示 workspace 名（信息未丢）。实例与 browser session 已清理。
- **注**: `scripts/test-project-cluster.ts` 在 worktree 裸 `bun` 下跑不起来（`server-only` 解析报错），**stash 后基线同样失败 = 预存在的环境问题**，非本次引入。
- **Next**: 已 commit + 合并 main + 推送；prod 生效需 `make deploy`。

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

### Session 78（2026-07-27，流式渲染风暴修复）
- **触发**: 用户报「swift-wren-91 这个项目的 tab 点不开了」+ 顺手审 bug。定位到根因不是侧栏/标签页逻辑（行可点、onPreview/onPin 全对），而是**流式期间 UI 被卡死**——点下去主线程在忙，表现像「点不开」。
- **根因（真 DB + 真会话探针坐实）**: swift-wren-91 是暂存区下的 workspace（非 project），挂 1 个 project 模式 session（7a720cc6…），末节点 bef90d7d 有 **195 个 tool calls（392KB）+ thinking 34KB+**，整 session 接口 2.6MB。流式期间每个 SSE 事件（catchup / tool_call_start / done / update）都用展开语法 `{ ...s.nodes, [id]: {...} }` 替换**整个 `nodes` 对象**，而 `LinearThreadView`（`s.nodes`）与 `Canvas`（`s.nodes`）都订阅整个对象 → 每事件「全树重渲 + 全图重布局」。实测 30s 内 96 个事件持续轰击，且流式时 `TurnCard` 每帧对**整段** response 跑 `rehypeHighlight`（几百 KB）→ 主线程卡死。run 结束后（14 done / 2 error / 0 streaming）tab 恢复正常，但下次长流式必复现。
- **Done（1+2 治本，挡住渲染风暴）**:
  - **① tool_call 类事件合批提交**（`stores/sessionStore.ts`）：新增 `scheduleNodePatch` + 每帧一次 `set()` 的微调度（`PENDING_NODE_PATCHES` 缓冲 + `requestAnimationFrame` flush，单帧多节点折叠成一次 store 通知）。`catchup` / `tool_call_start` / `tool_call_done` / `tool_call_update` 四类高频事件改走合批；`done`/`error`/`interaction_required` 等终端事件仍即时提交（状态翻转要立刻反映，且不在高频路径）。`emitStream` 的 thinking/delta 本就绕过 React state 直推，不受影响。
  - **② 流式态不跑 rehypeHighlight**（`components/TurnCard.tsx`）：`REHYPE_STREAMING` 从 `[rehypeHighlight]` 改成 `[]`，高亮只在 done 态（`REHYPE_FULL`）跑一次——这是单帧最大头，流式高亮性价比极低（与当年跳过 rehypeRaw 同一逻辑）。
  - **③ TurnCard 加 React.memo**：线性 thread 订阅整个 `nodes`，合批后仍每帧一次重渲；memo 后仅引用变化的（流式）节点重渲，其余 15 张已完成卡（含 `REHYPE_FULL` 高亮）直接跳过。
  - **Canvas 侧**：`ChatNode` 本就 `memo` + 自定义比较器（只看 `data.node` 引用），所以合批后只有正在流式的那张卡重渲，其余 15 张不重渲；`layoutKey` 只跟 status/拓扑走，tool_call 事件不触发 dagre 重布局——画布侧天然已免疫大半，未再改动。
- **验证**: `tsc --noEmit` 全量零错 ✓；lint 无新增（仅 3 项既有 `set-state-in-effect` 基线警告，非本次引入）。
- **遗留 / 可选后续（未做，按性价比排序）**: ① 大 response 流式时 `liveThinking` 全文灌 DOM 仍可能卡（34KB+），可加截断/虚拟化；② 错误节点 4aaedfa1（ConnectionRefused）的 response 里混进原始 `<thinking>…` 标签，done 态 rehypeRaw 会当真 HTML 处理（目前没崩但是脏数据 + 潜在异常源），可在写入侧拦一道 + 清存量；③ 给渲染层加 error boundary，防组件崩溃白屏。
- **Next**: 用户现场验收——开一个长流式 project 会话（或重放 swift-wren-91），边流边切 tab / 切画布应不再卡死。改动在 main 工作区未提交。

### Session 77 (2026-07-27)

**上下文（原 README `## Current Focus` 首段，原样迁入）**

**S1：Project/Workspace 层级 + 工作区终端（Session 77，脑爆完成，设计已定，未开工）** → [设计稿](project-workspace-layer.md) / [ADR](decisions/2026-07-27-project-workspace-layer.md)。用户提四条想法（多 workspace 并行 / 侧栏按项目分组 / Agent 与 .claude 配置管理 / 多租户与镜像隔离），判定为**同一个抽象缺口的四个症状**——缺把「执行环境」提升为一等实体，拆成 S1（层级+终端）/ S2（worktree 生命周期）/ S3（Agent 配置档）/ S4（隔离+多租户），本轮只做 S1。**用户拍板 trellis 与 harbor 独立开发**（harbor 已有的 Agent 配置绑定 / worktree 隔离 / 跨设备派活与 ③④ 高度重叠，但不走借力路线）。**关键实测（真 DB + 真探针）**：① 41 session 里 21 个纯 chat、project 仅 14 个散在 6 个目录（4 个非 git repo），trellis 自己 3 个 worktree 同 remote 但 **3 个 project session 全在主 checkout、worktree 里一个没有** → worktree 并行开发 100% 在 CLI 里发生，S1 是「搬工作流」不是「修 bug」，故**判据定为行为指标：一周内 worktree 里的 session 数 > 0**；② **node-pty 在 bun 1.3.14 下不可用**（chmod +x spawn-helper 后不再报 posix_spawnp，但 onData 永不触发、8s 零输出；同代码 node v24.14.1 正常）+ **`Bun.spawn({pty:true})` 是假的**（tty 返回 not a tty）→ 终端不可能跑在 trellis 进程内；③ **单 ttyd 服务多 workspace 成立**（`ttyd -a -W tmux new -A -s` + `?arg=<name>&arg=-c&arg=<cwd>`，两 workspace cwd 各自独立、断开后 tmux session 存活、同名重连复用创建时间不变）。**设计要点**：加 `projects`/`workspaces` 两表 + `sessions.workspace_id`，**`workspace_path` 保留不删**（它是 spawn cwd 唯一真源，保住 spawn/resume/claude 前缀 jsonl/codex 前缀 rollout 四条脆链零改动）；project 靠 `git rev-parse --git-common-dir` + remote 归一化自动聚类；终端 = cookie 闸后反代到单个 ttyd，**每 workspace 可开任意多终端**（`ws-<id>-<n>` 各自独立 tmux session），**终端列表不入 DB，`tmux list-sessions -F` 就是真源**（零 schema、重启自恢复、无漂移）；底部分栏 + tab 栏，只挂载激活 tab 的 iframe（卸载断连但 tmux 存活、重连复用）。**分期** P0 数据模型+侧栏三级 / P1 终端（判据靠它不能砍）/ P2 git 状态+新建回收，**P0+P1 后停一周看数据**再决定 P2 与 S2/S3/S4。**Next**：开工 P0。

- **Done**: **工作平台化脑爆 → S1 设计定稿（未写一行产品代码）**。用户提四条想法（多 workspace 并行 / 侧栏按项目分组 / Agent 与 .claude 配置管理 / 多租户与镜像隔离），判为同一抽象缺口的四个症状 → 拆 S1–S4，本轮只做 S1。产物：[project-workspace-layer.md](project-workspace-layer.md)（设计稿）+ [decisions/2026-07-27-project-workspace-layer.md](decisions/2026-07-27-project-workspace-layer.md)（ADR）+ Goals 新增「工作平台化」区 + 3 条 Verified Facts。
- **Decisions**: ① **trellis 与 harbor 独立开发**（用户拍板，不走借力路线）；② 加两表一列不改，**`sessions.workspace_path` 保留**以保住四条脆链零改动；③ 终端走 **ttyd + tmux 外部进程**（因 bun 无 pty）；④ **终端列表不入 DB，`tmux list-sessions -F` 是真源**；⑤ **每 workspace 可开任意多终端**（用户当场推翻我原设计的「一个」——跑着 dev server 就没法再跑 test）；⑥ 判据定为行为指标而非交付物。
- **验证**: 全部实测非推断——真 DB 查 session/workspace_path 分布（41 session / 6 目录 / 4 个非 git）、`git worktree list` + remote 核实自动聚类可行、node-pty 在 bun vs node 双跑对照、`Bun.spawn({pty:true})` 证伪、`brew install ttyd` 后**双 workspace WebSocket 真连测**（各自 cwd / 断开存活 / 重连复用创建时间不变）。探针环境已清理（kill-server + 删 /tmp 产物），ttyd 保留在 `/opt/homebrew/bin/ttyd`。
- **踩到的坑（已写进 Verified Facts）**: node-pty 的 spawn-helper 无执行位；ttyd bind 有 3.5s 延迟（第一次探针 `sleep 1.5` 抢跑失败）；ttyd 吃 `http_proxy` 被 clash 污染；`tmux` 被 oh-my-zsh 函数遮蔽；iframe 键盘不冒泡致 `⌃\`` 只能开不能关。
- **注**: 顺带核实 prod 鉴权闸是开的（本地 `curl` 401）——测绘 subagent 曾据 launchd plist 无 `TRELLIS_AUTH_PASS` 报警说闸可能是关的，实测证伪。但 `https://trellis.smokingmouse.cc` 返回 **530**（cloudflared 那头没通），与本次工作无关，未处理。
- **Next**: 开工 S1 P0（两表 + 迁移回填 + git 自动聚类 + 侧栏三级）。当前分支 `trevally`，除本轮三个 progress 文件外无代码改动，未 commit。
- **追记（同 session，S1 P0 已落地）**: 见下一条 Session 77 P0 记录 —— 脑爆与实现在同一 session 内接续完成。

### Session 77 · S1 P0（2026-07-27，接上条脑爆）
- **Done**: **Project/Workspace 三级层级落地**（详细记录见 [project-workspace-layer.md](project-workspace-layer.md) 的「P0 落地记录」）。新增 `lib/server/project-cluster.ts`（git 推断层）+ `lib/server/workspaces.ts`（读写层）+ `scripts/test-project-cluster.ts`（26 项回归）；`sqlite.ts` 两表 + `sessions.workspace_id` 幂等 migration；`repo.ts`/`cli-import-db.ts`/`cli-sync-watcher.ts` 四条创建流接线；`instrumentation.ts` boot 回填；`/api/sessions` 带回 `projects` 骨架；`SessionSidebar` 三级渲染 + 折叠持久化。
- **与设计稿的三处偏离（实测逼出来的）**: ① `cluster_key` 与 `git_remote` 拆两列（原设计用 remote 当唯一键，非 git 与无 remote 的本地 repo 无法去重）；② **加了兄弟 worktree 主动扫描**（原归 P2）——实测只按「有 session 的目录」聚类时 trellis 项目下只剩主 checkout，`sole`/`trevally` 被 0-session 过滤掉，而那正是判据要打的地方，不扫等于判据必败；③ workspace 名用目录 basename 而非分支名（`~/.claude` 会显示成 "master"）。
- **关键纪律**: `ensureWorkspaceForPath` 有**纯 SELECT 快路径**（cli-sync-watcher 高频调用，流式期间每秒多次，不能 spawn git）；归组解析一律在事务外；归组失败吞异常返回 null（绝不带崩创建会话主链路）；`workspace_id` 用 `ON DELETE SET NULL` 不连坐删历史；过滤 `<repo>/.claude/worktrees/agent-*`（Claude Code subagent 的临时隔离目录，本机 trellis repo 实测有两条）。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / worktree 独立 build ✓ / 聚类回归 26 项 ALL PASS / 隔离实例 :3170（真 DB 副本沙箱）——回填 18 session·8 目录且幂等、35 session 完全对账（归组 12 + chat 21 + 未归组 2）、聚类落点全对（三 worktree 认亲成一个 project）、浏览器 DOM 级核验缩进与状态、折叠+持久化+三层下点击跳转、**闭环：mock provider 在 trevally worktree 真发一轮 → `created` 事件当场带 workspaceId → 侧栏该 worktree 从「0 会话灰显」变「1 个会话」**。真库零触碰已核实（无 projects 表、session 数仍 41）。
- **Next**: **P1 终端**（ttyd boot + `/term` 反代 + 底部分栏 + 多终端 tab）—— 判据靠它。P0 未 commit。

### Session 77 · S1 P1 终端（2026-07-27，接上条）
- **Done**: **工作区终端落地**（详细记录见 [project-workspace-layer.md](project-workspace-layer.md) 的「P1 落地记录」）。新增 `lib/server/ttyd.ts`（进程生命周期 + 孤儿收尸）+ `lib/server/terminals.ts`（tmux 为真源的列表层）+ `app/api/terminals/route.ts` + `components/TerminalPanel.tsx`（底部分栏 + 多终端 tab + 拖拽调高 + ⌃` + 远程降级）；`LinearThreadView`/`Canvas` 加 `var(--trellis-term-h)` 让位（与 `--trellis-sb` 同一套 CSS 变量模式）。
- **架构被自己的实测推翻一次**: spec 原画「trellis 在 cookie 闸后反代 `/term/*`」，开工先打这个洞 → 三层探针证明 **bun 的 node:http upgrade socket 写不回客户端**（详见 Verified Facts）→ 改 **iframe 直连 `127.0.0.1:<ttyd 端口>`**，安全靠「ttyd 只绑 127.0.0.1、远程连不上」而非 cookie 闸，远程渲染降级面板并给出确切的 `tmux attach -t <session>`。**教训：spec 里写下的约束要与自己画的架构图当场对账**——那条「App Router 不能升级 WebSocket」当时就在文档里，却没和反代图对上。用户在三个备选（直连 / Bun.serve 前置代理 / 第二个 tunnel hostname）里拍板直连。
- **改掉两处自己写错的东西**: ① `nextTerminalSession` 的注释在说谎（原写「max+1 为了不复用死名字」，实测关掉最大号再开就是复用；它真正买到的是**不与活着的 session 撞名**——count+1 在序号有空洞时会撞上活的，而 `tmux new -A -s` 同名会 attach 到已有 session，用户点「+」得到的是副本不是新终端）；② 远程降级面板没兑现「给出接管这个终端的确切命令」（远程路径没拉列表只能显示 `tmux ls`）→ 加 `start=0` 参数让远程只读列表、不触发 ttyd 懒启动。
- **补一个真泄漏**: spec 写了 boot 清理旧实例但实现时漏了。实测**杀掉 trellis 后 ttyd 不跟着死**，孤儿占着端口逼新实例漂到 7682，每重启泄漏一个。补 `reapOrphans()` 按签名清理；**tmux session 刻意不清**（那正是「重启不丢终端」）。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / build ✓ / 隔离实例 :3170 —— API 十项（懒启动、cwd 落点、序号递增、双终端隔离、断开重连状态不丢、DELETE、前缀闸挡住手建 session、空洞场景 max+1 不撞活的）；浏览器十一项（真提示符含真分支真 git 状态、**面板里真敲 `git branch --show-current && bun --version` 得 `trevally`/`1.3.14`**、composer 让位、多 tab 切换后命令历史完整还在、关 tab 真 kill、收起/⌃` 重开、chat 会话无入口、局域网 IP 触发降级面板并给出确切 attach 命令）；跨重启 `capture-pane` 仍留着浏览器那轮的输出。真库零触碰已核实。
- **遗留**: `killWorkspaceTerminals` 已就绪但无调用点——workspace 移除/删除是 P2，届时必须接上，否则 tmux 里堆孤儿。
- **Next**: 用户现场验收（本机开一个 project 会话 → ⌃` → 跑测试）。P0+P1 均未 commit。**按计划应停下来看一周数据**（判据 = worktree 里的 session 数 > 0）再决定 P2 与 S2/S3/S4。

### Session 77 · P1' 换大门：终端变成同源接口（2026-07-27，用户打回后重做）
- **触发**: 用户验收时报「终端访问不了，我希望的效果是能远程访问」，并给出判据性的一句 —— **「不应该是作为一个接口吗，怎么使用的这个平台，就怎么使用终端？」**。这句话是对的：P1 那版把终端做成了**旁路**（独立端口 + iframe 直连 127.0.0.1 + 打算给 cloudflared 加路由 + 远程降级面板 + `isLocalHost` 分支），全是为绕开「Next 不能升级 WS」长出来的偶然复杂度。正确解是解决限制本身 —— **换掉大门**。
- **诊断顺带修好一件更大的事**: `cloudflared tunnel info` 显示隧道 **`does not have any active connection`**，整条隧道上 15 个服务全 530 —— 用户「远程访问不了」的直接原因其实是这个，跟终端无关。`launchctl kickstart -k gui/$(id -u)/com.smokingmouse.cloudflared` 后全部恢复（trellis 401 / memos 200 / ip 200）。cloudflared 2026.3.0 已过期（建议 2026.7.3），**是否是它导致连接失效未查**，下次再断先看这条。
- **Done**: 新增 `server.ts` —— Bun.serve 当大门：`/term/*` 校 cookie 后转发 ttyd（HTTP + WS），其余全部转发给内部端口（`PORT+99`，只绑 127.0.0.1）上的 `next start` 子进程。`package.json` 的 `start` 从 `next start` 改成 `bun server.ts`（认 `-p`），**launchd plist 一个字不用改**。新增 `/api/terminals/port` 供大门问端口。前端**净减代码**：删 `isLocalHost` / `RemoteFallback` / 直连 iframe / API 外露端口 / `start=0` 补丁参数，iframe src 变成同源 `/term/?arg=…`，本机远程同一条路径。
- **差点上 prod 的 bug（已写进 Verified Facts）**: bun 的 `fetch` 自动解压上游响应且自带 `Accept-Encoding`，原样透传响应头 = 客户端收到「声称 gzip 的明文」。**curl 默认不解压所以一路 200 全绿，浏览器白屏卡死** —— 第一次浏览器实测才暴露。修法是转发时删 `content-encoding`/`content-length`/`transfer-encoding`。教训：代理层的验证不能只用 curl。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / build ✓；本机与隧道两条路径 `/` 401、`/login` 200、`/term/` 401 完全一致；隧道上 `--compressed` 拿到完整明文 HTML；关闸实例上 `/term/ws` WebSocket 真 shell（`git branch --show-current` → `trevally`）+ 真 `/api/chat` SSE 49 delta 跨 1154ms 未缓冲；浏览器页面正常、iframe 同源、终端保留重连前输出。**无 cookie / 假 cookie 打 `/term/` 均 401**。
- **Next**: 用户远程验收（手机或公司机开 trellis → 任意 project 会话 → ⌃`）。**WS 经 Cloudflare 那一跳我没法自测**（需要登录态），是唯一未覆盖的一环。

### Session 77 · 交互返工三连 + P2 提前（2026-07-27，用户三条反馈）
- **① 终端改 Quake 浮层 + 可钉住**（「终端最好别放底下，有没有更轻量优雅的」）。默认浮层：`⌃\`` 唤出、悬右下圆角带阴影、对话四周透出，**`--trellis-term-h` 恒为 0 = 内容区零常驻让位**（这就是「更轻」的全部含义）；点钉住变回底部通栏分栏、内容区让位，保住用户最初选它的理由（一边看 agent 输出一边跑测试）。钉住是**全局偏好**（回答「我习惯哪种形态」）而非 per-workspace。浮层刻意 `bottom:88` 抬到 composer 之上——盖对话是 Quake 终端常态，盖输入框不行。
- **② 侧栏**：宽度可拖右边缘（160–420 + localStorage）；**`--trellis-sb` 的所有权从 page.tsx 移到 SessionSidebar**（宽度一旦可变，两处各按常量发一份必然打架）；Chat 与「未归组」也可折叠（合成 id `__chat`/`__orphans` 复用 projects 那套 collapsed 集合，不开第二份状态）。
- **③ worktree 创建/删除**（原划 P2；用户一提就发现原判断错了——侧栏显示了 worktree 却不能在里面新建，它就只是个只读装饰）。新 `POST/DELETE /api/workspaces/worktree`：已有同名分支直接检出否则 `-b` 新建、落主 checkout 同级兄弟目录、`created_by='trellis'`；删除**默认拒删有未提交改动**并回传脏文件清单，`force=1` 才真删，删前先 `killWorkspaceTerminals`——**正好接上 P1 留的那个悬空调用点**。UI 只给 git 项目挂「+」、只给 `created_by='trellis'` 的挂删除（用户自己在 CLI 建的不给删磁盘按钮）。
- **验证**: tsc ✓ / lint 32 = 基线 ✓ / build ✓ / 隔离实例 :3170 —— 浮层圆角 + 让位 0px、钉住后圆角消失 + 让位 260px + 左缘对齐侧栏、取消钉住回浮层；侧栏拖 210→310 且 reload 保持；Chat 折叠子项隐藏；「+」只出现在 trellis/.claude 两个 git 项目；**真 UI 填分支名回车 → 磁盘目录 + 分支 + 侧栏行三者同时出现**；删除被脏改动拦下（回传 `?? DIRTY.txt`）、force 后目录消失 + 该 workspace 的 tmux 终端清零 + `git worktree list` 干净。测试产物（两个探针 worktree 与分支）已清理。
- **Next**: 用户验收。P0/P1/P1'/本轮均未 commit（22 个文件，9 新增）。

### Session 77 · 性能排查：ttyd 互相残杀（2026-07-27，用户报「切 tab 和终端都得等好久」）
- **量了一圈，后端全是干净的**：大门 vs 直连内部 Next 的差是 **~1ms**（/login、静态 chunk、401 路径各 5 次取平均）；`/api/sessions` 9ms、`/api/sessions/<id>` 2ms、`/api/runs` 1ms、`/api/providers` 5ms；浏览器里真切一次 tab，全部请求 ≤ 27ms。gate 进程 FD 24、CPU 0.4%、无 CLOSE_WAIT，**无泄漏**。
- **找到并修掉一个真 bug（我自己引入的）**：`reapOrphans()` 按命令行签名杀 ttyd，**认不出是哪个 trellis 实例的**。同时跑两个实例时（prod + 隔离测试实例，正是我这一路的状态），后启动的会把先启动的 ttyd 杀掉 → 用户的终端反复死亡重建。**判据改用 PPID**：父进程死后子进程被 reparent 到 launchd（PID 1），所以 `ppid == 1` 才是真孤儿；被活实例持有的 ttyd 其 ppid 是那个实例的 pid。实测双向都对：起第二个实例时 0 条收尸、第一个的 ttyd 存活；杀掉某实例后其 ttyd ppid 变 1，下一个实例启动时被正确收掉且不误伤活着的。
- **量到的真实成本（非 bug，是环境）**：**复用已有 tmux session 首字节 8ms，全新 session 588ms** —— 差的 580ms 全是交互式 zsh 启动（`zsh -i -c exit` 实测 0.53–1.15s，powerlevel10k 等配置）。所以只要终端不被杀就是瞬开；一被杀就每次重付。这条解释了「命令行得等好久」。
- **没能复现的**：「切 tab 得等好久」在隔离实例里复现不出来（所有请求 ≤ 27ms）。**待用户给更锐的信号**：是所有 tab 都慢还是只有 project tab、终端面板开着时才慢还是关着也慢、本机还是隧道。
- **追记（用户一句话点破根因）**：「是每次切换会默认创建命令行吗，命令行能改成点击才创建吗」—— 正是。`TerminalPanel` 里有一行「面板打开且列表为空就自动建一个」，理由是「别让用户对着空面板再点一次」。**那个理由建立在「创建很便宜」上，而实测创建要 588ms**，前提根本不成立。于是闭合成恶性循环：叉掉终端（=kill-session）→ 切到别的 workspace 再切回 → 列表为空 → 又自动建 → 每次重付 588ms，还在 tmux 里堆 session。**删掉自动创建**，空态改成一个居中的「新建终端」按钮（创建显式化之后，空态就得把「怎么建」摆在手边）。
- **三个症状是同一条因果链**：`reapOrphans` 杀掉别的实例的 ttyd → `state.port` 被清 → **每次 `/api/terminals` 都走完整 spawn（202ms）** → 终端列表空 → 自动创建（588ms）→ 每次切 tab 重演。修完实测：`/api/terminals` 稳态 **202ms → 6ms**；面板打开后终端数 0（不再自动建）；点「新建终端」才出 iframe；**来回切 workspace 终端数 3→3 不新增**，切回时 attach 已有 session。
- **`✕` 的语义已明确**：= `kill-session`，shell 状态会丢；「只是不想看」用右上角收起（收起 / 切 tab / 重启 trellis 都不杀 session）。tooltip 已写清。
- **再追记（用户仍报慢 + 「像是这次优化后才出现」）→ 根因是隧道绕美国，与代码无关**：
  - **代码侧全部洗清**（同一份构建、同 DB，大门 3170 vs 直连 Next 3271 干净 A/B）：单请求差 ~1ms；**30 并发** 大门 14ms / 直连 13ms（持平）；**浏览器首屏** load 64ms vs 70ms、25 个资源零个超 100ms；**真实切会话 2–3ms**（MutationObserver 等到内容渲染完，不是固定 sleep）。
  - **`https://trellis.smokingmouse.cc` 首屏 load 4857ms，本机 `127.0.0.1:3088` 64ms —— 76 倍。** 单请求 1463ms vs 2ms（TLS 532ms + 首字节 1192ms 全是网络往返）。同隧道的 memos 1.38s / ip 1.35s **一样慢 = 隧道问题不是 trellis 问题**。
  - **为什么绕**：cloudflared 报 `ORIGIN IP 120.235.172.206`（广东）但 `EDGE 1xlax01/1xlax05`（洛杉矶）；机器出口 IP `206.190.238.193`（美国，clash 代理出口）。于是「浏览器 →(美国出口)→ CF 洛杉矶 →(隧道)→ 本机广东」，**为访问本机服务绕两趟太平洋**。
  - **为什么"像是这次优化后才出现"**：隧道此前是**死的**（`does not have any active connection`，全站 530），是本 session 我 `launchctl kickstart` 修好的。修好前用户只能走 127.0.0.1（快），修好后一旦改用域名就吃这 1.4s/请求。**确实是我这轮引起的，但引起它的是「我修好了隧道」，不是代码。**
  - **用户追问「不应该是 trellis.home.smokingmouse.cn 吗」→ 查清了整张访问拓扑**（Verified Fact，别再猜）：
    - `trellis.home.smokingmouse.cn` 真实 A 记录 = **182.92.78.57（阿里云北京）**，那台机器就是 tailnet 里的 `aliyun`（100.77.207.43）——所以 `.cn` 的路径是「浏览器 →(clash 代理，美国出口)→ 阿里云北京 →(Tailscale)→ macmini 广东」，**三跳且绕美国**。它从来就不是本地路径。
    - **clash 是 TUN 模式全局劫持 DNS**（两个域名都解析成 fake-ip `198.18.0.x`，`dig @8.8.8.8` 也绕不开；真实记录要用 DoH 才查得到）；运行时规则里**没有任何 smokingmouse 条目**，兜底是 `MATCH,Proxy` → 两个域名统统从代理出去。
    - **Tailscale 一直在跑**（`macmini` 100.102.237.93 / `aliyun` 100.77.207.43 / iphone17 / macbook-pro）。
    - **五路实测**：`127.0.0.1` 2.3ms · 局域网 `192.168.10.134` 4.3ms · **Tailscale `100.102.237.93` 4.6ms** · `.cn` 326ms（首次冷握手 10.6s）· `.cc` 1241ms。
  - **结论/建议**：本机用 `127.0.0.1:3088`；**任何设备（手机/公司机/MacBook）只要在 tailnet 上就用 `http://100.102.237.93:3088` —— 4.6ms，与局域网同级，且不经任何第三方**。想继续用域名则需要两件事同时做：clash 加 `DOMAIN-SUFFIX,smokingmouse.cn,DIRECT`，且让该域名在 tailnet 内解析到 Tailscale IP（MagicDNS / split-DNS），否则 DIRECT 之后仍然是绕阿里云北京的 326ms。
- **已合并上线（同日）**：`trevally` → `main`（merge `4bf66ef`，`--no-ff` 保住工作线形状），主 checkout tsc ✓ + `make build` ✓；prod 交回 launchd（`launchctl load com.smokingmouse.trellis`），进程形态 launchd → `bun server.ts -p 3088`（大门）→ `next start -p 3187`（内部只绑 127.0.0.1）；验活 / 401 · /login 200 · /term/ 401。**未 push**（推送需用户签名授权）。
- **Cloudflare 隧道已按用户要求关闭**（`launchctl unload com.smokingmouse.cloudflared`，配置备份 `~/.cloudflared/config.yml.bak-20260727-213648`）。副作用：`files.smokingmouse.cc` 真掉线（`.cn` 侧 502 未配通）；`ip.smokingmouse.cc` 变 530 而 **blog-publish skill 有 5 处引用它**，下次发博客验活会报错（服务没死，`ip.home.smokingmouse.cn` 200，只是地址过时）。另一条隧道 `cloudflared-trader` 未动。访问路径见 `~/.claude/global/workspace.md` 新增的「对外访问路径」节。
- **Next**: 用户验收 + **停一周看判据**（worktree 里的 session 数 > 0）再决定 P2 与 S2/S3/S4。唯一未覆盖的验证：ttyd 在 launchd 环境下的懒启动（需登录态才触发，我测不到）。

### Session 75 (2026-07-26)
- **Done**: 修 ExitPlanMode 批准报 ZodError（详见 Current Focus）。用户带着「Trellis 与 Claude Code 协议版本偏差」的自诊来，**结论推翻了它**：是 Trellis 自己三处交互表单里唯独计划审批漏传 `updatedInput`。改 `components/InteractionForm.tsx`（真 bug）+ `lib/server/run-bus.ts`（resolver 兜底回填）+ respond route 的误导注释。
- **设计取舍**: 没有把 `lib/llm/types.ts` 的 `updatedInput?: unknown` 收紧成判别联合（allow 强制 record）——那样能在编译期拦住这类漏传，但 respond route 收的是不可信 HTTP JSON、终究要运行时校验一遍，而 run-bus 那道兜底已经把这个位置守死了。为编译期好看做一圈波及面更大的重构不划算，留作独立一刀。
- **验证**: 关键在**对照组**。第一次 A/B 用本机默认 CLI(2.1.207)跑，未修版竟然也全绿——说明测法当时**没有区分力**，差点误判「已修好」。查出本机是 2.1.207 而用户报错在 2.1.183，把 183 装进 `/tmp/cc183` 用 PATH 钉版本重打：未修版逐字复现用户的 ZodError + 模型重发 ExitPlanMode 卡死，修复版一次通过并续跑写文件。**教训**：跨版本 bug 的对照组必须钉住报障者的版本，否则"绿"毫无信息量。
- **未做**: 浏览器点击态验证被一个**既有的** dev-mode hydration 故障挡住（见 Open Failures），故改走 API 直打——反而更强，因为它直接复刻了老客户端的错误 payload，同时验到了服务端兜底。表单那一改属静态可核（与另两处已 work 的表单同构）。测完已清：dev server kill / 沙箱 DB 删 / 临时 workspace 删 / `/tmp/cc183` 删 / browser session close / `.next/dev` 残留清；prod :3088 复核仍 401 正常、`.next/BUILD_ID` 未变。
- **Next**: 用户决定是否提交（在 main 未提交，提交需先切分支）；要在 prod 生效需主目录 `make build` + `launchctl kickstart -k`。

