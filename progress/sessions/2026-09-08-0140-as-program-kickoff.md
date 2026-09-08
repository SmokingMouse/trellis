# S147 · 2026-09-08 01:05–01:40 · agent-server 切流工程立项（对齐清单 + dogfood 方案 + 首批实现）

## 起因

用户问「Herdr 桥理论上也应该走 Agent Server？先论证完再把 Trellis 切过来？」→ 我给的判断：桥的控制半边被 AS 取代、观测半边长期保留；论证靠 fj 坐席 dogfood；退出标准四条。用户追问「为啥没有原生功能」→ 探针回答：能力在 headless 协议里、差的是壳与透传。用户拍板：「你作为中控，协调各 agent，把各种 feature 设计/实现/测试完」。

## 论证产物（只读单）

- **对齐清单** `.fenjue/archive/fj-as-parity-probe-a5c7/out/parity.md`（Opus）：57 个 control_request 子类型 / 49 个 system 子类型 / 80+ flag；三档分类；用户近 60 天画像（/clear 71、plan 123+24、bypass 88%、stop_hook_summary 1275、图片 47 条、@ 132 处、115 skill、5 MCP）；追平顺序 14 项；致命项：未知 control_request 杀会话。
- **dogfood 方案** `.fenjue/archive/fj-as-dogfood-design-082e/out/design.md`（codex）：单个用户级 launchd daemon；`--runner native|agent-tui` 开关；契约首轮经 AS RPC 注入；阶段 0（mock 预验收）→ 1（Codex 10 单）→ 2（Claude 10 单）→ 3（各再 20 单）；fj 源码在 `~/ai-coding/焚决/src`，bundle 到 herdr-leader/scripts/fj.js；关键路径 5–8 工程日 + 观察期。

## 计划结构（`.fenjue/plan.md`，目标「Trellis 会话驱动层切到 agent-server」）

```
as-fix4(✓) → as-foundation → as-foundation-review → tui-modes / tui-observe → 各 review ┐
tui-sessions → review ───────────────────────────────────────────────────────────────┼→ as-integrate2 → dogfood-impl → dogfood-review → trellis-step2 → review
tui-input   → review ───────────────────────────────────────────────────────────────┘
as-dogfood-design(✓) ─────────────────────────────────────────────────────────────────┘
```

- 每个实现单独占一个 worktree 分支（feat/as-foundation w28、feat/tui-sessions w26、feat/tui-input w27，均基于 feat/agent-server 6b0f179），最后 as-integrate2 合回 feat/agent-server。Herdr `worktree create` 必须从仓库父 workspace（wR）起，linked worktree 起会报 linked_worktree_source。
- 实现位 codex gpt-6-astra 普通档；review 位 Opus（异源）；留用坐席做返工循环。
- 已退位 5 个做完的留用坐席（doc-writer/doc-review/doc-feishu/hb-nestfix/hb-review）。

## 已落地

- as-fix4（feat/agent-server 60c006f + 6b0f179）：未知 control_request 回保守应答并上抛，不再杀会话；prompt_suggestion 忽略；5 个离线控制帧用例。

## 在跑

- as-foundation（engineEvent 通知、engineControl 直通、权限模式全集 + 热切、effort、子 agent 正文、bash 输入、compact；只增不改）。
- tui-sessions（/new=/clear、/threads、/fork、/resume、重连、状态栏）。
- tui-input（图片、@ 补全、斜杠/skill 补全、多行）。

## 实弹经验

- 同一 worktree 跑两单时，只读单的 settle 会把另一单未提交的改动判越界：等对方提交后把 base_commit 改成 HEAD 再 `fj settle --force`。
- zsh 下 `set -- $spec` 不分词，循环里用两次显式调用。
- `cd` 被 zoxide 接管，脚本里用 `bun install --cwd` / `git -C` 代替。

## Next

- 等三单验收 → 各自 review → tui-modes / tui-observe 起跑 → 集成 → dogfood-impl（需在焚决仓开 worktree）。
- 用户仍待决定：Herdr 桥合并上线、影子模式合并、agent-server 合 main 与发包。
