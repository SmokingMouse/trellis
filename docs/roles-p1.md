# 角色 P1：角色本体 + 记忆

交互以 `docs/ui-redesign/mockups/09-roles.html` 为准（2026-10-30 获批）。共享类型在 `lib/roles.ts`。

## 范围

| 做 | 不做（P2+） |
|---|---|
| 侧栏「角色」分区、角色固定会话、`/new` 新话题 | 夜间整理、例行、飞书 bot 绑定 |
| 角色目录与记忆注入、「记下了…」行 | 群聊 |
| 一览右栏（人设、最近记忆、目录、模型） | 一览里的例行 / 渠道 / 后台任务块 |
| 设置页：资料 / 人设 / 记忆 / 高级 | 能力 / 渠道 / 例行 tab |
| 新建弹窗：空白、从模板 | 从会话提炼 |

管家暂不迁成角色：侧栏「角色」分区里放一行「管家」，点了走现有 `openButler()`。导航里原来的管家行去掉，其余导航行不动。

## 数据

`agents` 加列（`pragma_table_info` 守卫的 ALTER，照 sqlite.ts 现有写法）：

| 列 | 类型 | 默认 |
|---|---|---|
| `kind` | TEXT NOT NULL | `'agent'`（角色 = `'role'`） |
| `intro` | TEXT NOT NULL | `''` |
| `avatar_hue` | INTEGER NOT NULL | `254` |
| `avatar_glyph` | TEXT NOT NULL | `''` |
| `work_dir` | TEXT | NULL |
| `memory_enabled` | INTEGER NOT NULL | `1` |
| `home_session_id` | TEXT | NULL |

角色的 `inherit_env` 恒为 1、`permission` 沿用 agents 的语义。现有 `/api/agents` 列表**排除** `kind='role'`（设置 → Agent 页和 AgentPicker 不出现角色）。

角色目录 `~/.trellis/roles/<slug>/`（`TRELLIS_ROLES_DIR` 可覆盖，测试用）：

```
USER.md          它对你的了解（自由文本）
MEMORY.md        索引：每行 - [name](memories/<file>.md) — description
memories/*.md    一条一个文件，frontmatter: name / description / metadata.type
```

## 会话

- 角色会话 = `kind='role'`、`context_mode='project'`、`agent_id=<role>`、`workspace_path = work_dir ?? homeDir`。`kind='role'` 不在 `sidebarSessionKinds` 里，会话列表自然看不到。
- 第一次发消息才建会话：前端草稿态 `roleDraft`（照 `butlerDraft`），`streamRoot` 带 `{ mode:"project", agentId, workspacePath }`。服务端在 chat 路由新会话分支认出角色：
  - `home_session_id` 指向的会话还在 → 改成在该会话里 `createRootInSession`（防重复建）。
  - 否则正常建，建完 `UPDATE sessions SET kind='role'` 并回写 `agents.home_session_id`。
- `/new`（角色输入框里）= 新话题 = 现有 `kind:"root", sessionId` 路径。
- 归档角色会话时清掉 `home_session_id`（照 `detachHomeSession`）。

## 记忆注入（spawn）

`resolveAgentSpawn` 之后，agent 是角色且 `memory_enabled` 时，`AgentSpawn` 带上：

- `addDirs: [homeDir]`（cwd 已是 homeDir 时省略）→ `additionalWorkspaces`
- `appendSystemPrompt` → `extraArgs: ["--append-system-prompt", text]`

