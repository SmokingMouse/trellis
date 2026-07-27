# 2026-07-27 · Project / Workspace 成为一等实体，终端走 ttyd + tmux 外部进程

## Context

用户提出四条想法：① 一个项目开多个 workspace 并行开发，但 trellis 现在以目录为基础管理
② 侧栏按实际项目分组 ③ Agent 管理（配置 Agent 及其背后的 `.claude`：复用本机 / 上传 CLAUDE.md / 技能）
④ 多租户，镜像隔离，或本地环境与远程镜像做映射。

现状实测：`Session ──(workspace_path: 绝对路径字符串, 创建时锁死不可改)──> 文件系统`，
完全平铺。无 `projects` 表、无任何分组外键；侧栏只按 mode 二分（chat / project），
组内 `ORDER BY updated_at DESC`；Agent 配置是散在 `sessions` 表上的列
（`system_prompt` / `model` / `require_approval` / `lineage_isolation`），无可复用的配置档实体；
`~/.claude` 全靠 `os.homedir()` 硬拼，无 `CLAUDE_CONFIG_DIR` 引用；
认证是单密码全有全无，无 users 表。

## Decision

### 1. 四条 = 一个抽象缺口的四个症状，拆成四个子项目

缺的是把「执行环境」提升为一等实体：`Project → Workspace → Session → Node`。

| 子项目 | 对应 | 依赖 |
|---|---|---|
| **S1** Project/Workspace 层级 + 工作区终端 | ①②的地基 | — |
| **S2** Workspace 生命周期（git worktree 主动管理） | ① 的深化 | S1 |
| **S3** Agent 配置档 | ③ | S1 |
| **S4** Runtime 隔离 + 多租户 | ④ | S1+S3 |

**本轮只做 S1**，其余挂 mid-term。详细设计见 [project-workspace-layer.md](../project-workspace-layer.md)。

### 2. trellis 与 harbor 保持独立，不互相借力

用户拍板：两个项目独立开发。（harbor 已有 `Agent = device+backend+model+permission+workdir`
配置绑定、`--isolation worktree`、跨设备派活、审批队列、cron，与 ③④ 高度重叠，
但不走「trellis 借 harbor 能力」这条路。）

### 3. S1 数据模型：加两表，一列都不改

新增 `projects` / `workspaces` 两表 + `sessions.workspace_id`。
**`sessions.workspace_path` 保留不删** —— 它是 spawn cwd 的唯一真源（`lib/paths.ts:18`），
且 cli-import 反向从 jsonl 的 cwd 推它。`workspace_id` 只是新增的归属指针。

这样 S1 对 spawn / resume / claude 前缀 jsonl 分叉 / codex 前缀 rollout 这四条最脆的链路**零改动**。

### 4. 终端走 ttyd + tmux 外部进程，不在 trellis 进程内实现

trellis cookie 闸后反代到 `127.0.0.1` 上的单个 ttyd；
`ttyd -a -W tmux new -A -s` + URL arg 传 session 名与 cwd。

### 5. 终端列表不入 DB，`tmux` 本身是真源

`tmux list-sessions -F '#{session_name}'` 按 `ws-<workspace-id>-` 前缀过滤即得。
零 schema、重启自动恢复、与用户在 CLI 里手开的 session 天然一致、无 DB↔tmux 漂移。

### 6. 判据不是「功能做完」，是「一周内 worktree 里的 session 数 > 0」

## Rationale

**为什么终端是 S1 的一部分而不是可选项**：用户明确指认它是「把开发活挪进 trellis」的必要条件
（「验证得在原地做」）。而真 DB 数据显示 —— 41 个 session、21 个纯 chat、project 仅 14 个散在
6 个目录（4 个非 git repo）；trellis 自己有 3 个 worktree 同 remote，
但 **3 个 project session 全在主 checkout，worktree 里一个都没有**。
即：worktree 并行开发现在 100% 在 CLI 里发生，trellis 从没承接过。
S1 是「搬工作流」不是「修 bug」，搬不动就是失败——所以判据定成行为指标而非交付物清单。

