# S150 · 2026-09-08 05:00–06:40 · dogfood 两轮复核可切换 → 主控切换 fj bundle、起 daemon、阶段 1 首单实弹

## dogfood 复核与返工

- dogfood-review（真实试点）：需返工——P0-1 真 herdr `pane run` 成功不输出 JSON、fj 判失败且 phase 已推到 pane_started 使 ready 握手被永久旁路（假 herdr 夹具与真实契约相反）；P1-1 herdr 不可用时关单泄漏 thread/引擎；P2×6。fjContext 对抗探针 19/19 拒绝。
- dogfood-fix → dogfood-review2：**可切换**——首次起位一次成功、握手四项身份核对真执行、herdr 离线关单回收引擎、daemon SIGKILL 后 fj next 不冒充 idle；新发现 P1-2（握手未完成的单无 CLI 出口）+ P2-7/8 → dogfood-fix2 修净（fj 102 pass / sm-toolkit 476 pass）。
- Trellis step2（feat/agent-server-step2 HEAD 032d7d4，9 提交）：验收通过（分叉验收按 leader 裁决收窄：末尾 fork 成功、早期节点 fork 明确失败）；review 在跑，含真 Sonnet 复验。

## 切换（主控亲自，06:26）

- 备份 `~/.claude/skills/herdr-leader/scripts/fj.js` → `fj.js.bak-native-20260908T062627`（sha 39a42a0…）；安装焚决仓 `skill/scripts/fj.js`（sha a61874a…，含 fix2）。`fj status`、`fj help` 正常，`--runner agent-tui` 可见。
- daemon：Herdr w4 新 tab `as-daemon`（pane **w4:pJ**），`bun ~/.herdr/worktrees/sm-toolkit/feat-dogfood/packages/agent-server/dist/daemon/cli.js run --grace-ms 5000`，socket `~/.sm-toolkit/agent-server.sock`、token `~/.agent-server/token`（0600），allowed_roots 缺省 = $HOME。未装 launchd。
- **阶段 1 首单**：as-polish2（集成后 P2 收尾）。第一次起位失败：未设 `FJ_AGENT_TUI_BIN`，argv[0] 落到裸 `agent-tui` 不在 PATH → pane 秒退 → 「ready 回执超时」；`fj task close --verdict aborted` 又因 pane 已消失报 pane_not_found 拒关（手工清 task.json.pane 后关成）。第二次带 `FJ_AGENT_TUI_BIN=<sm-toolkit feat-dogfood>/apps/agent-tui/bin/agent-tui` 起位一次成功：thread th_c7b505e5、契约首轮 tn_c0c59504、pane w22:pH，坐席已在跑测试。
- 三处暴露交 dogfood-fix3（预检可执行文件 + 持久化默认路径；ready 前 pane 消失让尝试干净失败；close 容忍 pane_not_found）。

## 阶段 1 计数

| # | 单 | runner | 起位 | 结果 |
|---|---|---|---|---|
| 1 | as-polish2（fj-as-polish2-b628） | agent-tui / gpt-6-astra | 第 2 次成功（首次为配置缺失） | 在跑 |

退出标准（方案 §7）：连续 10 单无 AS 消息丢失/重复、无审批卡死、首轮 settle 通过率不低于 native 基线。首次起位的配置缺失算基础设施失败，计入分母。

## 实弹经验

- 起 agent-tui 坐席必须带 `FJ_AGENT_TUI_BIN`（或等 fix3 的持久化默认）；daemon 与 fj 必须同一套 HOME/XDG 解析（本机无 XDG_* → 都落 HOME 默认）。
- `fj task close` 遇 pane 已死会拒关（fix3 前）：清 task.json 的 pane 字段再关。
- 忘了退位的设计坐席（smtk-dogfood-design）不在 fj 留用表里，`fj seat retire` 找不到，用 `herdr pane close` 关。

## Next

- 等 as-polish2 验收（首单）→ 继续用 agent-tui 派 codex 单累计 10 单；fix3 落地后重装 bundle。
- step2 review 结论 → 返工或收口。
- 用户待决：Herdr 桥合并上线、影子模式合并、agent-server 合 main 与发包、daemon 常驻（launchd）。
