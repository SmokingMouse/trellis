# S151 · 2026-09-08 06:40–07:30 · 阶段 1 试点 3/3 通过、bundle fix3 上线、Trellis 第二步复核收口

## 阶段 1（Codex 坐席走 agent-tui runner）计数

| # | 单 | 起位 | 验收 | 备注 |
|---|---|---|---|---|
| 1 | as-polish2（集成后 P2 收尾 ×7） | 第 2 次成功（首次缺 FJ_AGENT_TUI_BIN，基础设施失败） | 通过 | settle 后 thread + pane 自动关 |
| 2 | as-pending-notify（只读审批状态通知） | 一次成功 | 通过 | 消灭影子模式 2 秒轮询的协议前提 |
| 3 | as-midfork（thread/fork fromItemId，双引擎原生/播种） | 一次成功（policy 持久化路径，无 env） | 通过 | server 291 pass |
| 4 | trellis-step2b（重新 vendor、删轮询、走 midfork） | 一次成功 | 在跑 | Trellis 仓，w2D |

- 零丢消息、零审批卡死；settle 首轮通过率 3/3（native 近期基线 ≈ 首轮 2/3 因验收侧环境差异）。
- 复核安排：pending-notify + midfork 由 as-notify-fork-review（Opus，含真 Sonnet/Codex 分叉复验）统一复核；step2b 之后走 step2 复核坐席。

## 运行面

- fj bundle 升到 fix3（sha aab7228…，备份 `fj.js.bak-fix2-*`）；`.fenjue/policy.md` frontmatter 加 `agent_tui_bin`（FJ_AGENT_TUI_BIN > policy > PATH）。
- daemon 仍在 w4:pJ 前台跑（socket ~/.sm-toolkit/agent-server.sock）；allowed_roots 缺省 $HOME。launchd 未装（等用户）。
- 验收脚本基线 `/tmp/fj.js.baseline-dogfood` 已同步为当前安装版。

## Trellis 第二步

- review（Opus + 真 Sonnet）：需返工——P0 重试抹掉原答案且必败；P1 非末端续聊 503；P1 TRELLIS_AS=off 对已绑定会话失效。**leader 裁决**：重试成功前不清答案、tip 同线程重跑、非 tip 播种新线程；非末端普通续聊 = 从该节点起新线程，仅显式 fork 且协议不支持才拒；硬关闸对已绑定会话按 daemon 不可达回退；interrupt 不依赖租约。
- fix → review2：通过（P0/P1 转正，真引擎复验 200），剩 P2×若干不阻塞。HEAD 329e3b6。

## Next

- as-notify-fork-review 结论 → 返工或收口；step2b 验收 → 复核 → 第二步可交付（合并仍等用户）。
- 阶段 1 继续累计到 10 单；之后阶段 2 Claude 坐席试点（显式 sonnet）。
- 用户待决：Herdr 桥合并上线、影子模式与第二步合并、agent-server 合 main 与发包、daemon 常驻。
