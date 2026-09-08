目标：把 agent-server daemon 上「不是 Trellis 开的线程」自动收编为主页会话，并且双向可用（主页能提问、答审批、中断；外部客户端继续用同一线程）。只读观察页 `/console/threads` 保留不动（后续单删）。

## 背景指针（先读，再动手）

- 第二步（Trellis 会话绑定 AS 线程，双向）：`lib/server/as-project.ts`（binding_type=thread、turn → 节点双写、双端审批、中断/重试/分叉、离线回退）、`app/api/chat/route.ts`、`app/api/nodes/[id]/{respond,stream,as}/route.ts`、`lib/server/as-client.ts`（AgentClient、游标、listThreads/attach）、`lib/as-config.ts`、`lib/server/repo.ts`。
- 影子只读（可复用的 fixture 与投影代码）：`app/api/as/threads/*`、`app/console/threads/page.tsx`、`components/ThreadLogView.tsx`、`lib/as-shadow.ts`、`lib/as-log.ts`、`scripts/mobile-verify/mobile-as-shadow.sh` + `as-shadow-fixture.ts`、`mobile-as-project.sh` + `as-project-fixture.ts`/`as-project-regression.ts`。
- Herdr 桥（repo/worktree 路径 → 用于 cwd 归属）：`lib/server/herdr-*.ts`。
- 协议：`vendor/agent-server`（as/1：thread/list、thread/attach、turn/start、thread/pendingRequests、serverRequest/resolved、thread/fork、thread/interrupt、thread/close）；文档 `/Users/smokingmouse/sm-toolkit/docs/agent-server/protocol.md`、`trellis-migration.md`（只读参考，不改 sm-toolkit）。
- 线上事实：常驻 daemon socket `~/.sm-toolkit/agent-server.sock`（launchd），token `~/.agent-server/token`；生产 Trellis 3088，配置真源 `~/.trellis/shared/.env.local`（TRELLIS_AS=on、TRELLIS_AS_PROJECT=on、TRELLIS_AS_PROJECT_ID=暂存区）。daemon 上现在约 86 条线程，2 条活着；**其中一条是正在跑的 fj codex 坐席线程（cwd 含 feat-ingress-fresh-start），绝对不要往它发输入、审批或关闭**。
- 手机脚本统一前缀：`env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`；现有脚本占端口 3471–3478 与互斥锁 `/tmp/trellis-mobile-verify.lock`。新脚本用 3479/3480，同一把锁。
- 隔离验证实例起法：sqlite `.backup` 生产库副本 + `TRELLIS_DB_PATH`/`HOME` 覆盖 + `next start`（dev 会炸）+ `TRELLIS_LARK=off`；本地 curl 加 `--noproxy '*'`。

## 产品语义（已由主控定，不要改；有疑问发 blocker，不要自行放宽）

1. **收编对象**：daemon 上没有绑定任何 Trellis 会话、且状态非 closed 的线程，自动收编。启动时 `thread/list` 全量扫一遍，之后新线程与状态变化跟随（协议有通知就订阅，没有就 ≤5 秒轮询，轮询要有退避与开关关闭时零请求）。收编之前就已 closed 的线程忽略。
2. **归属**：线程 cwd 落在 Trellis 已知 project/workspace 根（含 Herdr 桥的 repo/worktree）之内 → 归到该 project 的对应 workspace；无匹配 → 系统 project「外部会话」（首次自动建，只建一个，可被识别为系统项目）。
3. **会话形状**：线性树，每个 turn 一个节点：用户输入 + 该 turn 的 items 投影为节点 response/tool_calls，与第二步双写格式一致（主页现有渲染直接可用，前端不新造协议）。收编时把线程已有 turns 回填成节点；之后实时跟随。会话/节点带来源标记：backend、origin=external，线程 meta/fjContext 里有契约号或标题就显示出来。
4. **双向**：在收编会话里提问 = 对该线程 `turn/start`（线程正在跑一轮时按协议行为提示排队或拒绝，不能静默丢）；审批/提问卡走现有双端审批路径（daemon 广播竞答、`serverRequest/resolved` 撤卡）；中断可用；分叉遵循第二步语义（tip 显式分叉，非 tip 普通续聊播种）。
5. **所有权**：Trellis 永不主动 `thread/close` 收编线程；在 Trellis 删除该会话只解绑不关线程；外部客户端关掉线程后会话保留并标记已结束，之后不可再提问。
6. **开关**：`TRELLIS_AS_ADOPT=on` 才收编，默认 off，off 时零副作用零请求；`TRELLIS_AS=off` 整体关闭仍覆盖它。`.env.example` 与 README 写明含回退方法。
7. **边界**：不删影子观察页；不改 daemon/vendor；不动飞书、自动化任务、run-bus 旧路径；不新增 npm 依赖。

## 交付物

- 代码 + 单测：归属映射（含 Herdr worktree 路径、无匹配走系统项目）、回填投影与 items 逐项一致、开关三态、删除只解绑、外部关线程后标记已结束且拒绝提问、同一线程不会被重复收编（幂等，Trellis 重启后不重建）。
- E2E 脚本 `scripts/mobile-verify/mobile-as-adopt.sh`（fixture daemon，与 mobile-as-shadow.sh 同风格，统一前缀下可跑，端口 3479/3480，同一把锁，自己清理），判据全部断言：外部客户端建线程 → ≤5 秒出现在主页会话列表且归属正确 → 回填节点与 items 逐项一致 → 外部客户端再跑一轮，主页实时出现 → 主页提问一轮，外部客户端 attach 能看到该 turn → 外部触发审批，主页回答后 daemon 侧 resolved → 主页删除会话，线程仍活且再次扫描不重收编（除非线程再次出现新 turn？不——删除即永久解绑，写清） → 开关 off 零收编零请求。手机视口 390×844 截图收编会话一张。
- 真机证据：对常驻 daemon 用 as/1 建一条临时线程（显式 `model: sonnet`，cwd 用 `~/.trellis/scratch/` 下临时目录），在隔离实例上验证：出现在列表、归属「外部会话」、主页提问一轮拿到回复、删除后线程仍在；结束后自己 `thread/close` 这条临时线程。全程不碰 fj 坐席线程。
- 零回归：现有 7 条手机脚本 + `mobile-as-shadow.sh` + `mobile-as-project.sh` + `mobile-herdr.sh` 在统一前缀下独占跑绿（跑完确认 3471–3480 无监听、锁已清）。
- `out/result.md`：改动清单、每条命令与 exit、E2E 与真机证据路径、已知限制、回退方法。提交到本 worktree 分支 `feat/as-adopt`（可多次提交，最终工作树干净）。**不 push、不开 PR、不部署**（ship 单负责）。
