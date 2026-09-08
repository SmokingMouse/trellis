# 侧栏波 3：会话内结构面板

契约：`fj-sidebar-wave3-8dc6`；分支：`feat/sidebar-wave3`。

- 新增 `StructurePanel`，桌面以共享 `--trellis-structure-w` 推挤线性正文、画布和 Composer；默认 36px 竖条，展开默认 280px、可调整宽度。画布按钮使用同一预留。
- 同源森林渲染保留话题、递归分叉、当前阅读链高亮、其它分支叶子入口；手机复用页面同级全屏 sheet。保留过滤、重命名、已读/未读、隐藏/恢复和删除动作。
- `NEXT_PUBLIC_TRELLIS_STRUCTURE_PANEL=off`（或 `0`）在构建时回退原 TreePanel / Outline；未设置默认开启。展开状态和宽度存入 `trellis-structure-panel`。
- 新增 10 条单测覆盖森林、链、分支、持久化及键盘；最终 `bunx tsc --noEmit` exit 0、`bun test` 296 pass / 1196 assertions，新组件与模型 ESLint exit 0。
- 当前仓库全部 11 条手机 shell 脚本按契约统一 env 前缀独占串行通过；D3 最终额外复跑 exit 0，D4 exit 0。安全区脚本内字体扫描 77 个控件，0 遗漏。
- 3500 生产库 `.backup` + `next start` 最终五图及浏览器断言全部通过：桌面收起 `.md-body` x=328–1286 / 面板 x=1404–1440；展开 `.md-body` x=243–1127 / 面板 x=1160–1440；P1-1 重叠均 0px。宽度 300px 刷新恢复、Esc/方向键/Enter、四个其它分支叶子跳转、画布同一 DOM 面板与新建按钮预留、390×844 全屏 sheet 均实测。画布阅读语义保留。
- flag off 单独构建 exit 0，浏览器确认线性旧 TreePanel、画布旧 Outline 恢复，新面板与预留宽度均不存在；已还原默认开启构建。最终 D5 清理命令 exit 0：3471–3480 / 3500 无监听，锁已清。

已结案验证差异（全部保留 attempt 日志）：slim-shell 的强制桌面全宽断言、followup 的 Composer 全宽断言改为 push 分区等式，仍保留高度/字体/三键检查；safe-area 同类断言同步修正。touch-targets 新话题入口改为先展开结构并测宿主边界，Ask 卡片基线前恢复收起状态；其中一次脚本编辑误将桌面收起动作放入手机段，移回桌面段后全绿。可复验命令及逐条理由在证据目录 `result.md`，没有改动这些卡片的产品实现。

证据目录：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-wave3-8dc6/out/`。

Next：交付主控独立验收；本分支仅本地提交，不 push、不 PR、不部署。