`text` 由 `buildRoleMemoryPrompt(role)` 生成：角色目录路径、记忆写法（一条一个文件 + 更新 MEMORY.md 索引、什么值得记、不记什么）、USER.md 全文、MEMORY.md 全文。记忆关掉时只给人设，不挂目录。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/roles` | `{ roles: Role[] }`，按 lastActiveAt 降序，未聊过的按 sortOrder |
| POST | `/api/roles` | body `RoleInput` → `{ role }`；建目录 + 空 USER.md / MEMORY.md |
| GET / PATCH / DELETE | `/api/roles/[id]` | DELETE 内置拒绝 409；删角色不删目录（改名为 `<slug>.deleted-<ts>`） |
| POST | `/api/roles/[id]/open` | `RoleOpenResult`：home 会话还在就给 id，否则 null |
| GET | `/api/roles/[id]/memories` | `RoleMemoryList` |
| PUT | `/api/roles/[id]/memories/[file]` | body `{ name, description, type, body }`，写文件并重建 MEMORY.md |
| DELETE | `/api/roles/[id]/memories/[file]` | 删文件并重建 MEMORY.md |
| PUT | `/api/roles/[id]/user-md` | body `{ text }` |

`[file]` 必须匹配 `^[a-z0-9][a-z0-9._-]{0,80}\.md$`，拒绝路径穿越。

## 前端

| 件 | 位置 |
|---|---|
| 头像 | `components/ui/Avatar.tsx`（`RoleAvatar`，用 `roleAvatarBackground`） |
| 数据 | `stores/roleStore.ts`：roles、refresh、create、update、remove、`openRole(id)`、glance 开关 |
| 侧栏 | `SessionSidebar.tsx` 导航与「会话」区之间加「角色」区：最多 5 行 + 「全部 N」，＋ 开新建弹窗；手机抽屉同样一块 |
| 顶栏 | `Header.tsx` 角色分支：头像 + 名字 + 介绍、工作目录 chip、「记得 N 条」、一览开关、齿轮 |
| 时间线 | `LinearThreadView.tsx`：角色会话把所有根按时间串成一条，根与根之间画「新话题」分隔，按天画日期分隔；回复下面画「记下了…」行（`isRoleMemoryPath` 认 Write/Edit） |
| 输入框 | `Composer.tsx` 角色版：去掉模式 / agent 选择，占位「跟 X 说点什么，/new 开新话题」；命令表按场景区分，角色下 `/new` = 新话题、`/remember` |
| 一览 | `components/RoleGlancePanel.tsx`，照 `ButlerPanel` 的 `--trellis-rp` 机制，300px，≥1280px 显示 |
| 设置 | `app/settings/roles/page.tsx`（列表）+ `app/settings/roles/[id]/page.tsx`（tab：资料 / 人设 / 记忆 / 高级，`?tab=`） |
| 新建 | `components/NewRoleModal.tsx`：空白 / 从模板（`BUILTIN_AGENT_SEEDS`）；名字、头像、介绍、人设、目录、模型、记忆开关 |

「记下了…」行的撤销：这一轮新建的记忆文件 → DELETE；改动已有文件 → 只给「改一下」（跳设置页记忆 tab）。

## 工作包

| 包 | 内容 | 依赖 |
|---|---|---|
| WP1 后端 | 迁移、`lib/server/roles.ts`（目录、记忆读写、MEMORY.md 重建、prompt 构建）、agents 排除角色、chat 路由角色分支、spawn 注入、API、单测 | 只依赖 `lib/roles.ts` |
| WP2 对话面 | roleStore、侧栏、顶栏、时间线、输入框、一览 | 按本文 API 写，接口未就绪时可 mock |
| WP3 管理面 | Avatar、设置页、新建弹窗 | 同上 |

## 验收

- `bunx tsc --noEmit`、改动文件 `bunx eslint`、`bun test`（含 ui-source-guard / tailwind-color-guard）全绿。
- 隔离实例（sqlite 副本 + `TRELLIS_ROLES_DIR` + mock 引擎）走一遍：新建角色 → 发消息 → 刷新后仍在同一会话 → `/new` 后时间线连续 → 记忆文件写入后出现「记下了…」并可撤销 → 设置页能改记忆。
- 真 claude 冒烟一次：确认 `--agent` + `--append-system-prompt` + `--add-dir` 同时生效，角色能按指示写记忆文件。
