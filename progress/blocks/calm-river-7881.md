# Block: calm-river-7881（worktree 分支 `worktree/calm-river-7881`）

> 并行 worktree 独占进度块（规则见 `~/.claude/global/rules/parallel-worktree.md`）。
> merge 回 main 后把下方「待提炼」并入 README/sessions，然后删本文件。

## Current Focus

**Agent 长任务 response 分段 + 过程/结论分层（finalStart）——已实现 + 六路验证全绿，待 commit/merge。**

## Session Log

### Session 1 (2026-08-18)

- **缘起**：用户截图报「正文+思考+正文……阅读体验特别差」——agent 长任务里工具调用/
  思考之间的几十段过程叙述在 TurnCard 里连成一大坨。根因：SDK（@smokingmouse/agent）
  逐 token 透传 `text_delta`，content block 边界零事件，run-bus `committedText += text`
  无缝拼接。cli-import 路径无此问题（早就 `join("\n\n")`），只有 live 流式路径有。
- **方案（两层，一个状态机）**：
  1. **分段**：run-bus 收到结构性中断（thinking / tool_call_start）置 `pendingBreak`，
     下一个 delta 前把 `"\n\n"` 作为普通 delta 走完整路径（commit + DB append +
     broadcast）→ 流式端/DB/catchup 快照三方天然一致，claude/codex/mock 后端通吃。
     刻意延迟到「确有新正文」才插：工具收尾的 turn 不留尾部垃圾。
  2. **分层**：同一状态机维护 `finalStart` =最后一次中断之后的正文起点，finalize 落库
     （`nodes.final_start`，NULL/0=不分层→存量行为不变）。TurnCard done 态把
     [0, finalStart) 折叠成「🧭 过程叙述（N 字）」details（弱化字号/墨色+左竖线），
     [finalStart, ∞) 作为正文正常渲染。分享卡片图只带最终段；复制全文仍是全文。
- **改动面**（9 文件 + 1 新回归脚本）：
  - `lib/server/run-bus.ts` 状态机 + done 事件/finalEvent 携带 finalStart
  - `lib/server/repo.ts` NodeRow/NODE_COLS/rowToNode/ApiNode/finalizeNode/resetNodeForRetry
  - `lib/server/sqlite.ts` 迁移 `nodes.final_start INTEGER`
  - `lib/server/cli-import.ts` 同构状态机按块结构精确算 finalStart（thinking 块 v1 仍
    丢内容但当中断信号）+ `cli-import-db.ts` upsert 落列
  - `lib/types.ts` / `stores/sessionStore.ts` ChatNode.finalStart、done 事件写入
  - `app/api/nodes/[id]/stream/route.ts` DB-fallback done 带 finalStart
  - `components/TurnCard.tsx` SegmentedResponse（splitResponse 纯函数 + details 折叠）
  - `scripts/test-final-start.ts` 回归 harness（两个状态机 9 断言）
- **验证（全绿）**：
  - `bunx tsc --noEmit` ✓；eslint 改动文件无新错误（TurnCard 4 个 error 为既有基线，
    stash 对比确认）✓
  - `bun --conditions react-server scripts/test-final-start.ts` 9/9 ✓（mock provider
    驱动真实 startRun/subscribe + 手造 jsonl；断言分段串、落库偏移、done 事件携带、
    纯回答不分层、工具收尾指向末段）
  - 真实数据回归：本机最近 60 个 CLI jsonl / 369 turns → 243 分层、**0 越界/空 final**；
    抽样最终段全是「TLDR/交付汇报」类收尾 ✓
  - 视觉冒烟：隔离 dev（TRELLIS_DB_PATH 临时库 + PORT=3210）+ agent-browser 截图，
    折叠/展开两态符合设计 ✓
  - `bun --bun run build` exit 0 ✓
- **踩坑记录**：worktree 里 `bun run build`（无 `--bun`）在 collect page data 阶段随机
  路由报 `Failed to collect page data`，根因 Turbopack worker 是 node 进程解析不了
  `bun:sqlite`——Makefile 头注早有记载，dev/build/start 必须 `bun --bun run`。
- **Next**：
  - [ ] commit 本分支 → 回主仓 merge → 删 worktree + 本 block
  - [ ] （可选跟进）marks/分叉锚点命中过程段时 details 自动展开——低频边角，先不做
  - [ ] （可选跟进）流式态实时分层——done 态已解决主诉求，流式态本就有 thinking 面板
    与动线，刻意不做

## 待提炼（merge 后并入共享文件）

- `sessions.md`：S105 条目——本块 Session 1 摘要。
- `facts.md`（如需）：「`bun run build` 无 `--bun` 会在 collect page data 阶段挂
  `bun:sqlite`（worker 是 node）——Makefile 已强制 `--bun`，别绕过 make 裸跑」
  （来源：本 block 踩坑记录 + Makefile:1-15 注释）。
