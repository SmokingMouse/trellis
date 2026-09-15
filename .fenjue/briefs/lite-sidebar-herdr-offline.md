# 侧栏：离线 Herdr 会话视为已归档，默认隐藏（以当前 Herdr 为基准）

目标：侧栏 v2 里，Herdr 在线且报某会话的 pane 已不存在时，把该会话按「已归档」对待——默认不显示，勾「含已归档」才出现；只装着离线会话的工作区因此变空、自动折进已有的「其它 N 个工作区」；pane 回来行自动回来；Herdr 本身不可用时**不**隐藏（保住「仍可阅读已同步的会话」的承诺）。纯前端派生，**不写库**。用户 2026-09-16 拍板。

工作目录：本 worktree（分支 `fix/sidebar-herdr-offline`，已 `bun install`）。产物目录（绝对路径，主仓内、git 忽略）：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/lite-sidebar-herdr-offline-20260916/out/`。

## 背景（先读）

- 现状与数字（真库只读快照 2026-09-16）：`herdr_sessions` alive=1 的 16 pane / 23 会话，alive=0 的 66 pane / 67 会话；86 个 herdr 会话无一归档；43 个工作区行里只有离线 Herdr 会话，多为 `~/.herdr/worktrees/{fenjue,dotclaude,herdr-leader}/…`。
- 为什么会这样：波 2（S165，`progress/sidebar-tree-ia.md` §430-431「并入」）把 Herdr 组并进项目树，让死 pane 会话可达（I3）；并入后没有任何一层把离线的藏起来，只有行内灰点（`components/SessionSidebar.tsx:1424`，title「Herdr 离线 · 可阅读历史」）。
- 选择器：`lib/sidebar-view.ts` `selectSidebarSessions(sessions, archived, source, includeArchived)`，调用点 `components/SessionSidebar.tsx:291-293`（`visibleSessions`）；`partitionEmptyWorkspaces` 把没有可见会话的工作区折进「其它 N 个工作区」（`SessionSidebar.tsx:665-685, 782-785`）。
- Herdr 状态：`hooks/useHerdrFleet.ts` `useHerdrSessionStatuses()` → `{ statuses: Map<sessionId, {status, alive, paneId}>, available, unavailableText }`；map 由 `lib/herdr-ui.ts:14` `buildHerdrSessionStatusMap` 生成（`alive = !error && fleet.available && binding.alive`）。`SessionSidebar.tsx:67` 已取到 `herdrStatus` / `herdrAvailable`。
- 先核一件事：`/api/herdr/fleet` 返回的 `sessions`（bindings）是否包含 alive=0 的死绑定（看 `lib/server/herdr-fleet.ts` 与 `listHerdrBindings` 的 SQL）。这决定「离线」在 map 里是 `alive:false` 的条目还是**缺失**条目；两种都要按下面的规则覆盖。

## 规则（写进选择器，单测锁死）

`offline(s) = SIDEBAR_V2 && herdrAvailable && sidebarSource(s) === "herdr" && !(statuses.get(s.id)?.alive)`

- `offline(s)` 为真 → 与 `s.archived` 同等对待：`includeArchived` 为假则过滤掉；为真则显示，行上沿用灰点，并加一枚与「归档」同款的小 chip「离线」（`SessionSidebar.tsx:1426` 旁）。
- `herdrAvailable` 为假（Herdr 没起 / socket 报错）→ 规则整体不生效，一个都不藏。
- 非 herdr 来源不受影响；来源筛选选「Herdr」时同样适用本规则。
- 排序、去重、恢复归档的既有行为不变（现有三条单测必须原样通过）。
- 「含已归档」复选框：label 文案改成「含已归档 / 离线」；若 `scripts/mobile-verify/mobile-herdr.sh` 或其它脚本断言了原文，则保留原文、只改 `title` 提示。先 grep 再改。

实现建议：给 `selectSidebarSessions` 加第五个可选参数 `isOffline?: (s: Session) => boolean`（默认 `() => false`），调用点传入基于 `herdrStatus` / `herdrAvailable` 的闭包，并把它们加进 `useMemo` 依赖。别把 Map 直接塞进 lib（保持 lib 纯函数、可单测）。

## 约束

- 只改 `lib/sidebar-view.ts`、`lib/sidebar-view.test.ts`、`components/SessionSidebar.tsx`（必要时 `lib/herdr-ui.ts` 加导出，不改语义）。不动服务端、不写库、不动 `herdr-fleet` / `herdr-bindings`。
- 在本 worktree 分支直接 commit（`git add <file>` 精确暂存）；**不 push、不合并、不部署**，leader 收尾。
- 不连生产 Herdr socket 之外的东西写入；验证只用脚本自带的隔离方式与 fixture。临时文件放 mktemp。

## 验收命令（自己跑通再交，日志留产物目录）

1. `bun test lib/sidebar-view.test.ts`：新增至少 4 条用例——Herdr 在线且 alive=false → 默认隐藏 / 勾含已归档显示；map 缺失条目视为离线；Herdr 不可用 → 不隐藏；非 herdr 来源不受影响。然后全量 `bun test` 312+ pass / 0 fail。
2. `bunx tsc --noEmit` 不得新增错误；`bunx eslint components/SessionSidebar.tsx lib/sidebar-view.ts` 不得新增问题。
3. `env -i HOME=$HOME PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=$HOME/.trellis/data.db bash scripts/mobile-verify/mobile-herdr.sh`（先读脚本头部，以脚本自己的前缀 / fixture 约定为准；注意它可能需要 `TRELLIS_HERDR` 打开）exit 0。
4. 若 fixture 里有离线 pane 会话：截一张 1440×900 桌面侧栏图，显示离线会话默认不见、勾「含已归档」后带「离线」chip 出现；fixture 没有就写明跳过。

## 汇报

最终结论用中文总结：改了什么、fleet 是否含死绑定、验收各项结果、遗留。完成后终端最后一行打印：`DONE: <一句话结果>`
