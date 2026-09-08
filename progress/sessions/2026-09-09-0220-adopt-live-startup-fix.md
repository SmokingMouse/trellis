# S164 · 2026-09-09 00:05–02:20 · 外部线程收编上线（含返工与二审）、启动期阻塞根因修复、侧栏波 1 上线、波 2 交付中、观察页退役开工

## 已落地（生产 release 0f126ab5e，previous ab2e1b760）

- **侧栏 IA 波 1**（PR #47，ab2e1b7）：会话种类谓词放开到 user/lark/herdr/task 并带来源 chip；删稍后再读 / 定时任务 / 未归组三组、不可达 Outline drawer 与 Header 隐藏按钮、两处「已隐藏」；修 `app/page.tsx` 初始化未把 URL session 传给 hydrate 的深链回归。前后：活跃会话 42 → 87，被排除的 Herdr 会话 43 → 0，焚决 worktree 有会话 0 → 13，顶层区域类型 8 → 5。第一次 `make deploy` 验活超时（下述根因），重试通过。
- **外部线程收编**（PR #48，c182e0a；二审通过 fj-as-adopt-review2-ebce）：语义终版——只收编 ≥1 turn 的线程；系统兜底 workspace 不参与归属，真实项目根 = git 仓库或 Herdr 已知 repo/worktree，取最长；无命中进系统项目「外部会话」；线性树回填；主页提问 / 审批 / 中断走第二步路径；删会话只解绑，Trellis 永不 close 外部线程；增量同步（每线程 cursor，稳态每 1.5 秒 1 次 `thread/list`、零 attach）。一审 P1-1（cwd 等于系统根被收进主目录）与 P1-2（全量快照 30 MB/轮）由 fj-as-adopt-fix-4fb3 修掉。**生产 `TRELLIS_AS_ADOPT=on` 已打开**（fj-as-adopt-ship-184a：生产真机临时线程闭环 + 十分钟 daemon 探针通过）；`/api/sessions` 已见 origin=external 会话（fj 坐席线程）。回退：`TRELLIS_AS_ADOPT=off` + `launchctl kickstart -k gui/$(id -u)/com.smokingmouse.trellis`。知情项（二审 N-1～N-3）：list 底噪随历史线程数线性涨（≈160 条超 100 KB/轮，backlog）；非 git 目录项目（如「投研」）不参与归属；不产 item 的通知也触发一次小 attach。
- **启动期阻塞根因修复**（PR #49，0f126ab，fix/cli-startup）：`cli-sync-watcher` 在 instrumentation 里同步重导全部镜像会话，Next 已监听、网关 ready 后事件循环仍被堵（53 个镜像会话快照：13.6 秒，首个 `/login` 16.96 秒 > smoke 15 秒；上一版 45d4189 也堵 10.3 秒，问题早于波 1，随镜像会话数增长才撞线）。修法：先监听，再逐会话异步补齐并让出事件循环；修后首个 `/login` 919 ms、最大 2.5 s；新增启动期 HTTP 回归测试。收编上线两次 `make deploy` 因此失败、第三次通过；部署判据未改。
- **主控运维**：干掉两个坐席遗留的隔离 `next start`（chore-ui-audit 3589、8/30 的 3397）；收编返工 rework_count 撞上限时把契约 max_reworks 2 → 4（三次都是验收与坐席自跑抢锁的时序）；ship 契约去掉 `git push` 禁令（改为禁 `--force`）。

## 在跑

- **侧栏波 2**（fj-sidebar-wave2-c6c6，feat/sidebar-wave2）：工具条按项目/按时间 + 来源 + 含归档，最近组与 Herdr 组退役，Chat → 「速记」，空工作区折叠，flag `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2` 可回退；顺手修波 1 遗漏的 `listProjectTree` 仍 kind=user（共享谓词 helper）。坐席自报全绿（286 单测、10 条脚本、六态截图、同口径行数 163 → 141）；第一次验收因 ship 单占锁被杀（exit 143），正在重跑验收。
- **观察页退役**（fj-as-observe-retire-6552，chore/observe-retire）：删 `/console/threads`、`/api/as/threads*`、ThreadLogView、影子脚本与文档引用，保留被收编/第二步复用的客户端封装；PR + 部署。

## Next

- 波 2 验收 → 主控合并部署 → 波 3（结构面板 push 合并）自动可起；波 4 画布地图化最后。
- 退役单交付 → 生产 `/console/threads` 404。
- backlog：`as-adopt-list-noise-grows-with-history`、`codex-interrupt-leaves-exec-alive`（P1）、launchd PATH 补 rg；观察一天后 AS 切流扩到全部项目（删 `TRELLIS_AS_PROJECT_ID`）。
