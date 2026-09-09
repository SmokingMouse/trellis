目标：会话内的树面板**原样恢复**到波 3 之前的版本，视觉与交互和以前完全一致。用户原话：「不能直接和之前的效果对齐吗」——上一轮「小浮窗返工」是坐席按旧截图重画的壳，细节对不上，用户不要重画版，要旧组件本身。

## 做法

1. 以 `013adb9`（波 2 合并提交，波 3 之前）为基准，把 `components/TreePanel.tsx`、`components/Outline.tsx` 及它们直接依赖的样式/hook/工具文件**逐字恢复**（`git show 013adb9:<path>`），并把 `app/page.tsx`、`components/LinearThreadView.tsx`、`components/Canvas.tsx`、`components/Header.tsx` 里与树面板 / 大纲相关的挂载、布局与入口恢复成 013adb9 的写法。新写的结构面板组件（波 3 与其浮窗返工产物，如 `StructurePanel*`、`lib/structure-*`、相关 flag `NEXT_PUBLIC_TRELLIS_STRUCTURE_PANEL`）整体删除，不留 flag。
2. **只保留一个新东西：地图**。波 4 返工后的地图覆盖层（`lib/canvas-map.ts` 与地图组件）保留，入口挂回旧 Header 上原来的「🗺 画布」按钮位置（按钮文案可仍叫「画布」或改「地图」，点击打开覆盖层，选中节点落回线性），旧的"画布阅读视图"按 013adb9 之后的裁决不再作为阅读视图。若恢复的 TreePanel 里有"画布"相关入口，一并指向地图覆盖层。
3. 波 1/2 的侧栏（工具条、项目树）不动；手机壳不动（若 013adb9 的 TreePanel 在手机上有全屏 sheet 逻辑，随之恢复）。
4. 数据模型没变（sessions/trees/nodes），旧组件直接可用；如因波 1/2 的 store 改动导致旧组件编译不过，只做最小适配并逐处写明，不改外观。

## 验收

- **逐项对照**：在生产库快照隔离实例（端口 3504）用与旧截图相同的会话（web3学习，124 节点）和视口 1440×900 截图，与 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-ui-audit-7b23/out/shots/d-05-linear-web3.png` 并排；面板位置 / 尺寸 / 标题栏（「树 · 124 · + 新树 · ⌥ · 🔍」）/ 行高 / 缩进 / 状态小点 / 高亮 全部一致，用 DOM rect 数字逐项列表证明（面板 left/top/width/height、首行高度、缩进像素）。另截 6 节点会话与手机 390×844 各一张。
- `git diff 013adb9 -- components/TreePanel.tsx components/Outline.tsx` 应为空或只含必要适配（写明每一处）。
- `bunx tsc --noEmit`、`bun test` 全绿；11 条手机脚本统一前缀独占跑绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`）；针对结构面板的断言改回旧面板断言并写明；跑完 3471–3480 与 3504 无监听、锁已清。
- 提交到本 worktree 分支 `fix/restore-tree-panel`，工作树干净；不 push、不 PR、不部署；**不改 `progress/README.md`**。**不发 partial result**，完成后发唯一一封 done，result.md 附对照截图与 DOM 数字表。
