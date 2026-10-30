# 角色 P2–P4：剩下的全部

P1 已上线（5b7cb7f，设计见 `docs/roles-p1.md`）。交互仍以 `docs/ui-redesign/mockups/09-roles.html` 为准。本文把剩下的事拆成三个包并行做，最后合回 `feat/roles-design` 再上线。

## 总表

| 事项 | 包 | 原型位置 |
|---|---|---|
| 夜间整理（每天 03:30，没新对话跳过；改动卡逐条接受 / 拒绝，7 天内可撤销） | A | s-role 的 `.chg` 卡 |
| 例行：角色的定时任务（tasks.agent_id = 角色），设置页「例行」tab + 一览「例行」块 | A | 一览、记忆页 tabs |
| 渠道：飞书 bot 绑角色（lark_bots.agent_id），设置页「渠道」tab + 一览「渠道」块 | A | 一览 |
| 能力：工具 / 技能（agents.tools / skills），设置页「能力」tab | A | 记忆页 tabs |
| 后台任务：角色开的后台任务卡 + 一览「后台任务」块 | A | s-role `.task-card` |
| 群聊：kind='group' 会话、成员、@、路由挑人、轮次上限、到顶两个出口 | B | s-group、s-group-limit |
| 从会话提炼：新建弹窗第三个起点 | C | 新建弹窗 |
| 管家迁成内置角色 | C | 侧栏 |
| 角色会话进全局搜索、可被 @ 引用 | C | — |
| 定时任务 / 飞书会话绑了角色时也注入角色记忆 | C | — |
| config-sync 导出 / 导入角色（不含记忆文件正文以外的会话） | C | — |
| 跟进我的会话（P4）：一个角色可开，没变化不出声 | C | 交互说明表 |

## 共享约定

- 每包新增的共享类型放**各自的新文件**，别往 `lib/roles.ts` 里塞，避免合并冲突：A → `lib/role-changes.ts`、`lib/role-routines.ts`；B → `lib/groups.ts`；C → `lib/role-follow.ts`。确实要改 `lib/roles.ts` 只许追加。
- 迁移照 `lib/server/sqlite.ts` 现有写法（`CREATE TABLE IF NOT EXISTS` + `pragma_table_info` 守卫 ALTER）。
- 会话里插入「不是模型回复」的系统消息（夜间整理卡、跟进报告、群聊轮次结束）：统一用一个服务端 helper 建一个已完成的节点，`question` 是给人看的标题、`answer` 是正文，节点上带 `meta.kind`（`role-nightly` / `role-follow` / `group-round-end`）。**这个 helper 由 A 写在 `lib/server/system-node.ts`**，B、C 先按这个签名各自写最小实现，合并时统一成 A 的：

  ```ts
  export function appendSystemNode(opts: {
    sessionId: string;
    title: string;     // 节点 question
    body: string;      // 节点 answer（markdown）
    kind: "role-nightly" | "role-follow" | "group-round-end";
    meta?: Record<string, unknown>;
  }): { nodeId: string };
  ```

  前端靠 `meta.kind` 认出来换渲染（卡片而不是普通问答）。节点作为新根挂在会话里，**不**参与 claude resume（下一轮用户消息仍接在上一个真实节点后面）。如果现有 schema 放不下 meta，A 决定加列还是复用现有字段，并在报告里写清。

## A：夜间整理 + 例行 / 渠道 / 能力 / 后台任务

- 表 `role_changes`：`id, role_id, node_id, kind ('add'|'merge'|'delete'|'skill'), payload_json, status ('pending'|'applied'|'rejected'|'reverted'|'failed'), before_json, created_at, decided_at`。
- 夜间整理调度：复用 `lib/server/task-scheduler.ts` 的调度器（或同级的轻量 cron），每个角色一个内置 routine（`memory_enabled` 且有固定会话才跑）。判断「自上次整理以来有没有新节点」，没有就跳过、不调模型。有就起一次 headless claude（角色人设 + 记忆目录 + 专用整理 prompt），要求它**只输出 JSON 提案**（不直接写文件），服务端解析成 `role_changes`，再 `appendSystemNode(kind:'role-nightly')`。频率：每天 / 每周 / 关闭，存在 agents 新列或 app_settings。
- 接受：add / merge / delete 落成 memories 文件变化 + 重建 MEMORY.md；skill 写到 `<roleDir>/skills/<name>/SKILL.md`，并确认它能被角色 spawn 用上（自己验证 claude 能否从 `--add-dir` 或 `--plugin-dir` 发现；不能就把角色 skills 目录物化进 agent-pack）。撤销：7 天内，按 before_json 回滚。
- 前端：时间线里认 `meta.kind === 'role-nightly'` 渲染原型的整理卡（全部接受、逐条 ✓ ✗、已接受 / 已拒绝态、底部说明 + 整理历史链接）；一览「例行」块列角色的例行（夜间整理 + 该角色的 tasks），开关可切；设置页补「能力」「渠道」「例行」三个 tab。例行可在设置页新建（名字、prompt、触发：每天 / 工作日 / 每周 / cron、没发现就不出声），落成 tasks + task_triggers，`agent_id` = 角色，会话进角色的固定会话（不另开 task home 会话）。
- 后台任务：角色在对话里起的后台任务（现有 Agent/Task 工具产生的子任务或 trellis task run）在时间线以 `.task-card` 显示，一览列最近 5 个。先摸清现有「后台任务」在 trellis 里是什么（task_runs？herdr 派活？），选最贴近的实现，报告里说明。

