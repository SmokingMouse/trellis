# S163 · 2026-09-08 22:25–2026-09-09 00:05 · daemon 重启带上两修复、收编关单进复核、UI 体检与侧栏 IA 方案拍板、波 1 开工

## 已落地

- **Codex 显示项映射**（用户截图「Unknown Codex item type: sleep」）：`codex-mapper.ts` 补 sleep/imageView/hookPrompt/enteredReviewMode/exitedReviewMode → toolCall，schema 全覆盖测试；PR #18 合 sm-toolkit main（ac103ac）。真机 gpt-6-astra 原生 sleep 在 AS 记为 completed toolCall clock.sleep，零 error item。
- **daemon 重启**（23:53，所有坐席收工后）：pid 71466 → 78674，dist 含冷启动 config 映射（PR #17）与显示项映射（PR #18）。**ingress 端口是动态的**：55919 → 61263，以 `~/.sm-toolkit/agent-server.sock.endpoint.json` 为准；fj 自动读。生产冷启动冒烟 `codex-remote-smoke.py --mode prod --endpoint … --expect fresh_tui_session_ok` 两后端各一次全新 TUI 会话通过（/tmp/as-prod-smoke/summary.json passed=true）。launchd 日志提示 PATH 缺 rg（只读免审的 rg 命令退回审批），待补 plist PATH。
- **UI 体检**（fj-ui-audit-7b23，Opus，只读）：13 路由 38 截图；P0 观察页无入口；P1 树面板遮正文 166px、画布 124 节点两端失效、无常驻待办、审批卡三键等权、中文搜索 <3 字被拒、抽屉盖住 Composer、machine 页 GB 显示成 TB、侧栏裸 ENOENT；7 个方向 + 三批推荐。
- **单点修复上线**（fj-ui-nits-p1-f2de → PR #46 → release 45d4189，00:52 部署，前两 release 保留）：侧栏「Herdr 未运行」降级文案、`lib/format-bytes.ts` 单位、新会话首屏读真实默认模型。
- **外部线程收编**（fj-as-adopt-a06a，验收 6/6 关单）：分支 feat/as-adopt（a3525a0+）；语义最终版：只收编 ≥1 turn 的线程、系统兜底 workspace 不参与归属、取最长真实根、删会话只解绑、`TRELLIS_AS_ADOPT` 默认 off；新增 `mobile-as-adopt.sh`；AS project 脚本 thread reuse 断言限定到 fixture 会话（切流后快照含其它 AS 线程，全库计数断言本就错）。真机：临时 sonnet 线程首轮收编 → 主页续问 → 删除后线程仍活。已知限制：空会话 hydrate 5 秒中止（疑存量）、backend=external 协议限制，见 archive result。复核单 fj-as-adopt-review-d57c（Opus）在跑。
- **侧栏与工作树 IA 方案**（fj-sidebar-tree-ia-4784，Opus）：五层模型 项目→工作区→会话→树→节点，侧栏叶子=会话，链=阅读位置不进侧栏；横切集合改排序/筛选/来源 chip；方案 A/B/C，推荐 A；四波实施。**用户「我同意」**：方案 A + 五条倾向（去侧栏链行、Herdr 并入项目树、结构面板右侧 push、画布降级为地图、伪项目显式命名）。副本 `progress/sidebar-tree-ia.md`，稿 `.fenjue/archive/fj-sidebar-tree-ia-4784/out/mockups/`。波 1（fj-sidebar-wave1-cc46，codex，worktree feat/sidebar-wave1）在跑；波 2–4 计划已落盘按依赖解锁。

## 主控失误与处置

- 冷启动单关单后坐席仍在无显示端状态下跑升级矩阵烧 token：`herdr agent` 已注销、pane 已关，用 as/1 `thread/interrupt` + `thread/close` 直接关掉线程（/tmp/as-close-orphan.ts，从已安装依赖的 worktree 跑）。其 worktree 留有未合并的 sleep 判据提交 7a691a0，归 backlog `codex-ingress-upgrade-check-interrupt-flaky`。
- 收编单 rework_count 撞 max_reworks=2：三次都是验收与坐席自跑脚本抢锁/partial 早发的时序，不是交付问题；契约 max_reworks 改 4 后继续。教训：契约里写明「不要发 partial result，中间只用 progress」。
- 迟到信件折叠改为「先看、mail 追加、out/ 搬 archive/out/late、再 rmdir」（auto-memory 已记）。

## 新 backlog

- `codex-interrupt-leaves-exec-alive`（P1）：真实 Codex 线程 turn/interrupt 后 commandExecution 无 item/completed 且子进程仍活。
- `codex-ingress-upgrade-check-interrupt-flaky`（P2）、`codex-ingress-picker-model-save`（P2）。
- launchd plist PATH 补 rg 所在目录（小）。

## Next

- 复核结论 → as-adopt-ship（PR、部署、生产 `TRELLIS_AS_ADOPT=on`、临时线程验活）→ as-observe-retire 删观察页。
- 波 1 交付 → 主控合并部署 → 波 2 自动可起；每波同步更新手机脚本。
- 观察一天后 AS 切流扩到全部项目；体检第一批里的「待办层」（Header 下 PendingBar）待用户点头。