**为什么终端必须在进程外**（实测，非训练记忆）：

| 探针 | 结果 |
|---|---|
| `node-pty` under bun 1.3.14 | ❌ `chmod +x spawn-helper` 后不再报 `posix_spawnp failed`，但 `onData` 永不触发、8s 超时零输出 |
| 同代码 under node v24.14.1 | ✅ `/dev/ttys059`、exit=0 |
| `Bun.spawn({pty:true})` | ❌ 不报错但 `tty` 返回 `not a tty`，字段被静默忽略 |

trellis 必须跑 `bun --bun`（`bun:sqlite` 是 Bun-only builtin，Makefile:5-9），
所以 bun 下无可用 pty = 进程内方案不可能。另有独立约束：
Next App Router 的 route handler 不能升级 WebSocket（现全走 SSE）。

**为什么 diff 视图 / git 操作按钮不做**：终端把它们吃掉了（`git diff` 就是一条命令）。
且 progress S69–S76 显示 git 动作基本都是叫 agent 跑的，操作按钮是伪需求。

## Alternatives considered

- **trellis 吃掉 harbor（长出调度层）** —— rejected：用户拍板两项目独立。
- **终端用 node sidecar（node-pty + xterm.js + WS）** —— rejected：自研量最大
  （重连/滚动缓冲/resize/持久化全自己写）+ 引入 bun/node 混跑长期税。
  对一个「先验证会不会用」的功能不成比例。node v24 下 node-pty 可用已实测，此路技术上可行，
  仅因成本被否——若将来 iframe 观感割裂成为真痛点，这是既定的升级路径。
- **终端用 tmux 轮询桥（send-keys + capture-pane）** —— rejected：零新依赖、与现有 SSE 架构同构，
  但不是真终端；跑 `bun test` 够用，第一次想 debug 就破功——而 debug 正是用户选终端的理由。
- **S1 只做导航整理（推断层 + 改侧栏，零 schema）** —— rejected：用户选了「承接 worktree 并行开发」，
  要真实体 + git 集成。
- **终端拆成 S1.5 单独一轮** —— rejected：用户已明确终端是挪进来的必要条件，
  S1 单独交付 = 做完仍然 `cd trevally && claude`。
- **一个 workspace 一个终端** —— rejected（用户当场推翻）：跑着 dev server 就没法再跑 test。
- **多终端用 tmux window 而非 session** —— rejected：tab 切换该归 trellis 管，
  不能让用户去学 `⌃b n`；session 方案下 URL 换个 arg 就完事。
- **终端列表存 DB** —— rejected：会与 tmux 真实状态漂移，且平白多一张表。

## Consequences

**已知影响**
- 新增外部依赖 `ttyd`（`brew install ttyd`，1.7.7）。`tmux` 本机已有（3.6a）。
- trellis 多一个常驻子进程（ttyd）需要生命周期管理。
- 存量 41 个 session 需要迁移回填 `workspace_id`（幂等，沿用现有 `pragma_table_info` 探测模式）。

**风险**
- 判据可能不达标：做完仍然回 CLI。缓解 = P0+P1 交付后停一周看数据再决定 P2 和 S2/S3/S4。
- `-a`（`--url-arg`）让浏览器端能传任意 args 给 tmux。放在 cookie 闸后
  = 「已认证用户能拿到 shell」，而 trellis 本就是 `--dangerously-skip-permissions` 级执行面
  （`proxy.ts:5-8` 自陈），**不新增攻击面**。
  **但 S4（多租户）一旦启动，`-a` 必须去掉**，换服务端签名的 session token。
- `sessions.workspace_path` 与 `workspaces.path` 冗余，靠「workspace 路径不可变」保持一致。