## B：群聊

- 表 `group_members(session_id, role_id, sort_order)`；会话 `kind='group'`，侧栏「角色」分区里和角色混排（四宫格头像）。
- 建群：侧栏 ＋ 菜单加「新建群聊」（名字、选 2–6 个角色、工作目录）。
- 一条用户消息的编排（服务端）：解析 @（名字匹配，`@所有人`）；有 @ 就只让被 @ 的依次回；没 @ 按群设置：`route`（默认，用一次轻量模型调用或规则挑一位）/ `all`（每位决定接不接）/ `mention-only`。每轮最多 3 遍、10 条，到顶插 `group-round-end` 系统节点，前端渲染原型的上限卡（继续讨论 / 让管家记成任务 → 打开管家并预填结论）。
- 每个角色各自的 CLI 会话：每个成员在群里有自己的 claude session id（存在成员表或节点上），带自己的人设与记忆注入（复用 P1 的 `roleSpawnExtras`），只喂它没看过的群消息增量（格式「[名字]：内容」）。
- 前端：群聊时间线（每条消息左侧头像 + 名字 + 时间，引用回复 quote，「X 在想…」），输入框 @ 菜单，轮次条（第几遍、x / 10、停下这一轮），群设置弹层（没人 @ 时的策略、每轮上限、加成员）。手机同样可用。
- 停下这一轮：中断当前所有成员 run。

## C：提炼 / 管家迁移 / 搜索与引用 / 任务与飞书注入 / 导出 / 跟进

- 从会话提炼：新建弹窗第三个起点可用。选来源会话（最近 50 个可搜），服务端读该会话问答（截断到合理长度），一次模型调用产出 `{ name, intro, systemPrompt, memories: [{name, description, type, body}] }`，预填表单 + 显示「提炼出的草稿」摘要；创建时一并写入记忆。
- 管家迁成内置角色：`builtin-trellis-admin` 改 `kind='role'`，`home_session_id` = 最近一个管家会话（迁移时把它标 `kind='role'`；其余历史管家会话保持原样可见）。管家专属渲染（ButlerPanel、改动卡、butler 输入框）照旧按 `isButlerSession` 走。侧栏里管家那行变成普通角色行（P1 的特判去掉），`/?butler=1` 仍能用。`latestButlerSessionId` 等依赖 `kind='user'` 的地方要跟着改。
- 搜索 / @ 引用：全局搜索和节点 @ 引用纳入 `kind='role'`（以及 B 的 `group`），结果里带角色头像 / 名字。
- 注入：tasks、飞书会话里 agent 是角色时，同样走 `roleSpawnExtras`（cwd 规则同角色会话）。
- config-sync：导出包含角色行（含 intro / 头像 / workDir / memoryEnabled）和 USER.md、memories/；导入时 slug 冲突策略与现有 agents 一致，并修 P1 留下的「导入 agent 撞上角色 slug 会改到角色行」。
- 跟进我的会话（P4）：角色设置「例行」tab 里一个内置开关「跟进我的会话」，全局只能有一个角色开着。每 15 分钟扫一遍：普通会话与 herdr 窗格里新进入「等你 / 卡住（运行超 N 分钟无输出）/ 失败 / 完成」的会话（复用 `lib/attention.ts` 的判定与 pending 快照）。**没变化不出声、不调模型**；有变化就 `appendSystemNode(kind:'role-follow')` 一条清单（每项链接到会话），绑了飞书 bot 的再推一条。去重：同一会话同一状态只报一次。
- 前端：`role-follow` 节点渲染成清单卡；时间线里点链接打开对应会话。

## 验收（每包、以及合并后整体）

- `bunx tsc --noEmit`、改动文件 `bunx eslint`、全量 `bun test` 全绿（含 ui-source-guard / tailwind-color-guard）、`bun --bun run build` 过。
- 隔离实例（sqlite `.backup` 副本、HOME / TRELLIS_DB_PATH / TRELLIS_ROLES_DIR 覆盖、TRELLIS_LARK=off、`bun server.ts -p <端口>`）走本包主流程；mock 引擎覆盖不到的（夜间整理提案、群聊路由、提炼）各用真 claude 跑一次冒烟。
- 合并后整体用 Gemini 看图对照原型过一遍，再部署。
