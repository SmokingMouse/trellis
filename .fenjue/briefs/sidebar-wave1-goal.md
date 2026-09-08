目标：侧栏统一信息架构 **波 1 · 统一最小单元**（纯删 + 一个 SQL 谓词），按已拍板的方案 A 实施。用户已同意方案与全部五条倾向。

## 输入（先读）

- 方案正文 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-sidebar-tree-ia-4784/out/ia-spec.md`：§1（现状与不一致清单 I1–I12、T1–T5）、§2（概念模型：项目 → 工作区 → 会话 → 树 → 节点；侧栏叶子 = 会话；横切集合改筛选/来源 chip）、§4「分波实施 · 波 1」（本单范围）与「审美类判断」；静态稿 `mockups/a-sidebar-desktop.html`（目标形态，本波只做其中的删减部分）。
- 体检报告 `.fenjue/archive/fj-ui-audit-7b23/out/ui-audit.md` §3 P1-8（已由 PR #46 修掉，本波不重复）。
- 代码：`components/SessionSidebar.tsx`、`components/HerdrSidebarGroup.tsx`、`components/Header.tsx`、`components/Outline.tsx`、`app/page.tsx`、`lib/server/repo.ts`（`listSessions()` / `listRecentChains()` 的 `kind IN ('user','lark')` 谓词，约 :382、:2425）。

## 本波范围（§4 波 1 的五条，逐条对应）

1. `listSessions()` / `listRecentChains()` 的会话种类谓词放开到含 `'herdr'`、`'task'`；会话行加 origin/kind chip（⚓ / ⏱ / 💬，只在非 user 来源显示；样式沿用现有 chip 原语）。目的：消灭 I1 的空目录与 I3 的幽灵会话。注意 chat 类会话与归档语义不变。
2. 删三个顶层组：「🔖 稍后再读」（真库 0 条；能力保留在 `BookmarksDrawer`）、「⏱ 定时任务」（变成会话行 chip；任务 CRUD 仍在 `/settings/tasks`）、「未归组」（并入「暂存区」伪项目）。
3. 删不可达代码：`<Outline variant="drawer">`（`app/page.tsx:174` 附近）与 `Header.tsx:353` 附近永不渲染的 ⑂ 按钮（T2）。
4. 删两处「已隐藏 · N 棵」（真库 0 行，T5）。
5. Herdr 组的降级说明已在 main（PR #46），本波只确认不回归。

**不做**：工具条、按时间排布、最近组/Herdr 组退役、面板合并、画布——那是波 2–4。不动手机壳已裁决的首屏结构（`progress/mobile-shell.md`）。

## 验收判据（写进 result 并给证据）

- 侧栏顶层组数从 8 降到 ≤ 5（本波删 3 组；最近 / Herdr / 已归档 / 项目树保留）；用生产库快照隔离实例截图对比前后（桌面 1440×900 + 手机 390×844 会话抽屉）。
- 焚决项目下的 worktree 行不再是 0 会话；幽灵会话数用 `ia-spec.md` 附录的复现 SQL 前后对比（before/after 数字写进 result）。
- `bunx tsc --noEmit`、`bun test` 全绿；单测覆盖谓词放开（herdr/task 会话进入列表）与 chip 映射；`git diff --check` 干净。
- 现有 11 条手机脚本（`scripts/mobile-verify/*.sh`，含 `mobile-as-adopt.sh` 若已在 main，不在则跳过并写明）统一前缀独占跑绿：`env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db sh scripts/mobile-verify/<x>.sh`。脚本里若有针对被删组的断言，改断言并在 result 写明每处理由。跑完确认 3471–3480 无监听、`/tmp/trellis-mobile-verify.lock` 已清。
- 隔离实例用 3494 端口（生产库 `.backup` 快照 + `next start`），不碰 3088，结束杀进程。
- `out/result.md`：逐条对应上面 1–5 的改动、命令与 exit、前后截图与 SQL 数字、已知限制、回退方法（本波全是删除，`git revert` 即可）。提交到本 worktree 分支 `feat/sidebar-wave1`，工作树干净。**不 push、不 PR、不部署**（主控合并部署）。
