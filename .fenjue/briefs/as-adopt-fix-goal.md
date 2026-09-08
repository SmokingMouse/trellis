目标：按异源复核报告返工「外部线程收编」，分支 feat/as-adopt（本 worktree，最新提交含 a3525a0 之后的裁决修订）。复核报告：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-adopt-review-d57c/out/review.md`（含复现脚本 `ownership-exact.ts`、`probe.ts` 与日志），原交付 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-adopt-a06a/out/result.md`，语义 `.fenjue/briefs/as-adopt-goal.md` + 裁决（只收编 ≥1 turn；系统兜底 workspace 不参与归属；取最长真实根；AS project 脚本断言限定 fixture 会话）。

## 必修（P1）

1. **P1-1 归属兜底复用了系统 workspace**（`lib/server/as-adopt.ts` 兜底分支用原始 cwd 精确查 workspaces 表，撞 UNIQUE 后把 `trellis:home` / `trellis:scratch` 的已有行原样返回）。修：兜底分支拿到已存在 workspace 时，若它属于系统 cluster（home / scratch / external 或任何非真实项目），不复用，改为在「外部会话」项目下归属（另建一条或把 cwd 记在会话上，二选一写明）。单测必须覆盖 **cwd 正好等于系统根本身**（`/Users/smokingmouse`、已登记的 scratch 目录）→ 外部会话；复核的 `ownership-exact.ts` 在生产快照上跑必须全 PASS。
2. **P1-2 全量轮询成本**（每 1.5 秒对每个未墓碑线程 `thread/attach {sinceSeq:0}`，实测 98 线程 29.9 MB/轮）。修成增量：每线程记 cursor（sinceSeq）与 list 摘要（status / updatedAt / 最新 seq），一轮只 `thread/list` 一次，仅对「新出现」或「摘要有变化」的线程 attach 且 attach 用已记 cursor 增量；协议若有线程级变更通知则订阅替代轮询。稳态目标：无变化时每轮只有一次 `thread/list`、零 attach、字节量 < 100 KB。用复核的 `probe.ts` 或等价探针在常驻 daemon 上测修前/修后每轮字节量，两组数字写进 result。

## 顺手修（P2，写明处理）

- P2-1：真实项目根的定义收紧——只有 git 仓库 / worktree（路径下有 `.git` 文件或目录）或 Herdr 桥已知的 repo/worktree 才参与祖先匹配；`dir:/private` 这类非 git 目录项目不参与（cwd 在 /tmp 下的外部线程归「外部会话」）。单测覆盖。
- P2-2：兜底插入前对 cwd 做 realpath，与匹配侧一致，避免 symlink 双建。
- P2-3：线程关闭 / 会话删除时从 `this.turns`（及其它 per-thread map）清掉，避免只增不减。
- 复核「漏写的已知限制」一节：逐条要么修掉要么写进 result 已知限制。

## 验收

- `bunx tsc --noEmit`、`bun test` 全绿；新增单测覆盖上述每条。
- 统一前缀独占跑 `mobile-as-adopt.sh`、`mobile-as-project.sh`、`mobile-as-shadow.sh`、`mobile-herdr.sh` 各一次绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`），跑完确认 3471–3480 无监听、锁已清。
- 真机：对常驻 daemon（endpoint `~/.sm-toolkit/agent-server.sock.endpoint.json`，端口每次重启会变）建一条显式 model=sonnet 临时线程，cwd 用 `/Users/smokingmouse`（主目录本身）先跑一轮，在隔离实例（生产库快照、端口 3496、TRELLIS_AS_ADOPT=on）上验它归「外部会话」；结束 close 该线程。不碰 daemon 上别的线程（有坐席在跑）。
- **不要发 partial result**，中间只用 progress；全部绿后发唯一一封 result（done），附修前/修后探针数字、每条 P1/P2 的处理与证据。提交到 feat/as-adopt，工作树干净；不 push、不 PR、不部署。
