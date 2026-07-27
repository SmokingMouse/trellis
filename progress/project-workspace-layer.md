# S1：Project / Workspace 层级 + 工作区终端

> 脑爆日期 2026-07-27（Session 77）。上游讨论见 decisions/2026-07-27-project-workspace-layer.md。

## 目标

把 session 从「平铺 + 一个目录字符串」提升成 `Project → Workspace → Session` 三级，
并给每个 workspace 配一个持久终端，让**在 worktree 里并行开发**这件事能在 trellis 里跑完闭环。

## 判据（这是本设计最该盯的东西）

**不是「功能做完」，是「一周内 worktree 里的 session 数 > 0」。**

脑爆时查了真 DB：41 个 session，21 个纯 chat，project 只有 14 个散在 6 个目录，
其中 4 个不是 git repo；trellis 自己有 3 个 worktree（trellis / sole / trevally，同一 remote），
但 **3 个 project session 全在主 checkout，worktree 里一个都没有**。

也就是说：worktree 并行开发现在 100% 在 CLI 里发生，trellis 从没承接过。
所以 S1 不是「修一个坏掉的东西」，是「把一个现在在别处跑得挺顺的工作流搬进来」——
搬不动就是失败，功能做完了也算失败。

用户明确指认的**必要条件是终端**（「验证得在原地做」），diff / git 操作被终端顺带吃掉，不单独做。

## 数据模型：加两表，一列都不改

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,        -- 显示名，默认从 remote/basename 派生，可改
  git_remote  TEXT,                 -- 归一化 remote，自动聚类的 key；非 git 为 NULL
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX projects_remote ON projects(git_remote) WHERE git_remote IS NOT NULL;

CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,       -- worktree 用分支名，否则 basename
  path         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,       -- main | worktree | plain
  git_branch   TEXT,                -- 缓存，轮询刷新
  created_by   TEXT NOT NULL,       -- trellis | discovered ← 决定能不能删磁盘
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
```

### `sessions.workspace_path` 保留不删 —— 本设计最重要的一条

它是 spawn cwd 的唯一真源（`lib/paths.ts:18` `sessionCwd`），
且 cli-import 反向从 jsonl 的 `cwd` 推它（`lib/server/cli-import-db.ts:175`）。

`workspace_id` 只是**新增的归属指针**，不是替代。这样 S1 对
spawn / resume / 前缀 jsonl 分叉（claude）/ 前缀 rollout（codex）这四条最脆的链路**零改动**。
那四条是 S31–S76 攒出来的，不该为了做分组去动。

代价：`path` 与 `workspace_path` 有冗余，靠「创建 session 时从 workspace 取 path 写进 workspace_path」+
「workspace 路径不可变」保持一致。可接受——workspace 改路径本就等于换一个 workspace。

### 迁移

启动 migrate 时按现有 distinct `workspace_path` 建 project / workspace 并回填 `workspace_id`。
chat（path=NULL）不归组，侧栏仍单列 Chat 组。幂等，沿用 `sqlite.ts` 现有的
`pragma_table_info` 探测 + `ALTER TABLE ADD COLUMN` 模式。

## 自动聚类规则

对每个 distinct path 依次尝试：

1. `git -C <path> rev-parse --git-common-dir` —— **worktree 的关键**，同 repo 所有 worktree 共享它
2. `git -C <path> remote get-url origin` → 归一化（剥 `.git`、ssh/https 统一）→ project key
3. 有 common dir 无 remote → 用 common dir 路径当 key（纯本地 repo 也能聚）
4. 非 git → 父目录路径当 key；`~/.trellis/scratch/*` 特判归「暂存区」

实测在真实数据上的落点：`trellis`+`sole`+`trevally` → 1 个 project；`~/.claude` → 1 个；
`documentary` / 两个 scratch / `~` 走兜底。

## 终端

> **架构被推翻过两次。** ①「trellis 反代 `/term/*`」——Next/bun 都做不到 WS
> （见下表）。② 退而求其次的「iframe 直连 127.0.0.1 + 远程降级面板」——
> 用户一句话打回：「**不应该是作为一个接口吗，怎么使用的这个平台，就怎么使用终端？**」
> 这句是对的：那版把终端做成了旁路（独立端口 + 直连 + cloudflared 加路由 +
> 降级面板 + `isLocalHost` 分支），全是为绕开「Next 不能升级 WS」而长出来的
> **偶然复杂度**。正确解是把限制本身解决掉 —— 换掉大门。

```
:PORT  server.ts（Bun.serve = trellis 的大门）
   ├─ /term/*  →（校 trellis_auth cookie）→ ttyd 127.0.0.1:<ttydPort>
   │                                          └─> tmux new -A -s ws-<id>-<n> -c <path>
   └─ /*       → next start 127.0.0.1:<PORT+99>（只绑本机，外面看不见）
```

**同一个域名、同一个端口、同一个 cookie 闸；本机与远程是同一个 URL、同一条代码
路径。** 前端 iframe 的 src 就是 `/term/?arg=…`，没有任何 isLocal 分支。
cloudflared 一行不用改（它本来就指向 `localhost:3088`）。

净效果是**减代码**：删掉 `isLocalHost`、`RemoteFallback` 降级面板、
直连 127.0.0.1 的 iframe、API 里外露的 ttyd 端口、`start=0` 那个补丁参数。

部署面零改动：launchd plist 调的是 `bun --bun run start -- -p 3088`，
只把 `package.json` 的 `start` 从 `next start` 改成 `bun server.ts`（它认 `-p`）。
`next start` 变成大门拉起的子进程，它挂了大门跟着 exit，交给 launchd 重拉。

### 反代为什么不可能（2026-07-27 三层实测）

| 探针 | 结果 |
|---|---|
| `next.config` rewrites 反代 WS | ❌ HTTP 200 通，**WS upgrade 不透传**，客户端零数据 |
| custom server 手动 `upgrade` pipe | ❌ 字节层通了（ttyd 的 `101 Switching Protocols` + WS 帧都到了代理），**但发不回客户端** |
| 定性：bun `node:http` 的 upgrade socket | ❌ `writable=true`、`write()` 返回 `true`、**客户端收到 0 字节**，静默吞 |
| 同一段代码换 node v24.14.1 | ✅ 两次写入客户端都收到 |

**与 `Bun.spawn({pty:true})` 同一种病**：API 在、报成功、什么也不做。
Next 的 route handler 也不能升级 WS。**所以 WS 只能由 Next 之前的一层来处理。**

而 **`Bun.serve` 自己的原生 WebSocket 是好的**（实测：经它转发到 ttyd，
shell 真执行了命令）。坏的只是 bun 对 node:http 的兼容层。这就是换大门的依据。

### 大门的三条承重属性（都已实测，缺一不可）

| 属性 | 结果 |
|---|---|
| WS upgrade 转发 | ✓ 消息级转发到 ttyd，shell 真执行命令 |
| **SSE 增量流式** | ✓ 合成源 12/413/815/1217/1618ms vs 直连 8/408/810/1211/1613ms（~4ms 开销）；真 `/api/chat` 49 个 delta 跨 1154ms。**trellis 整个对话是 SSE，被缓冲就全瘫** |
| POST 请求体 | ✓ 透传（需 `duplex: "half"`） |

### 差点上 prod 的一个 bug：gzip 头必须重写

bun 的 `fetch` **会自动解压**上游响应，而且它自己会加 `Accept-Encoding`
（所以哪怕客户端没要压缩，上游也可能返回 gzip）。把响应头原样贴回去 =
客户端收到「声称是 gzip 的明文」+ 对不上的 `Content-Length`。

**curl 默认不解压所以完全看不出来（一路 200），浏览器当场白屏卡死。**
第一次浏览器实测就是挂在这儿，而此前所有 curl 验证都是绿的。
修法：转发响应时删掉 `content-encoding` / `content-length` / `transfer-encoding`
三个头，由 Bun.serve 这层重新生成。

**教训**：代理层的验证不能只用 curl —— 它和浏览器的 `Accept-Encoding` 行为不同，
恰好绕开了这类 bug。

### 安全

- ttyd 仍**只绑 `127.0.0.1`**，只有大门够得着。
- `/term/*` 在大门里校 `trellis_auth` cookie（与 `proxy.ts` 同一套判据：
  `TRELLIS_AUTH_PASS`/`TOKEN` 任一缺失则闸关）。**proxy.ts 那个 middleware
  管不到 `/term`**（它不经 Next），所以闸必须在大门自己把一遍 —— 实测无 cookie
  与假 cookie 都 401，本机与隧道皆然。
- 大门问 ttyd 端口的内部接口 `/api/terminals/port` 同样盖在 Next 的闸下面；
  大门把**调用方那份已验证的 cookie** 透传下去，而不是在闸上开一个
  「内部 header 免验」的口子（那种口子外部可以伪造）。
- `-a`（`--url-arg`）让浏览器端可传任意 args 给 tmux —— 现在它在 cookie 闸后面，
  等价于「已认证用户能拿到 shell」，而 trellis 本就是
  `--dangerously-skip-permissions` 级执行面（`proxy.ts:5-8` 自陈），不新增攻击面。
  **但 S4（多租户）一旦启动，`-a` 必须去掉**换服务端签名 token。
- 形态见下面「P1'' 交互返工」：默认 Quake 浮层（零常驻占用），可钉住成底部通栏分栏。
  `⌃\`` 开关；高度可拖（全局偏好）；开合状态 per-workspace；钉住是全局偏好
- chat session 无 workspace → 无终端

### 每个 workspace 可开任意多个终端

一个 workspace 一个终端是不够的（跑着 dev server 就没法再跑 test）。多终端几乎白送——
已实测的 `tmux new -A -s <name>` 换个名字就是一个新终端。

- **命名**：`ws-<workspace-id>-<n>`，n = 当前该 workspace 下最大序号 + 1
- **一个终端 = 一个独立 tmux session = 一个独立 iframe**（不是 tmux window）。
  选 session 而非 window，是因为 tab 切换要归 trellis 管、不能让用户去学 `⌃b n`；
  而 session 方案下 URL 换个 arg 就完事，与已实测机制完全一致。
- **面板顶部一条 tab 栏**：`[bash 1] [bash 2] [+]`，行内 ✕ 关闭
- **只挂载当前激活 tab 的 iframe，其余卸载**。卸载会断开 ttyd 连接，但
  **tmux session 仍活着、重连复用**（已实测：断开后 `tmux ls` 存活，同名重连创建时间不变），
  所以状态不丢。避免 N 个 iframe 常驻吃内存。

**终端列表不入 DB —— `tmux` 本身就是真源。**

`tmux list-sessions -F '#{session_name}'` 按前缀 `ws-<workspace-id>-` 过滤即得当前终端列表。
好处：零 schema、trellis 重启后自动恢复、与用户在 CLI 里手动开的 tmux session 天然一致，
且不存在「DB 说有 3 个但 tmux 里只剩 1 个」的漂移。

- 新建 = 直接连一个新名字的 URL（ttyd 的 `tmux new -A -s` 自动创建）
- 关闭 = `tmux kill-session -t ws-<id>-<n>`
- 用 `list-sessions -F` 而非裸 `tmux ls`（后者输出格式是给人看的，解析脆）

显示名先用 `bash 1/2/3`，**重命名留后**（YAGNI；真需要时 `tmux rename-session` 也是白送）。

### 已实测钉死（2026-07-27，全部真跑）

| 事实 | 证据 |
|---|---|
| **单 ttyd 可服务任意多 workspace** | `ttyd -a -W tmux new -A -s` + URL `?arg=<name>&arg=-c&arg=<cwd>` |
| 各自 cwd 独立 | ws-A 提示符 `/tmp/wsA`、ws-B `/tmp/wsB`；`mark.txt` 真落在 wsA |
| 断开后 session 存活 | 客户端全断开后 `tmux ls` 两个 session 都在 |
| 同名重连复用而非新建 | ws-A 二次连接后创建时间仍是 16:19:16，会话数仍为 2 |
| **node-pty 在 bun 1.3.14 下不可用** | `chmod +x spawn-helper` 后不再报 `posix_spawnp failed`，但 `onData` 永不触发、8s 超时零输出；同代码 node v24.14.1 下正常 |
| **`Bun.spawn({pty:true})` 是假的** | 不报错，但 `tty` 返回 `not a tty`，字段被静默忽略 |

后两条合起来 = **终端不可能跑在 trellis 进程内**（trellis 必须 `bun --bun`，`bun:sqlite` 是 Bun-only
builtin，Makefile:5-9）。另有独立约束：Next App Router 的 route handler 不能升级 WebSocket。

### 已知坑（实现时必踩）

1. **ttyd 启动到真正 bind 有 ~3.5s 延迟**（实测 16:19:01 启动 → 16:19:04 `Listening on port`）。
   boot 时不能 `sleep 1` 就认为好了，要轮询探活。
2. **ttyd 读 `http_proxy`**，本机 clash 污染会让它刷 `lws_set_proxy: http_proxy needs to be ads:port`
   （不致命但刷屏）。拉起时清 `http_proxy/https_proxy/ALL_PROXY`，`no_proxy='*'`。
3. **iframe 键盘边界**：`⌃\`` 能开但**关不掉**——iframe 内的键盘事件不冒泡到父文档。
   S70 为 Excalidraw 建的 `[data-keys-yield]` 让位机制对 iframe **无效**（那是同文档内方案）。
   解法：关闭靠面板外的按钮 / 拖拽边缘，或从 ttyd 侧注入 postMessage。
4. 交互 shell 里 `tmux` 被 oh-my-zsh 插件函数遮蔽（`_zsh_tmux_plugin_run: command not found`）。
   代码里走绝对路径 `/opt/homebrew/bin/tmux`，别依赖 PATH 解析。

## UI

- 侧栏三级：Project → Workspace → Session；Chat 仍单列一组
- workspace 行显示 git 状态（branch + dirty 数 + ahead/behind），
  `git status --porcelain=v2 --branch` 轮询 5s，**仅当前展开的 project**
- `[+ 新建 workspace]` → 表单（分支名 / 从哪个 ref 起）→ `git worktree add`
- 终端底部分栏（见上）

### 两条已定的产品规则

- **新 workspace 落同级兄弟目录**（`/python/learning/<name>`）。理由：现有 `sole`/`trevally`
  就这么放，`git worktree add` 默认行为也是；集中到 `~/.trellis/worktrees/` 会让在 CLI 里 cd 不方便，
  而用户明确还会用 CLI。
- **「移除」与「删除」分开**：移除只删 trellis 记录；删除才动磁盘，走 `git worktree remove`，
  未提交改动拒删。`created_by=discovered` 的只能移除、不能删。
  **两种操作都要连带 `tmux kill-session` 掉该 workspace 名下所有终端**——否则 tmux 里堆一地
  指向已消失目录的孤儿 session，而 tmux 是终端列表的真源，脏了就一直脏。

## 不做（YAGNI）

- **diff 视图** —— 终端里 `git diff` 就是一条命令，用户已确认不需要
- **git 操作按钮**（commit/push/merge）—— progress S69–S76 显示这些基本都是叫 agent 跑的，UI 是伪需求
- **workspace 改路径** —— 换路径 = 换 workspace
- **project 手动创建 / 拖拽归组** —— 先看自动聚类够不够，被绊到再加

## 风险

1. **判据可能不达标**：做完了但仍然 `cd trevally && claude`。缓解 = 先交最小闭环再看数据，
   别一次把 UI 打磨到底。
2. **ttyd 是新的常驻进程**：trellis 崩了 ttyd 可能变孤儿。boot 时按端口/进程名清理旧实例。
   注意 **tmux session 刻意不在 boot 时清**——它们的存活正是「重启不丢终端」这个特性本身。
3. **git 轮询开销**：限制在展开的 project、5s、`--porcelain=v2` 单次调用；无 workspace 展开时不轮询。

## 分期

- **P0 ✅ 已落地（Session 77）**：两表 + 迁移 + 自动聚类 + 侧栏三级（不含 git 状态、不含终端）
- **P1 ✅ 已落地（Session 77）**：终端（ttyd 懒启动 + iframe 直连 + 底部分栏 + 多终端 tab）
- **P2**：git 状态角标 + 新建/回收 workspace

P0+P1 交付后停下来看一周数据，再决定 P2 和 S2/S3/S4。

---

## P0 落地记录（Session 77）

### 实现与设计稿的三处偏离（都是实测逼出来的）

1. **`projects.cluster_key` 与 `git_remote` 拆成两列**。设计稿原写 `git_remote` 当唯一键，
   但非 git 目录与无 remote 的本地 repo 都没有 remote，用它当键这两类无法去重。
   现在 `cluster_key` 是去重键（`remote:<归一化>` / `gitdir:<common-dir>` / `dir:<父目录>`），
   `git_remote` 只存真实 remote 供显示。

2. **加了「兄弟 worktree 主动扫描」**（设计稿原把它归在 P2 的「新建/回收」里）。
   理由是它**直接决定判据能不能达成**：实测发现只按「有 session 的目录」聚类时，
   trellis 项目下只显示主 checkout —— `sole`/`trevally` 因为一个 session 都没有而被过滤掉，
   而那恰恰是脑爆时钉死的现状。侧栏不显示这些 worktree，用户就没有新的可供性，
   「一周内 worktree 里的 session 数 > 0」直接落空。
   现在 `listSiblingWorktrees` 走 `git worktree list --porcelain`，
   扫出来的行 `created_by='worktree-scan'`，**即使 0 session 也显示**（灰显 + `worktree` 标签）。

3. **workspace 名用目录 basename 而非分支名**。实测 `~/.claude` 会显示成 "master"，
   而目录明明叫 `.claude`。分支随时会切、且 P2 本就要单独显示分支，名字该锚定目录。

### 关键实现纪律

- **`ensureWorkspaceForPath` 有纯 SELECT 快路径**：已登记目录直接返回，一个 git 子进程都不 spawn。
  这条是硬要求 —— `cli-sync-watcher` 每次 jsonl 变动都会走到它（流式期间每秒多次）。
  代价是 `git_branch` 只在首次登记与启动扫描时刷新；P0 不显示分支，P2 会带自己的轮询。
- **归组解析一律在 DB 事务外**（会 spawn git，放事务里白握写锁）。
- **归组失败永不上抛**：`resolveWorkspaceId` 吞异常返回 null。归属是分组视图的锦上添花，
  绝不该把「创建会话」这条主链路带崩。
- **`sessions.workspace_id` 用 `ON DELETE SET NULL`**（非 CASCADE）：移除 workspace 不连坐删会话历史，
  它们仍持有 `workspace_path`、仍能正常 resume，只是回到未归组。这是「workspace_path 才是真源」
  在删除路径上的体现。
- **过滤 `<repo>/.claude/worktrees/agent-<hash>`**：那是 Claude Code 给 `isolation: "worktree"`
  subagent 开的临时目录，机器生成、用完即删。实测本机 trellis repo 的 `git worktree list`
  里就有两条，不滤会在侧栏堆一地看不懂的哈希、且很快变成指向已删目录的死行。

### 新增/改动文件

| 文件 | 内容 |
|---|---|
| `lib/server/project-cluster.ts` 🆕 | `clusterPath` / `normalizeRemote` / `listSiblingWorktrees`，纯 git 推断层 |
| `lib/server/workspaces.ts` 🆕 | `ensureWorkspaceForPath` / `registerSiblingWorktrees` / `listProjectTree` / `backfillWorkspaces` |
| `scripts/test-project-cluster.ts` 🆕 | 26 项回归（临时目录现造 repo/worktree，不依赖本机恰好有哪些仓库）。跑法：`bun --conditions react-server scripts/test-project-cluster.ts` |
| `lib/server/sqlite.ts` | 两表 + `sessions.workspace_id` 幂等 migration |
| `lib/server/repo.ts` | `ApiSession.workspaceId` + 两处创建流接线 + `resolveWorkspaceId` |
| `lib/server/cli-import-db.ts` / `cli-sync-watcher.ts` | cli-import 两条路径接线（upsert 用 COALESCE 防解析失败清空已有归属） |
| `instrumentation.ts` | boot 时 `backfillWorkspaces()` |
| `app/api/sessions/route.ts` | 随主列表带回 `projects` 骨架 |
| `components/SessionSidebar.tsx` | 三级渲染 + `GroupRow` + 折叠持久化 + 未归组组 |
| `lib/types.ts` | `ProjectSummary` / `WorkspaceSummary` / `Session.workspaceId` |

### 验证（隔离实例 :3170 + 真 DB 副本沙箱，真库零触碰已核实）

tsc ✓ / lint 32 = 基线 ✓ / worktree 独立 build ✓ / 聚类回归 26 项 ALL PASS。

- **回填**：18 session / 8 目录，二次跑 0（幂等）；35 个活跃 session 完全对账
  （归组 12 + chat 21 + 未归组 2）
- **聚类落点**：`trellis`+`sole`+`trevally` → 一个 project（remote 认亲，三者路径无公共前缀）；
  `~/.claude` → 一个；scratch 两个 → 「暂存区」；`~` → 「主目录」；
  `documentary`（目录已删）+ 一条无 cwd 的存量 project 行 → 「未归组」不隐藏
- **浏览器 DOM 级核验**：缩进 项目 6px / 工作区 16px / 其下会话 28px / chat 平铺 12px；
  worktree 标签、分支进 tooltip、空工作区灰显且三角 opacity=0 且 `cursor-default`（不给假开关）
- **交互**：项目折叠 → 子树隐藏 + 角标「3」+ 写 localStorage；reload 后仍折叠；
  工作区级折叠同样成立；点击嵌套三层下的会话正确加载（头部 `Project · trellis`）
- **闭环**（最关键一项）：用 mock provider 在 `trevally` worktree 里真发一轮 →
  `created` 事件当场带 `workspaceId` → 侧栏该 worktree 从「0 会话灰显」变成「1 个会话」并挂上新行

### 已知遗留

- 「未归组」组里混了两类（目录已删 / 存量行本就没记 cwd），文案没区分，暂不细分。
- 空 worktree 只在**启动时**扫描；在 CLI 里新 `git worktree add` 之后要重启 trellis 才出现。
  真变成痛点再加 watcher 或手动刷新按钮。

---

## P1 落地记录（Session 77）

### 开工第一件事：架构被自己的实测推翻

spec 原本画的是「trellis 在 cookie 闸后反代 `/term/*`」。开工先打这个洞，
三层探针一层比一层往下（详见上面「反代为什么不可能」表），结论是
**bun 的 `node:http` upgrade socket 写不回客户端**——与 `Bun.spawn({pty:true})`
同一种病：API 在、报成功、什么也不做。改成 iframe 直连 `127.0.0.1:<port>`。

教训：spec 里那条「App Router 不能升级 WebSocket」的约束我当时写下了，
却没和自己画的反代架构图对上。**约束与架构图要当场对账**，别等开工才发现打架。

### 新增/改动文件

| 文件 | 内容 |
|---|---|
| `lib/server/ttyd.ts` 🆕 | ttyd 进程生命周期：二进制探测（绝对路径，绕开 oh-my-zsh 对 `tmux` 的函数遮蔽）、清代理变量、端口选择、**孤儿收尸**、轮询探活 |
| `lib/server/terminals.ts` 🆕 | tmux 为真源的终端列表：`listTerminals` / `nextTerminalSession` / `killTerminal` / `killWorkspaceTerminals` |
| `app/api/terminals/route.ts` 🆕 | GET（列表 + 懒启动 ttyd，`start=0` 只读）/ POST（分配 session 名）/ DELETE（kill-session） |
| `components/TerminalPanel.tsx` 🆕 | 底部分栏 + tab 栏 + 拖拽调高 + `⌃\`` + 远程降级面板 |
| `components/LinearThreadView.tsx` / `Canvas.tsx` | 加 `bottom` / `paddingBottom: var(--trellis-term-h)` 让出面板高度 |
| `app/page.tsx` | 挂载 TerminalPanel |

### 实现中改掉的两处「自己写错」

1. **`nextTerminalSession` 的注释在说谎**。原注释写「max+1 是为了不复用刚死掉的名字」——
   实测关掉 #2 后新开的就是 2，max+1 根本不保证这个。它真正买到的是**不与活着的
   session 撞名**：用 count+1 时，若留着 #1 #2 而杀掉 #1，count+1=2 正好撞上活的 #2，
   而 ttyd 的命令是 `tmux new -A -s`，同名会 **attach 到已有 session** ——
   用户点「+」拿到的是现有终端的副本而不是新终端。已按实测改写注释。
2. **远程降级面板没兑现承诺**。设计说「给出在本机接管**这个**终端的确切命令」，
   但远程路径压根没拉列表（`!local` 直接 return），只能显示干巴巴的 `tmux ls`。
   修法：远程也拉列表，但带 `start=0` 只读、不触发 ttyd 懒启动
   （远程连不上 127.0.0.1，为它启进程纯属浪费）。

### 补上的一个真泄漏

spec 写了「boot 时按端口/进程名清理旧实例」，实现时漏了，实测当场暴露：
**杀掉 trellis 后 ttyd 不会跟着死**，留在原端口 LISTEN 变孤儿；下次启动
`pickPort` 跳过被占端口漂到 7682 —— 每重启一次泄漏一个进程 + 一个端口。
补 `reapOrphans()`：按 `pgrep -f "ttyd .*titleFixed trellis"` 签名清理
（`titleFixed trellis` 是我们自己下发的 client option，够独特，不误杀用户自己的 ttyd）。
实测：2 个孤儿被收，端口回到 7681，且**tmux session 全部存活**。

### 验证（隔离实例 :3170 + 真 DB 副本沙箱，真库零触碰已核实）

tsc ✓ / lint 32 = 基线 ✓ / worktree 独立 build ✓。

**API 层**：ttyd 懒启动（GET 才拉起，端口 7681、cwd 正确）· POST 分配 `ws-<uuid>-1`
且服务端刻意不建 session（tmux 里此刻仍空，ttyd 连上时才建）· 连上后 cwd 实测
落在 trevally · 第二个终端序号递增 · **两终端互相隔离**（#2 看不到 #1 的变量）·
**断开重连状态不丢**（`SURVIVOR=ZEBRA9` 跨重连仍在）· DELETE 真 kill-session ·
**前缀闸挡住非 `ws-` 的 session**（手建的 `my-own-work` 杀不掉）·
空洞场景 max+1 给出 3 而非撞上活的 2。

**浏览器层**：面板在 trevally 会话下打开，终端提示符是真实的
`~/python/learning/trevally trevally !12 ?9`（真 worktree + 真分支 + 真 git 状态）·
**在面板里真敲 `git branch --show-current && bun --version` → `trevally` / `1.3.14`** ·
composer 正确让位到面板之上 · 「+」开第二个 tab、切换 tab、
**切回 bash 1 时之前的命令历史完整还在**（iframe 卸载重挂 + tmux 重连复用）·
关 tab 真 kill-session · 收起面板（iframe 卸载、CSS 变量归 0、把手回来）·
**真键盘 ⌃\` 重开**（CSS 变量回 260px）· chat 会话完全没有终端入口 ·
**局域网 IP 访问渲染降级面板**且给出确切的 `tmux attach -t ws-…-1`。

**跨重启**：杀 trellis → 收尸 ttyd → 重启后，`tmux capture-pane` 里仍留着
浏览器那轮敲的命令与输出 = 「重启不丢终端」端到端成立。

### P1' 追加：换大门（同 session，用户打回「终端应该是接口」之后）

新增 `server.ts`（Bun.serve 大门）+ `app/api/terminals/port/route.ts`（大门问端口的内部接口）；
`package.json` 的 `start` 改指大门；`components/TerminalPanel.tsx` 删掉
`isLocalHost` / `RemoteFallback` / 直连 iframe；`app/api/terminals/route.ts` 不再外露 ttyd 端口，
改回 `ready: boolean`，并删掉 `start=0` 那个为降级面板打的补丁。

**顺带修好的一件事**：诊断中发现 **cloudflared 隧道压根没建立连接**
（`does not have any active connection`），整条隧道上 15 个服务全 530 ——
「远程访问不了」的直接原因其实是这个，不是终端。`launchctl kickstart -k
gui/$(id -u)/com.smokingmouse.cloudflared` 后恢复。cloudflared 版本 2026.3.0
已过期（官方建议 2026.7.3），**是否是它导致连接失效未查**，下次再断先看这条。

**验证**：tsc ✓ / lint 32 = 基线 ✓ / build ✓。
本机与隧道两条路径上 `/` 401、`/login` 200、`/term/` 401 全部一致；
隧道上 `--compressed` 拿到完整明文 HTML（gzip 修复的远程验证）；
关闸实例上 `/term/` HTTP 200、`/term/ws` WebSocket 真 shell（`git branch --show-current`
→ `trevally`）、真 `/api/chat` SSE 49 delta 跨 1154ms 未被缓冲；
浏览器实测页面正常渲染、iframe src = `/term/?arg=…`（同源、无 127.0.0.1）、
终端里保留着重连前的输出。

### P1'' 交互返工 + P2 提前（同 session，用户三条反馈）

**① 终端改 Quake 浮层 + 可钉住**（用户：「终端最好还是别放在底下，有没有更轻量优雅的」）。
默认浮层：`⌃\`` 唤出，悬右下、圆角带阴影、对话从四周透出，**`--trellis-term-h` 恒为 0
= 内容区零常驻让位**（这就是「更轻」的全部含义）。点标题栏的钉住 → 变回底部通栏分栏，
内容区让位，与对话并排（保住用户最初选它的理由：一边看 agent 输出一边跑测试）。
钉住是**全局偏好**不是 per-workspace —— 它回答「我习惯哪种形态」。
浮层刻意 `bottom: 88` 抬到 composer 之上：盖住对话是 Quake 终端的常态，
盖住输入框不行，那是收起终端后马上要用的东西。
标题栏必须常显 ✕ —— 焦点一进 iframe，`⌃\`` 和 Esc 都到不了父文档。

**② 侧栏**：宽度可拖右边缘（160–420，localStorage 持久化）；`--trellis-sb` 的所有权
从 `page.tsx` 移到 `SessionSidebar`（宽度一旦可变，两处按常量各发一份必然打架）；
Chat 与「未归组」也可折叠（用合成 id `__chat` / `__orphans` 复用 projects 那套
collapsed 集合，不再开第二份状态）。

**③ worktree 创建/删除**（原划在 P2，用户提了才发现判断错了 —— 侧栏显示了 worktree
却不能在里面新建，它就只是个只读装饰）。`POST /api/workspaces/worktree`：
已有同名分支直接检出、否则 `-b` 新建，落**主 checkout 的同级兄弟目录**，
`created_by='trellis'`。`DELETE`：**未提交改动默认拒删**并回传脏文件清单，
`force=1` 才真删；删前先 `killWorkspaceTerminals` —— 这正好接上了 P1 留的那个悬空调用点。
UI 只给 git 项目挂「+」，只给 `created_by='trellis'` 的 worktree 挂删除
（用户自己在 CLI 里建的不给删磁盘的按钮）。

**验证**：tsc ✓ / lint 32 = 基线 ✓ / build ✓ / 隔离实例 :3170 —— 浮层态圆角+`--trellis-term-h`
为 0、钉住后圆角消失+让位 260px+左缘对齐侧栏、取消钉住回浮层；侧栏拖 210→310 且 reload
保持（把手实测在 x=205–209，4px 宽）；Chat 折叠子项隐藏；「+」只出现在 trellis/.claude
两个 git 项目上；**真 UI 里填分支名回车 → 磁盘目录 + 分支 + 侧栏行三者同时出现**；
删除被脏改动拦下（回传 `?? DIRTY.txt`）、`force=1` 后目录消失且该 workspace 的
tmux 终端连带清零、`git worktree list` 干净。

### 已知遗留

- ~~`killWorkspaceTerminals` 已就绪但还没有调用点~~ —— 已在 worktree 删除路径接上。
- 移动端不显示终端面板（`md:` 以下隐藏）。手机上没有终端的使用场景。
- 面板只对当前会话所属 workspace 生效；切到别的 workspace 会重新拉列表，
  这是对的（终端属于工作区不属于会话），但切换时有一次短暂的「启动终端…」。
