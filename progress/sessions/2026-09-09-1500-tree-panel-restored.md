# S169 · 2026-09-09 12:40–15:00 · 用户要求「直接和之前的效果对齐」→ 树面板原样恢复

## 事件

- 小浮窗返工（S168）上线后用户原话：「不能直接和之前的效果对齐吗」——重画版细节对不上，用户要旧组件本身。
- 返工单 fj-restore-tree-panel-ccd2（codex，fix/restore-tree-panel）：以波 2 合并提交 013adb9 为基准逐字恢复 `TreePanel.tsx` / `Outline.tsx`（连带 Canvas、AddNodeFAB 与相关样式/hook），`git diff 013adb9 -- components/TreePanel.tsx components/Outline.tsx` 为空、零适配；删除波 3 结构面板（`StructurePanel*`、`lib/structure-panel*`）及其 flag；波 4 地图覆盖层保留，入口挂回旧 Header「🗺 画布」按钮。证据：面板区域 (1138,349)–(1428,804) 与旧截图 d-05 逐像素比对 131950/131950 相等、MAE=0；默认态/选中态/手机 sheet 的 outerHTML、rect、状态点颜色与 013adb9 隔离实例全等；tsc、301 单测、11 条脚本绿。验收时任务缺基线快照（launch 时 worktree 刚建），`fj task rebase` 后 settle 通过。PR 合 main 并部署（release 见 `~/.trellis/current`）。

## 终态

- 会话内导航 = 旧 TreePanel/Outline 原样 + 地图覆盖层（波 4 返工版，从画布按钮打开）；侧栏 = 波 1/2 的工具条 + 项目树。方案 A 的第 10–12 条（结构面板）作废，`progress/decisions.md` 已记。

## 教训

- 用户说「对齐以前」时，恢复原组件比按截图重画更快更准：三轮（push 整列 → 小浮窗重画 → 原样恢复）里只有最后一轮零返工。UI 形态类改动先问「保留旧壳还是换壳」再动手。
- launch 后立刻发 result 的短单可能缺基线快照；settle 前看 task.json 有无 base_commit。

## Next

- 待用户：`FJ_RUNNER_DEFAULT=codex-tui`；待办层；非 git 项目归属。
- 观察一天后 AS 切流扩到全部项目；backlog 见 S166。
