# S165 · 2026-09-09 02:20–03:10 · 侧栏波 2 上线、观察页退役上线、引擎事件人话化交付、波 3 开工

## 已落地

- **侧栏 IA 波 2**（PR #50，main 013adb9；生产 release 8687a2dff，03:59 部署）：工具条「按项目 ▏按时间」+ 来源筛选 + 含已归档；「最近」组与 Herdr 组退役（pane 状态点 + ⚓ chip 进会话行）；Chat 会话归伪项目「速记」；空工作区折叠；共享来源谓词 helper 收敛三处查询（顺手修波 1 遗漏的 `listProjectTree` 仍 kind=user）；flag `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2` 可回退。同口径侧栏行数 163 → 141。集成单 fj-sidebar-wave2-integrate-b80f 合入收编代码（GitHub 判冲突，本地合并干净）；主控最后再合一次 main（含退役与进度提交）后 PR 才被 GitHub 判可合。
- **观察页退役**（PR #51，d6c5bfb；release d6c5bfb3e）：`/console/threads`、`/api/as/threads*`、ThreadLogView、影子脚本与文档引用删除（29 文件 +142/−733），保留收编/第二步复用的客户端封装；生产 `/console/threads` 404。
- **引擎事件人话化**（fj-as-controls-polish-dfcc 验收通过，PR #52 待合）：用户点开收编会话的「系统日志」看到 86 行原始 JSON（daemon 透传的 item/completed、hook/started 等）。改为默认过滤 item/hook/turn 回显、只留生命周期/错误/权限事件，一行一句摘要 + 可展开原始 JSON，外部会话权限模式只读。

## 用户问答

- 「看着 working 但看不到 streaming」（Herdr · codex 会话）：那是另一个 leader 用原生 runner 起的 Herdr pane 坐席，走 Herdr 桥的转录文件镜像（按 item 刷、无 token 流），daemon 上无对应线程。真正的流只有走 daemon 的线程（`--runner codex-tui`）经收编才有。建议全局 `export FJ_RUNNER_DEFAULT=codex-tui`，**待用户点头**再写 shell 启动文件。
- 「为啥还有这种乱七八糟的」（原始 JSON 系统日志）：第二步的开发者调试口被收编会话原样带到主页，已修（上条）。

## 主控运维与教训

- 部署守卫把收编的外部会话算成「正在生成」（backlog `deploy-guard-counts-external-sessions`）；坐席在跑时用 `make deploy FORCE=1`。
- 「分支包含最新 origin/main」这类 verify 是移动靶（我推进度提交就把它打红），改用固定基线 sha。
- 波 2 坐席交付后线程 busy 关不掉：`thread/interrupt` 后它又起新 turn，最终用 as/1 `thread/close` 直接关（Codex 中断语义 P1 的另一表现）。
- 从 worktree 目录跑 `make deploy` 会部署该分支 tip 而不是 main 合并提交（内容等价但 release 名不同）；后续统一从主仓跑。
- 进度与 .fenjue 已提交推送（7d615a9）。

## 在跑

- **波 3**（fj-sidebar-wave3-8dc6，feat/sidebar-wave3，w39）：TreePanel + Outline → 右侧 push 式「结构」面板，递归森林 + 当前话题 + 当前链高亮 + 其它分支，手机复用全屏 sheet，正文零遮挡（P1-1 归零），flag 可回退。
- PR #52（引擎事件人话化）合入 main 与部署在跑。

## Next

- 波 3 交付 → 合并部署 → 波 4 画布地图化。
- 待用户：`FJ_RUNNER_DEFAULT=codex-tui` 写进 shell；体检第一批「待办层」要不要做。
- 观察一天后 AS 切流扩到全部项目；backlog P1 `codex-interrupt-leaves-exec-alive`。
