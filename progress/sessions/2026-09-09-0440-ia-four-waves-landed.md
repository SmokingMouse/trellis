# S166 · 2026-09-09 03:10–04:40 · 侧栏 IA 波 3 / 波 4 上线，方案 A 四波全部落地；引擎事件人话化上线

## 已落地

- **引擎事件人话化**（PR #52，main 77e9680；release 77e9680fd，部署时守卫拦收编坐席会话，确认 origin=external 后 `FORCE=1`）：`lib/as-engine-event-format.ts` 摘要函数 + 默认过滤 item/hook/turn 回显（折叠计数 + 「显示全部」开关），一行一句、原始 JSON 收进每行展开；外部会话权限模式只读。合并时唯一冲突是 `progress/failures.md` 两边追加，保留双方。
- **侧栏 IA 波 3**（PR #53，main 3a26f47；release 3a26f47d8）：TreePanel + Outline → 右侧 push 式「结构」面板（默认 36px 竖条，展开推挤内容列），递归森林 + 当前话题 + 当前链高亮 + 「其它分支 N 条」，键盘可达，手机复用全屏 sheet；DOM 实测正文 243–1127 / 面板 1160–1440，重叠 0px（体检 P1-1 归零）；11 条脚本、296 单测绿；flag 可回退。
- **侧栏 IA 波 4**（PR #54，main a59c986；部署见本条 Next）：画布降级为结构面板里的「🗺 地图」覆盖层：进入必 fitView 并高亮当前位置，概览下卡片退化为色块 + 标签 + 未读/等待点，选中即关闭落回线性；124 节点会话手机 390×844 fitView 后 124/124 可见（体检基线 6/124），桌面全貌一屏；`lib/canvas-map.ts`；flag off 保留旧画布。基于波 3 分支开发（`--base feat/sidebar-wave3`），PR 只含波 4 差异。
- **方案 A 四波全部在生产**：1 条工具条 + 1 棵项目树 + 1 个结构面板 + 地图；顶层区域从 8 组 14 种行收敛到 1 树 1 工具条 4 种行。

## 主控运维

- 波 4 部署链里 `git pull --ff-only` 被本地未提交的 `progress/README.md` 挡住，`make deploy` 结果重部了 3a26f47（等价无害）；stash → pull → pop 后 README 两处冲突（Focus 与 sessions 指针，坐席的 PR 也改了 README）手工按主控口径解决。教训：**坐席 PR 不该改 `progress/README.md`**（Focus/指针由主控维护），下次契约明写；主控在部署链前先提交自己的 progress 改动。
- 每次 PR 都被 GitHub 判 CONFLICTING 而本地干净：main 推进太快（每小时多次合并），branch 需先合 main 再合 PR；已固化为「本地 merge origin/main → tsc/test → push → 轮询 mergeable → merge → pull → deploy」一条链。

## Next

- 确认波 4 release 上线（`make deploy` 在跑）→ 提交推送 progress。
- 待用户：`FJ_RUNNER_DEFAULT=codex-tui` 写 shell；体检第一批「待办层」；投研等非 git 项目是否要纳入归属。
- 观察一天后 AS 切流扩到全部项目；backlog P1 `codex-interrupt-leaves-exec-alive`、P2 `deploy-guard-counts-external-sessions`、`as-adopt-list-noise-grows-with-history`、launchd PATH 补 rg。
