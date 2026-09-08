# S162 · 2026-09-08 21:30–22:25 · 上线单收口、冷启动修复合 main（待重启）、外部线程收编主页开工、映射修复与 UI 体检起单

## 收口

- **trellis-ship-d 关单（验收 6/6）**：第一次验收失败是 D4 端口检查与坐席自跑脚本抢占的瞬态；第二次失败是 D3——坐席为 D5 提交了 44134a3（`mobile-safe-area.sh` 等深链目标就绪再数 header 按钮；根因是深链目标延迟 2 秒的时序，不是 AS 多出按钮）而 main 未含。主控推送后走小 PR #45（6e5e3ce），只改验证脚本与 progress，**生产维持 release d19fd63**（坐席按旧指令多部署了一次又 `make rollback` 回来，历史保留在 archive result）。
- **ingress-fresh-start 关单（验收 6/6）**：冷启动 config 逐项映射修复 PR #17 合 sm-toolkit main（88d5e5c），`~/sm-toolkit` 已拉并 `bun run build` 重建 dist（22:10）。**daemon 71466 尚未重启**：三个 codex-tui 坐席线程正跑在它上面，重启会杀引擎；等它们收工再 `launchctl kickstart -k`，之后跑生产冷启动冒烟。升级回归脚本的 interrupt 判据在真实引擎上不稳定（记 backlog `codex-ingress-upgrade-check-interrupt-flaky`），坐席合并时该矩阵未全绿，与产品修复无关。picker 保存默认模型走 `config/batchWrite` 维持 deny（backlog `codex-ingress-picker-model-save`）。
- 主控失误一次：迟到信件重建的 tasks 目录我 `rm -rf` 掉了坐席 21:45 重写的 out/（archive 已有 21:41–42 版本，事实未丢）。规则改为：先看、mail 追加、out/ 搬进 archive/out/late、再 rmdir（已写 auto-memory）。

## 用户问答（事实已核）

- 「能在 Trellis 看到 CLI 的流式恢复吗」：能。`/console/threads` 列常驻 daemon 全部线程（当时 86 条），SSE 快照 + 增量 + Last-Event-ID 续传；生产实测正在跑的坐席线程快照 293 items、status running。边界：只看不动；不经 daemon 的原生 CLI 仍走文件导入。
- 「为啥点会话看不到实时流」：入口与排序——主界面会话列表只有 Trellis 自己的会话；观察页无导航入口只能手敲；列表按创建时间正序，活线程在最底、多数无标题。
- 「为啥单独搞观察页不在主页双向」：迁移计划第一步「影子只读」刻意零风险；第二步（主页双向）已在线上但只对 Trellis 自己开的会话；外部线程收编计划里排第三步且只写到只读——当时租约规则未定，现已定案，可直接做双向收编。

## 新开线

- **外部线程收编主页**（用户「开始吧」）：计划四项 as-adopt → as-adopt-review → as-adopt-ship → as-observe-retire。语义已定：只收活线程；cwd 最长真实项目根归属，系统兜底 workspace（trellis:home/scratch）不参与，无命中进系统项目「外部会话」；线性树每 turn 一节点并回填；提问/审批/中断走第二步路径；Trellis 永不 close 外部线程，删会话只解绑；`TRELLIS_AS_ADOPT` 默认 off。as-adopt 在 worktree `feat/as-adopt`（w2W）由 codex 坐席实现中；起位基线 `mobile-as-project.sh` 在干净 main 上一次红（FAIL: thread reuse，疑负载偶发），已告知坐席独占复跑判断。
- **codex-mapper-display-items**（用户截图「Unknown Codex item type: sleep」）：根因 `codex-mapper.ts` 只映射 14 种类型，0.153.4 schema 里 `sleep/imageView/hookPrompt/enteredReviewMode/exitedReviewMode` 未映射，fallback 降级成 error item 画红条。修法：五种 → toolCall，不改协议；schema 全覆盖测试；真机 pty 证明。worktree `feat/codex-mapper-display-items`（w2Y），codex 坐席，测试已过在跑真机。
- **ui-audit**（用户「整体来个大的设计优化」）：只读体检单（Opus，w2Z chore/ui-audit，生产库快照 + 3490 隔离实例），产出路由清单截图、动线走查、P0–P2、一致性统计、保留项、5–8 个方向候选。等用户答两问：最痛三处、深度档位（我建议二档：重排 IA 与导航、保留画布与树内核）。

## Next

- 三个坐席收工 → 备份 `~/.agent-server` DB → `launchctl kickstart -k gui/$(id -u)/com.smokingmouse.agent-server` → 核 endpoint.json 新 pid → 生产冷启动冒烟两后端 → 告知用户 `codex --remote` 可直接开新会话。
- as-adopt 交付 → 复核 → 上线开开关 → 删观察页；mapper 修复交付 → 主控推送 + PR 合 main + 构建（随下次 daemon 重启生效）。
- ui-audit 报告 → 用户挑方向 → 方案单（HTML 稿）→ 分波实施并同步更新手机脚本。
- 观察一天后把 AS 切流扩到全部项目（删 `TRELLIS_AS_PROJECT_ID`）。
