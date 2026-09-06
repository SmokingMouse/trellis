# 卡片级「稍后再读」

## 目标与非目标

给暂时没时间读完的问答卡片一个可回找的收藏标记。收藏粒度固定为节点（一问一答），跨未归档会话集中展示，并能深链回原卡片。

不做会话级或树级收藏，不自动触发模型 run，不把“收藏”与现有“已读/未读”合并，也不改变「最近」分组的结构、排序或行为。

## 交互（桌面 + 手机）

- 桌面：回答动作区在“标为已读/未读”旁新增书签切换。未收藏时 `aria-label="稍后再读"`，收藏后显示填充态并改为 `aria-label="取消稍后再读"`。侧栏在「最近」之上显示「稍后再读 (N)」分组，仅 `N > 0` 时出现。
- 手机：书签切换收入卡片 `…` 菜单，触控高度至少 44px。全局 overflow 新增「稍后再读 (N)」，仅有收藏时展示计数；点击后打开复用 `ui/Drawer` 的 bottom sheet，同一收藏列表的行与“读完 ✓”按钮均至少 44px。
- 收藏列表行显示“会话标题 · 问题摘要”、回答摘要与未读点；点行复用「最近」链行的深链导航，落到 `?session=<sessionId>&node=<nodeId>`。导航不自动移除收藏。
- 移除收藏只有两条路：在原卡片再次切换书签，或在列表行点击“读完 ✓”。后者只取消收藏，不改节点的 `readAt`；“已读/未读”与“收藏”始终是独立标记。
- 卡片切换采用乐观更新，失败时回滚并重新以服务端状态为准。

## 数据与 API

- `nodes.bookmarked_at INTEGER NULL`：毫秒时间戳；`NULL` 表示未收藏。按 `lib/server/sqlite.ts` 现有幂等 `pragma_table_info` + `ALTER TABLE` 模式迁移。
- repo：`setNodeBookmark(nodeId, on)` 返回持久化后的时间戳或 `null`；`listBookmarks({ limit })` 仅查询未归档会话，按 `bookmarked_at DESC`，返回 `nodeId`、`sessionId`、`sessionTitle`、`question`（纯文本摘要，最多 80 字）、`response`（去 Markdown 后最多 120 字）、`bookmarkedAt`、`readAt`、`status`。
- `PATCH /api/nodes/:id` 接受 `{ bookmarked: boolean }`，与既有节点更新字段并存；不存在的节点返回 404，非法 body 返回 400。
- `GET /api/bookmarks?limit=` 返回 `{ bookmarks }`；limit 有安全默认值与上限。
- `ChatNode` / API wire 类型携带 `bookmarkedAt`，保证会话载入即可渲染卡片状态。
- repo 与 route 均补 `bun test`，覆盖幂等切换、倒序、归档过滤、摘要长度/去 Markdown、limit 与错误输入。

## 决策

1. 列表入口：侧栏新增「稍后再读 (N)」，位于「最近」之上；手机从 overflow 打开 bottom sheet。
2. 打开卡片不自动移除；仅卡片切换或列表“读完 ✓”移除。收藏与已读是正交状态。
3. 收藏粒度是节点，不扩展到会话或树。
4. 状态与动作统一进入 `sessionStore`：`bookmarks`、`refreshBookmarks`、`toggleBookmark`；会话切换、列表 revision 变化和回前台时刷新，计数与两处列表同源。
5. 桌面 1280×800 除新增书签按钮及有数据时的新分组外保持不变；所有新增手机控件至少 44px。

## 验收

- `scripts/mobile-verify/mobile-read-later.sh` 在 3476 使用数据库副本、独立登录与 `mv-read-later` browser session，trap 清理且含与现有脚本一致的互斥锁。
- iPhone 15：从卡片 `…` 收藏后断言切换为“取消”态；overflow 计数为 1；bottom sheet 行高至少 44px且包含会话标题；点击行后 URL 含 node id；列表“读完 ✓”后计数归零。
- 1280×800：动作区书签按钮可见；收藏后侧栏出现「稍后再读 (1)」及一行；既有分组数量等于脚本修改前记录的基线；取消后分组消失。
- 脚本不触发模型 run、不读写 `~/.trellis/data.db` 本体；已有 slim-shell、touch-targets、followup-approval 与新增 read-later 四条脚本串行连跑两遍。
- `bunx tsc --noEmit` 与 `bun test` 全绿；端口 3471–3476 均释放且互斥锁目录不存在。
